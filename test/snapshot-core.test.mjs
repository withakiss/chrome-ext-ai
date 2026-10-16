import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/lib/snapshot-core.js';
const { computeRole, computeName, isSensitive, filterInteractive, foldLeafText, renderTree, truncateTree, diffLines } = globalThis.SnapshotCore;

const el = (tag, attrs = {}, text = '', value = '') => ({ tag, attrs, text, value });

test('computeRole maps tags and respects role attr', () => {
  assert.equal(computeRole(el('a')), 'link');
  assert.equal(computeRole(el('input', { type: 'checkbox' })), 'checkbox');
  assert.equal(computeRole(el('input', { type: 'submit' })), 'button');
  assert.equal(computeRole(el('input')), 'textbox');
  assert.equal(computeRole(el('select')), 'combobox');
  assert.equal(computeRole(el('h2')), 'heading');
  assert.equal(computeRole(el('div', { role: 'dialog' })), 'dialog');
  assert.equal(computeRole(el('span')), 'generic');
});

test('computeName priority: aria-label > placeholder > title > alt > label > text > value', () => {
  assert.equal(computeName(el('input', { 'aria-label': 'Search', placeholder: 'x' })), 'Search');
  assert.equal(computeName(el('input', { placeholder: '검색' })), '검색');
  assert.equal(computeName(el('img', { alt: 'logo' })), 'logo');
  assert.equal(computeName(el('input', {}), 'Email'), 'Email');
  assert.equal(computeName(el('button', {}, '  Go  ')), 'Go');
  assert.equal(computeName(el('input', { type: 'text' }, '', 'hello')), 'hello');
  assert.equal(computeName(el('input', { type: 'text' }, '', 'x'.repeat(60))), '');
});

test('sensitive inputs are redacted', () => {
  assert.ok(isSensitive(el('input', { type: 'password' })));
  assert.ok(isSensitive(el('input', { autocomplete: 'cc-number' })));
  assert.ok(isSensitive(el('input', { autocomplete: 'one-time-code' })));
  assert.equal(computeName(el('input', { type: 'password' }, '', 'secret')), '[value redacted]');
  assert.equal(computeName(el('input', { type: 'password' }, '', '')), '');
});

const tree = () => ({ role: 'fragment', name: '', children: [
  { role: 'generic', name: '', children: [
    { role: 'text', name: 'hello', children: [] },
    { role: 'button', name: 'OK', ref: 'e1', children: [] },
  ] },
  { role: 'paragraph', name: '', children: [{ role: 'text', name: 'plain', children: [] }] },
] });

test('filterInteractive keeps only interactive nodes and their ancestors', () => {
  const out = filterInteractive(tree());
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].children.length, 1);
  assert.equal(out.children[0].children[0].ref, 'e1');
});

test('foldLeafText merges text-only children into parent name', () => {
  const n = { role: 'link', name: '', ref: 'e2', children: [
    { role: 'text', name: 'Read', children: [] }, { role: 'text', name: 'more', children: [] }] };
  foldLeafText(n);
  assert.equal(n.name, 'Read more');
  assert.equal(n.children.length, 0);
});

test('renderTree prints one line per node with attributes', () => {
  const root = { role: 'fragment', name: '', children: [
    { role: 'heading', name: 'Title', level: 2, children: [] },
    { role: 'checkbox', name: 'Agree', ref: 'e3', checked: true, disabled: true, children: [] },
    { role: 'textbox', name: '', ref: 'e4', placeholder: 'Search', focused: true, children: [] },
  ] };
  assert.equal(renderTree(root), [
    'heading "Title" [level=2]',
    'checkbox "Agree" [ref=e3] [checked] [disabled]',
    'textbox [ref=e4] [focused] [placeholder="Search"]',
  ].join('\n'));
});

test('renderTree indents children by two spaces', () => {
  const root = { role: 'fragment', name: '', children: [
    { role: 'list', name: '', ref: 'e1', children: [{ role: 'listitem', name: 'a', ref: 'e2', children: [] }] }] };
  assert.equal(renderTree(root), 'list [ref=e1]\n  listitem "a" [ref=e2]');
});

test('escapes quotes and newlines in names', () => {
  const root = { role: 'fragment', name: '', children: [{ role: 'button', name: 'Say "hi"\nnow', ref: 'e1', children: [] }] };
  assert.equal(renderTree(root), 'button "Say \\"hi\\" now" [ref=e1]');
});

test('truncateTree cuts at limit with a note', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const out = truncateTree(text, 200);
  assert.ok(out.length < 320);
  assert.match(out, /\[… \d+줄 생략, selector로 범위를 좁히세요\]$/);
  assert.equal(truncateTree('short', 200), 'short');
});

test('diffLines shows added and removed lines', () => {
  assert.equal(diffLines('a\nb\nc', 'a\nc\nd'), '- b\n+ d');
  assert.equal(diffLines('a', 'a'), '(변경 없음)');
  assert.equal(diffLines('', 'a'), '+ a');
});

test('cross-origin iframe shows [cross-origin] flag', () => {
  const root = { role: 'fragment', name: '', children: [{ role: 'iframe', name: 'ad', ref: 'f2', crossOrigin: true, children: [] }] };
  assert.equal(renderTree(root), 'iframe "ad" [ref=f2] [cross-origin]');
});

test('filterInteractive keeps any node with a ref (onclick generic) and drops listitem without ref', () => {
  const root = { role: 'fragment', name: '', children: [
    { role: 'generic', name: 'card', ref: 'e1', children: [] },
    { role: 'listitem', name: 'plain', children: [] },
  ] };
  const out = filterInteractive(root);
  assert.deepEqual(out.children.map((c) => c.role), ['generic']);
});

test('escapeHeader escapes backslash and quotes', async () => {
  const { escapeText } = globalThis.SnapshotCore;
  assert.equal(escapeText('a\\b "c"'), 'a\\\\b \\"c\\"');
});

test('filterByRect keeps nodes intersecting the rect, their ancestors, and their text leaves', async () => {
  const { filterByRect } = globalThis.SnapshotCore;
  const root = { role: 'fragment', name: '', children: [
    { role: 'generic', name: '', rect: { x: 0, y: 0, w: 1000, h: 1000 }, children: [
      { role: 'link', name: 'in', ref: 'e1', rect: { x: 100, y: 100, w: 50, h: 20 }, children: [] },
      { role: 'link', name: 'out', ref: 'e2', rect: { x: 900, y: 900, w: 50, h: 20 }, children: [] },
      { role: 'paragraph', name: '', rect: { x: 90, y: 130, w: 300, h: 40 }, children: [{ role: 'text', name: 'hello', children: [] }] },
    ] },
    { role: 'generic', name: 'far', rect: { x: 2000, y: 2000, w: 10, h: 10 }, children: [] },
  ] };
  const out = filterByRect(root, { x: 80, y: 80, w: 200, h: 100 });
  assert.equal(out.children.length, 1);
  assert.deepEqual(out.children[0].children.map((c) => c.name || c.role), ['in', 'paragraph']);
  assert.equal(out.children[0].children[1].children[0].name, 'hello');
  assert.equal(filterByRect(root, { x: 5000, y: 5000, w: 1, h: 1 }), null);
});

test('filterInteractive keeps clickable generic (cursor:pointer gives ref)', () => {
  // content-main이 cursor:pointer 요소에 ref를 주므로 ref만 있으면 유지돼야 함
  const root = { role: 'fragment', name: '', children: [{ role: 'generic', name: 'card', ref: 'e1', children: [] }] };
  assert.equal(filterInteractive(root).children.length, 1);
});
