import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModels, fetchModels, modelsUrl } from '../extension/lib/models.js';

test('normalizeModels per kind', () => {
  assert.deepEqual(normalizeModels('ollama', { models: [{ name: 'llama3:8b' }] }), ['llama3:8b']);
  assert.deepEqual(normalizeModels('openai', { data: [{ id: 'openai/gpt-oss-120b' }] }), ['openai/gpt-oss-120b']);
  assert.deepEqual(normalizeModels('lmstudio', { data: [{ id: 'qwen' }] }), ['qwen']);
});

test('modelsUrl per kind', () => {
  assert.equal(modelsUrl({ kind: 'ollama', baseUrl: 'http://localhost:11434/v1' }), 'http://localhost:11434/api/tags');
  assert.equal(modelsUrl({ kind: 'openai', baseUrl: 'https://h/v1/' }), 'https://h/v1/models');
});

test('fetchModels falls back to manual list on failure', async () => {
  const p = { kind: 'openai', baseUrl: 'http://x/v1', models: ['manual'] };
  assert.deepEqual(await fetchModels(p, async () => { throw new Error('offline'); }), ['manual']);
  assert.deepEqual(await fetchModels(p, async () => ({ ok: true, json: async () => ({ data: [{ id: 'a' }] }) })), ['a']);
});
