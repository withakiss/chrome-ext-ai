// Rich 응답 계약(가이드 6장 CodingAssistantResponseV1 확장)과 손 검증. 의존성 0.
// 모델은 answer 도구로 JSON을 낸다. 검증을 통과한 블록만 렌더하고, actions·patchId·이미지 주소는 패널이 발급한 것만 쓴다.

const BLOCK_TYPES = ['markdown', 'table', 'code', 'callout', 'diff', 'timeline', 'metrics', 'status', 'card', 'tabs', 'chart', 'diagram', 'image'];
const STATES = ['pending', 'running', 'done', 'failed'];
const TONES = ['info', 'warning', 'success', 'error'];

const str = (max) => ({ type: 'string', maxLength: max });
const blockSchema = {
  type: 'object',
  description: `답변 블록. type은 ${BLOCK_TYPES.filter((t) => t !== 'diff' && t !== 'image').join('|')} 중 하나. markdown{text} table{title?,columns[],rows[][]} code{language,filename?,content} callout{tone:info|warning|success|error,title?,text} timeline{steps[{label,state:pending|running|done|failed}]} metrics{items[{label,value}]} status{label,state:success|warning|error|info} card{title,blocks[]} tabs{tabs[{label,blocks[]}]} chart{kind:bar|line,title?,labels[],values[]} diagram{title?,nodes[{id,label,sub?,children?[]}],edges?[{from,to,label?}]}`,
  properties: { type: { type: 'string', enum: BLOCK_TYPES.filter((t) => t !== 'diff' && t !== 'image') } },
  required: ['type'],
};

export const ANSWER_TOOL = {
  type: 'function',
  function: {
    name: 'answer',
    description: '최종 답변을 구조화해 보낸다. 질문 유형에 맞는 최소 블록을 고른다: 일반 설명=markdown, 비교=table, 흐름=diagram, 오류 분석=status+callout+근거 code, 수치=metrics/chart, 진행=timeline. 파일 근거는 citations에 실제 읽은 경로·줄만.',
    parameters: {
      type: 'object',
      properties: {
        title: str(80),
        summary: { type: 'string', description: '한두 문장 결론', maxLength: 1200 },
        status: { type: 'string', enum: ['complete', 'needs_input', 'error'] },
        blocks: { type: 'array', maxItems: 30, items: blockSchema },
        citations: { type: 'array', maxItems: 50, items: { type: 'object', properties: { path: str(500), startLine: { type: 'integer' }, endLine: { type: 'integer' }, note: str(300) }, required: ['path', 'startLine', 'endLine'] } },
        followups: { type: 'array', maxItems: 4, items: str(80), description: '사용자가 이어서 물을 만한 짧은 질문' },
      },
      required: ['summary', 'blocks'],
    },
  },
};

