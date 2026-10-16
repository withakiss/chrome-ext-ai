// 에이전트 루프: 모델 ↔ run_js 도구. 한도(도구 25회·10분)와 오래된 도구 출력 접기(32k 대응).
import { RUN_JS_TOOL, chatStream as defaultChatStream } from './openai.js';

const OMITTED = '[이전 출력 생략]';
// 턴 수 기준 + 글자 예산 기준(32k 토큰 ≈ 한국어 6만 자)으로 오래된 도구 출력을 접는다. 최근 2턴은 항상 유지.
export function compactOldToolOutputs(messages, keepTurns = 8, charBudget = 60000) {
  const idx = messages.map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  const cutoff = idx.length > keepTurns ? idx[idx.length - keepTurns] : 0;
  for (let i = 0; i < cutoff; i++) if (messages[i].role === 'tool' && messages[i].content !== OMITTED) messages[i].content = OMITTED;
  const total = () => messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  const protect = idx.length >= 2 ? idx[idx.length - 2] : messages.length - 1; // 턴이 1개뿐이면 마지막 메시지만 보호
  for (let i = 0; i < protect && total() > charBudget; i++) if (messages[i].role === 'tool' && messages[i].content !== OMITTED) messages[i].content = OMITTED;
}

// tools: 모델에 노출할 도구 목록(기본 run_js). runTool(name, args) → { output, image? } 가 있으면 run_js 외 도구를 처리한다. 이미지는 대화 기록에 넣지 않고 이벤트로만 전달.
// 오래된 user 메시지의 첨부·선택 영역 블록을 접는다(질문 문장은 유지). 최근 keepTurns 턴은 그대로.
const ATTACH_HEAD = /^\[(화면 선택 영역|첨부 \d+:)/;
export function compactAttachments(messages, keepTurns = 4) {
  const idx = messages.map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  const cutoff = idx.length >= keepTurns ? idx[idx.length - keepTurns] : 0;
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i]; if (m.role !== 'user') continue;
    const text = Array.isArray(m.content) ? (m.content.find((p) => p.type === 'text')?.text || '') : m.content;
    if (!ATTACH_HEAD.test(text)) continue;
    const parts = text.split('\n\n'); const question = parts.at(-1);
    m.content = `[이전 첨부·선택 영역 생략]\n\n${question}`;
  }
}
const isContextError = (e) => /context length|maximum context|context_length|too many tokens|prompt is too long/i.test(String(e?.message || e));

export async function runAgent({ messages, provider, model, runJs, runTool, tools = [RUN_JS_TOOL], chatStream = defaultChatStream, onEvent, signal, maxTools = 25, maxMs = 600000 }) {
  const started = Date.now();
  let toolCount = 0, retriedContext = false;
  try {
    for (;;) {
      if (Date.now() - started > maxMs) throw new Error('시간 한도(10분) 초과');
      compactOldToolOutputs(messages, 8, 45000); // 한국어·트리 기준 약 1.5~2자/토큰 → 32k 토큰에 여유
      compactAttachments(messages, 4);
      let r;
      try { r = await chatStream({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, messages, tools, signal, onDelta: onEvent }); }
      catch (e) { // 컨텍스트 초과면 한 번만 세게 접고 재시도
        if (!isContextError(e) || retriedContext) throw e;
        retriedContext = true; compactOldToolOutputs(messages, 2, 20000); compactAttachments(messages, 1);
        onEvent({ type: 'reasoning', text: '(컨텍스트 초과 — 오래된 첨부·출력을 접고 재시도)\n' });
        continue;
      }
      const assistant = { role: 'assistant', content: r.content || '' };
      if (r.reasoning) assistant.reasoning = r.reasoning;
      if (r.raw) assistant.raw = r.raw; // Claude: 생각 블록 서명까지 원본 그대로 다시 보내야 함
      if (r.toolCalls.length) assistant.tool_calls = r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      messages.push(assistant);
      if (!r.toolCalls.length) { onEvent({ type: 'done' }); return; }
      let limitHit = false, finished = false;
      for (const call of r.toolCalls) {
        let out, image, file, final, data;
        if (limitHit || ++toolCount > maxTools) { limitHit = true; out = `도구 호출 한도(${maxTools}회) 초과로 실행하지 않음`; }
        else {
          let args;
          try { args = JSON.parse(call.arguments || '{}'); }
          catch (e) { out = `arguments JSON 파싱 실패: ${e.message}\n받은 값: ${call.arguments}`; }
          if (args) {
            if (call.name === 'run_js' || !runTool) { const code = args.code ?? ''; onEvent({ type: 'tool_call', id: call.id, name: 'run_js', code, args }); out = await runJs(code); }
            else { onEvent({ type: 'tool_call', id: call.id, name: call.name, args }); try { ({ output: out, image, file, final, data } = await runTool(call.name, args)); if (final) finished = true; } catch (e) { out = `${call.name} 실패: ${e.message}`; } }
          }
          onEvent({ type: 'tool_output', id: call.id, name: call.name, output: out, image, file, data });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: out }); // 모든 tool_call에 짝을 맞춰 다음 요청이 400 나지 않게
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      }
      if (finished) { onEvent({ type: 'done' }); return; } // runTool이 final을 돌려주면(answer 도구 통과) 루프 종료
      if (limitHit) throw new Error(`도구 호출 한도(${maxTools}회) 초과`);
    }
  } catch (e) {
    let message = String(e?.message || e);
    if (e?.name === 'AbortError') message = '중지됨';
    else if (/^HTTP 404/.test(message)) message = `${provider.label || '모델 서버'}(${provider.baseUrl})가 404를 돌려줬습니다. 서버가 꺼져 있거나 주소·모델 이름이 틀립니다. 아래 모델 선택에서 다른 서버를 고르거나 설정을 확인하세요.${message.length > 10 ? `\n${message}` : ''}`;
    else if (/^HTTP 401/.test(message)) message = `${provider.label || '모델 서버'} API 키가 틀렸거나 없습니다(설정 → ${provider.label || '서버'} → API 키).\n${message}`;
    else if (/Failed to fetch|NetworkError|fetch failed/i.test(message)) message = `모델 서버에 연결할 수 없습니다: ${provider.baseUrl} (주소·서버 상태·host_permissions 확인)`;
    onEvent({ type: 'error', message });
  }
}
