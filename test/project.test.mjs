import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normPath, listFiles, searchCode, readFile, maskSecrets, createLedger, isSecretName, LIMITS } from '../extension/lib/project.js';

// File System Access 디렉터리 핸들 흉내: { 'a.js': '내용', src: { 'b.ts': '...' } }
export function fakeDir(tree) {
  const file = (name, content) => ({ kind: 'file', name, async getFile() { const b = typeof content === 'string' ? new TextEncoder().encode(content) : content; return { size: b.length, text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; } });
  const dir = (name, t) => ({
    kind: 'directory', name,
    async *entries() { for (const [k, v] of Object.entries(t)) yield [k, typeof v === 'object' && !(v instanceof Uint8Array) ? dir(k, v) : file(k, v)]; },
    async getDirectoryHandle(n) { const v = t[n]; if (v && typeof v === 'object' && !(v instanceof Uint8Array)) return dir(n, v); throw new Error('NotFound'); },
    async getFileHandle(n) { const v = t[n]; if (typeof v === 'string' || v instanceof Uint8Array) return file(n, v); throw new Error('NotFound'); },
  });
  return dir('root', tree);
}

const root = fakeDir({
  'README.md': '# 앱\n설명',
  '.env': 'API_KEY=abc',
  src: { 'search.ts': 'export function search() {\n  return fetch("/api/orders")\n}\n', 'logo.png': new Uint8Array([0, 1, 2]), 'data.txt': new Uint8Array([65, 0, 66]) },
  node_modules: { 'x.js': 'fetch' },
  'big.txt': Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'),
});

test('normPath: 루트 이탈·절대·역슬래시 거부', () => {
  assert.equal(normPath('./src//search.ts/'), 'src/search.ts');
  assert.equal(normPath(''), '');
  for (const p of ['../etc/passwd', 'src/../../x', '/etc/passwd', 'C:/Windows', 'src\\a.js', '~/x']) assert.throws(() => normPath(p), undefined, p);
});

test('listFiles: node_modules·비밀 파일 제외', async () => {
  const { files } = await listFiles(root);
  assert.ok(files.includes('src/search.ts'));
  assert.ok(!files.some((f) => f.startsWith('node_modules') || f === '.env'));
  assert.equal((await listFiles(root, { limit: 2 })).truncated, true);
});

test('searchCode: 줄 번호, 바이너리·제외 폴더 건너뜀', async () => {
  const { hits } = await searchCode(root, { query: 'fetch' });
  assert.deepEqual(hits.map((h) => `${h.path}:${h.line}`), ['src/search.ts:2']);
  assert.equal((await searchCode(root, { query: 'B' , glob: '*.txt' })).hits.every((h) => h.path !== 'src/data.txt'), true);
  assert.equal((await searchCode(root, { query: 'search\\(', regex: true })).hits.length, 1);
});

test('readFile: 줄 범위·상한·비밀/바이너리 거부', async () => {
  const r = await readFile(root, { path: 'src/search.ts', start: 2, end: 2 });
  assert.equal(r.text, '2\t  return fetch("/api/orders")');
  const big = await readFile(root, { path: 'big.txt' });
  assert.equal(big.end - big.start + 1, LIMITS.readLines);
  await assert.rejects(readFile(root, { path: '.env' }), /비밀/);
  await assert.rejects(readFile(root, { path: 'src/logo.png' }), /바이너리/);
  await assert.rejects(readFile(root, { path: 'node_modules/x.js' }), /제외/);
  await assert.rejects(readFile(root, { path: 'nope.js' }), /파일 없음/);
});

test('maskSecrets', () => {
  assert.equal(maskSecrets('password = "hunter22"'), 'password = "[masked]"');
  assert.equal(maskSecrets('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer [masked]');
  assert.equal(maskSecrets('k AKIAABCDEFGHIJKLMNOP'), 'k [masked]');
  assert.match(maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nxx\n-----END RSA PRIVATE KEY-----'), /masked private key/);
  assert.equal(maskSecrets('const tokenizer = 1'), 'const tokenizer = 1');
});

test('ledger·비밀 파일 이름', () => {
  const l = createLedger(); l.add('a', 1, 5); l.add('a', 10, 12);
  assert.deepEqual(l.map.get('a'), [[1, 5], [10, 12]]);
  assert.ok(isSecretName('.env.local') && isSecretName('id_rsa') && !isSecretName('env.ts'));
});
