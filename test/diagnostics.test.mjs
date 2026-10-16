import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, maskUrl, formatDiagnostics } from '../extension/lib/diagnostics.js';

test('maskUrl: 쿼리값·계정 가림', () => {
  assert.equal(maskUrl('https://u:p@x.local/api/orders?token=abc&page=2'), 'https://x.local/api/orders?token=*&page=*');
  assert.equal(maskUrl('not a url?x=1'), 'not a url');
});

test('실패 요청만 기록, 헤더·쿠키 없음', () => {
  const d = createDiagnostics();
  const src = { tabId: 7 };
  d.onEvent(src, 'Network.requestWillBeSent', { requestId: '1', request: { method: 'GET', url: 'https://x/api/orders?sid=s', headers: { Cookie: 'secret' } } });
  d.onEvent(src, 'Network.responseReceived', { requestId: '1', type: 'XHR', response: { status: 403, url: 'https://x/api/orders?sid=s', headers: { 'set-cookie': 'x' } } });
  d.onEvent(src, 'Network.requestWillBeSent', { requestId: '2', request: { method: 'GET', url: 'https://x/ok' } });
  d.onEvent(src, 'Network.responseReceived', { requestId: '2', response: { status: 200, url: 'https://x/ok' } });
  d.onEvent(src, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] });
  d.onEvent(src, 'Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'fine' }] });
  const items = d.get(7);
  assert.equal(items.length, 2);
  assert.deepEqual({ ...items[0], at: 0 }, { kind: 'http', method: 'GET', url: 'https://x/api/orders?sid=*', status: 403, type: 'XHR', at: 0 });
  assert.ok(!JSON.stringify(items).includes('secret'));
  assert.match(formatDiagnostics(items), /HTTP 403 GET https:\/\/x\/api\/orders\?sid=\*/);
});

test('버퍼 상한·빈 결과 안내', () => {
  const d = createDiagnostics({ max: 3 });
  for (let i = 0; i < 5; i++) d.onEvent({ tabId: 1 }, 'Runtime.exceptionThrown', { exceptionDetails: { text: `e${i}` } });
  assert.deepEqual(d.get(1).map((x) => x.message), ['e2', 'e3', 'e4']);
  assert.match(formatDiagnostics([]), /수집된 오류 없음/);
});
