import test from 'node:test';
import assert from 'node:assert/strict';
import { labelForCode } from '../extension/lib/labels.js';

test('uses leading comment as label', () => {
  assert.equal(labelForCode('// 검색창에 입력\nawait page.locator("e3").fill("맛집")'), '검색창에 입력');
});
test('derives label from API calls in order', () => {
  assert.equal(labelForCode('const s = await snapshot(page, {interactive:true}); console.log(s.tree)'), '스냅샷');
  assert.equal(labelForCode(`await page.locator('e3').fill('맛집'); await page.keyboard.press('Enter'); await sleep(500); const s=await snapshot(page); console.log(s.diff)`), "'맛집' 입력 · Enter · 스냅샷");
  assert.equal(labelForCode(`await page.locator('e7').click(); console.log(await page.title())`), '클릭 · 제목 확인');
  assert.equal(labelForCode(`await page.goto('https://map.kakao.com/'); const t = await openTab('https://a.b')`), 'map.kakao.com 이동 · 새 탭');
});
test('falls back to run_js and truncates', () => {
  assert.equal(labelForCode('const x = 1;'), 'run_js');
  assert.ok(labelForCode(`await page.locator('e1').fill('${'가'.repeat(80)}')`).length <= 60);
});
