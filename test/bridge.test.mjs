import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../extension/lib/bridge.js';
import { KEYS, parseCombo } from '../extension/lib/cdp.js';

function fakes() {
  const calls = [];
  const cdp = {
    attach: async (t) => { calls.push(['attach', t]); if (t === 99) throw new Error('Cannot attach to this target'); },
    detach: async () => {}, click: async (t, p) => calls.push(['click', t, p]), hover: async (t, p) => calls.push(['hover', t, p]),
    insertText: async (t, s) => calls.push(['insertText', t, s]), pressKey: async (t, k) => calls.push(['pressKey', t, k]),
  };
  const tabMsgs = [];
  const sendToTab = async (tabId, msg) => {
    tabMsgs.push([tabId, msg]);
    if (msg.type === 'snapshot') return { tree: 'page "T" http://x\nbutton "OK" [ref=e1]' };
    if (msg.type === 'elementPoint') return msg.ref === 'e9' ? { error: 'unknown ref e9 (take a new snapshot)' } : { x: 10, y: 20, obscured: msg.ref === 'e2' };
    return { ok: true };
  };
  const chrome = {
    tabs: { get: async (id) => ({ id, url: 'http://x', title: 'T' }), update: async () => ({}), create: async () => ({ id: 7 }), remove: async () => {}, query: async () => [{ id: 1, title: 'T', url: 'http://x', active: true }] },
    webNavigation: { onCompleted: { addListener: (f) => setTimeout(() => f({ tabId: 1, frameId: 0 }), 0), removeListener: () => {} } },
  };
  return { calls, tabMsgs, cdpRef: cdp, sendToTabRef: sendToTab, bridge: createBridge({ chrome, cdp, sendToTab }) };
}

test('snapshot returns tree and diff against previous', async () => {
  const { bridge } = fakes();
  const a = await bridge.handle('snapshot', { tabId: 1, interactive: true });
  assert.match(a.tree, /button "OK" \[ref=e1\]/);
  assert.equal(a.diff, '(첫 스냅샷 — tree를 보세요)');
  const b = await bridge.handle('snapshot', { tabId: 1, interactive: true });
  assert.equal(b.diff, '(변경 없음)');
});

test('locator.click attaches, resolves point, dispatches mouse', async () => {
  const { bridge, calls } = fakes();
  await bridge.handle('locator.click', { tabId: 1, ref: 'e1' });
  assert.deepEqual(calls[0], ['attach', 1]);
  assert.deepEqual(calls[1], ['click', 1, { x: 10, y: 20, clickCount: 1 }]);
});

test('obscured target falls back to DOM click', async () => {
  const { bridge, calls, tabMsgs } = fakes();
  await bridge.handle('locator.click', { tabId: 1, ref: 'e2' });
  assert.ok(!calls.some((c) => c[0] === 'click'));
  assert.ok(tabMsgs.some(([, m]) => m.type === 'domClick' && m.ref === 'e2'));
});

test('unknown ref throws with hint', async () => {
  const { bridge } = fakes();
  await assert.rejects(bridge.handle('locator.click', { tabId: 1, ref: 'e9' }), /unknown ref e9/);
});

test('fill clears then inserts text', async () => {
  const { bridge, calls, tabMsgs } = fakes();
  await bridge.handle('locator.fill', { tabId: 1, ref: 'e1', text: 'abc' });
  assert.ok(tabMsgs.some(([, m]) => m.type === 'focusAndClear'));
  assert.deepEqual(calls.at(-1), ['insertText', 1, 'abc']);
});

test('attach failure returns error string', async () => {
  const { bridge } = fakes();
  await assert.rejects(bridge.handle('locator.click', { tabId: 99, ref: 'e1' }), /Cannot attach/);
});

test('page.goto waits for navigation and returns url', async () => {
  const { bridge } = fakes();
  assert.deepEqual(await bridge.handle('page.goto', { tabId: 1, url: 'http://x' }), { url: 'http://x' });
});

test('parseCombo splits modifiers', () => {
  assert.deepEqual(parseCombo('Shift+Tab'), { modifiers: 8, key: KEYS.Tab });
  assert.deepEqual(parseCombo('Enter'), { modifiers: 0, key: KEYS.Enter });
  assert.throws(() => parseCombo('Nope'), /unsupported key/);
});

test('clearTrees resets diff baseline', async () => {
  const { bridge } = fakes();
  await bridge.handle('snapshot', { tabId: 1 });
  bridge.clearTrees();
  assert.equal((await bridge.handle('snapshot', { tabId: 1 })).diff, '(첫 스냅샷 — tree를 보세요)');
});

test('navigation timeout message is Korean', async () => {
  const { bridge } = fakes();
  const chrome = { tabs: { update: async () => ({}), get: async () => ({ url: 'x' }) }, webNavigation: { onCompleted: { addListener: () => {}, removeListener: () => {} } } };
  const b = createBridge({ chrome, cdp: {}, sendToTab: async () => null, navTimeoutMs: 10 });
  await assert.rejects(b.handle('page.goto', { tabId: 1, url: 'x' }), /페이지 로딩 시간 초과/);
});

test('unreachable content script message is Korean', async () => {
  const b = createBridge({ chrome: {}, cdp: {}, sendToTab: async () => null });
  await assert.rejects(b.handle('snapshot', { tabId: 1 }), /content script.*탭을 새로고침/);
});

test('parseCombo: digits use Digit code, Meta+a maps to selectAll command', () => {
  assert.equal(parseCombo('1').key.code, 'Digit1');
  assert.deepEqual(parseCombo('Meta+a').commands, ['selectAll']);
});

test('keyboard.type inserts text into focused element; locator.type clicks first without clearing; paste writes clipboard then Paste command', async () => {
  const f = fakes(); const wrote = [];
  const bridge = createBridge({ chrome: { tabs: {}, webNavigation: {} }, cdp: f.cdpRef, sendToTab: f.sendToTabRef, writeClipboard: async (t) => { wrote.push(t); } });
  const { calls, tabMsgs } = f;
  await bridge.handle('keyboard.type', { tabId: 1, text: 'ab' });
  assert.deepEqual(calls.at(-1), ['insertText', 1, 'ab']);
  await bridge.handle('locator.type', { tabId: 1, ref: 'e1', text: 'cd' });
  assert.ok(!tabMsgs.some(([, m]) => m.type === 'focusAndClear'));
  assert.deepEqual(calls.at(-1), ['insertText', 1, 'cd']);
  await bridge.handle('keyboard.paste', { tabId: 1, text: '본문' });
  assert.deepEqual(wrote, ['본문']);
  assert.deepEqual(calls.at(-1), ['pressKey', 1, 'Meta+v']);
});
