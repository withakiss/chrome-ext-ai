import test from 'node:test';
import assert from 'node:assert/strict';
import { readZip, docxText, pptxText, xlsxText, hwpxText, extractDocText, DOC_EXT } from '../extension/lib/docs.js';

// 테스트용 zip(저장 방식 0 = 무압축) 생성: 파서는 0(stored)·8(deflate) 둘 다 처리해야 함
function makeZip(entries) {
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  for (const [name, text] of Object.entries(entries)) {
    const n = enc.encode(name), d = enc.encode(text), crc = crc32(d);
    const local = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0)];
    parts.push(new Uint8Array([...local, ...n, ...d]));
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...n]));
    offset += local.length + n.length + d.length;
  }
  const cd = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cd), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end]; const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0)); let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out.buffer;
}

test('readZip lists stored entries and decodes text', async () => {
  const z = await readZip(makeZip({ 'a/b.xml': '<x>hi</x>', 'c.txt': '안녕' }));
  assert.deepEqual([...z.keys()].sort(), ['a/b.xml', 'c.txt']);
  assert.equal(await z.text('c.txt'), '안녕');
});

test('docx/pptx/xlsx/hwpx text extraction', async () => {
  const docx = makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>첫 문단</w:t></w:r><w:r><w:t xml:space="preserve"> 이어서</w:t></w:r></w:p><w:p><w:r><w:t>둘째</w:t></w:r></w:p></w:body></w:document>' });
  assert.equal(await docxText(await readZip(docx)), '첫 문단 이어서\n둘째');
  const pptx = makeZip({ 'ppt/slides/slide2.xml': '<p:sld><a:t>두번째 슬라이드</a:t></p:sld>', 'ppt/slides/slide1.xml': '<p:sld><a:t>제목</a:t><a:t>부제</a:t></p:sld>' });
  assert.equal(await pptxText(await readZip(pptx)), '[슬라이드 1]\n제목\n부제\n\n[슬라이드 2]\n두번째 슬라이드');
  const xlsx = makeZip({ 'xl/sharedStrings.xml': '<sst><si><t>이름</t></si><si><t>점수</t></si></sst>', 'xl/workbook.xml': '<workbook><sheets><sheet name="성적" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>김</t></is></c><c r="B2"><v>95</v></c></row></sheetData></worksheet>' });
  assert.equal(await xlsxText(await readZip(xlsx)), '[시트 성적]\n이름\t점수\n김\t95');
  const hwpx = makeZip({ 'Contents/section0.xml': '<hs:sec><hp:p><hp:run><hp:t>한글 문서</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>둘째 줄</hp:t></hp:run></hp:p></hs:sec>' });
  assert.equal(await hwpxText(await readZip(hwpx)), '한글 문서\n둘째 줄');
});

test('extractDocText routes by extension and reports unsupported', async () => {
  assert.ok(DOC_EXT.has('hwp') && DOC_EXT.has('pdf'));
  const buf = makeZip({ 'word/document.xml': '<w:p><w:t>x</w:t></w:p>' });
  assert.equal(await extractDocText(buf, 'a.docx'), 'x');
  await assert.rejects(extractDocText(new ArrayBuffer(4), 'a.hwp'), /HWP/);
});
