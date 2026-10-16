// HWP(구형 바이너리) → 텍스트. rhwp(Rust+WASM, MIT) 동봉본 사용. 브라우저(확장) 전용.
let ready = null;
async function init() {
  ready ||= (async () => {
    if (!globalThis.measureTextWidth) { // rhwp 필수 콜백(조판용). 텍스트 추출엔 정확도가 중요하지 않다.
      let ctx = null;
      globalThis.measureTextWidth = (font, text) => { try { ctx ||= document.createElement('canvas').getContext('2d'); if (font) ctx.font = font; return ctx.measureText(text).width; } catch { return (text || '').length * 8; } };
    }
    const mod = await import('../vendor/rhwp.js');
    await mod.default(new URL('../vendor/rhwp_bg.wasm', import.meta.url));
    return mod;
  })();
  return ready;
}

export async function hwpToText(buffer) {
  const mod = await init();
  const bytes = new Uint8Array(buffer);
  const doc = typeof mod.HwpDocument.open === 'function' ? mod.HwpDocument.open(bytes) : new mod.HwpDocument(bytes);
  try {
    const raw = doc.getTextFileUnicode?.() ?? doc.getTextFileText();
    let text = raw;
    try { const j = JSON.parse(raw); text = typeof j === 'string' ? j : (j.text ?? j.content ?? raw); } catch {}
    return String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  } finally { doc.free?.(); }
}

// 앞쪽 페이지를 SVG로 렌더링해 PNG dataURL로 바꾼다(표·그림 확인용).
export async function hwpPageImages(buffer, maxPages = 3) {
  const mod = await init();
  const doc = new mod.HwpDocument(new Uint8Array(buffer));
  const viewer = new mod.HwpViewer(doc);
  const out = [];
  try {
    const n = Math.min(viewer.pageCount(), maxPages);
    for (let i = 0; i < n; i++) {
      const svg = viewer.renderPageSvg(i);
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; });
      const c = document.createElement('canvas'); c.width = img.naturalWidth || 800; c.height = img.naturalHeight || 1100;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
      out.push(c.toDataURL('image/png'));
    }
  } finally { viewer.free?.(); } // 뷰어가 문서 소유권을 가져가므로 doc.free()는 하지 않는다(이중 해제 → null pointer)
  return out;
}
