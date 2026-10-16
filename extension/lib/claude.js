// Claude Messages API 어댑터(raw fetch). 확장은 빌드·npm 의존성이 없어 SDK 대신 HTTP로 부른다.
// chatStream(openai.js)과 같은 시그니처·결과({content, reasoning, toolCalls, finishReason, raw})를 돌려준다.
// 대화 기록은 OpenAI 형식으로 저장되므로 보낼 때 Claude 형식으로 바꾸고, 받은 블록 원본(raw)은 생각 블록 서명 보존을 위해 그대로 저장·재전송한다.
import { parseSSE } from './openai.js';

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const CLAUDE_MORE_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'];
export const CLAUDE_NAMES = { 'claude-opus-5-5': 'Opus 5.5', 'claude-fable-5-1': 'Fable 5.1', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-haiku-4-5': 'Haiku 4.5', 'claude-sonnet-5': 'Sonnet 5', 'claude-opus-5': 'Opus 5', 'claude-fable-5': 'Fable 5', 'claude-opus-4-8': 'Opus 4.8', 'claude-opus-4-7': 'Opus 4.7', 'claude-opus-4-6': 'Opus 4.6', 'claude-sonnet-4-6': 'Sonnet 4.6' };
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5-5']); // 서버 측 거절 대체(fallbacks: "default") 지원
const NO_ADAPTIVE = /^claude-(haiku-4-5|.*-4-5|.*-3)/; // 적응형 생각·effort 미지원(이전 세대)

export function claudeHeaders(apiKey, betas = []) {
  const h = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  if (betas.length) h['anthropic-beta'] = betas.join(',');
  return h;
}

const dataUrlImage = (url) => { const m = /^data:([^;]+);base64,(.*)$/.exec(url || ''); return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null; };
const parseArgs = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

// 거절 대체가 일어난 턴을 되돌려 보낼 때: 마지막 fallback 블록 앞의 text 외 블록(생각·도구 호출)은 뺀다.
export function echoBlocks(raw) {
  const last = raw.map((b) => b.type).lastIndexOf('fallback');
  return last < 0 ? raw : raw.filter((b, i) => i > last || b.type === 'text');
}

// OpenAI 형식 messages → { system, messages }(Claude 형식). 연속 tool 결과는 user 메시지 하나로 묶는다.
export function toClaudeMessages(messages) {
  const sys = []; const out = [];
  const push = (role, blocks) => { const prev = out.at(-1); if (prev && prev.role === role && role === 'user' && blocks.every((b) => b.type === 'tool_result') && prev.content.every?.((b) => b.type === 'tool_result')) prev.content.push(...blocks); else out.push({ role, content: blocks }); };
  for (const m of messages) {
    if (m.role === 'system') { sys.push(typeof m.content === 'string' ? m.content : ''); continue; }
    if (m.role === 'tool') { push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') || '(출력 없음)' }]); continue; }
    if (m.role === 'assistant') {
      if (Array.isArray(m.raw) && m.raw.length) { out.push({ role: 'assistant', content: echoBlocks(m.raw) }); continue; }
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(빈 응답)' }] });
      continue;
    }
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content || '(빈 메시지)' }]
      : m.content.map((p) => (p.type === 'image_url' ? dataUrlImage(p.image_url.url) : { type: 'text', text: p.text || '' })).filter(Boolean);
    out.push({ role: 'user', content });
  }
  return { system: sys.filter(Boolean).join('\n\n'), messages: out };
}

// OpenAI 도구 정의 → Claude 도구 정의. 스트리밍이라 큰 입력이 바로 흐르게 eager_input_streaming(입력 검증은 우리 쪽 JSON.parse·도구별 검사).
export const toClaudeTools = (tools) => tools.map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} }, eager_input_streaming: true }));

