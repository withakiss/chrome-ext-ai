import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdits, unifiedDiff, createPatchStore, sha256 } from '../extension/lib/patch.js';

// 쓰기까지 되는 가짜 디렉터리 핸들
function memDir(tree) {
  const dir = (t) => ({
    kind: 'directory',
    async *entries() { for (const [k, v] of Object.entries(t)) yield [k, typeof v === 'object' ? dir(v) : file(t, k)]; },
    async getDirectoryHandle(n, o) { if (typeof t[n] !== 'object') { if (!o?.create) throw new Error('NotFound'); t[n] = {}; } return dir(t[n]); },
    async getFileHandle(n, o) { if (typeof t[n] !== 'string') { if (!o?.create) throw new Error('NotFound'); t[n] = ''; } return file(t, n); },
  });
  const file = (t, n) => ({ kind: 'file', async getFile() { const b = new TextEncoder().encode(t[n]); return { size: b.length, text: async () => t[n], arrayBuffer: async () => b.buffer }; }, async createWritable() { let buf = ''; return { write: async (x) => { buf += x; }, close: async () => { t[n] = buf; } }; } });
  return dir(tree);
}

test('applyEdits: 정확히 1회 일치만', () => {
  assert.equal(applyEdits('a\nb\nc', [{ oldText: 'b', newText: 'B' }]), 'a\nB\nc');
  assert.throws(() => applyEdits('a\nb', [{ oldText: 'zz', newText: '' }]), /0번/);
  assert.throws(() => applyEdits('x x', [{ oldText: 'x', newText: 'y' }]), /2번/);
  assert.equal(applyEdits('', [{ oldText: '', newText: 'new' }]), 'new');
  assert.equal(applyEdits('a$b', [{ oldText: '$', newText: '$&' }]), 'a$&b'); // 치환 패턴 해석 안 함
});

test('unifiedDiff 형식과 증감 수', () => {
  const { diff, add, del } = unifiedDiff('1\n2\n3\n4\n5\n6\n7\n8\n9', '1\n2\n3\n4\nX\n6\n7\n8\n9', 'f.js');
  assert.equal(add, 1); assert.equal(del, 1);
  assert.equal(diff, ['--- a/f.js', '+++ b/f.js', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+X', ' 6', ' 7', ' 8'].join('\n'));
  assert.match(unifiedDiff('', 'a\nb', 'n.js').diff, /@@ -0,0 \+1,2 @@/);
});

test('제안은 파일을 안 바꾸고, 승인 적용 후 바뀜', async () => {
  const t = { src: { 'a.js': 'const x = 1;\n' } };
  const root = memDir(t); const log = [];
  const store = createPatchStore({ newId: () => 'P1', audit: (e) => log.push(e.action) });
  const p = await store.propose(root, 'proj', { reason: 'r', edits: [{ path: 'src/a.js', oldText: '1', newText: '2' }] });
  assert.equal(p.id, 'P1'); assert.equal(t.src['a.js'], 'const x = 1;\n');
  assert.equal(p.files[0].baseHash, await sha256('const x = 1;\n'));
  await store.apply(root, 'P1');
  assert.equal(t.src['a.js'], 'const x = 2;\n');
  assert.equal(store.get('P1').state, 'applied');
  await assert.rejects(store.apply(root, 'P1'), /상태/); // 같은 승인 재사용 불가
  assert.deepEqual(log, ['propose', 'apply']);
});

test('파일이 바뀌면 옛 승인은 stale, 아무것도 안 씀', async () => {
  const t = { 'a.js': 'v1' }; const root = memDir(t);
  const store = createPatchStore({ newId: () => 'P' });
  await store.propose(root, 'p', { edits: [{ path: 'a.js', oldText: 'v1', newText: 'v2' }] });
  t['a.js'] = 'v1 edited';
  const r = await store.apply(root, 'P');
  assert.equal(r.state, 'stale'); assert.equal(t['a.js'], 'v1 edited');
});

test('되돌리기: 적용 직후 내용일 때만', async () => {
  const t = { 'a.js': 'old' }; const root = memDir(t);
  let n = 0; const store = createPatchStore({ newId: () => `P${++n}` });
  await store.propose(root, 'p', { edits: [{ path: 'a.js', oldText: 'old', newText: 'new' }] });
  await store.apply(root, 'P1'); await store.undo(root, 'P1');
  assert.equal(t['a.js'], 'old');
  await store.propose(root, 'p', { edits: [{ path: 'a.js', oldText: 'old', newText: 'new' }] });
  await store.apply(root, 'P2'); t['a.js'] = 'new + 사람 수정';
  await assert.rejects(store.undo(root, 'P2'), /바뀌어/);
});

test('새 파일 생성·비밀 파일 수정 거부·없는 파일', async () => {
  const t = {}; const root = memDir(t);
  const store = createPatchStore({ newId: () => 'N' });
  await store.propose(root, 'p', { edits: [{ path: 'dir/new.js', oldText: '', newText: 'hi' }] });
  await store.apply(root, 'N'); assert.equal(t.dir['new.js'], 'hi');
  await assert.rejects(store.propose(root, 'p', { edits: [{ path: '.env', oldText: '', newText: 'x' }] }), /수정할 수 없는/);
  await assert.rejects(store.propose(root, 'p', { edits: [{ path: 'nope.js', oldText: 'a', newText: 'b' }] }), /파일 없음/);
  await assert.rejects(store.propose(root, 'p', { edits: [{ path: '../x.js', oldText: '', newText: 'b' }] }), /루트 밖/);
});
