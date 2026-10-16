// Rich 응답 렌더러. 검증된 응답(response.js validateResponse 결과)만 그린다.
// 모든 글자는 textContent로 넣고, markdown 블록만 renderMarkdown(HTML 이스케이프 후 변환)을 쓴다. 모델 HTML·SVG는 실행하지 않는다.
import { renderMarkdown } from './markdown.js';

const ICON = { copy: 'i-copy', check: 'i-check', expand: 'i-expand', wrap: 'i-wrap', code: 'i-code', image: 'i-image', undo: 'i-undo', x: 'i-x' };

export function createRenderer(doc = document, hooks = {}) {
  const h = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const icon = (name) => { const s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); const u = doc.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#${ICON[name] || name}`); s.append(u); return s; };
  const ib = (name, label, onclick) => { const b = h('button', 'ib ghost'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.append(icon(name)); b.onclick = onclick; return b; };
  const copyBtn = (label, getText) => { const b = ib('copy', label, async () => { try { await navigator.clipboard.writeText(getText()); b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 1200); } catch {} }); b.append(icon('check')); return b; };
  const expandBtn = (el, title) => ib('expand', '크게 보기', () => hooks.expand?.(el, title));
  const head = (title, ...tools) => { const d = h('div', 'rb-head'); d.append(h('span', 'rb-title', title || '')); d.append(...tools.filter(Boolean)); return d; };

  const R = {
    markdown(b) { const d = h('div', 'rb-md'); d.innerHTML = renderMarkdown(b.text); return d; },
    status(b) { return h('span', `rb-status s-${b.state}`, b.label); },
    callout(b) {
      const d = h('div', `rb-callout t-${b.tone}`); d.setAttribute('role', b.tone === 'error' || b.tone === 'warning' ? 'alert' : 'note');
      if (b.title) d.append(h('div', 'rb-callout-title', b.title));
      d.append(h('div', null, b.text)); return d;
    },
    table(b) {
      const card = h('div', 'rb-card rb-table');
      const tsv = () => [b.columns, ...b.rows].map((r) => r.join('\t')).join('\n');
      const box = h('div', 'rb-scroll'); const t = h('table'); const tr = h('tr');
      for (const c of b.columns) tr.append(h('th', null, c));
      const thead = h('thead'); thead.append(tr); t.append(thead);
      const tb = h('tbody');
      for (const r of b.rows) { const row = h('tr'); for (let i = 0; i < b.columns.length; i++) row.append(h('td', null, r[i] || '-')); tb.append(row); }
      t.append(tb); box.append(t);
      card.append(head(b.title || '표', copyBtn('표 복사', tsv), expandBtn(card, b.title || '표')), box); return card;
    },
    code(b) {
      const card = h('div', 'rb-card rb-code');
      const pre = h('pre'); const code = h('code', null, b.content); pre.append(code);
      const label = h('span', 'rb-title'); label.append(icon('code'), doc.createTextNode(` ${b.language}${b.filename ? ` · ${b.filename}` : ''}`));
      const hd = h('div', 'rb-head'); hd.append(label, ib('wrap', '줄바꿈', () => pre.classList.toggle('wrap')), copyBtn('코드 복사', () => b.content));
      card.append(hd, pre); return card;
    },
    metrics(b) { const g = h('div', 'rb-metrics'); for (const i of b.items) { const c = h('div', 'rb-metric'); c.append(h('div', 'v', i.value), h('div', 'l', i.label)); g.append(c); } return g; },
    timeline(b) {
      const ol = h('ol', 'rb-timeline');
      for (const s of b.steps) { const li = h('li', `st-${s.state}`); li.append(h('span', 'dot'), h('span', null, s.label)); ol.append(li); }
      return ol;
    },
    card(b, depth) { const c = h('div', 'rb-card rb-group'); c.append(head(b.title)); const body = h('div', 'rb-body'); for (const x of b.blocks) body.append(block(x, depth + 1)); c.append(body); return c; },
    tabs(b, depth) {
      const wrap = h('div', 'rb-tabs'); const bar = h('div', 'rb-tabbar'); bar.setAttribute('role', 'tablist'); const panes = [];
      const select = (i) => { bar.querySelectorAll('button').forEach((x, j) => { x.setAttribute('aria-selected', String(i === j)); x.tabIndex = i === j ? 0 : -1; }); panes.forEach((p, j) => { p.hidden = i !== j; }); };
      b.tabs.forEach((t, i) => {
        const btn = h('button', null, t.label); btn.type = 'button'; btn.setAttribute('role', 'tab'); btn.onclick = () => select(i);
        btn.onkeydown = (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + b.tabs.length) % b.tabs.length; select(n); bar.children[n].focus(); } };
        bar.append(btn);
        const pane = h('div', 'rb-pane'); pane.setAttribute('role', 'tabpanel'); for (const x of t.blocks) pane.append(block(x, depth + 1)); panes.push(pane);
      });
      wrap.append(bar, ...panes); select(0); return wrap;
    },
    chart(b) {
      const card = h('div', 'rb-card rb-chart'); card.append(head(b.title || '차트'));
      const W = 320, H = 140, P = 22, n = b.values.length, max = Math.max(...b.values, 0), min = Math.min(...b.values, 0), span = max - min || 1;
      const NS = 'http://www.w3.org/2000/svg'; const svg = doc.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H + 18}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${b.title || '차트'}: ${b.labels.map((l, i) => `${l} ${b.values[i]}`).join(', ')}`);
      const y = (v) => P / 2 + (H - P) * (1 - (v - min) / span); const step = (W - 8) / n;
      const el = (tag, attrs) => { const e = doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); svg.append(e); return e; };
      el('line', { x1: 0, x2: W, y1: y(0), y2: y(0), class: 'axis' });
      if (b.kind === 'line') el('polyline', { points: b.values.map((v, i) => `${4 + step * (i + 0.5)},${y(v)}`).join(' '), class: 'line' });
      b.values.forEach((v, i) => {
        const x = 4 + step * i;
        if (b.kind === 'bar') el('rect', { x: x + step * 0.15, width: step * 0.7, y: Math.min(y(v), y(0)), height: Math.max(1, Math.abs(y(v) - y(0))), rx: 3, class: 'bar' });
        else el('circle', { cx: x + step * 0.5, cy: y(v), r: 3, class: 'pt' });
        if (n <= 12) { const t = el('text', { x: x + step * 0.5, y: H + 14, 'text-anchor': 'middle', class: 'lbl' }); t.textContent = b.labels[i].slice(0, 6); }
      });
      card.append(svg); return card;
    },
    diagram(b) {
      const card = h('div', 'rb-card rb-diagram'); card.append(head(b.title || '구조'));
      const body = h('div', 'rb-flow');
      const nodeEl = (n) => {
        const d = h('div', 'rb-node'); const t = h('div', 'rb-node-t', n.label); if (n.sub) t.append(h('span', 'sub', ` · ${n.sub}`)); d.append(t);
        if (n.children.length) { const g = h('div', 'rb-node-kids'); for (const c of n.children) g.append(h('span', null, c.label)); d.append(g); }
        return d;
      };
      // ponytail: 세로 1열 배치. edges는 순서 정보로만 쓰고, 연결 라벨은 화살표 옆에 표시.
      const label = new Map(b.edges.map((e) => [`${e.from}>${e.to}`, e.label]));
      b.nodes.forEach((n, i) => {
        if (i) { const a = h('div', 'rb-arrow', '↓'); const l = label.get(`${b.nodes[i - 1].id}>${n.id}`); if (l) a.append(h('span', null, ` ${l}`)); a.setAttribute('aria-hidden', 'true'); body.append(a); }
        body.append(nodeEl(n));
      });
      card.append(body); return card;
    },
    diff(b) { return hooks.patchCard?.(b.patchId) || h('div', 'rb-callout t-info', '수정안 정보를 찾을 수 없습니다'); },
    image(b) { const src = hooks.image?.(b.imageId); if (!src) return h('div'); const img = h('img', 'rb-img'); img.src = src; img.alt = '선택한 화면 영역'; return img; },
  };
  function block(b, depth = 0) { try { return (R[b.type] || (() => h('div')))(b, depth); } catch (e) { return h('div', 'rb-callout t-error', `블록 표시 실패: ${e.message}`); } }

  function citations(list) {
    const row = h('div', 'rb-cites'); row.append(h('span', 'lbl', '근거'));
    for (const c of list) {
      const name = `${c.path.split('/').pop()}:${c.startLine}${c.endLine !== c.startLine ? `–${c.endLine}` : ''}`;
      if (!c.verified) { const s = h('span', 'rb-cite off', `${name} · 확인 안 됨`); s.title = `${c.path} — 도구로 읽지 않은 범위라 근거로 쓰지 않습니다`; row.append(s); continue; }
      const btn = h('button', 'rb-cite', name); btn.type = 'button'; btn.title = `${c.path}:${c.startLine}-${c.endLine}${c.note ? ` — ${c.note}` : ''}`;
      btn.onclick = async () => { const nx = btn.nextElementSibling; if (nx?.classList.contains('rb-cite-view')) { nx.remove(); return; } const pre = h('pre', 'rb-cite-view', '읽는 중…'); btn.after(pre); try { pre.textContent = await hooks.readRange(c); } catch (e) { pre.textContent = `읽기 실패: ${e.message}`; } };
      row.append(btn);
    }
    return row;
  }

  // 응답 전체: 제목+상태 → summary → blocks → citations → followups
  function answer(v) {
    const root = h('div', 'rich');
    const statusBlocks = v.blocks.filter((b) => b.type === 'status');
    if (v.title || statusBlocks.length) { const t = h('div', 'rb-top'); t.append(h('div', 'rb-h', v.title || '')); for (const s of statusBlocks) t.append(R.status(s)); root.append(t); }
    if (v.summary) root.append(h('p', 'rb-summary', v.summary));
    for (const b of v.blocks) if (b.type !== 'status') root.append(block(b));
    if (v.citations.length) root.append(citations(v.citations));
    return root;
  }
  function followups(list) {
    const row = h('div', 'rb-follow');
    for (const f of list) { const b = h('button', null, f); b.type = 'button'; b.onclick = () => hooks.followup?.(f); row.append(b); }
    return row;
  }

  // 수정안 카드(패널 데이터로만 그림). p: { id, reason, state, files:[{path,diff,add,del}] }
  function patch(p, act = {}) {
    const card = h('div', 'rb-patch'); card.dataset.patch = p.id;
    const STATE = { proposed: ['승인 대기', 'warning'], applied: ['적용됨', 'success'], rejected: ['거절됨', 'info'], stale: ['파일이 바뀜 · 다시 제안 필요', 'warning'], reverted: ['되돌림', 'info'] };
    const [txt, tone] = STATE[p.state] || [p.state, 'info'];
    const top = h('div', 'rb-top'); top.append(h('div', 'rb-h', '수정안'), h('span', `rb-status s-${tone}`, txt)); card.append(top);
    if (p.reason) card.append(h('p', 'rb-summary', p.reason));
    for (const f of p.files) {
      const fc = h('div', 'rb-card rb-diff');
      const hd = h('div', 'rb-head'); hd.append(h('span', 'rb-title mono', f.path), h('span', 'add', `+${f.add}`), h('span', 'del', `−${f.del}`), copyBtn('Diff 복사', () => f.diff));
      const body = h('div', 'rb-scroll diff-body');
      for (const line of f.diff.split('\n').slice(2)) body.append(h('div', line.startsWith('@@') ? 'hunk' : line[0] === '+' ? 'ins' : line[0] === '-' ? 'rem' : 'ctx', line));
      fc.append(hd, body); card.append(fc);
    }
    const bar = h('div', 'rb-actions');
    const btn = (label, cls, fn) => { const b = h('button', cls, label); b.type = 'button'; b.onclick = async () => { bar.querySelectorAll('button').forEach((x) => { x.disabled = true; }); await fn(); }; bar.append(b); };
    if (p.state === 'proposed' && act.apply) { btn('적용', 'primary', act.apply); btn('거절', 'outline', act.reject); }
    if (p.state === 'applied' && act.undo) btn('되돌리기', 'soft', act.undo);
    if (bar.children.length) card.append(bar);
    return card;
  }

  // 테스트 결과 카드. r: { state: passed|failed|timeout|notrun, command?, exitCode?, ms?, log?, reason? }
  function testResult(r) {
    const card = h('div', 'rb-test');
    const L = { passed: ['통과', 'success'], failed: ['실패', 'warning'], timeout: ['시간 초과', 'warning'], notrun: ['미실행', 'info'] }[r.state];
    const top = h('div', 'rb-top'); top.append(h('div', 'rb-h', '테스트 결과'), h('span', `rb-status s-${L[1]}`, L[0])); card.append(top);
    if (r.reason) card.append(h('p', 'rb-summary', r.reason));
    if (r.command) card.append(h('p', 'rb-cmd', `$ ${r.command}`));
    const items = [];
    if (r.exitCode != null) items.push({ label: '종료 코드', value: String(r.exitCode) });
    if (r.ms != null) items.push({ label: '시간', value: `${Math.round(r.ms / 100) / 10}초` });
    if (items.length) card.append(R.metrics({ items }));
    if (r.log) card.append(R.code({ language: 'log', filename: '출력 끝부분', content: r.log }));
    return card;
  }

  return { answer, followups, patch, testResult, block };
}
