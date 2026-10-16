import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../extension/lib/markdown.js';

test('escapes html and renders bold, headings, lists', () => {
  const h = renderMarkdown('## 제목\n**굵게** <b>x</b>\n- 하나\n- 둘\n1. 셋');
  assert.match(h, /<h2>제목<\/h2>/);
  assert.match(h, /<strong>굵게<\/strong> &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(h, /<ul><li>하나<\/li><li>둘<\/li><\/ul>/);
  assert.match(h, /<ol><li>셋<\/li><\/ol>/);
});

test('renders tables and code blocks', () => {
  const h = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1 < 2;\n```\n인라인 `code`');
  assert.match(h, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.match(h, /<pre><code>const x = 1 &lt; 2;\n<\/code><\/pre>/);
  assert.match(h, /<code>code<\/code>/);
});

test('links only http(s), newlines become paragraphs/br', () => {
  const h = renderMarkdown('[a](https://x.y) [b](javascript:alert(1))\n줄1\n줄2\n\n문단2');
  assert.match(h, /<a href="https:\/\/x\.y" target="_blank" rel="noopener">a<\/a>/);
  assert.ok(!/href="javascript/.test(h));
  assert.match(h, /줄1<br>줄2/);
  assert.match(h, /<p>문단2<\/p>/);
});
