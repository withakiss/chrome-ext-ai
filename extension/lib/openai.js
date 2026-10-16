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

export function createAccumulator() {
  let content = '', reasoning = '', finishReason = null;
  const calls = [];
  return {
    push(ev) {
      const out = [];
      const ch = ev.choices?.[0]; if (!ch) return out;
      const d = ch.delta || {};
      if (d.content) { content += d.content; out.push({ type: 'content', text: d.content }); }
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
    result: () => ({ content, reasoning, toolCalls: calls.filter(Boolean), finishReason }),
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
  return acc.result();
}
