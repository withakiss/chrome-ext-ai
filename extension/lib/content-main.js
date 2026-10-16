// 탭 안에서 실행(일반 content script, lib/snapshot-core.js 다음에 주입). DOM을 걸어 스냅샷 트리를 만들고 ref -> Element 레지스트리를 유지한다.
(() => {
if (globalThis.__agentContentLoaded) return; globalThis.__agentContentLoaded = true; // executeScript 재주입 방지
const { computeRole, computeName, filterInteractive, filterByRect, foldLeafText, renderTree, escapeText, INTERACTIVE_ROLES } = globalThis.SnapshotCore;

const registry = new Map(); // ref -> Element
let counter = 0;

const attrsOf = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('');
const labelFor = (el) => (el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || '';

function isHidden(el) {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return true;
  const r = el.getBoundingClientRect();
  return r.width === 0 && r.height === 0 && el.tagName !== 'OPTION';
}

function toNode(el, prefix, showHidden) {
  const tag = el.tagName.toLowerCase();
  if (['script', 'style', 'noscript', 'template', 'svg', 'path', 'meta', 'link', 'head'].includes(tag)) return null;
  const hidden = isHidden(el);
  if (hidden && !showHidden) return null;
  const view = { tag, attrs: attrsOf(el), text: ownText(el), value: el.value ?? '' };
  const role = computeRole(view);
  const node = { role, name: computeName(view, labelFor(el)), children: [], hidden };
  { const r = el.getBoundingClientRect(); node.rect = { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }; } // 영역 선택용(페이지 좌표)
  if (/^h[1-6]$/.test(tag)) node.level = Number(tag[1]);
  if (el.checked) node.checked = true;
  if (el.disabled) node.disabled = true;
  if (el.ownerDocument.activeElement === el) node.focused = true;
  if (el.selected) node.selected = true;
  if (view.attrs.placeholder && node.name !== view.attrs.placeholder) node.placeholder = view.attrs.placeholder;
  if (el.scrollHeight > el.clientHeight + 8 && getComputedStyle(el).overflowY !== 'visible') node.scrollable = true;
  // addEventListener 로 붙인 클릭(React 등)은 못 보므로 cursor:pointer 도 조작 가능으로 본다
  const interactive = INTERACTIVE_ROLES.has(role) || el.onclick || el.hasAttribute('onclick') || tag === 'input' || (role === 'generic' && getComputedStyle(el).cursor === 'pointer');
  if (interactive) { const ref = `${prefix}e${++counter}`; registry.set(ref, el); node.ref = ref; }
  if (tag === 'iframe') {
    let doc = null; try { doc = el.contentDocument; } catch {}
    const ref = `${prefix}f${++counter}`;
    registry.set(ref, el);
    if (!doc) return { ...node, role: 'iframe', ref, name: node.name || el.src, crossOrigin: true, children: [] };
    node.ref = ref; node.role = 'iframe';
    node.children = [...(doc.body?.children ?? [])].map((c) => toNode(c, `${ref}`, showHidden)).filter(Boolean);
    return node;
  }
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { const t = child.textContent.replace(/\s+/g, ' ').trim(); if (t && !node.name) node.children.push({ role: 'text', name: t, children: [] }); }
    else if (child.nodeType === Node.ELEMENT_NODE) { const n = toNode(child, prefix, showHidden); if (n) node.children.push(n); }
  }
  return node;
}

function snapshot({ interactive = false, showHidden = false, selector, ref, region } = {}) {
  let rootEl = document.body;
  if (ref) { rootEl = registry.get(ref); if (!rootEl) return { error: `unknown ref ${ref} (take a new snapshot)` }; }
  else if (selector) { rootEl = document.querySelector(selector); if (!rootEl) return { error: `no element matches ${selector}` }; }
  registry.clear(); counter = 0;
  let root = { role: 'fragment', name: '', children: [toNode(rootEl, '', showHidden)].filter(Boolean) };
  if (region) root = filterByRect(root, region) || { role: 'fragment', name: '', children: [] };
  foldLeafText(root);
  if (interactive) root = filterInteractive(root) || { role: 'fragment', name: '', children: [] };
  const header = `page "${escapeText(document.title)}" ${location.href}`;
  return { tree: `${header}\n${renderTree(root)}` };
}

const byRef = (ref) => registry.get(ref);

function elementPoint(ref) {
  const el = byRef(ref); if (!el) return { error: `unknown ref ${ref} (take a new snapshot)` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  let x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = el.ownerDocument.elementFromPoint(x, y); // 가림 판정은 요소가 속한 문서 기준
  // 동일 출처 iframe 안 요소: 프레임 위치를 더해 최상위 뷰포트 좌표로 바꾼다(CDP 입력은 top 기준)
  for (let f = el.ownerDocument.defaultView.frameElement; f; f = f.ownerDocument.defaultView.frameElement) { const fr = f.getBoundingClientRect(); x += fr.left + f.clientLeft; y += fr.top + f.clientTop; }
  return { x, y, obscured: !!hit && hit !== el && !el.contains(hit) && !hit.contains(el) };
}

// "화면에서 선택": 오버레이에서 드래그한 사각형 안의 트리를 패널로 보낸다(Esc 취소).
function startRegionSelect() {
  document.getElementById('__agent_region_overlay__')?.remove();
  const ov = document.createElement('div'); ov.id = '__agent_region_overlay__';
  ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.15)';
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:2px solid #1a73e8;background:rgba(26,115,232,.15);display:none;pointer-events:none';
  ov.append(box); document.documentElement.append(ov);
  let sx = 0, sy = 0, dragging = false;
  const viewport = () => ({ scrollX: window.scrollX, scrollY: window.scrollY, width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 });
  const done = (region) => { ov.remove(); document.removeEventListener('keydown', onKey, true); if (region) chrome.runtime.sendMessage({ type: 'regionSelected', ...snapshot({ region }), region, viewport: viewport() }); else chrome.runtime.sendMessage({ type: 'regionCancelled' }); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  document.addEventListener('keydown', onKey, true);
  ov.onmousedown = (e) => { dragging = true; sx = e.clientX; sy = e.clientY; box.style.display = 'block'; };
  ov.onmousemove = (e) => { if (!dragging) return; const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY); Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - sx)}px`, height: `${Math.abs(e.clientY - sy)}px` }); };
  ov.onmouseup = (e) => {
    const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
    if (w < 4 || h < 4) return done(null);
    done({ x: Math.min(sx, e.clientX) + window.scrollX, y: Math.min(sy, e.clientY) + window.scrollY, w, h });
  };
  return { ok: true };
}

const handlers = {
  snapshot: (m) => snapshot(m),
  startRegionSelect: () => startRegionSelect(),
  elementPoint: (m) => elementPoint(m.ref),
  domClick: (m) => { const el = byRef(m.ref); if (!el) return { error: `unknown ref ${m.ref}` }; el.click(); return { ok: true }; },
  focusAndClear: (m) => {
    const el = byRef(m.ref); if (!el) return { error: `unknown ref ${m.ref}` }; el.focus();
    if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (el.isContentEditable) { el.textContent = ''; }
    return { ok: true };
  },
  selectOption: (m) => {
    const el = byRef(m.ref); if (!el) return { error: `unknown ref ${m.ref}` };
    el.value = m.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = handlers[msg?.type]; if (!h) return false;
  try { reply(h(msg)); } catch (e) { reply({ error: String(e?.message || e) }); }
  return false;
});
})();
