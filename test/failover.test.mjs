import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFailoverStream, isConfigured, isFailoverError } from '../extension/lib/failover.js';

const P = [
  { id: 'runpod', label: 'vLLM', kind: 'openai', baseUrl: 'https://down', model: 'gpt' },
  { id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434/v1', model: '' , models: [] },
  { id: 'claude', label: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-opus-5-5' },
  { id: 'img', label: '이미지', kind: 'image-gen', baseUrl: 'x', model: 'sd' },
];

test('설정된 서버 판정', () => {
  assert.equal(isConfigured(P[1]), false); // 모델 없음
  assert.equal(isConfigured({ ...P[2], apiKey: '' }), false); // Claude 키 없음
  assert.equal(isConfigured(P[3]), false); // 이미지 생성은 제외
  assert.equal(isConfigured({ kind: 'builtin' }), true);
});

test('출력 전 404면 아래의 설정된 서버로 넘어가고 계속 그 서버를 쓴다', async () => {
  const calls = []; const switched = [];
  const f = createFailoverStream({ providers: P, startId: 'runpod', model: 'gpt', streamFor: (p) => async (a) => { calls.push(`${p.id}:${a.model}`); if (p.id === 'runpod') throw new Error('HTTP 404: '); return { content: 'ok', toolCalls: [] }; }, onSwitch: (from, to) => switched.push(`${from.id}>${to.id}`) });
  assert.equal((await f.chatStream({})).content, 'ok');
  await f.chatStream({});
  assert.deepEqual(calls, ['runpod:gpt', 'claude:claude-opus-5-5', 'claude:claude-opus-5-5']); // Ollama(모델 없음) 건너뜀, 두 번째부터 바로 Claude
  assert.deepEqual(switched, ['runpod>claude']);
  assert.equal(f.current().provider.id, 'claude');
});

test('출력이 나온 뒤 실패·중지·일반 오류는 넘기지 않는다, 다 실패하면 요약', async () => {
  const mid = createFailoverStream({ providers: P, startId: 'runpod', model: 'gpt', streamFor: () => async (a) => { a.onDelta({ type: 'content', text: 'x' }); throw new Error('HTTP 500'); } });
  await assert.rejects(mid.chatStream({ onDelta: () => {} }), /HTTP 500/);
  const bad = createFailoverStream({ providers: P, startId: 'runpod', model: 'gpt', streamFor: () => async () => { throw new Error('HTTP 400: bad request'); } });
  await assert.rejects(bad.chatStream({}), /HTTP 400/);
  const all = createFailoverStream({ providers: P, startId: 'runpod', model: 'gpt', streamFor: (p) => async () => { throw new Error(p.id === 'runpod' ? 'Failed to fetch' : 'HTTP 401: invalid x-api-key'); } });
  await assert.rejects(all.chatStream({}), /연결 가능한 모델 서버가 없습니다 — vLLM: Failed to fetch \/ Claude: HTTP 401/);
  assert.equal(isFailoverError(Object.assign(new Error('x'), { name: 'AbortError' })), false);
});
