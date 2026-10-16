// 스냅샷 순수 함수. DOM에 의존하지 않아 node --test 로 검증한다.
// content script(일반 스크립트)와 ESM(패널·테스트) 양쪽에서 쓰려고 globalThis.SnapshotCore 로 내보낸다.
// (content script에서 동적 import()는 Chrome 155가 "Unsafe attempt to load URL"로 막는다.)
(() => {
const TAG_ROLES = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'image', nav: 'navigation',
  main: 'main', header: 'banner', footer: 'contentinfo', section: 'region', article: 'article', aside: 'complementary',
  form: 'form', table: 'table', ul: 'list', ol: 'list', li: 'listitem', label: 'label', p: 'paragraph', dialog: 'dialog',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', option: 'option' };
const INPUT_ROLES = { submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'button', checkbox: 'checkbox', radio: 'radio' };
// listitem은 클릭 핸들러가 있을 때만 ref를 받는다(content-main의 onclick 검사).
const INTERACTIVE_ROLES = new Set(['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'option', 'tab', 'menuitem', 'slider', 'switch', 'searchbox']);
const SENSITIVE_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year'];

function computeRole({ tag, attrs }) {
  if (attrs.role) return attrs.role;
  if (tag === 'input') return INPUT_ROLES[(attrs.type || '').toLowerCase()] || 'textbox';
  return TAG_ROLES[tag] || 'generic';
}

function isSensitive({ attrs }) {
  const t = (attrs.type || '').toLowerCase();
  if (t === 'password' || t === 'hidden') return true;
  const ac = (attrs.autocomplete || '').toLowerCase();
  return SENSITIVE_AUTOCOMPLETE.some((k) => ac.includes(k));
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function computeName(el, labelText = '') {
  const { tag, attrs, text, value } = el;
  for (const k of ['aria-label', 'placeholder', 'title', 'alt']) if (clean(attrs[k])) return clean(attrs[k]);
  if (clean(labelText)) return clean(labelText);
  if (tag === 'input' || tag === 'textarea') {
    if (isSensitive(el)) return value ? '[value redacted]' : '';
    if (tag === 'input' && (attrs.type || '').toLowerCase() === 'submit' && clean(attrs.value)) return clean(attrs.value);
    return value && value.length < 50 ? clean(value) : '';
  }
  return clean(text);
}

function filterInteractive(node) {
  const kids = node.children.map(filterInteractive).filter(Boolean);
  const keep = !!node.ref; // ref가 있다 = 조작 가능(역할 또는 onclick)
  if (!keep && kids.length === 0) return null;
  return { ...node, children: kids };
}

// "화면에서 선택": 사각형(페이지 좌표)과 겹치는 노드·그 조상·겹치는 노드의 텍스트 잎만 남긴다.
function filterByRect(node, rect) {
  const hit = (r) => r && r.x < rect.x + rect.w && r.x + r.w > rect.x && r.y < rect.y + rect.h && r.y + r.h > rect.y;
  const self = hit(node.rect);
  const kids = node.children.map((c) => (c.role === 'text' ? (self ? c : null) : filterByRect(c, rect))).filter(Boolean);
  if (!self && kids.length === 0) return null;
  return { ...node, children: kids };
}

function foldLeafText(node) {
  for (const c of node.children) if (c.role !== 'text') foldLeafText(c);
  if (!node.ref || node.name || node.children.length === 0 || node.children.length > 3) return node;
  if (!node.children.every((c) => c.role === 'text' && c.name)) return node;
  node.name = clean(node.children.map((c) => c.name).join(' '));
  node.children = [];
  return node;
}

const escapeText = (s) => clean(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const esc = escapeText;
const FLAGS = { hidden: 'hidden', scrollable: 'scrollable', checked: 'checked', disabled: 'disabled', focused: 'focused', selected: 'selected', crossOrigin: 'cross-origin' };

function lineOf(n) {
  const p = [n.role];
  if (n.name) p.push(`"${esc(n.name)}"`);
  if (n.ref) p.push(`[ref=${n.ref}]`);
  if (n.level) p.push(`[level=${n.level}]`);
  for (const [k, label] of Object.entries(FLAGS)) if (n[k]) p.push(`[${label}]`);
  if (n.placeholder) p.push(`[placeholder="${esc(n.placeholder)}"]`);
  return p.join(' ');
}

function renderTree(root) {
  const lines = [];
  const walk = (n, depth) => {
    if (n.role !== 'fragment') lines.push('  '.repeat(depth) + (n.role === 'text' ? `text "${esc(n.name)}"` : lineOf(n)));
    const d = n.role === 'fragment' ? depth : depth + 1;
    for (const c of n.children) walk(c, d);
  };
  walk(root, 0);
  return lines.join('\n');
}

function truncateTree(text, max = 20000) {
  if (text.length <= max) return text;
  const kept = text.slice(0, max);
  const cut = kept.lastIndexOf('\n');
  const head = cut > 0 ? kept.slice(0, cut) : kept;
  const omitted = text.slice(head.length).split('\n').length - 1;
  return `${head}\n[… ${omitted}줄 생략, selector로 범위를 좁히세요]`;
}

// ponytail: 집합 기반 줄 diff. 순서 변화는 못 잡음. 정확한 diff가 필요하면 LCS로 교체.
function diffLines(prev, next) {
  const a = prev ? prev.split('\n') : [], b = next ? next.split('\n') : [];
  const setA = new Set(a), setB = new Set(b);
  const out = [];
  for (const l of a) if (!setB.has(l)) out.push(`- ${l}`);
  for (const l of b) if (!setA.has(l)) out.push(`+ ${l}`);
  return out.length ? out.join('\n') : '(변경 없음)';
}

globalThis.SnapshotCore = { computeRole, computeName, isSensitive, INTERACTIVE_ROLES, filterInteractive, filterByRect, foldLeafText, renderTree, truncateTree, diffLines, escapeText };
})();
