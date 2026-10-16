import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, createAccumulator, chatStream } from '../extension/lib/openai.js';

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

test('parseSSE splits complete events and keeps remainder', () => {
  const { events, rest } = parseSSE('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, 'data: {"c"');
  assert.deepEqual(parseSSE('data: [DONE]\n\n').events, []);
});

test('accumulator separates content and reasoning', () => {
  const acc = createAccumulator();
  const ev = [...acc.push({ choices: [{ delta: { reasoning: 'think' } }] }), ...acc.push({ choices: [{ delta: { content: 'hi' } }] })];
  assert.deepEqual(ev, [{ type: 'reasoning', text: 'think' }, { type: 'content', text: 'hi' }]);
  assert.equal(acc.result().content, 'hi');
  assert.equal(acc.result().reasoning, 'think');
});

test('merges split tool_call arguments', () => {
  const acc = createAccumulator();
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_js', arguments: '{"co' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'de":"1"}' } }] }, finish_reason: 'tool_calls' }] });
  const r = acc.result();
  assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'run_js', arguments: '{"code":"1"}' }]);
  assert.equal(r.finishReason, 'tool_calls');
});

function fakeFetch(body, status = 200) {
  return async (url, init) => ({ ok: status < 400, status, text: async () => body, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), _init: init });
}

test('chatStream streams deltas and returns result', async () => {
  const body = chunk({ content: 'Hel' }) + chunk({ content: 'lo' }, 'stop') + 'data: [DONE]\n\n';
  const deltas = [];
  const r = await chatStream({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetch: fakeFetch(body), onDelta: (d) => deltas.push(d.text) });
  assert.equal(deltas.join(''), 'Hello');
  assert.equal(r.content, 'Hello');
});

test('chatStream throws on http error with body', async () => {
  await assert.rejects(chatStream({ baseUrl: 'http://x/v1', model: 'm', messages: [], fetch: fakeFetch('{"error":"bad key"}', 401) }), /HTTP 401: .*bad key/);
});

test('omits Authorization when apiKey empty', async () => {
  let seen;
  const f = async (u, i) => { seen = i; return fakeFetch(chunk({ content: 'x' }, 'stop'))(u, i); };
  await chatStream({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', messages: [], fetch: f });
  assert.equal(seen.headers.Authorization, undefined);
});

test('parses CRLF-delimited SSE', async () => {
  const body = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const r = await chatStream({ baseUrl: 'http://x/v1', model: 'm', messages: [], fetch: fakeFetch(body) });
  assert.equal(r.content, 'ok');
});

test('글자로 온 도구 호출(Qwen XML·JSON)을 도구 호출로 바꾸고 화면엔 흘리지 않음', async () => {
  const { createAccumulator, parseTextToolCalls } = await import('../extension/lib/openai.js');
  const xml = '페이지를 볼게요.\n<tool_call>\n<function=run_js>\n<parameter=code>\nconst s = await snapshot(page, { interactive: true });\nconsole.log(s.tree.slice(0, 3000));\n</parameter>\n</function>\n</tool_call>';
  const acc = createAccumulator(); const shown = [];
  for (const piece of xml.match(/[\s\S]{1,7}/g)) for (const d of acc.push({ choices: [{ delta: { content: piece } }] })) if (d.type === 'content') shown.push(d.text);
  const r = acc.result();
  assert.equal(shown.join(''), '페이지를 볼게요.\n'); // 도구 글은 조각으로 와도 화면에 안 나감
  assert.equal(r.content, '페이지를 볼게요.');
  assert.equal(r.toolCalls.length, 1); assert.equal(r.toolCalls[0].name, 'run_js');
  assert.equal(JSON.parse(r.toolCalls[0].arguments).code, 'const s = await snapshot(page, { interactive: true });\nconsole.log(s.tree.slice(0, 3000));');
  assert.equal(r.finishReason, 'tool_calls');
  const j = parseTextToolCalls('<tool_call>{"name": "read_file", "arguments": {"path": "a.js", "start": 3}}</tool_call>');
  assert.deepEqual(JSON.parse(j.toolCalls[0].arguments), { path: 'a.js', start: 3 });
  const num = parseTextToolCalls('<function=read_file><parameter=path>a.js</parameter><parameter=start>10</parameter></function>');
  assert.deepEqual(JSON.parse(num.toolCalls[0].arguments), { path: 'a.js', start: 10 }); // 숫자는 숫자로
  assert.equal(parseTextToolCalls('그냥 답입니다. a < b 입니다.').toolCalls.length, 0);
});
