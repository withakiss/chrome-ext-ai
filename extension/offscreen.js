// 오프스크린 문서: 브라우저 내 SmolVLM-256M(Transformers.js + ONNX Runtime)을 한 번 올려 두고 이미지 설명 요청을 처리한다.
// 모델 파일은 extension/models/ (동봉, 오프라인). WebGPU 있으면 fp16/q4, 없으면 wasm(CPU)에서 fp32/q8.
import { env, AutoProcessor, AutoModelForVision2Seq, RawImage } from './vendor/transformers.min.js'; // onnxruntime-web 포함 번들

const MODEL = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const DTYPES = {
  webgpu: { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' },
  wasm: { embed_tokens: 'fp32', vision_encoder: 'q8', decoder_model_merged: 'q8' },
};
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
// chrome-extension:// 응답엔 content-length가 없어 Transformers.js가 버퍼를 두 배씩 늘리다 OOM이 난다.
// sizes.json으로 정확한 길이를 붙인 Response를 돌려주는 커스텀 캐시를 쓰고, 브라우저 캐시엔 다시 쓰지 않는다.
env.useBrowserCache = false;
env.useCustomCache = true;
const sizesPromise = fetch(chrome.runtime.getURL('models/sizes.json')).then((r) => r.json()).catch(() => ({}));
env.customCache = {
  async match(url) {
    const u = String(url instanceof Request ? url.url : url);
    const rel = u.split('/models/')[1];
    const size = (await sizesPromise)[rel];
    const r = await fetch(u);
    if (!r.ok) return undefined;
    return new Response(r.body, { status: 200, headers: { 'content-length': String(size ?? ''), 'content-type': 'application/octet-stream' } });
  },
  async put() {},
};

let loading = null, loaded = null, device = null, lastError = null, progress = 0;

async function loadWith(dev) {
  const progress_callback = (p) => { if (p.status === 'progress') progress = p.progress || 0; else if (p.status !== 'progress_total') console.log('[localvlm]', p.status, p.file || ''); };
  const processor = await AutoProcessor.from_pretrained(MODEL);
  const model = await AutoModelForVision2Seq.from_pretrained(MODEL, { device: dev, dtype: DTYPES[dev], progress_callback });
  return { processor, model };
}
async function load(force) {
  if (loaded) return loaded;
  loading ||= (async () => {
    device = force || (navigator.gpu ? 'webgpu' : 'wasm');
    console.log('[localvlm] device', device);
    try { loaded = await loadWith(device); }
    catch (e) { if (device !== 'webgpu' || force) throw e; console.log('[localvlm] webgpu 실패, wasm 폴백:', e?.message); device = 'wasm'; loaded = await loadWith(device); }
    console.log('[localvlm] loaded on', device);
    return loaded;
  })().catch((e) => { lastError = String(e?.message || e); loading = null; throw e; });
  return loading;
}

async function describe(dataUrl, prompt) {
  const { processor, model } = await load();
  const image = await RawImage.fromURL(dataUrl);
  const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  const inputs = await processor(text, [image], { do_image_splitting: false });
  const out = await model.generate({ ...inputs, max_new_tokens: 200, do_sample: false });
  const n = inputs.input_ids.dims.at(-1);
  const decoded = processor.batch_decode(out.slice(null, [n, null]), { skip_special_tokens: true });
  return String(decoded[0] ?? '').trim();
}

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m?.target !== 'offscreen-localvlm') return false;
  (async () => {
    if (m.type === 'status') return { status: loaded ? 'ready' : loading ? 'loading' : lastError ? `error: ${lastError}` : 'idle', device, progress };
    if (m.type === 'load') { await load(m.device); return { status: 'ready', device }; }
    if (m.type === 'describe') return { text: await describe(m.dataUrl, m.prompt) };
    throw new Error(`unknown ${m.type}`);
  })().then(reply, (e) => reply({ error: String(e?.stack || e?.message || e) }));
  return true;
});
