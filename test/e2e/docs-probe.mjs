// 브라우저 전용 문서 파서(pdf.js·rhwp HWP) 프로브: Chrome for Testing에 확장을 올리고 파일을 base64로 넘겨 extractDocText를 돌린다.
// 실행: node test/e2e/docs-probe.mjs <파일...>
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const EXT = path.join(ROOT, 'extension');
const BIN = ['chromium-1234', 'chromium-1208'].map((d) => path.join(process.env.HOME, 'Library/Caches/ms-playwright', d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(existsSync);
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(BIN, [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'docs-'))}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, `--remote-debugging-port=${PORT}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let ws; for (let i = 0; i < 50 && !ws; i++) { try { ws = new WebSocket((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl); } catch { await sleep(200); } }
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
try {
  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await cdp('Target.getTargets');
    for (const t of targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'))) {
      const { sessionId } = await cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await cdp('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, sessionId);
      if (r.result?.value === 'Local Browser Agent') extId = t.url.split('/')[2];
    }
    if (!extId) await sleep(200);
  }
  const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html` });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await sleep(800);
  for (const f of process.argv.slice(2)) {
    const b64 = readFileSync(f).toString('base64');
    const t0 = Date.now();
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { try { const { extractDocText } = await import('./lib/docs.js'); const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); const { extractDocPages } = await import('./lib/docs.js'); const t = await extractDocText(u8.buffer, ${JSON.stringify(path.basename(f))}); const pages = await extractDocPages(u8.buffer.slice(0), ${JSON.stringify(path.basename(f))}, { maxPages: 2 }); return { len: t.length, head: t.slice(0, 120), pages: pages.map((p) => p.length) }; } catch (e) { return { error: String(e && (e.stack || e.message || e)).slice(0, 600) }; } })()`, awaitPromise: true, returnByValue: true, timeout: 120000 }, sessionId);
    console.log(`== ${path.basename(f)} (${Math.round((Date.now() - t0) / 1000)}s)`, JSON.stringify(r.result?.value ?? r.exceptionDetails?.text ?? r).slice(0, 700));
  }
} finally { chrome.kill(); process.exit(0); }
