import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolBlocks, toInitialPrompts, builtinChatStream, BUILTIN_TOOL_HINT } from '../extension/lib/builtin.js';

test('parseToolBlocks extracts one json code block as run_js call', () => {
  const r = parseToolBlocks('먼저 봅니다.\n```json\n{"tool":"run_js","code":"console.log(1)"}\n```\n');
  assert.equal(r.content.trim(), '먼저 봅니다.');
  assert.deepEqual(r.toolCalls, [{ id: 'b1', name: 'run_js', arguments: JSON.stringify({ code: 'console.log(1)' }) }]);
  assert.deepEqual(parseToolBlocks('그냥 답').toolCalls, []);
  assert.deepEqual(parseToolBlocks('```json\n{"x":1}\n```').toolCalls, []); // code 없는 블록은 도구 아님
});

test('toInitialPrompts maps history: tool outputs and tool_calls become text', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't', function: { name: 'run_js', arguments: '{"code":"1"}' } }] },
    { role: 'tool', tool_call_id: 't', content: 'out' },
    { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
  ];
  const { initialPrompts, last, hasImage } = toInitialPrompts(msgs, true);
  assert.equal(initialPrompts[0].role, 'system');
  assert.match(initialPrompts[0].content, /sys[\s\S]*run_js/);
  assert.match(initialPrompts[2].content, /```json[\s\S]*"code"/);
  assert.match(initialPrompts[3].content, /\[도구 출력\][\s\S]*out/);
  assert.equal(last.length, 2);
  assert.equal(last[1].type, 'image');
  assert.equal(hasImage, true);
});

function fakeLM(chunks, log) {
  return {
    availability: async () => 'available',
    create: async (opts) => { log.create = opts; return { promptStreaming: (parts, o) => { log.parts = parts; return (async function* () { for (const c of chunks) yield c; })(); }, destroy() {} }; },
  };
}

test('builtinChatStream streams deltas and parses tool block', async () => {
  const log = {}; const deltas = [];
  const r = await builtinChatStream({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }], tools: [{}], onDelta: (d) => deltas.push(d.text), LM: fakeLM(['실행', '합니다\n```json\n{"tool":"run_js","code":"1"}\n```'], log) });
  assert.equal(deltas.join(''), '실행합니다\n```json\n{"tool":"run_js","code":"1"}\n```');
  assert.equal(r.content.trim(), '실행합니다');
  assert.equal(r.toolCalls[0].name, 'run_js');
  assert.equal(r.finishReason, 'tool_calls');
  assert.deepEqual(log.parts, [{ role: 'user', content: [{ type: 'text', value: 'go' }] }]);
  assert.match(log.create.initialPrompts[0].content, new RegExp(BUILTIN_TOOL_HINT.slice(0, 10)));
});

test('builtinChatStream handles cumulative chunks and image input', async () => {
  const log = {};
  const r = await builtinChatStream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }], tools: [], onDelta: () => {}, LM: fakeLM(['He', 'Hello'], log), toBlob: async (u) => ({ blob: u }) });
  assert.equal(r.content, 'Hello');
  assert.deepEqual(log.create.expectedInputs.map((i) => i.type).sort(), ['image', 'text']);
  assert.deepEqual(log.parts[0].content[1], { type: 'image', value: { blob: 'data:image/png;base64,AAA' } });
});

test('builtinChatStream throws Korean error when unavailable', async () => {
  await assert.rejects(builtinChatStream({ messages: [{ role: 'user', content: 'x' }], LM: { availability: async () => 'downloadable' } }), /내장 모델.*downloadable/);
  await assert.rejects(builtinChatStream({ messages: [{ role: 'user', content: 'x' }], LM: undefined }), /LanguageModel API 없음/);
});

test('parseToolBlocks handles generate_image blocks', () => {
  const r = parseToolBlocks('그릴게요\n```json\n{"tool":"generate_image","prompt":"a cat","size":"512x512"}\n```');
  assert.deepEqual(r.toolCalls, [{ id: 'b1', name: 'generate_image', arguments: JSON.stringify({ prompt: 'a cat', size: '512x512' }) }]);
});