// 요청 본문(모델별 생각·effort·거절 대체)과 베타 목록
export function buildRequest({ baseUrl, model, messages, tools = [] }) {
  const { system, messages: msgs } = toClaudeMessages(messages);
  const body = { model, max_tokens: 64000, stream: true, messages: msgs };
  if (system) body.system = system;
  if (tools.length) body.tools = toClaudeTools(tools);
  const betas = [];
  if (!NO_ADAPTIVE.test(model)) {
    // 이 확장은 오래된 도구 출력을 접고 모드별로 시스템 프롬프트를 바꾼다 → 대화가 바뀌면 생각 블록만 버리고 진행(drop_block)
    body.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
    body.output_config = { effort: 'high' };
    betas.push('thinking-binding-controls-2026-08-01');
  }
  if (FALLBACK_MODELS.has(model) && /(^|\/\/)api\.anthropic\.com/.test(baseUrl)) { body.fallbacks = 'default'; betas.push('server-side-fallback-2026-07-01'); }
  return { body, betas };
}

// SSE 이벤트 누적기
export function createClaudeAccumulator() {
  const blocks = []; let stopReason = null;
  return {
    push(ev) {
      const out = [];
      if (ev.type === 'error') throw new Error(`Claude API 오류: ${ev.error?.message || JSON.stringify(ev.error)}`);
      if (ev.type === 'content_block_start') { const b = { ...ev.content_block }; if (b.type === 'tool_use') b._json = ''; if (b.type === 'thinking') b.thinking ||= ''; if (b.type === 'text') b.text ||= ''; blocks[ev.index] = b; }
      else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index]; const d = ev.delta || {}; if (!b) return out;
        if (d.type === 'text_delta') { b.text += d.text; out.push({ type: 'content', text: d.text }); }
        else if (d.type === 'input_json_delta') { b._json += d.partial_json || ''; out.push({ type: 'tool_input', name: b.name, text: b._json }); }
        else if (d.type === 'thinking_delta') { b.thinking += d.thinking || ''; if (d.thinking) out.push({ type: 'reasoning', text: d.thinking }); }
        else if (d.type === 'signature_delta') b.signature = (b.signature || '') + (d.signature || '');
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      return out;
    },
    result() {
      let raw = blocks.filter(Boolean).map((b) => { if (b.type !== 'tool_use') return b; const { _json, ...rest } = b; return { ...rest, input: _json ? parseArgs(_json) : (rest.input || {}), _args: _json || JSON.stringify(rest.input || {}) }; });
      const after = raw.map((b) => b.type).lastIndexOf('fallback');
      let toolCalls = raw.filter((b, i) => b.type === 'tool_use' && i > after).map((b) => ({ id: b.id, name: b.name, arguments: b._args }));
      let content = raw.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const reasoning = raw.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('\n');
      // 도구를 실행하기 전에 멈춘 이유부터 본다: 출력 한도면 도구 입력이 잘렸을 수 있고, 거절이면 실행하지 않는다
      if (toolCalls.length && (stopReason === 'max_tokens' || stopReason === 'refusal')) { toolCalls = []; raw = raw.filter((b) => b.type !== 'tool_use'); content += stopReason === 'refusal' ? '' : '\n(출력 한도에 걸려 도구 호출이 잘렸습니다. 더 작게 나눠 다시 요청하세요.)'; }
      if (stopReason === 'refusal') content += '\n(모델이 이 요청을 거절했습니다.)';
      raw = raw.map(({ _args, ...b }) => b);
      return { content, reasoning, toolCalls, finishReason: stopReason, raw };
    },
  };
}

export async function claudeChatStream({ baseUrl = 'https://api.anthropic.com', apiKey = '', model, messages, tools = [], signal, onDelta = () => {}, fetch = globalThis.fetch }) {
  if (!apiKey) throw new Error('Claude API 키가 없습니다(설정 → Claude → API 키)');
  const { body, betas } = buildRequest({ baseUrl, model, messages, tools });
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, { method: 'POST', headers: claudeHeaders(apiKey, betas), body: JSON.stringify(body), signal });
  if (!res.ok) { const t = await res.text(); let msg = t.slice(0, 300); try { msg = JSON.parse(t).error?.message || msg; } catch {} throw new Error(`HTTP ${res.status}: ${msg}`); }
  const acc = createClaudeAccumulator();
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const { events, rest } = parseSSE(buf); buf = rest;
    for (const ev of events) for (const d of acc.push(ev)) onDelta(d);
  }
  return acc.result();
}