// ---- 검증 ----
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const cut = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function cleanBlock(b, depth, warn, ctx) {
  if (!b || typeof b !== 'object') { warn.push('블록이 객체가 아님'); return null; }
  const t = b.type;
  switch (t) {
    case 'markdown': return isStr(b.text, 12000) && b.text ? { type: t, text: b.text } : (warn.push('markdown.text'), null);
    case 'table': {
      const columns = arr(b.columns, 8).filter((c) => typeof c === 'string').map((c) => cut(c, 100));
      if (!columns.length) { warn.push('table.columns'); return null; }
      const rows = arr(b.rows, 100).filter(Array.isArray).map((r) => r.slice(0, columns.length).map((c) => cut(String(c ?? ''), 1000)));
      return { type: t, title: cut(b.title, 200), columns, rows };
    }
    case 'code': return isStr(b.content, 20000) ? { type: t, language: cut(b.language || 'text', 40), filename: cut(b.filename, 500), content: b.content } : (warn.push('code.content'), null);
    case 'callout': return isStr(b.text, 2000) && b.text ? { type: t, tone: TONES.includes(b.tone) ? b.tone : 'info', title: cut(b.title, 200), text: b.text } : (warn.push('callout.text'), null);
    case 'timeline': { const steps = arr(b.steps, 20).filter((s) => s && typeof s.label === 'string').map((s) => ({ label: cut(s.label, 200), state: STATES.includes(s.state) ? s.state : 'pending' })); return steps.length ? { type: t, steps } : (warn.push('timeline.steps'), null); }
    case 'metrics': { const items = arr(b.items, 12).filter((i) => i && i.label != null).map((i) => ({ label: cut(String(i.label), 100), value: cut(String(i.value ?? ''), 100) })); return items.length ? { type: t, items } : (warn.push('metrics.items'), null); }
    case 'status': return isStr(b.label, 100) && b.label ? { type: t, label: b.label, state: ['success', 'warning', 'error', 'info'].includes(b.state) ? b.state : 'info' } : (warn.push('status.label'), null);
    case 'chart': {
      const labels = arr(b.labels, 50).map((l) => cut(String(l), 40));
      const values = arr(b.values, 50).map(Number);
      if (!labels.length || labels.length !== values.length || values.some((v) => !Number.isFinite(v))) { warn.push('chart 데이터'); return null; }
      return { type: t, kind: b.kind === 'line' ? 'line' : 'bar', title: cut(b.title, 200), labels, values };
    }
    case 'diagram': {
      const node = (n, d) => (n && typeof n.label === 'string' ? { id: cut(String(n.id ?? n.label), 60), label: cut(n.label, 80), sub: cut(n.sub, 120), children: d < 1 ? arr(n.children, 8).map((c) => node(c, d + 1)).filter(Boolean) : [] } : null);
      const nodes = arr(b.nodes, 20).map((n) => node(n, 0)).filter(Boolean);
      if (!nodes.length) { warn.push('diagram.nodes'); return null; }
      const ids = new Set(nodes.map((n) => n.id));
      const edges = arr(b.edges, 40).filter((e) => e && ids.has(String(e.from)) && ids.has(String(e.to))).map((e) => ({ from: String(e.from), to: String(e.to), label: cut(e.label, 60) }));
      return { type: t, title: cut(b.title, 200), nodes, edges };
    }
    case 'card': case 'tabs': {
      if (depth >= 2) { warn.push(`${t} 중첩 깊이 초과`); return null; }
      if (t === 'card') { const blocks = cleanBlocks(b.blocks, depth + 1, warn, ctx); return blocks.length ? { type: t, title: cut(b.title, 200), blocks } : (warn.push('card.blocks'), null); }
      const tabs = arr(b.tabs, 6).filter((x) => x && typeof x.label === 'string').map((x) => ({ label: cut(x.label, 40), blocks: cleanBlocks(x.blocks, depth + 1, warn, ctx) })).filter((x) => x.blocks.length);
      return tabs.length ? { type: t, tabs } : (warn.push('tabs.tabs'), null);
    }
    case 'diff': case 'image': // 모델이 직접 못 만든다: 패널이 발급한 ID만 허용
      if (t === 'diff' && ctx.patches?.has(b.patchId)) return { type: t, patchId: b.patchId };
      if (t === 'image' && ctx.images?.has(b.imageId)) return { type: t, imageId: b.imageId };
      warn.push(`${t}: 발급되지 않은 ID`); return null;
    default: warn.push(`알 수 없는 블록 ${String(t).slice(0, 20)}`); return null;
  }
}
function cleanBlocks(blocks, depth, warn, ctx) { return arr(blocks, 30).map((b) => cleanBlock(b, depth, warn, ctx)).filter(Boolean); }

// obj: answer 도구 arguments(이미 파싱된 객체 또는 JSON 문자열). ctx: { patches:Set, images:Set }
// 반환 { ok, value, warnings }. ok=false면 value.summary만 믿을 수 있다(대체 표시용).
export function validateResponse(obj, ctx = {}) {
  const warnings = [];
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { return { ok: false, value: null, warnings: [`JSON 파싱 실패: ${e.message}`] }; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, value: null, warnings: ['객체가 아님'] };
  const summary = cut(obj.summary, 1200).trim();
  const blocks = cleanBlocks(obj.blocks, 0, warnings, ctx);
  const citations = arr(obj.citations, 50).filter((c) => c && isStr(c.path, 500) && Number.isInteger(c.startLine) && Number.isInteger(c.endLine) && c.startLine >= 1 && c.endLine >= c.startLine)
    .map((c) => ({ path: c.path, startLine: c.startLine, endLine: c.endLine, note: cut(c.note, 300) }));
  if (Array.isArray(obj.citations) && citations.length < Math.min(obj.citations.length, 50)) warnings.push('잘못된 인용 제외');
  const followups = arr(obj.followups, 4).filter((f) => typeof f === 'string' && f.trim()).map((f) => cut(f.trim(), 80));
  const value = { title: cut(obj.title, 80), summary, status: ['complete', 'needs_input', 'error'].includes(obj.status) ? obj.status : 'complete', blocks, citations, followups };
  return { ok: !!summary || blocks.length > 0, value, warnings };
}

// 읽기 장부(ledger: Map<path, [[s,e],…]>)에 없는 인용은 verified=false로 표시(근거처럼 보이지 않게).
export function verifyCitations(citations, ledger) {
  return citations.map((c) => {
    const ranges = ledger?.get(c.path) || [];
    const verified = ranges.some(([s, e]) => c.startLine >= s && c.endLine <= e);
    return { ...c, verified };
  });
}

// 대체 표시용 마크다운(검증 실패 시)
export function fallbackText(raw) {
  if (raw && typeof raw === 'object' && typeof raw.summary === 'string') return raw.summary;
  return typeof raw === 'string' ? raw : '(답변 형식 오류 — 내용을 표시할 수 없습니다)';
}
