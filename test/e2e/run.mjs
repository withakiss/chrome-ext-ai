// e2e: Chromium(--load-extension) + CDP + 가짜 OpenAI 서버로 "검색 → 두 번째 결과 열기"를 외부 접속 없이 검증한다.
// 실행: node test/e2e/run.mjs [chromium 경로]   (기본: Playwright 캐시의 Chromium)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const EXT = path.join(ROOT, 'extension');
const FIXTURE = `file://${path.join(ROOT, 'test/fixture/search.html')}`;
const PORT = 18080, CDP_PORT = 9333;
const CHROMIUM = process.argv[2] || findChromium();

function findChromium() {
  const base = path.join(process.env.HOME, 'Library/Caches/ms-playwright');
  for (const d of ['chromium-1234', 'chromium-1208']) {
    const p = path.join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
    if (existsSync(p)) return p;
  }
  throw new Error('Chromium not found; pass path as argv[2]');
}

// ---- 가짜 LLM: 직전 도구 출력에서 ref를 찾아 다음 코드를 만든다 ----
const ref = (out, re) => { const m = out.match(re); if (!m) throw new Error(`ref not found: ${re}\n${out}`); return m[1]; };
const steps = [
  () => `const s1 = await snapshot(page, {interactive:true}); console.log(s1.tree)`,
  (out) => `await page.locator('${ref(out, /button "동의" \[ref=(e\d+)\]/)}').click(); const s = await snapshot(page, {interactive:true}); console.log(s.tree)`,
  (out) => `await page.locator('${ref(out, /textbox "검색어" \[ref=(e\d+)\]/)}').fill('playwright'); await page.keyboard.press('Enter'); await sleep(200); const s = await snapshot(page, {interactive:true}); console.log(s.tree)`,
  (out) => `await page.locator('${ref(out, /link "playwright 결과 2" \[ref=(e\d+)\]/)}').click(); await sleep(500); console.log(await page.title())`,
  null, // 최종 답
];
let step = 0;
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='; // 1x1 PNG
const sse = (res, deltas) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const d of deltas) res.write(`data: ${JSON.stringify({ choices: [{ delta: d, finish_reason: null }] })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); };
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    if (req.url === '/v1/messages') { // 가짜 Claude Messages API(SSE)
      lastClaude = { headers: req.headers, body: JSON.parse(body) };
      const ev = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(ev({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } }));
      const lastUserText = JSON.stringify(lastClaude.body.messages.filter((m) => m.role === 'user').at(-1)?.content || '');
      const long = lastUserText.includes('긴 답변');
      const json = JSON.stringify(long
        ? { title: '긴 답변', summary: '여러 단락으로 된 긴 답변입니다. 화면보다 길어서 시작 부분이 위쪽에 와야 합니다.', blocks: [{ type: 'markdown', text: Array.from({ length: 40 }, (_, i) => `${i + 1}. 긴 답변의 ${i + 1}번째 줄입니다.`).join('\n') }], followups: ['더 알려줘'] }
        : { title: '클로드', summary: '클로드 응답입니다. 천천히 흘러나오는 요약입니다.', blocks: [{ type: 'markdown', text: '**굵게**' }] });
      const thoughts = long ? ['질문을 읽는 중', '\n관련 내용을 정리하는 중', '\n답변 구조를 잡는 중', '\n예시를 고르는 중', '\n마무리하는 중'] : ['사용자 질문을 살펴보는 중'];
      const steps = [ // 생각 → 답변 JSON을 조각으로 천천히(진행 표시·실시간 미리보기 확인용)
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
        ...thoughts.map((t) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } })),
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } }),
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'answer', input: {} } }),
        ...(long ? Array.from({ length: Math.ceil(json.length / 120) }, (_, i) => json.slice(i * 120, i * 120 + 120)) : [json.slice(0, 50), json.slice(50, 70), json.slice(70)]).map((c) => ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: c } })),
        ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }), ev({ type: 'message_stop' })];
      let k = 0; const tick = () => { if (k < steps.length) { res.write(steps[k++]); setTimeout(tick, long ? 250 : 350); } else res.end(); }; tick(); return;
    }
    if (req.url === '/diag.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>진단</title><button id="q">조회</button><script>fetch("/api/orders?token=secret-token")</script>'); }
    if (req.url.startsWith('/api/orders')) { res.writeHead(403, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=cookie-secret' }); return res.end('{"error":"forbidden"}'); }
    if (req.url.endsWith('/images/generations')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ b64_json: PNG1 }] })); }
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
    const msgs = JSON.parse(body).messages;
    const lastUserText = [...msgs].reverse().find((m) => m.role === 'user')?.content;
    if (typeof lastUserText === 'string' && lastUserText.includes('오래 걸리는')) { // 중지 테스트: 끝나지 않는 run_js
      const already = msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'slow1');
      return already ? sse(res, [{ content: '끝' }]) : sse(res, [{ tool_calls: [{ index: 0, id: 'slow1', type: 'function', function: { name: 'run_js', arguments: JSON.stringify({ code: 'await sleep(100000); console.log(1)' }) } }] }]);
    }
    if (typeof lastUserText === 'string' && lastUserText.includes('그려줘')) {
      const already = [...msgs].reverse().find((m) => m.role === 'tool' && /이미지 생성 완료/.test(m.content));
      return already ? sse(res, [{ content: '그렸습니다.' }]) : sse(res, [{ tool_calls: [{ index: 0, id: 'img1', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: 'a red circle', size: '512x512' }) } }] }]);
    }
    const coding = codingReply(msgs, lastUserText);
    if (coding) return sse(res, coding);
    const lastTool = [...msgs].reverse().find((m) => m.role === 'tool')?.content || '';
    try {
      const fn = steps[step++];
      if (!fn) return sse(res, [{ content: `완료: ${lastTool.trim()}` }]);
      sse(res, [{ tool_calls: [{ index: 0, id: `c${step}`, type: 'function', function: { name: 'run_js', arguments: JSON.stringify({ code: fn(lastTool) }) } }] }]);
    } catch (e) { sse(res, [{ content: `FAKE-LLM-ERROR: ${e.message}` }]); }
  });
});

// 코딩 보조 시나리오용 가짜 응답: 마지막 사용자 질문 이후 도구 출력을 보고 다음 호출을 정한다
const call = (id, name, args) => [{ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }];
let callSeq = 0, lastClaude = null;
function codingReply(msgs, q) {
  if (typeof q !== 'string') return null;
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
  const outs = msgs.slice(lastUser).filter((m) => m.role === 'tool').map((m) => m.content);
  const last = outs.at(-1) || '';
  const id = () => `k${++callSeq}`;
  if (q.endsWith('코드 질문')) {
    if (!outs.length) return call(id(), 'search_code', { query: 'fetch' });
    if (last.startsWith('거부')) return call(id(), 'answer', { summary: '프로젝트가 연결되지 않았습니다.', blocks: [] });
    if (!last.startsWith('<file')) return call(id(), 'read_file', { path: 'src/api.js', start: 1, end: 3 });
    return call(id(), 'answer', { title: '검색 결과', summary: 'fetch는 src/api.js 2번째 줄에 있습니다.', blocks: [{ type: 'table', columns: ['파일', '내용'], rows: [['src/api.js', 'fetch 호출']] }, { type: 'chart', kind: 'bar', labels: ['a', 'b'], values: [1, 2] }], citations: [{ path: 'src/api.js', startLine: 1, endLine: 3 }, { path: 'src/other.js', startLine: 1, endLine: 1 }], followups: ['더 보기'] });
  }
  if (q.endsWith('글자 도구')) return outs.length ? [{ content: `글자 도구 결과: ${outs.at(-1).trim()}` }] : [{ content: '확인할게요.\n<tool_call>\n<function=run_js>\n<parameter=code>\nconsole.log(\'ok-xml\')\n</parameter>\n</function>\n</tool_call>' }];
  if (q.endsWith('깨진 답')) return call(id(), 'answer', { summary: 5, blocks: 'x' });
  if (q.endsWith('다시 수정해')) return outs.length ? call(id(), 'answer', { summary: '수정안을 다시 만들었습니다.', blocks: [] }) : call(id(), 'propose_patch', { reason: 'v2를 v3로', edits: [{ path: 'src/api.js', oldText: 'v2', newText: 'v3' }] });
  if (q.endsWith('수정해')) return outs.length ? call(id(), 'answer', { summary: '수정안을 만들었습니다. 승인하면 적용됩니다.', blocks: [] }) : call(id(), 'propose_patch', { reason: 'v1을 v2로', edits: [{ path: 'src/api.js', oldText: 'v1', newText: 'v2' }] });
  if (q.endsWith('테스트 돌려')) return outs.length ? call(id(), 'answer', { summary: '테스트를 실행하지 못했습니다.', blocks: [] }) : call(id(), 'run_tests', { templateId: 'unit' });
  if (q.endsWith('진단해')) {
    if (!outs.length) return call(id(), 'run_js', { code: "await page.goto('http://127.0.0.1:18080/diag.html'); await sleep(800); console.log('ok')" });
    if (outs.length === 1) return call(id(), 'get_page_diagnostics', {});
    return call(id(), 'answer', { summary: '조회 API가 403을 돌려줍니다.', blocks: [{ type: 'status', label: '분석 완료', state: 'success' }] });
  }
  return null;
}

// ---- CDP ----
let ws, seq = 0; const pending = new Map();
const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!ws) throw new Error('CDP not reachable');
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
}
const attach = async (targetId) => (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId;
const evaluate = async (sid, expression) => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid); if (r.exceptionDetails) console.log('EVAL EXC', r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = mkdtempSync(path.join(tmpdir(), 'ext-e2e-'));
  const chrome = spawn(CHROMIUM, [`--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', ...(process.env.E2E_HEADED ? [] : ['--headless=new', '--window-size=1280,900']), FIXTURE], { stdio: 'ignore' }); // 기본은 창 없이(E2E_HEADED=1이면 창 표시)
  let ok = false;
  try {
    await connect();
    // 우리 확장의 service worker 찾기 (내장 확장도 chrome-extension:// 이므로 manifest 이름으로 확인)
    let extId, swSid;
    for (let i = 0; i < 50 && !extId; i++) {
      const { targetInfos } = await cdp('Target.getTargets');
      for (const t of targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'))) {
        const s = await attach(t.targetId);
        if (await evaluate(s, 'chrome.runtime.getManifest().name') === 'Local Browser Agent') { extId = t.url.split('/')[2]; swSid = s; break; }
      }
      if (!extId) await sleep(200);
    }
    if (!extId) throw new Error('extension not loaded');
    // 설정을 가짜 서버로 (service worker 컨텍스트에서 storage 기록)
    // E2E_BASE_URL/E2E_MODEL/E2E_KEY 가 있으면 실제 모델 서버로 (예: vLLM, Ollama)
    const prov = process.env.E2E_BASE_URL
      ? { id: 'real', label: 'Real', kind: 'openai', baseUrl: process.env.E2E_BASE_URL, apiKey: process.env.E2E_KEY || '', model: process.env.E2E_MODEL, models: [process.env.E2E_MODEL] }
      : { id: 'fake', label: 'Fake', kind: 'openai', baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: '', model: 'fake', models: ['fake'] };
    const imgProv = { id: 'imagegen', label: '이미지 생성 서버', kind: 'image-gen', baseUrl: process.env.E2E_BASE_URL ? '' : `http://127.0.0.1:${PORT}/v1`, apiKey: '', model: 'fake-sd', models: [] };
    await evaluate(swSid, `chrome.storage.local.set({ settings: { providers: [${JSON.stringify(prov)}, ${JSON.stringify(imgProv)}], selected: { providerId: '${prov.id}', model: '${prov.model}' } } })`);
    // 사이드 패널 페이지를 별도 창으로 열고 프롬프트 전송
    const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html`, newWindow: true });
    const sid = await attach(targetId);
    const logs = [];
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.sessionId !== sid) return;
      if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ' ' + m.params.args.map((a) => a.value ?? a.description).join(' ')); });
    await cdp('Runtime.enable', {}, sid);
    await sleep(800);
    // E2E_SHOTS=<폴더>면 기능 안내용 화면을 실제 흐름 중간에 캡처(평소엔 동작 안 함). 패널은 사이드 패널 폭 400px로
    const SHOTS = process.env.E2E_SHOTS; if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 2, mobile: false }, sid); }
    const snap = async (name, sel, block = 'start', session = sid) => {
      if (!SHOTS) return;
      if (sel) await evaluate(session, `(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].at(-1); if (e) e.scrollIntoView({ block: ${JSON.stringify(block)} }); return true; })()`);
      await sleep(350); const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, session); writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, 'base64'));
    };
    await snap('01-start');
    console.log('panel:', await evaluate(sid, 'location.href + " " + document.readyState + " body=" + document.body.innerHTML.length'));
    await evaluate(sid, `(() => { document.getElementById('input').value = '테스트 검색해서 두 번째 결과 열어'; document.getElementById('send').click(); return true; })()`);
    let last = '';
    for (let i = 0; i < 240; i++) { // 실제 모델은 느릴 수 있어 최대 2분
      await sleep(500);
      const busy = await evaluate(sid, `document.getElementById('send').disabled`);
      last = await evaluate(sid, `[...document.querySelectorAll('#messages .msg.assistant, #messages .msg.error')].map(e => e.textContent).join('\\n')`);
      if (!busy && i > 2) break;
    }
    const tools = await evaluate(sid, `[...document.querySelectorAll('details.tool')].map(d => d.querySelector('.out').textContent).join('\\n---\\n')`);
    const pages = (await cdp('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').map((t) => t.url);
    ok = pages.some((u) => u.endsWith('result-2.html')) && (process.env.E2E_BASE_URL ? /결과 2/.test(last) : /완료: 결과 2/.test(last));
    console.log('tool calls:', await evaluate(sid, `document.querySelectorAll('details.tool').length`));
    await snap('02-page-control', '#messages > :not(#turnSpacer)', 'end');
    // 2) "화면에서 선택": 결과 페이지 위에서 드래그 → 칩 표시 → 질문에 첨부
    let regionOk = false;
    if (ok) {
      const pageT = (await cdp('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url.endsWith('result-2.html'));
      const psid = await attach(pageT.targetId);
      await cdp('Target.activateTarget', { targetId: pageT.targetId });
      await evaluate(sid, `document.getElementById('selectRegion').click()`);
      await sleep(400);
      const drag = async (type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra }, psid);
      await drag('mousePressed', 5, 5, { clickCount: 1 }); await drag('mouseMoved', 300, 200, { buttons: 1 }); await snap('03-region-drag', null, 'start', psid); await drag('mouseReleased', 300, 200, { clickCount: 1 });
      await sleep(400);
      await sleep(600); await snap('04-region-chip');
      const chip = await evaluate(sid, `document.getElementById('regionChip').hidden ? '' : document.getElementById('regionLabel').textContent`);
      await evaluate(sid, `(() => { document.getElementById('input').value = '이 영역 설명해'; document.getElementById('send').click(); return true; })()`);
      // SmolVLM 모델 파일이 있으면 실제로 이미지 설명을 만들며 보내기가 기다린다(최대 120초) → 넉넉히 대기
      for (let i = 0; i < 320; i++) { await sleep(500); if (!(await evaluate(sid, `document.getElementById('send').disabled`)) && i > 1) break; }
      const lastUser = await evaluate(sid, `[...document.querySelectorAll('#messages .msg.user')].at(-1).textContent`);
      regionOk = /선택 영역 · \d+자/.test(chip) && lastUser.startsWith('(선택 영역');
      console.log('region:', chip, '|', lastUser, regionOk ? 'OK' : 'FAIL');
      ok = ok && regionOk;
    }
    // 3) 이미지 생성 도구: "그려줘" → generate_image → 카드에 이미지 표시
    if (ok && !process.env.E2E_BASE_URL) {
      await evaluate(sid, `(() => { document.getElementById('input').value = '빨간 원 그려줘'; document.getElementById('send').click(); return true; })()`);
      for (let i = 0; i < 60; i++) { await sleep(500); if (!(await evaluate(sid, `document.getElementById('send').disabled`)) && i > 1) break; }
      const imgs = await evaluate(sid, `document.querySelectorAll('details.tool .img img').length`);
      const dl = await evaluate(sid, `!!document.querySelector('details.tool .img a[download]')`);
      const lastA = await evaluate(sid, `[...document.querySelectorAll('#messages .msg.assistant')].at(-1)?.textContent`);
      const genOk = imgs === 1 && dl && /그렸습니다/.test(lastA);
      console.log('imagegen:', imgs, dl, lastA, genOk ? 'OK' : 'FAIL');
      ok = ok && genOk;
    }
    // 4) 민감값 가림: 첫 스냅샷 출력에 비밀번호 값이 아니라 [value redacted]
    if (ok && !process.env.E2E_BASE_URL) {
      const info = await evaluate(sid, `(() => { const t = [...document.querySelectorAll('details.tool .out')].map((o) => o.textContent).join(' '); return { red: t.includes('[value redacted]'), leak: t.includes('secret123'), sample: (t.match(/[^\\n]*textbox[^\\n]*/g) || []).slice(0, 3) }; })()`);
      const redOk = !!info && info.red && !info.leak;
      console.log('redaction:', redOk ? 'OK' : 'FAIL', JSON.stringify(info));
      ok = ok && redOk;
    }
    // 5) 중지: 끝나지 않는 run_js 중 중지 → "중지됨" + 보내기 복구
    if (ok && !process.env.E2E_BASE_URL) {
      await evaluate(sid, `(() => { document.getElementById('input').value = '오래 걸리는 작업'; document.getElementById('send').click(); return true; })()`);
      await sleep(2500);
      await evaluate(sid, `document.getElementById('stop').click()`);
      let stopOk = false;
      for (let i = 0; i < 20; i++) { await sleep(500); const st = await evaluate(sid, `({ busy: document.getElementById('send').disabled, err: [...document.querySelectorAll('#messages .msg.error')].at(-1)?.textContent })`); if (!st.busy && st.err === '중지됨') { stopOk = true; break; } }
      if (!stopOk) console.log('stop debug:', JSON.stringify(await evaluate(sid, `({ busy: document.getElementById('send').disabled, stopHidden: document.getElementById('stop').hidden, errs: [...document.querySelectorAll('#messages .msg.error')].map((e) => e.textContent), outs: [...document.querySelectorAll('details.tool .out')].slice(-2).map((o) => o.textContent.slice(0, 120)), last: [...document.querySelectorAll('#messages .msg')].at(-1)?.textContent.slice(0, 100) })`)), '| panel logs:', logs.slice(-6).join(' || ').slice(0, 800));
      console.log('stop:', stopOk ? 'OK' : 'FAIL');
      ok = ok && stopOk;
    }
    // 6) 코딩 보조: 프로젝트 없음 거부 → OPFS 프로젝트 연결 → 근거 답변·인용 검증·잘못된 답 대체·수정안 승인/stale·테스트 미실행·화면 진단
    if (ok && !process.env.E2E_BASE_URL) {
      const ask = async (q) => { await evaluate(sid, `(() => { document.getElementById('input').value = ${JSON.stringify(q)}; document.getElementById('send').click(); return true; })()`); for (let i = 0; i < 60; i++) { await sleep(400); if (!(await evaluate(sid, `document.getElementById('send').disabled`)) && i > 1) break; } };
      const reload = async () => { await evaluate(sid, 'location.reload()'); await sleep(1500); };
      const setSettings = (patch) => evaluate(sid, `chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(patch)} } }))`);
      const fileText = (p) => evaluate(sid, `(async () => { let d = await navigator.storage.getDirectory(); const parts = ${JSON.stringify(p)}.split('/'); const n = parts.pop(); for (const x of parts) d = await d.getDirectoryHandle(x); return (await (await d.getFileHandle(n)).getFile()).text(); })()`);
      const writeFile = (p, t) => evaluate(sid, `(async () => { let d = await navigator.storage.getDirectory(); const parts = ${JSON.stringify(p)}.split('/'); const n = parts.pop(); for (const x of parts) d = await d.getDirectoryHandle(x, { create: true }); const w = await (await d.getFileHandle(n, { create: true })).createWritable(); await w.write(${JSON.stringify(t)}); await w.close(); return true; })()`);
      const checks = {};
      await setSettings({ mode: 'code', projectId: '' }); await reload();
      await ask('코드 질문');
      checks.noProject = /거부: 연결된 프로젝트가 없습니다/.test(await evaluate(sid, `[...document.querySelectorAll('details.tool .out')].at(-1)?.textContent || ''`));
      // OPFS에 고정 프로젝트를 만들고 IndexedDB에 핸들 등록
      await writeFile('src/api.js', 'export const v = "v1";\nfetch("/api/orders")\nexport default v;\n');
      await writeFile('src/other.js', 'export const o = 1;\n');
      await writeFile('.env', 'API_KEY=hidden');
      await evaluate(sid, `new Promise((res, rej) => { const r = indexedDB.open('agent-projects', 1); r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' }); r.onsuccess = async () => { const root = await navigator.storage.getDirectory(); const t = r.result.transaction('projects', 'readwrite'); t.objectStore('projects').put({ id: 'e2e', name: 'e2e-proj', handle: root, testPath: '' }); t.oncomplete = () => res(true); t.onerror = () => rej(t.error); }; })`);
      await setSettings({ mode: 'code', projectId: 'e2e' }); await reload();
      checks.badge = (await evaluate(sid, `document.querySelector('#bProject span').textContent`)) === 'e2e-proj';
      await ask('코드 질문');
      const rich = await evaluate(sid, `(() => { const m = [...document.querySelectorAll('.rich-msg')].at(-1); return m && { title: m.querySelector('.rb-h')?.textContent, table: m.querySelectorAll('.rb-table td').length, chart: m.querySelectorAll('.rb-chart rect.bar').length, cites: [...m.querySelectorAll('button.rb-cite')].map((b) => b.textContent), off: [...m.querySelectorAll('.rb-cite.off')].map((b) => b.textContent), follow: document.querySelectorAll('.rb-follow button').length }; })()`);
      await snap('05-code-answer', '.rich-msg');
      checks.rich = !!rich && rich.title === '검색 결과' && rich.table === 2 && rich.chart === 2 && rich.cites.join() === 'api.js:1–3' && /other\.js:1 · 확인 안 됨/.test(rich.off.join()) && rich.follow >= 1;
      const searchOut = await evaluate(sid, `[...document.querySelectorAll('details.tool .out')].map((o) => o.textContent).join(' | ')`);
      checks.noSecret = !searchOut.includes('API_KEY=hidden');
      await ask('글자 도구');
      const xml = await evaluate(sid, `({ out: [...document.querySelectorAll('details.tool .out')].at(-1)?.textContent || '', raw: document.getElementById('messages').textContent.includes('<tool_call>'), ans: [...document.querySelectorAll('.msg.assistant')].at(-1)?.textContent || '' })`);
      checks.textToolCall = /ok-xml/.test(xml.out) && !xml.raw && /글자 도구 결과: ok-xml/.test(xml.ans);
      await ask('깨진 답');
      checks.fallback = /형식 오류/.test(await evaluate(sid, `[...document.querySelectorAll('.rich-msg')].at(-1)?.textContent || ''`));
      await ask('수정해');
      checks.patchCard = (await evaluate(sid, `!!document.querySelector('.rb-patch .rb-actions .primary')`)) && /v1/.test(await fileText('src/api.js'));
      await snap('06-patch', '.rb-patch');
      await evaluate(sid, `[...document.querySelectorAll('.rb-patch .rb-actions .primary')].at(-1).click()`); await sleep(800);
      await snap('07-patch-applied', '.rb-patch');
      checks.applied = /v2/.test(await fileText('src/api.js')) && /적용됨/.test(await evaluate(sid, `[...document.querySelectorAll('.rb-patch')].at(-1).textContent`));
      await ask('다시 수정해');
      await writeFile('src/api.js', 'export const v = "v2 changed";\n');
      await evaluate(sid, `[...document.querySelectorAll('.rb-patch .rb-actions .primary')].at(-1).click()`); await sleep(800);
      checks.stale = (await fileText('src/api.js')).includes('v2 changed') && /파일이 바뀜/.test(await evaluate(sid, `[...document.querySelectorAll('.rb-patch')].at(-1).textContent`));
      await ask('테스트 돌려');
      await snap('08-test-result', '.rb-test');
      checks.tests = /미실행/.test(await evaluate(sid, `[...document.querySelectorAll('.rb-test')].at(-1)?.textContent || ''`));
      await setSettings({ mode: 'screen' }); await reload();
      await ask('진단해');
      const diagOut = await evaluate(sid, `[...document.querySelectorAll('details.tool .out')].at(-1)?.textContent || ''`);
      await evaluate(sid, `(() => { const d = [...document.querySelectorAll('details.tool')].at(-1); if (d) d.open = true; return true; })()`); await snap('09-diagnostics', 'details.tool');
      checks.diag = /HTTP 403 GET http:\/\/127\.0\.0\.1:18080\/api\/orders\?token=\*/.test(diagOut) && !/secret-token|cookie-secret/.test(diagOut);
      checks.audit = (await evaluate(sid, `chrome.storage.local.get('audit').then(({ audit = [] }) => audit.map((a) => a.action).join(','))`)).includes('apply');
      const codeOk = Object.values(checks).every(Boolean);
      console.log('coding:', codeOk ? 'OK' : 'FAIL', JSON.stringify(checks), codeOk ? '' : JSON.stringify({ rich, diagOut: diagOut.slice(0, 300) }));
      ok = ok && codeOk;
    }
    // 7) 자동 전환 + Claude API: 선택 서버가 끊겨 있으면 아래 Claude(가짜 서버)로 넘어가고, Claude 형식 요청·SSE·answer 렌더 확인
    if (ok && !process.env.E2E_BASE_URL) {
      await evaluate(sid, `chrome.storage.local.get('settings').then(({ settings }) => { let c = settings.providers.find((p) => p.kind === 'anthropic'); if (!c) { c = { id: 'claude', label: 'Claude', kind: 'anthropic', model: 'claude-opus-5-5', models: [] }; settings.providers.push(c); } c.baseUrl = 'http://127.0.0.1:${PORT}'; c.apiKey = 'test-key'; const f = settings.providers[0]; f.baseUrl = 'http://127.0.0.1:1/v1'; settings.selected = { providerId: f.id, model: f.model }; settings.mode = 'chat'; return chrome.storage.local.set({ settings }); })`);
      await evaluate(sid, 'location.reload()'); await sleep(1500);
      await evaluate(sid, `document.getElementById('newChat').click()`); await sleep(300);
      await evaluate(sid, `(() => { document.getElementById('input').value = '안녕 클로드'; document.getElementById('send').click(); return true; })()`);
      const seen = { pending: false, think: false, preview: false };
      for (let i = 0; i < 60; i++) {
        await sleep(150);
        const st = await evaluate(sid, `({ p: !!document.querySelector('.msg.pending'), t: [...document.querySelectorAll('details.think.live .tk-last')].some((e) => /살펴보는/.test(e.textContent)), v: document.querySelector('.msg.pending .pd-preview')?.textContent || '', busy: document.getElementById('send').disabled })`);
        seen.pending ||= st.p; seen.think ||= st.t; seen.preview ||= /클로드 응답입니다/.test(st.v);
        if (!st.busy && i > 3) break;
      }
      const after = await evaluate(sid, `({ pending: !!document.querySelector('.msg.pending'), thinkClosed: [...document.querySelectorAll('details.think')].at(-1)?.open === false, thinkLabel: [...document.querySelectorAll('details.think summary')].at(-1)?.textContent })`);
      // 스크롤: 위로 올리면 ↓ 버튼, 누르면 맨 아래
      const scroll = await evaluate(sid, `(async () => { const m = document.getElementById('messages'); const w = (ms) => new Promise((r) => setTimeout(r, ms)); const near = () => m.scrollHeight - m.scrollTop - m.clientHeight < 48; const add = (t) => { const d = document.createElement('div'); d.className = 'msg user'; d.textContent = t; m.append(d); };
        document.getElementById('toBottom').click(); await w(100); // 답변 고정을 풀고 맨 아래 따라가기 상태에서 시작
        for (let i = 0; i < 12; i++) add('긴 대화 ' + i); await w(150); const follow = near() && document.getElementById('toBottom').hidden; // 맨 아래면 자동으로 따라감
        m.dispatchEvent(new WheelEvent('wheel', { deltaY: -500 })); m.scrollTop = 0; await w(150); const shown = !document.getElementById('toBottom').hidden;
        add('위로 올린 동안 새 내용'); await w(150); const kept = m.scrollTop === 0 && !document.getElementById('toBottom').hidden; // 올려 둔 화면은 그대로
        document.getElementById('toBottom').click(); await w(150); const back = near(); add('다시 따라감'); await w(150);
        return { atBottomHidden: follow, shown, kept, back: back && near() }; })()`);
      const ui = await evaluate(sid, `({ info: [...document.querySelectorAll('.msg.info')].at(-1)?.textContent || '', rich: [...document.querySelectorAll('.rich-msg')].at(-1)?.textContent || '', badge: document.getElementById('bModel').textContent, opt: document.getElementById('modelSelect').selectedOptions[0]?.textContent, groups: [...document.querySelectorAll('#modelSelect optgroup')].map((g) => g.label) })`);
      const b = lastClaude?.body || {};
      const live = seen.pending && seen.think && seen.preview && !after.pending && after.thinkClosed && /생각 · \d+초/.test(after.thinkLabel) && scroll.atBottomHidden && scroll.shown && scroll.kept && scroll.back;
      await snap('10-auto-switch', '.msg.info');
      const claudeOk = live && /자동 전환했습니다/.test(ui.info) && /클로드 응답입니다/.test(ui.rich) && ui.badge === 'Claude Opus 5.5' && ui.opt === 'Opus 5.5' && ui.groups.includes('Claude · 더 많은 모델')
        && lastClaude?.headers['x-api-key'] === 'test-key' && lastClaude?.headers['anthropic-version'] === '2023-06-01'
        && typeof b.system === 'string' && b.messages?.[0]?.role === 'user' && b.tools?.some((t) => t.name === 'answer' && t.input_schema) && b.thinking?.type === 'adaptive' && b.stream === true;
      console.log('claude:', claudeOk ? 'OK' : 'FAIL', claudeOk ? '' : JSON.stringify({ seen, after, scroll, ui, headers: lastClaude?.headers, keys: Object.keys(b) }));
      ok = ok && claudeOk;
    }
    // 8) 화면 움직임 측정: 긴 대화 뒤 질문 → 생각 → 긴 답변. 50ms마다 내 질문 위치를 재서 튐(한 번에 80px 넘게 아래로 밀림)과 최종 위치를 본다
    if (ok && !process.env.E2E_BASE_URL) {
      await evaluate(sid, `(() => { const m = document.getElementById('messages'); for (let i = 0; i < 8; i++) { const d = document.createElement('div'); d.className = 'msg user'; d.textContent = '앞선 대화 ' + i + ' — 화면을 채우는 긴 문장입니다. '.repeat(3); m.append(d); } return true; })()`);
      await evaluate(sid, `(() => { document.getElementById('input').value = '긴 답변 해줘'; document.getElementById('send').click(); return true; })()`);
      const track = [];
      for (let i = 0; i < 200; i++) {
        await sleep(50);
        const st = await evaluate(sid, `(() => { const m = document.getElementById('messages'); const u = [...m.querySelectorAll('.msg.user')].at(-1); const top = m.getBoundingClientRect().top; return { u: Math.round(u.getBoundingClientRect().top - top), st: Math.round(m.scrollTop), sh: m.scrollHeight - m.clientHeight, busy: document.getElementById('send').disabled }; })()`);
        track.push(st); if (!st.busy && i > 5) break;
      }
      await sleep(400);
      const fin = await evaluate(sid, `(() => { const m = document.getElementById('messages'); const a = [...m.querySelectorAll('.rich-msg')].at(-1); const top = m.getBoundingClientRect().top; return { answerTop: Math.round(a.getBoundingClientRect().top - top), atBottom: m.scrollHeight - m.scrollTop - m.clientHeight < 48, toBottom: !document.getElementById('toBottom').hidden, view: m.clientHeight, answerH: a.offsetHeight }; })()`);
      // 보낸 직후 0.4초(질문이 위로 올라가는 의도된 부드러운 이동)는 튐 판정에서 제외
      const jumps = []; for (let i = 9; i < track.length; i++) { const d = track[i].u - track[i - 1].u; if (d > 30 || d < -160) jumps.push({ at: i * 50, d }); } // 아래로 밀림(+)은 튐, 50ms 안에 160px 넘게 위로 순간 이동도 튐(부드러운 스크롤은 나눠 움직임)
      const qTop = track.find((t, i) => i > 8)?.u; // 보낸 직후 질문이 화면 위쪽에 있는지
      const placeOk = fin.answerH > fin.view ? fin.answerTop >= 0 && fin.answerTop <= 24 && fin.toBottom : true;
      await snap('11-long-answer');
      await evaluate(sid, `document.getElementById('settingsBtn').click()`); await sleep(300); await snap('12-settings', '#settings fieldset:has(.pbtns)');
      await evaluate(sid, `document.querySelector('#settings .back')?.click()`);
      const scrollOk = jumps.length === 0 && placeOk && qTop != null && qTop <= 24;
      console.log('scroll:', scrollOk ? 'OK' : 'FAIL', JSON.stringify({ jumps, qTop, fin, trail: track.filter((_, i) => i % 6 === 0).map((t) => `${t.u}/${t.st}/${t.sh}`) }));
      ok = ok && scrollOk;
    }
    console.log(ok ? 'E2E PASS' : 'E2E FAIL');
    console.log('assistant:', last);
    if (!ok) {
      console.log('tool outputs:\n', tools.slice(0, 4000)); console.log('pages:', pages);
      console.log('messages html:', (await evaluate(sid, `document.getElementById('messages').innerHTML.slice(0, 500)`)));
      console.log('panel logs:\n' + logs.join('\n').slice(0, 3000));
    }
  } finally {
    chrome.kill(); server.close();
    await new Promise((r) => { chrome.once('exit', r); setTimeout(() => { chrome.kill('SIGKILL'); r(); }, 3000); }); // 창·프로세스가 남지 않게 종료까지 기다림
  }
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('E2E ERROR', e); process.exit(2); });
