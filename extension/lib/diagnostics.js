// 페이지 진단 버퍼: CDP 이벤트에서 실패 요청(4xx/5xx)과 콘솔 오류만 탭별로 최근 N건 모은다.
// 헤더·쿠키·본문은 저장하지 않고, URL 쿼리값은 가린다.
export const GET_DIAGNOSTICS_TOOL = {
  type: 'function',
  function: {
    name: 'get_page_diagnostics',
    description: '현재 탭의 최근 실패 네트워크 요청(method, URL, status)과 콘솔 오류를 가져온다. 화면 오류(403·500 등)의 원인을 코드에서 찾기 전에 먼저 쓴다. 헤더·쿠키·본문은 포함되지 않는다.',
    parameters: { type: 'object', properties: {} },
  },
};

export function maskUrl(u) {
  try { const url = new URL(u); for (const k of [...url.searchParams.keys()]) url.searchParams.set(k, '*'); url.username = ''; url.password = ''; return url.toString().replace(/=%2A/g, '=*'); }
  catch { return String(u).split('?')[0]; }
}

export function createDiagnostics({ max = 50 } = {}) {
  const tabs = new Map(); // tabId -> { reqs: Map(requestId -> {method,url}), items: [] }
  const tab = (id) => tabs.get(id) || tabs.set(id, { reqs: new Map(), items: [] }).get(id);
  const push = (t, item) => { t.items.push({ ...item, at: Date.now() }); if (t.items.length > max) t.items.shift(); };
  return {
    // chrome.debugger.onEvent 핸들러: (source, method, params)
    onEvent({ tabId }, method, p = {}) {
      if (tabId == null) return;
      const t = tab(tabId);
      if (method === 'Network.requestWillBeSent') { t.reqs.set(p.requestId, { method: p.request?.method, url: p.request?.url }); if (t.reqs.size > 500) t.reqs.delete(t.reqs.keys().next().value); }
      else if (method === 'Network.responseReceived' && p.response?.status >= 400) {
        const r = t.reqs.get(p.requestId) || {};
        push(t, { kind: 'http', method: r.method || '?', url: maskUrl(p.response.url || r.url), status: p.response.status, type: p.type });
      } else if (method === 'Network.loadingFailed' && !p.canceled) {
        const r = t.reqs.get(p.requestId) || {};
        push(t, { kind: 'network', method: r.method || '?', url: maskUrl(r.url || ''), error: String(p.errorText || '').slice(0, 200) });
      } else if (method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails || {};
        push(t, { kind: 'exception', message: String(d.exception?.description || d.text || '').split('\n')[0].slice(0, 300), source: d.url ? `${maskUrl(d.url)}:${d.lineNumber + 1}` : '' });
      } else if (method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) {
        push(t, { kind: `console.${p.type}`, message: (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
      }
    },
    get: (tabId) => [...(tabs.get(tabId)?.items || [])],
    clear: (tabId) => tabs.delete(tabId),
  };
}

// 모델에 넘길 짧은 텍스트
export function formatDiagnostics(items) {
  if (!items.length) return '수집된 오류 없음. (진단은 에이전트가 이 탭에 연결된 뒤부터 쌓인다. 문제를 재현한 뒤 다시 호출하라.)';
  return items.map((i) => i.kind === 'http' ? `HTTP ${i.status} ${i.method} ${i.url}` : i.kind === 'network' ? `네트워크 실패 ${i.method} ${i.url} (${i.error})` : `${i.kind}: ${i.message}${i.source ? ` @ ${i.source}` : ''}`).join('\n');
}
