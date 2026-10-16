import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage, IMAGE_TOOL } from '../extension/lib/imagegen.js';

test('generateImage posts OpenAI-compatible request and returns data URL from b64_json', async () => {
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ data: [{ b64_json: 'AAAA' }] }) }; };
  const r = await generateImage({ baseUrl: 'http://h/v1/', apiKey: 'k', model: 'flux', prompt: '고양이', size: '512x512' }, fetch);
  assert.equal(seen.url, 'http://h/v1/images/generations');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(seen.init.body), { model: 'flux', prompt: '고양이', size: '512x512', n: 1, response_format: 'b64_json' });
  assert.equal(r, 'data:image/png;base64,AAAA');
});

test('generateImage accepts url responses and reports HTTP errors', async () => {
  assert.equal(await generateImage({ baseUrl: 'http://h/v1', prompt: 'x' }, async () => ({ ok: true, json: async () => ({ data: [{ url: 'http://img/1.png' }] }) })), 'http://img/1.png');
  await assert.rejects(generateImage({ baseUrl: 'http://h/v1', prompt: 'x' }, async () => ({ ok: false, status: 500, text: async () => 'boom' })), /HTTP 500: boom/);
  await assert.rejects(generateImage({ baseUrl: '', prompt: 'x' }), /이미지 생성 서버 주소/);
});

test('IMAGE_TOOL schema', () => {
  assert.equal(IMAGE_TOOL.function.name, 'generate_image');
  assert.deepEqual(IMAGE_TOOL.function.parameters.required, ['prompt']);
});
