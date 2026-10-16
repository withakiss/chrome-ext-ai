// 브라우저 내 SmolVLM 실제 추론 프로브: Chrome for Testing에 확장을 올리고 캔버스 이미지 한 장을 설명시킨다.
// 실행: node test/e2e/localvlm-probe.mjs   (extension/models/ 에 모델 파일 필요, 첫 로드 수십 초~수 분)
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const EXT = path.join(ROOT, 'extension');
const BIN = [ 'chromium-1234', 'chromium-1208' ].map((d) => path.join(process.env.HOME, 'Library/Caches/ms-playwright', d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(existsSync);
const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(BIN, [`--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'localvlm-'))}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--enable-unsafe-webgpu', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const errLines = []; chrome.stderr.on('data', (d) => { errLines.push(...String(d).split('\n')); if (errLines.length > 400) errLines.splice(0, errLines.length - 400); });
chrome.on('exit', () => console.log('[chrome stderr tail]\n' + errLines.filter((l) => /FATAL|CHECK|Check failed|OOM|out of memory|crash|SIGTRAP|GPU/i.test(l)).slice(-15).join('\n')));
chrome.on('exit', (c, sig) => console.log('[chrome exited]', c, sig));
let ws; for (let i = 0; i < 50 && !ws; i++) { try { ws = new WebSocket((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl); } catch { await sleep(200); } }
await new Promise((r) => ws.addEventListener('open', r));
ws.addEventListener('close', () => console.log('[ws closed]'));
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
  await sleep(1000);
  const t0 = Date.now();
  // 오프스크린 문서의 콘솔·예외를 수집(모델 로드 진단)
  (async () => { for (let i = 0; i < 100; i++) { await sleep(300); const { targetInfos } = await cdp('Target.getTargets'); const off = targetInfos.find((t) => t.url.endsWith('offscreen.html')); if (off) { const { sessionId: os } = await cdp('Target.attachToTarget', { targetId: off.targetId, flatten: true }); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.sessionId !== os) return; if (m.method === 'Runtime.exceptionThrown') console.log('[offscreen EXC]', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 500)); if (m.method === 'Runtime.consoleAPICalled') console.log('[offscreen', m.params.type + ']', m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300)); }); await cdp('Runtime.enable', {}, os); return; } } })();
  const r = await cdp('Runtime.evaluate', { expression: `(async () => {
    const g = await import('./lib/localvlm.js');
    const st0 = await g.localVlmStatus();
    const c = document.createElement('canvas'); c.width = 320; c.height = 120; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 320, 120); x.fillStyle = '#d00'; x.fillRect(20, 20, 120, 80); x.fillStyle = '#000'; x.font = '28px sans-serif'; x.fillText('HELLO 42', 160, 75);
    const load = await g.localVlmLoad(${JSON.stringify(process.env.VLM_DEVICE || null)} || undefined);
    const text = await g.localVlmDescribe(c.toDataURL('image/png'), 'Describe this image in one short English sentence.');
    return { st0, load, text };
  })().catch((e) => ({ error: String(e && (e.stack || e.message || e)) }))`, awaitPromise: true, returnByValue: true, timeout: 600000 }, sessionId);
  console.log(JSON.stringify(r, null, 1).slice(0, 3000), `(${Math.round((Date.now() - t0) / 1000)}s)`);
  const { targetInfos: ti } = await cdp('Target.getTargets'); console.log('targets:', ti.map((t) => `${t.type} ${t.url}`).join(' | '));
} finally { chrome.kill(); process.exit(0); }
