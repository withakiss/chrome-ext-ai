import test from 'node:test';
import assert from 'node:assert/strict';
import { SAVE_FILE_TOOL, toDataUrl } from '../extension/lib/savefile.js';

test('SAVE_FILE_TOOL schema and toDataUrl encodes utf-8 text', () => {
  assert.equal(SAVE_FILE_TOOL.function.name, 'save_file');
  assert.deepEqual(SAVE_FILE_TOOL.function.parameters.required, ['name', 'content']);
  const url = toDataUrl('맛집\n목록', 'memo.txt');
  assert.match(url, /^data:text\/plain;charset=utf-8;base64,/);
  assert.equal(Buffer.from(url.split(',')[1], 'base64').toString('utf8'), '맛집\n목록');
  assert.match(toDataUrl('{}', 'a.json'), /^data:application\/json/);
  assert.match(toDataUrl('a,b', 'a.csv'), /^data:text\/csv/);
});
