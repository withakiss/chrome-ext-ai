import test from 'node:test';
import assert from 'node:assert/strict';
import { cropRect } from '../extension/lib/vision.js';

test('cropRect converts page rect to captured-image pixels, clamped to viewport', () => {
  const vp = { scrollX: 100, scrollY: 50, width: 800, height: 600, dpr: 2 };
  assert.deepEqual(cropRect({ x: 150, y: 70, w: 100, h: 40 }, vp), { x: 100, y: 40, w: 200, h: 80 });
  // 뷰포트 밖으로 나간 부분은 잘림
  assert.deepEqual(cropRect({ x: 850, y: 600, w: 200, h: 200 }, vp), { x: 1500, y: 1100, w: 100, h: 100 });
  // 완전히 밖이면 null
  assert.equal(cropRect({ x: 0, y: 0, w: 50, h: 20 }, vp), null);
});
