import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClaudeMessages, toClaudeTools, buildRequest, createClaudeAccumulator, echoBlocks, claudeChatStream } from '../extension/lib/claude.js';
import { authHeaders, modelsUrl } from '../extension/lib/models.js';

const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('OpenAI 형식 → Claude 형식: system 분리, 병렬 도구 결과는 user 하나로, 원본 블록 우선', () => {
  const { system, messages } = toClaudeMessages([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '보자', tool_calls: [tc('t1', 'search_code', { query: 'a' }), tc('t2', 'read_file', { path: 'b' })] },
    { role: 'tool', tool_call_id: 't1', content: 'r1' }, { role: 'tool', tool_call_id: 't2', content: '' },
    { role: 'assistant', content: 'x', raw: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'x' }] },
    { role: 'user', content: [{ type: 'text', text: '이미지' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
  ]);
  assert.equal(system, 'S');
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(messages[1].content.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
  assert.deepEqual(messages[1].content[1].input, { query: 'a' });
  assert.equal(messages[2].content.length, 2); assert.equal(messages[2].content[1].content, '(출력 없음)');
  assert.equal(messages[3].content[0].signature, 'sig'); // 생각 블록 서명 그대로
  assert.deepEqual(messages[4].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } });
});

test('거절 대체 턴 되돌려 보내기: 마지막 fallback 앞의 생각·도구 호출 제거', () => {
  const raw = [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'a' }, { type: 'tool_use', id: 'x' }, { type: 'fallback' }, { type: 'text', text: 'b' }];
  assert.deepEqual(echoBlocks(raw).map((b) => b.type), ['text', 'text']); // fallback 표시 블록은 무시 대상이라 뺀다
});

test('요청: 도구 변환, 모델별 생각·effort·거절 대체', () => {
  const tools = [{ type: 'function', function: { name: 'run_js', description: 'd', parameters: { type: 'object', properties: { code: { type: 'string' } } } } }];
  assert.deepEqual(toClaudeTools(tools)[0], { name: 'run_js', description: 'd', input_schema: tools[0].function.parameters, eager_input_streaming: true });
  const a = buildRequest({ baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'q' }], tools });
  assert.equal(a.body.thinking.block_binding.prefix_mismatch_behavior, 'drop_block');
  assert.equal(a.body.fallbacks, 'default');
  assert.deepEqual(a.betas, ['thinking-binding-controls-2026-08-01', 'server-side-fallback-2026-07-01']);
  const h = buildRequest({ baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(h.body.thinking, undefined); assert.equal(h.body.output_config, undefined); assert.equal(h.body.fallbacks, undefined);
  assert.equal(buildRequest({ baseUrl: 'http://proxy.local', model: 'claude-opus-5-5', messages: [] }).body.fallbacks, undefined); // 프록시엔 거절 대체 안 보냄
});

const sseOf = (evs) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const start = (index, content_block) => ({ type: 'content_block_start', index, content_block });
const delta = (index, d) => ({ type: 'content_block_delta', index, delta: d });

test('스트림 누적: 텍스트·생각·서명·도구 입력', () => {
  const acc = createClaudeAccumulator(); const out = [];
  for (const ev of [start(0, { type: 'thinking', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: '생각' }), delta(0, { type: 'signature_delta', signature: 'S' }),
    start(1, { type: 'text', text: '' }), delta(1, { type: 'text_delta', text: '안녕' }),
    start(2, { type: 'tool_use', id: 'tu1', name: 'search_code', input: {} }), delta(2, { type: 'input_json_delta', partial_json: '{"query":' }), delta(2, { type: 'input_json_delta', partial_json: '"fetch"}' }),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }]) out.push(...acc.push(ev));
  const r = acc.result();
  assert.deepEqual(out, [{ type: 'reasoning', text: '생각' }, { type: 'content', text: '안녕' }, { type: 'tool_input', name: 'search_code', text: '{"query":' }, { type: 'tool_input', name: 'search_code', text: '{"query":"fetch"}' }]); // 도구 입력은 누적 텍스트로
  assert.equal(r.content, '안녕'); assert.equal(r.reasoning, '생각');
  assert.deepEqual(r.toolCalls, [{ id: 'tu1', name: 'search_code', arguments: '{"query":"fetch"}' }]);
  assert.deepEqual(r.raw[0], { type: 'thinking', thinking: '생각', signature: 'S' });
  assert.deepEqual(r.raw[2], { type: 'tool_use', id: 'tu1', name: 'search_code', input: { query: 'fetch' } });
});

test('출력 한도·거절이면 도구를 실행하지 않고 원본에서도 뺌, 오류 이벤트는 throw', () => {
  const acc = createClaudeAccumulator();
  acc.push(start(0, { type: 'tool_use', id: 't', name: 'save_file', input: {} })); acc.push(delta(0, { type: 'input_json_delta', partial_json: '{"name":"a' }));
  acc.push({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } });
  const r = acc.result(); assert.equal(r.toolCalls.length, 0); assert.equal(r.raw.length, 0); assert.match(r.content, /잘렸습니다/);
  const ref = createClaudeAccumulator(); ref.push({ type: 'message_delta', delta: { stop_reason: 'refusal' } }); assert.match(ref.result().content, /거절/);
  assert.throws(() => createClaudeAccumulator().push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), /Overloaded/);
});

test('claudeChatStream: 헤더·본문 전송과 스트림 파싱(가짜 fetch)', async () => {
  let sent;
  const fetch = async (url, init) => { sent = { url, init }; const body = sseOf([start(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: '네' }), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]); return { ok: true, body: new Response(body).body }; };
  const r = await claudeChatStream({ apiKey: 'k', model: 'claude-sonnet-5-5', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'q' }], fetch });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['x-api-key'], 'k'); assert.equal(sent.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(sent.init.body).system, 'S');
  assert.equal(r.content, '네'); assert.equal(r.finishReason, 'end_turn');
  await assert.rejects(claudeChatStream({ model: 'x', messages: [] }), /API 키/);
  await assert.rejects(claudeChatStream({ apiKey: 'k', model: 'x', messages: [], fetch: async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"invalid x-api-key"}}' }) }), /401: invalid x-api-key/);
});

test('모델 목록 주소·인증 헤더', () => {
  assert.equal(modelsUrl({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/' }), 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(authHeaders({ kind: 'anthropic', apiKey: 'k' })['x-api-key'], 'k');
  assert.deepEqual(authHeaders({ kind: 'openai', apiKey: 'k' }), { Authorization: 'Bearer k' });
});
