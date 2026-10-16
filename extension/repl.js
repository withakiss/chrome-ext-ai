// 샌드박스 페이지. 부모(사이드 패널)와 postMessage로 run/result, rpc/rpc-result 를 주고받는다.
import { createRepl } from './lib/repl-core.js';

const pending = new Map();
let seq = 0;
const rpc = (call, args) => new Promise((res, rej) => {
  const id = `r${++seq}`;
  pending.set(id, { res, rej });
  window.parent.postMessage({ type: 'rpc', id, call, args }, '*');
});
const repl = createRepl({ rpc });

window.addEventListener('message', async (e) => {
  if (e.source !== window.parent) return;
  const m = e.data || {};
  if (m.type === 'rpc-result') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.res(m.value) : p.rej(new Error(m.error)); return; }
  if (m.type === 'run') { const r = await repl.run(m.code, { tabId: m.tabId }); window.parent.postMessage({ type: 'result', id: m.id, ...r }, '*'); }
});
