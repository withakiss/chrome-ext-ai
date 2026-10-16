import test from 'node:test';
import assert from 'node:assert/strict';

const detached = [];
globalThis.chrome = { runtime: { lastError: null }, debugger: {
  attach: (t, v, cb) => cb(), detach: (t, cb) => { detached.push(t.tabId); cb(); }, sendCommand: (t, m, p, cb) => cb({}),
} };
const cdp = await import('../extension/lib/cdp.js');

test('detachAll detaches every attached tab, including click-only tabs', async () => {
  await cdp.attach(1); await cdp.attach(2);
  await cdp.detachAll();
  assert.deepEqual(detached.sort(), [1, 2]);
  await cdp.detachAll();
  assert.equal(detached.length, 2);
});
