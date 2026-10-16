// 브라우저 내 SmolVLM(오프스크린 문서) 호스트 API. 모델 파일이 extension/models/ 에 있어야 한다.
const MODEL_DIR = 'models/HuggingFaceTB/SmolVLM-256M-Instruct/';

export async function localVlmFilesPresent() {
  try { const r = await fetch(chrome.runtime.getURL(`${MODEL_DIR}config.json`), { method: 'HEAD' }); return r.ok; } catch { return false; }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: '브라우저 내 SmolVLM 추론(WebGPU/wasm)을 유지하기 위해' });
}
const call = async (msg) => { await ensureOffscreen(); const r = await chrome.runtime.sendMessage({ target: 'offscreen-localvlm', ...msg }); if (r?.error) throw new Error(r.error); return r; };

// 'missing' | 'idle' | 'loading' | 'ready' | 'error: …'
export async function localVlmStatus() {
  if (!(await localVlmFilesPresent())) return 'missing';
  try { return (await call({ type: 'status' })).status; } catch (e) { return `error: ${e.message}`; }
}
export const localVlmLoad = (device) => call({ type: 'load', device }); // device: 'webgpu' | 'wasm' | undefined(자동)
export const localVlmDescribe = (dataUrl, prompt) => call({ type: 'describe', dataUrl, prompt }).then((r) => r.text);
