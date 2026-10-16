import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResponse, verifyCitations, ANSWER_TOOL, fallbackText } from '../extension/lib/response.js';

test('정상 응답: 블록·인용·후속 질문 통과', () => {
  const r = validateResponse({ summary: '결론', blocks: [{ type: 'markdown', text: '본문' }, { type: 'table', columns: ['a', 'b'], rows: [['1', '2', '3']] }], citations: [{ path: 'a.js', startLine: 1, endLine: 3 }], followups: ['더 보기'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.blocks[1].rows, [['1', '2']]); // 열 수보다 많은 셀은 자름
  assert.equal(r.value.citations.length, 1);
});

test('문자열 JSON 파싱, 깨진 JSON은 ok=false', () => {
  assert.equal(validateResponse('{"summary":"x","blocks":[]}').ok, true);
  const bad = validateResponse('{"summary":');
  assert.equal(bad.ok, false); assert.match(bad.warnings[0], /JSON/);
});

test('모르는 블록·잘못된 블록은 버리고 경고', () => {
  const r = validateResponse({ summary: 's', blocks: [{ type: 'html', html: '<script>' }, { type: 'markdown' }, { type: 'callout', tone: 'x', text: 't' }] });
  assert.equal(r.value.blocks.length, 1);
  assert.equal(r.value.blocks[0].tone, 'info');
  assert.equal(r.warnings.length, 2);
});

test('과도한 길이·개수 제한', () => {
  const r = validateResponse({ summary: 'x'.repeat(5000), blocks: Array.from({ length: 50 }, () => ({ type: 'markdown', text: 'a' })), followups: ['1', '2', '3', '4', '5', 'y'.repeat(200)] });
  assert.equal(r.value.summary.length, 1200);
  assert.equal(r.value.blocks.length, 30);
  assert.equal(r.value.followups.length, 4);
  assert.equal(validateResponse({ summary: 's', blocks: [{ type: 'markdown', text: 'a'.repeat(13000) }] }).value.blocks.length, 0);
});

test('중첩 깊이 2 초과 차단', () => {
  const deep = { type: 'card', title: '1', blocks: [{ type: 'card', title: '2', blocks: [{ type: 'card', title: '3', blocks: [{ type: 'markdown', text: 'x' }] }] }] };
  const r = validateResponse({ summary: 's', blocks: [deep] });
  assert.ok(r.warnings.some((w) => /중첩/.test(w)));
  const two = validateResponse({ summary: 's', blocks: [{ type: 'tabs', tabs: [{ label: 'A', blocks: [{ type: 'card', title: 'c', blocks: [{ type: 'markdown', text: 'x' }] }] }] }] });
  assert.equal(two.value.blocks[0].tabs[0].blocks[0].type, 'card'); // 2단계까지는 허용
});

test('diff·image는 발급된 ID만', () => {
  const ctx = { patches: new Set(['p1']), images: new Set(['i1']) };
  const r = validateResponse({ summary: 's', blocks: [{ type: 'diff', patchId: 'p1' }, { type: 'diff', patchId: 'fake' }, { type: 'image', imageId: 'i1' }, { type: 'image', imageId: 'http://x' }] }, ctx);
  assert.deepEqual(r.value.blocks.map((b) => b.type), ['diff', 'image']);
});

test('chart 숫자 검증, diagram 없는 노드 연결 제거', () => {
  assert.equal(validateResponse({ summary: 's', blocks: [{ type: 'chart', labels: ['a'], values: ['x'] }] }).value.blocks.length, 0);
  const d = validateResponse({ summary: 's', blocks: [{ type: 'diagram', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'zz' }] }] }).value.blocks[0];
  assert.equal(d.edges.length, 1);
});

test('인용: endLine < startLine 제외, 읽지 않은 범위는 verified=false', () => {
  const r = validateResponse({ summary: 's', blocks: [], citations: [{ path: 'a', startLine: 5, endLine: 2 }, { path: 'a', startLine: 2, endLine: 4 }, { path: 'b', startLine: 1, endLine: 1 }] });
  assert.equal(r.value.citations.length, 2);
  const v = verifyCitations(r.value.citations, new Map([['a', [[1, 10]]]]));
  assert.deepEqual(v.map((c) => c.verified), [true, false]);
});

test('도구 정의와 대체 텍스트', () => {
  assert.equal(ANSWER_TOOL.function.name, 'answer');
  assert.equal(fallbackText({ summary: '요약' }), '요약');
  assert.equal(fallbackText('원문'), '원문');
});
