// 비전 보조: 보이는 탭 캡처를 선택 영역만 잘라낸다.
// 페이지 좌표 사각형 → 캡처 이미지 픽셀 사각형(뷰포트 밖은 잘라냄). 겹치는 부분이 없으면 null.
export function cropRect(region, { scrollX, scrollY, width, height, dpr }) {
  const x0 = Math.max(0, region.x - scrollX), y0 = Math.max(0, region.y - scrollY);
  const x1 = Math.min(width, region.x + region.w - scrollX), y1 = Math.min(height, region.y + region.h - scrollY);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: Math.round(x0 * dpr), y: Math.round(y0 * dpr), w: Math.round((x1 - x0) * dpr), h: Math.round((y1 - y0) * dpr) };
}

// DOM 필요(사이드 패널에서만 호출). dataUrl 전체 캡처에서 rect(픽셀)를 잘라 PNG dataUrl로.
export async function cropDataUrl(dataUrl, rect) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const c = document.createElement('canvas'); c.width = rect.w; c.height = rect.h;
  c.getContext('2d').drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return c.toDataURL('image/png');
}
