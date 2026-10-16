import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepl, truncateOutput, formatError } from '../extension/lib/repl-core.js';

const mkRpc = (log) => async (call, args) => { log.push([call, args]); if (call === 'snapshot') return { tree: 'page "T"\nbutton "OK" [ref=e1]', diff: '(변경 없음)' }; if (call === 'page.url') return 'http://x'; return { ok: true }; };

test('console output is captured; return is ignored', async () => {
  const repl = createRepl({ rpc: mkRpc([]) });
  const r = await repl.run('console.log("a", 1, {b:2}); return 5;', { tabId: 1 });
  assert.equal(r.error, null);
  assert.equal(r.output, 'a 1 {"b":2}');
});

test('no console output yields placeholder', async () => {
  const r = await createRepl({ rpc: mkRpc([]) }).run('const x = 1;', { tabId: 1 });
  assert.equal(r.output, '(출력 없음 — console.log로 결과를 출력하세요)');
});

test('page.locator(ref).click calls rpc with tabId', async () => {
  const log = [];
  await createRepl({ rpc: mkRpc(log) }).run('await page.locator("e1").click(); console.log(await page.url())', { tabId: 3 });
  assert.deepEqual(log[0], ['locator.click', { tabId: 3, ref: 'e1', dblClick: false }]);
  assert.deepEqual(log[1], ['page.url', { tabId: 3 }]);
});

test('snapshot(page, opts) forwards options', async () => {
  const log = [];
  const r = await createRepl({ rpc: mkRpc(log) }).run('const s = await snapshot(page, {interactive:true}); console.log(s.tree)', { tabId: 1 });
  assert.deepEqual(log[0], ['snapshot', { tabId: 1, interactive: true }]);
  assert.match(r.output, /button "OK"/);
});

test('errors are formatted with message', async () => {
  const r = await createRepl({ rpc: async () => { throw new Error('unknown ref e9'); } }).run('await page.locator("e9").click()', { tabId: 1 });
  assert.match(r.error, /Error: unknown ref e9/);
});

test('syntax error is reported', async () => {
  const r = await createRepl({ rpc: mkRpc([]) }).run('const = 1', { tabId: 1 });
  assert.match(r.error, /SyntaxError/);
});

test('timeout rejects', async () => {
  const r = await createRepl({ rpc: mkRpc([]), timeoutMs: 20 }).run('await sleep(1000)', { tabId: 1 });
  assert.match(r.error, /timeout/);
});

test('truncateOutput and formatError', () => {
  assert.equal(truncateOutput('x'.repeat(10), 5), 'xxxxx\n[출력 5자 초과, 생략]');
  assert.match(formatError(new TypeError('bad')), /^TypeError: bad/);
});

test('console.log prints undefined and circular objects without failing', async () => {
  const r = await createRepl({ rpc: async () => ({}) }).run('const o = {}; o.self = o; console.log(undefined, null, o)', { tabId: 1 });
  assert.equal(r.error, null);
  assert.match(r.output, /^undefined null \[object Object\]/);
});

test('keyboard.type/paste and locator.type map to rpc calls', async () => {
  const log = []; const rpc = async (c, a) => { log.push([c, a]); return { ok: true }; };
  await createRepl({ rpc }).run(`await page.keyboard.type('안녕'); await page.keyboard.paste('본문'); await page.locator('e3').type('x')`, { tabId: 1 });
  assert.deepEqual(log, [['keyboard.type', { tabId: 1, text: '안녕' }], ['keyboard.paste', { tabId: 1, text: '본문' }], ['locator.type', { tabId: 1, ref: 'e3', text: 'x' }]]);
});
