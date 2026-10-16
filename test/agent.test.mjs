import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, compactOldToolOutputs, compactAttachments } from '../extension/lib/agent.js';
globalThis.__agent = { compactAttachments };

const scripted = (steps) => { let i = 0; return async ({ onDelta }) => { const s = steps[i++]; for (const t of s.content || []) onDelta({ type: 'content', text: t }); return { content: (s.content || []).join(''), reasoning: '', toolCalls: s.toolCalls || [], finishReason: s.toolCalls ? 'tool_calls' : 'stop' }; }; };

test('runs tool calls until model stops', async () => {
  const events = [];
  const messages = [{ role: 'user', content: 'go' }];
  const ran = [];
  await runAgent({ messages, provider: { baseUrl: 'x' }, model: 'm', onEvent: (e) => events.push(e),
    runJs: async (code) => { ran.push(code); return 'out1'; },
    chatStream: scripted([{ toolCalls: [{ id: 't1', name: 'run_js', arguments: '{"code":"console.log(1)"}' }] }, { content: ['done'] }]) });
  assert.deepEqual(ran, ['console.log(1)']);
  assert.equal(messages.at(-1).content, 'done');
  assert.equal(messages.find((m) => m.role === 'tool').content, 'out1');
  assert.equal(events.at(-1).type, 'done');
});

test('stops after maxTools with error event', async () => {
  const events = [];
  const loop = { toolCalls: [{ id: 't', name: 'run_js', arguments: '{"code":"1"}' }] };
  await runAgent({ messages: [{ role: 'user', content: 'x' }], provider: {}, model: 'm', maxTools: 2, onEvent: (e) => events.push(e), runJs: async () => 'o', chatStream: scripted([loop, loop, loop, loop]) });
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 2);
  assert.match(events.at(-1).message, /도구 호출 한도/);
});

test('http error ends loop with error event', async () => {
  const events = [];
  await runAgent({ messages: [{ role: 'user', content: 'x' }], provider: {}, model: 'm', onEvent: (e) => events.push(e), runJs: async () => '', chatStream: async () => { throw new Error('HTTP 401: nope'); } });
  assert.equal(events.at(-1).type, 'error'); assert.match(events.at(-1).message, /API 키가 틀렸거나 없습니다[\s\S]*HTTP 401: nope/); // 안내 + 원문
});

test('invalid tool arguments are reported back to the model', async () => {
  const messages = [{ role: 'user', content: 'x' }];
  await runAgent({ messages, provider: {}, model: 'm', onEvent: () => {}, runJs: async () => 'never',
    chatStream: scripted([{ toolCalls: [{ id: 't', name: 'run_js', arguments: '{bad' }] }, { content: ['ok'] }]) });
  assert.match(messages.find((m) => m.role === 'tool').content, /arguments JSON 파싱 실패/);
});

test('compactOldToolOutputs keeps recent turns', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', tool_call_id: `t${i}`, content: `out${i}` });
  compactOldToolOutputs(msgs, 8);
  assert.equal(msgs[1].content, '[이전 출력 생략]');
  assert.equal(msgs[3].content, '[이전 출력 생략]');
  assert.equal(msgs[5].content, 'out2');
});

test('abort during tool run ends with 중지됨 and no further model call', async () => {
  const events = []; let calls = 0;
  const ac = new AbortController();
  await runAgent({ messages: [{ role: 'user', content: 'x' }], provider: {}, model: 'm', signal: ac.signal, onEvent: (e) => events.push(e),
    runJs: async () => { ac.abort(); return '중지됨'; },
    chatStream: (o) => { calls++; return scripted([{ toolCalls: [{ id: 't', name: 'run_js', arguments: '{"code":"1"}' }] }, { content: ['never'] }])(o); } });
  assert.equal(calls, 1);
  assert.deepEqual(events.at(-1), { type: 'error', message: '중지됨' });
});

test('limit exceeded still pairs every tool_call with a tool message', async () => {
  const messages = [{ role: 'user', content: 'x' }];
  const loop = { toolCalls: [{ id: 'a', name: 'run_js', arguments: '{"code":"1"}' }, { id: 'b', name: 'run_js', arguments: '{"code":"2"}' }] };
  await runAgent({ messages, provider: {}, model: 'm', maxTools: 1, onEvent: () => {}, runJs: async () => 'o', chatStream: scripted([loop, loop]) });
  const calls = messages.flatMap((m) => m.tool_calls || []).map((c) => c.id);
  const tools = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(tools, calls);
  assert.match(messages.at(-1).content, /한도/);
});

