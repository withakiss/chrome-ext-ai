// Chrome 내장 모델(Gemini Nano, Prompt API) 어댑터. chatStream과 같은 시그니처.
// 네이티브 tool calling이 없어 ```json {"tool":"run_js","code":...}``` 블록을 도구 호출로 해석한다.
const OUT = [{ type: 'text', languages: ['en'] }]; // 지원 목록(de,en,es,fr,ja)에 ko가 없어 en으로 선언; 한국어 출력은 실제로 됨
export const BUILTIN_TOOL_HINT = '도구를 쓰려면 답 끝에 아래 형식의 json 코드 블록을 정확히 하나만 출력한다. 블록 밖 설명은 짧게.\n```json\n{"tool":"run_js","code":"<실행할 JavaScript>"}\n```\n파일 저장: {"tool":"save_file","name":"a.txt","content":"<내용>"} / 이미지 생성 도구가 있으면: {"tool":"generate_image","prompt":"<영어 설명>","size":"1024x1024"}';
const BLOCK = /```json\s*([\s\S]*?)```/g;

export function parseToolBlocks(text) {
  const toolCalls = [];
  let content = text, n = 0;
  for (const m of text.matchAll(BLOCK)) {
    try {
      const j = JSON.parse(m[1]);
      if (typeof j.code === 'string') { toolCalls.push({ id: `b${++n}`, name: 'run_js', arguments: JSON.stringify({ code: j.code }) }); content = content.replace(m[0], ''); }
      else if (typeof j.tool === 'string' && j.tool !== 'run_js') { const { tool, ...args } = j; toolCalls.push({ id: `b${++n}`, name: tool, arguments: JSON.stringify(args) }); content = content.replace(m[0], ''); }
    } catch {}
  }
  return { content, toolCalls };
}

const partsOf = (content) => (typeof content === 'string' ? [{ type: 'text', value: content }]
  : content.map((p) => (p.type === 'image_url' ? { type: 'image', value: p.image_url.url } : { type: 'text', value: p.text })));
const textOf = (content) => partsOf(content).filter((p) => p.type === 'text').map((p) => p.value).join('\n');

// 메시지 이력을 Prompt API의 initialPrompts(앞부분)와 마지막 user 프롬프트(parts)로 나눈다.
export function toInitialPrompts(messages, withTools) {
  const msgs = [...messages];
  const lastUser = msgs.length && msgs.at(-1).role === 'user' ? msgs.pop() : null;
  const initialPrompts = [];
  let sys = withTools ? BUILTIN_TOOL_HINT : '';
  for (const m of msgs) {
    if (m.role === 'system') { sys = `${m.content}\n\n${sys}`.trim(); continue; }
    if (m.role === 'tool') { initialPrompts.push({ role: 'user', content: `[도구 출력]\n${m.content}` }); continue; }
    if (m.role === 'assistant') {
      const calls = (m.tool_calls || []).map((c) => { let code = ''; try { code = JSON.parse(c.function.arguments).code; } catch {} return `\n\`\`\`json\n${JSON.stringify({ tool: 'run_js', code })}\n\`\`\``; }).join('');
      initialPrompts.push({ role: 'assistant', content: `${m.content || ''}${calls}`.trim() || '(없음)' }); continue;
    }
    initialPrompts.push({ role: 'user', content: textOf(m.content) || '(없음)' });
  }
  if (sys) initialPrompts.unshift({ role: 'system', content: sys });
  const last = lastUser ? partsOf(lastUser.content) : [{ type: 'text', value: '(계속)' }];
  const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
  return { initialPrompts, last, hasImage };
}

const defaultToBlob = async (dataUrl) => (await fetch(dataUrl)).blob();

export async function builtinChatStream({ messages, tools = [], signal, onDelta = () => {}, LM = globalThis.LanguageModel, toBlob = defaultToBlob }) {
  if (!LM) throw new Error('Chrome 내장 모델: LanguageModel API 없음 (Chrome 138 이상 필요)');
  const { initialPrompts, last, hasImage } = toInitialPrompts(messages, tools.length > 0);
  const expectedInputs = [{ type: 'text' }, ...(hasImage ? [{ type: 'image' }] : [])];
  const avail = await LM.availability({ expectedInputs, expectedOutputs: OUT });
  if (avail !== 'available') throw new Error(`Chrome 내장 모델 사용 불가: ${avail} (설정의 연결 테스트에서 다운로드)`);
  const session = await LM.create({ initialPrompts, expectedInputs, expectedOutputs: OUT, signal });
  const parts = [];
  for (const p of last) parts.push(p.type === 'image' ? { type: 'image', value: await toBlob(p.value) } : p);
  let text = '';
  try {
    for await (const chunk of session.promptStreaming([{ role: 'user', content: parts }], { signal })) { // 배열 입력은 LanguageModelMessage 형식
      const delta = chunk.startsWith(text) ? chunk.slice(text.length) : chunk; // 누적형·증분형 모두 대응
      text += delta;
      if (delta) onDelta({ type: 'content', text: delta });
    }
  } finally { session.destroy?.(); }
  const { content, toolCalls } = parseToolBlocks(text);
  return { content, reasoning: '', toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' };
}

export async function builtinStatus(LM = globalThis.LanguageModel) {
  if (!LM) return 'API 없음';
  try { return await LM.availability({ expectedInputs: [{ type: 'text' }, { type: 'image' }], expectedOutputs: OUT }); } catch (e) { return `오류: ${e.message}`; }
}
export async function builtinDownload(onProgress, LM = globalThis.LanguageModel) {
  const s = await LM.create({ expectedInputs: [{ type: 'text' }, { type: 'image' }], expectedOutputs: OUT, monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress(e.loaded)); } });
  s.destroy?.();
}
