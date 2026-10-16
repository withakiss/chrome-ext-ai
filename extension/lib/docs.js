// 문서 파일 → 텍스트. zip 계열(docx·pptx·xlsx·hwpx)은 내장 DecompressionStream으로 풀고 XML에서 글자만 뽑는다.
// pdf는 vendor/pdf.min.mjs(pdf.js), hwp는 vendor/rhwp(WASM)로 처리(브라우저 전용, 동적 import).
export const DOC_EXT = new Set(['docx', 'pptx', 'xlsx', 'hwpx', 'hwp', 'pdf']);

// ---- zip 읽기(중앙 디렉터리 기준, stored/deflate) ----
export async function readZip(buffer) {
  const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip 형식이 아닙니다(EOCD 없음)');
  const count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  const entries = new Map(); const dec = new TextDecoder();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), loff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, loff });
    p += 46 + nlen + elen + clen;
  }
  const bytes = async (name) => {
    const e = entries.get(name); if (!e) throw new Error(`zip 항목 없음: ${name}`);
    const nlen = dv.getUint16(e.loff + 26, true), elen = dv.getUint16(e.loff + 28, true);
    const start = e.loff + 30 + nlen + elen; const raw = u8.subarray(start, start + e.csize);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`지원하지 않는 zip 압축 방식 ${e.method}`);
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([raw]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  };
  return { keys: () => entries.keys(), has: (n) => entries.has(n), bytes, text: async (n) => dec.decode(await bytes(n)) };
}

// ---- XML 유틸 ----
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
const tagTexts = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => unesc(m[1]));
const numSort = (a, b) => (parseInt(a.match(/(\d+)\.xml$/)?.[1] || 0) - parseInt(b.match(/(\d+)\.xml$/)?.[1] || 0));

export async function docxText(z) {
  const xml = await z.text('word/document.xml');
  return xml.split(/<\/w:p>/).map((p) => tagTexts(p, 'w:t').join('')).filter((s) => s.trim()).join('\n');
}
export async function pptxText(z) {
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort(numSort);
  const out = [];
  for (const s of slides) out.push(`[슬라이드 ${s.match(/(\d+)\.xml$/)[1]}]\n${tagTexts(await z.text(s), 'a:t').join('\n')}`);
  return out.join('\n\n');
}
export async function xlsxText(z) {
  const shared = z.has('xl/sharedStrings.xml') ? [...(await z.text('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => tagTexts(m[1], 't').join('')) : [];
  const names = z.has('xl/workbook.xml') ? [...(await z.text('xl/workbook.xml')).matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unesc(m[1])) : [];
  const sheets = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort(numSort);
  const out = [];
  sheets.forEach((s, i) => out.push(s));
  const res = [];
  for (const [i, s] of sheets.entries()) {
    const xml = await z.text(s);
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => [...r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
      const attrs = c[1], inner = c[2] || '';
      const t = attrs.match(/\bt="([^"]*)"/)?.[1];
      if (t === 's') return shared[+(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? -1)] ?? '';
      if (t === 'inlineStr') return tagTexts(inner, 't').join('');
      return unesc(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '');
    }).join('\t'));
    res.push(`[시트 ${names[i] || i + 1}]\n${rows.join('\n')}`);
  }
  return res.join('\n\n');
}
export async function hwpxText(z) {
  const secs = [...z.keys()].filter((k) => /^Contents\/section\d+\.xml$/.test(k)).sort(numSort);
  const out = [];
  for (const s of secs) out.push((await z.text(s)).split(/<\/hp:p>/).map((p) => tagTexts(p, 'hp:t').join('')).filter((t) => t.trim()).join('\n'));
  return out.join('\n');
}

// ---- 브라우저 전용(동적 import) ----
async function pdfText(buffer) {
  const pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer).slice() }).promise; // 복사본: pdf.js가 원본 버퍼를 워커로 넘겨 분리시킴
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) { const c = await (await doc.getPage(i)).getTextContent(); pages.push(`[${i}쪽]\n${c.items.map((it) => it.str).join(' ').replace(/\s+\n/g, '\n')}`); }
  return pages.join('\n\n');
}
async function hwpText(buffer) {
  if (typeof chrome === 'undefined' || !chrome.runtime) throw new Error('HWP: 브라우저(확장) 안에서만 지원');
  const { hwpToText } = await import('./hwp.js');
  return hwpToText(buffer);
}

// 문서 앞쪽 페이지를 이미지(PNG dataURL)로. pdf·hwp만. 브라우저 전용.
export async function extractDocPages(buffer, name, { maxPages = 3, scale = 1.2 } = {}) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    const pdfjs = await import('../vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer).slice() }).promise;
    const out = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const page = await doc.getPage(i); const vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      out.push(c.toDataURL('image/png'));
    }
    return out;
  }
  if (ext === 'hwp') { const { hwpPageImages } = await import('./hwp.js'); return hwpPageImages(buffer, maxPages); }
  return [];
}

export async function extractDocText(buffer, name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'docx') return docxText(await readZip(buffer));
  if (ext === 'pptx') return pptxText(await readZip(buffer));
  if (ext === 'xlsx') return xlsxText(await readZip(buffer));
  if (ext === 'hwpx') return hwpxText(await readZip(buffer));
  if (ext === 'pdf') return pdfText(buffer);
  if (ext === 'hwp') return hwpText(buffer);
  throw new Error(`지원하지 않는 문서 형식: ${ext}`);
}
