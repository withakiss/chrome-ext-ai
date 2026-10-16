import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, DEFAULT_SETTINGS } from '../extension/lib/store.js';

const mem = () => { const d = {}; return { get: async (k) => ({ [k]: d[k] }), set: async (o) => Object.assign(d, o) }; };

test('settings default and roundtrip', async () => {
  const s = createStore(mem());
  const def = await s.getSettings();
  assert.equal(def.providers.length, 6); // vLLM·Ollama·LM Studio·Claude·Chrome 내장·이미지 생성
  assert.equal(def.providers.at(-1).kind, 'image-gen');
  assert.equal(def.visionAssist, true);
  assert.equal(def.providers[0].model, 'openai/gpt-oss-120b');
  assert.equal(DEFAULT_SETTINGS.selected.providerId, 'runpod');
  await s.saveSettings({ ...def, selected: { providerId: 'ollama', model: 'llama3' } });
  assert.equal((await s.getSettings()).selected.model, 'llama3');
});

test('sessions list newest first', async () => {
  const s = createStore(mem());
  const a = await s.newSession({ model: 'm' }); a.createdAt = 1; await s.saveSession(a);
  const b = await s.newSession({ model: 'm' }); b.createdAt = 2; await s.saveSession(b);
  assert.deepEqual((await s.listSessions()).map((x) => x.id), [b.id, a.id]);
  assert.equal((await s.getSession(a.id)).messages.length, 0);
});

test('deleteSession removes one, clearSessions removes all', async () => {
  const s = createStore(mem());
  const a = await s.newSession({ model: 'm' }); const b = await s.newSession({ model: 'm' });
  await s.deleteSession(a.id);
  assert.deepEqual((await s.listSessions()).map((x) => x.id), [b.id]);
  await s.clearSessions();
  assert.deepEqual(await s.listSessions(), []);
});

test('prompt settings defaults', async () => {
  const s = createStore(mem());
  const def = await s.getSettings();
  assert.equal(def.systemPrompt, '');
});

test('일부만 저장된 설정도 기본 provider·선택을 채운다', async () => {
  const { createStore } = await import('../extension/lib/store.js');
  const mem = { settings: { mode: 'code' } };
  const store = createStore({ get: async (k) => ({ [k]: mem[k] }), set: async (o) => Object.assign(mem, o) });
  const s = await store.getSettings();
  assert.ok(s.providers.length >= 4); assert.ok(s.selected.providerId); assert.equal(s.mode, 'code');
});
