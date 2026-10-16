import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFile, clipText, folderTreeText, buildAttachmentBlocks } from '../extension/lib/attachments.js';

test('classifyFile by mime then extension', () => {
  assert.equal(classifyFile({ name: 'a.png', type: 'image/png' }), 'image');
  assert.equal(classifyFile({ name: 'a.md', type: '' }), 'text');
  assert.equal(classifyFile({ name: 'a.py', type: 'text/x-python' }), 'text');
  assert.equal(classifyFile({ name: 'a.pdf', type: 'application/pdf' }), 'doc');
  assert.equal(classifyFile({ name: '보고서.hwp', type: '' }), 'doc');
  assert.equal(classifyFile({ name: 'a.zip', type: 'application/zip' }), 'other');
  assert.equal(classifyFile({ name: 'noext', type: '' }), 'other');
});

test('clipText keeps text under limit with a note', () => {
  assert.equal(clipText('abc', 10), 'abc');
  assert.equal(clipText('x'.repeat(20), 5), 'xxxxx\n[… 15자 생략]');
});

test('folderTreeText lists up to max entries with sizes', () => {
  const entries = [{ path: 'src/a.js', size: 1200 }, { path: 'README.md', size: 300 }];
  assert.equal(folderTreeText(entries, 10), 'README.md (300 B)\nsrc/a.js (1.2 KB)');
  const many = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, size: 1 }));
  assert.match(folderTreeText(many, 10), /\[… 2개 더 있음\]$/);
});

test('buildAttachmentBlocks composes blocks and enforces total budget', () => {
  const atts = [
    { kind: 'image', name: 'p.png', description: '빨간 버튼이 있는 화면' },
    { kind: 'image', name: 'q.png' },
    { kind: 'text', name: 'memo.md', text: '# 메모\n내용' },
    { kind: 'other', name: 'r.zip', size: 2048 },
    { kind: 'doc', name: 'x.hwp', error: '암호 문서' },
    { kind: 'folder', name: 'proj', entries: [{ path: 'a.js', size: 10 }] },
  ];
  const out = buildAttachmentBlocks(atts);
  assert.match(out, /\[첨부 1: p\.png — 이미지 내용\(.*이 내용으로 답하라\)\]\n빨간 버튼이 있는 화면/);
  assert.match(out, /\[첨부 2: q\.png — 이미지, 내용 읽기 불가\(비전 모델 없음\)\]/);
  assert.match(out, /\[첨부 3: memo\.md\]\n# 메모\n내용/);
  assert.match(out, /\[첨부 4: r\.zip — 2\.0 KB, 내용은 읽지 못함\]/);
  assert.match(out, /\[첨부 5: x\.hwp — 문서 읽기 실패: 암호 문서\]/);
  assert.match(out, /\[첨부 6: 폴더 proj — 1개 항목\]\na\.js \(10 B\)/);
  const big = buildAttachmentBlocks([{ kind: 'text', name: 'a', text: 'x'.repeat(50000) }, { kind: 'text', name: 'b', text: 'y'.repeat(50000) }], 60000);
  assert.ok(big.length < 61000);
  assert.match(big, /생략/);
});

test('countFiles counts files inside folders', async () => {
  const { countFiles } = await import('../extension/lib/attachments.js');
  assert.equal(countFiles([{ kind: 'image' }, { kind: 'folder', entries: [{}, {}, {}] }, { kind: 'text' }]), 5);
  assert.equal(countFiles([]), 0);
});

test('doc attachment appends page image notes after the text', async () => {
  const { buildAttachmentBlocks } = await import('../extension/lib/attachments.js');
  const out = buildAttachmentBlocks([{ kind: 'doc', name: 'r.pdf', text: '본문', pageNotes: ['1쪽: 표와 로고', '2쪽: 그래프'] }]);
  assert.match(out, /\[첨부 1: r\.pdf\]\n본문\n\n\[페이지 이미지 설명 — 비전 보조 모델\]\n1쪽: 표와 로고\n2쪽: 그래프/);
});
