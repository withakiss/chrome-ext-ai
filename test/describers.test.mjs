import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDescriber } from '../extension/lib/describers.js';

test('pickDescriber prefers Nano, then in-browser SmolVLM, else none', () => {
  assert.equal(pickDescriber({ nano: 'available', local: 'ready' }), 'nano');
  assert.equal(pickDescriber({ nano: 'downloadable', local: 'ready' }), 'local');
  assert.equal(pickDescriber({ nano: 'API 없음', local: 'missing' }), null);
  assert.equal(pickDescriber({ nano: 'available', local: 'ready', prefer: 'local' }), 'local');
});
