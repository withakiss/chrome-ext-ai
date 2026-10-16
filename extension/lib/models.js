// provider별 모델 목록 조회. 실패하면 수동 입력 목록으로 대체.
export function normalizeModels(kind, json) {
  if (kind === 'ollama') return (json.models || []).map((m) => m.name).filter(Boolean);
  return (json.data || []).map((m) => m.id).filter(Boolean);
}
// 서버 종류별 인증 헤더(Claude는 x-api-key + 버전 헤더)
export function authHeaders({ kind, apiKey }) {
  if (kind === 'anthropic') return { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
export function modelsUrl({ kind, baseUrl }) {
  const b = baseUrl.replace(/\/+$/, '');
  if (kind === 'anthropic') return `${b}/v1/models?limit=100`;
  return kind === 'ollama' ? `${b.replace(/\/v1$/, '')}/api/tags` : `${b}/models`;
}
export async function fetchModels(provider, fetch = globalThis.fetch) {
  try {
    const headers = authHeaders(provider);
    const res = await fetch(modelsUrl(provider), { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = normalizeModels(provider.kind, await res.json());
    return list.length ? list : (provider.models || []);
  } catch { return provider.models || []; }
}
