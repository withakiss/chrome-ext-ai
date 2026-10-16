// OpenAI 호환 chat/completions 스트리밍 클라이언트. vLLM·Ollama·LM Studio 공통.
export const RUN_JS_TOOL = {
  type: 'function',
  function: {
    name: 'run_js',
    description: '브라우저 REPL에서 JavaScript를 실행한다. page, snapshot, openTab, closeTab, tabs, sleep 전역을 쓸 수 있다. 결과는 console.log 출력만 돌아온다.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: '실행할 JavaScript(top-level await 가능)' } }, required: ['code'] },
  },
};

export function parseSSE(buf) {
  const events = [];
  let rest = buf;
  for (;;) {
    const i = rest.indexOf('\n\n');
    if (i < 0) break;
    const block = rest.slice(0, i); rest = rest.slice(i + 2);
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try { events.push(JSON.parse(d)); } catch {}
    }
  }
  return { events, rest };
}

// 서버가 도구 호출을 정식 tool_calls가 아닌 글자로 돌려줄 때(vLLM 도구 파서 미설정 등) 그 글을 도구 호출로 바꾼다.
// Qwen 형식 <tool_call><function=이름><parameter=키>값</parameter></function></tool_call> 과
// JSON 형식 <tool_call>{"name":..,"arguments":{..}}</tool_call> 지원. 반환 { content(도구 글 제거), toolCalls }
const TOOL_START = /<tool_call>|<function=/;
const paramValue = (v) => { const t = v.replace(/^\n/, '').replace(/\n$/, ''); if (/^(-?\d+(\.\d+)?|true|false|null|[[{].*)$/s.test(t.trim())) { try { return JSON.parse(t); } catch {} } return t; };
export function parseTextToolCalls(text) {
  const toolCalls = []; let n = 0;
  const xml = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
  const json = /<tool_call>\s*(\{[\s\S]*?\})\s*(?:<\/tool_call>|$)/g;
  for (const m of text.matchAll(xml)) {
    const args = {}; for (const p of m[2].matchAll(/<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g)) args[p[1]] = paramValue(p[2]);
    toolCalls.push({ id: `txt${++n}`, name: m[1], arguments: JSON.stringify(args) });
  }
  if (!toolCalls.length) for (const m of text.matchAll(json)) {
    try { const j = JSON.parse(m[1]); if (j.name) toolCalls.push({ id: `txt${++n}`, name: j.name, arguments: JSON.stringify(typeof j.arguments === 'string' ? JSON.parse(j.arguments) : j.arguments || {}) }); } catch {}
  }
  if (!toolCalls.length) return { content: text, toolCalls };
  const i = text.search(TOOL_START);
  return { content: text.slice(0, i).trim(), toolCalls };
}

export function createAccumulator() {
  let content = '', reasoning = '', finishReason = null, shown = 0;
  const calls = [];
  // 글자 도구 호출이 시작되면 그 뒤는 화면에 흘리지 않음('<tool_call>'의 앞부분일 수 있는 꼬리도 잠시 보류)
  const visibleEnd = () => { const i = content.search(TOOL_START); if (i >= 0) return i; const lt = content.lastIndexOf('<'); return lt >= 0 && '<tool_call>'.startsWith(content.slice(lt)) || (lt >= 0 && '<function='.startsWith(content.slice(lt))) ? lt : content.length; };
  return {
    push(ev) {
      const out = [];
      const ch = ev.choices?.[0]; if (!ch) return out;
      const d = ch.delta || {};
      if (d.content) { content += d.content; const e = visibleEnd(); if (e > shown) { out.push({ type: 'content', text: content.slice(shown, e) }); shown = e; } }
      const r = d.reasoning ?? d.reasoning_content;
      if (r) { reasoning += r; out.push({ type: 'reasoning', text: r }); }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? 0;
        calls[i] ||= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name = tc.function.name;
        if (tc.function?.arguments) { calls[i].arguments += tc.function.arguments; out.push({ type: 'tool_input', name: calls[i].name, text: calls[i].arguments }); }
      }
      if (ch.finish_reason) finishReason = ch.finish_reason;
      return out;
    },
    flush() { if (TOOL_START.test(content) || shown >= content.length) return null; const t = content.slice(shown); shown = content.length; return { type: 'content', text: t }; }, // 끝에 보류한 '<' 등 남은 글 내보내기
    result() {
      const native = calls.filter(Boolean);
      if (native.length || !TOOL_START.test(content)) return { content, reasoning, toolCalls: native, finishReason };
      const parsed = parseTextToolCalls(content); // 정식 tool_calls가 없을 때만 글자에서 꺼냄
      return { content: parsed.toolCalls.length ? parsed.content : content, reasoning, toolCalls: parsed.toolCalls, finishReason: parsed.toolCalls.length ? 'tool_calls' : finishReason };
    },
  };
}

export async function chatStream({ baseUrl, apiKey = '', model, messages, tools = [], signal, onDelta = () => {}, fetch = globalThis.fetch }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = { model, messages: messages.map(({ raw, ...m }) => m), stream: true }; // raw(Claude 원본 블록)는 OpenAI 호환 서버에 보내지 않음
  if (tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const acc = createAccumulator();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const { events, rest } = parseSSE(buf); buf = rest;
    for (const ev of events) for (const d of acc.push(ev)) onDelta(d);
  }
  const rest = acc.flush(); if (rest) onDelta(rest);
  return acc.result();
}