test('compactOldToolOutputs also enforces a character budget', () => {
  const msgs = [{ role: 'user', content: 'q' }];
  for (let i = 0; i < 4; i++) msgs.push({ role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', tool_call_id: `t${i}`, content: 'x'.repeat(30000) });
  compactOldToolOutputs(msgs, 8, 70000);
  assert.equal(msgs[2].content, '[이전 출력 생략]');
  assert.equal(msgs[4].content, '[이전 출력 생략]');
  assert.equal(msgs[6].content.length, 30000);
  assert.equal(msgs[8].content.length, 30000);
});

test('fetch failure becomes a Korean connection error with baseUrl', async () => {
  const events = [];
  await runAgent({ messages: [{ role: 'user', content: 'x' }], provider: { baseUrl: 'http://h/v1' }, model: 'm', onEvent: (e) => events.push(e), runJs: async () => '', chatStream: async () => { throw new TypeError('Failed to fetch'); } });
  assert.match(events.at(-1).message, /모델 서버에 연결할 수 없습니다.*http:\/\/h\/v1/);
});

test('routes non-run_js tools through runTool and keeps images out of the transcript', async () => {
  const messages = [{ role: 'user', content: '고양이 그려줘' }];
  const events = [];
  await runAgent({ messages, provider: {}, model: 'm', onEvent: (e) => events.push(e),
    runJs: async () => 'never', runTool: async (name, args) => ({ output: `이미지 생성 완료 (${args.size || '1024x1024'})`, image: 'data:image/png;base64,AAAA' }),
    chatStream: scripted([{ toolCalls: [{ id: 'g1', name: 'generate_image', arguments: '{"prompt":"고양이"}' }] }, { content: ['다 그렸어요'] }]) });
  const tool = messages.find((m) => m.role === 'tool');
  assert.equal(tool.content, '이미지 생성 완료 (1024x1024)');
  assert.ok(!JSON.stringify(messages).includes('base64,AAAA'));
  const out = events.find((e) => e.type === 'tool_output');
  assert.equal(out.image, 'data:image/png;base64,AAAA');
  assert.deepEqual(events.find((e) => e.type === 'tool_call').args, { prompt: '고양이' });
});

test('context-length 400 triggers aggressive compaction and one retry', async () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: '[첨부 1: a.md]\n' + 'x'.repeat(30000) + '\n\n요약해' }, { role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', tool_call_id: 't0', content: 'y'.repeat(30000) }, { role: 'user', content: '다음' }];
  let calls = 0; const events = [];
  await runAgent({ messages, provider: {}, model: 'm', onEvent: (e) => events.push(e), runJs: async () => '',
    chatStream: async ({ messages: m, onDelta }) => { calls++; if (calls === 1) throw new Error("HTTP 400: {\"error\":{\"message\":\"Input length (33054) exceeds model's maximum context length (32768).\"}}"); onDelta({ type: 'content', text: 'ok' }); return { content: 'ok', reasoning: '', toolCalls: [], finishReason: 'stop' }; } });
  assert.equal(calls, 2);
  assert.equal(events.at(-1).type, 'done');
  assert.ok(messages[1].content.length < 1000, '옛 첨부 블록이 접혀야 함');
  assert.equal(messages[3].content, '[이전 출력 생략]');
  assert.equal(messages[4].content, '다음');
});

test('compactAttachments shortens old user attachment blocks but keeps the question', () => {
  const { compactAttachments } = awaitImport();
  const msgs = [{ role: 'user', content: '[화면 선택 영역 — x]\ntree\n\n[첨부 1: a.md]\nbody\n\n질문1' }, { role: 'assistant', content: 'a' }, { role: 'user', content: '[첨부 1: b.md]\nbody\n\n질문2' }];
  compactAttachments(msgs, 1);
  assert.equal(msgs[0].content, '[이전 첨부·선택 영역 생략]\n\n질문1');
  assert.match(msgs[2].content, /body/);
});
function awaitImport() { return globalThis.__agent; }

test('tool results may carry a file (kept out of transcript, passed in event)', async () => {
  const messages = [{ role: 'user', content: 'txt로 저장' }];
  const events = [];
  await runAgent({ messages, provider: {}, model: 'm', onEvent: (e) => events.push(e), runJs: async () => '',
    runTool: async (name, args) => ({ output: `저장 준비: ${args.name}`, file: { name: args.name, dataUrl: 'data:text/plain;base64,QQ==' } }),
    chatStream: scripted([{ toolCalls: [{ id: 's1', name: 'save_file', arguments: '{"name":"a.txt","content":"A"}' }] }, { content: ['저장했어요'] }]) });
  const out = events.find((e) => e.type === 'tool_output');
  assert.deepEqual(out.file, { name: 'a.txt', dataUrl: 'data:text/plain;base64,QQ==' });
  assert.ok(!JSON.stringify(messages).includes('QQ=='));
});

test('runTool이 final을 돌려주면 루프 종료(추가 모델 호출 없음)', async () => {
  const { runAgent } = await import('../extension/lib/agent.js');
  let calls = 0; const events = [];
  const chatStream = async () => { calls++; return { content: '', reasoning: '', toolCalls: [{ id: 'a1', name: 'answer', arguments: '{"summary":"끝","blocks":[]}' }] }; };
  const messages = [{ role: 'user', content: 'q' }];
  await runAgent({ messages, provider: { baseUrl: 'x' }, model: 'm', runJs: async () => '', runTool: async () => ({ output: '표시됨', final: true }), chatStream, onEvent: (e) => events.push(e.type) });
  assert.equal(calls, 1);
  assert.equal(events.at(-1), 'done');
  assert.equal(messages.at(-1).role, 'tool');
});

test('404·401 오류는 어느 서버인지와 할 일을 알려 준다', async () => {
  const { runAgent } = await import('../extension/lib/agent.js');
  for (const [err, re] of [['HTTP 404: ', /vLLM\(https:\/\/x\)가 404.*다른 서버/], ['HTTP 401: invalid x-api-key', /Claude API 키가 틀렸거나/]]) {
    const ev = [];
    const label = err.includes('401') ? 'Claude' : 'vLLM';
    await runAgent({ messages: [{ role: 'user', content: 'q' }], provider: { label, baseUrl: 'https://x' }, model: 'm', runJs: async () => '', chatStream: async () => { throw new Error(err); }, onEvent: (e) => ev.push(e) });
    assert.match(ev.at(-1).message, re);
  }
});
