// 브라우저 내 비전 모델(SmolVLM-256M) 파일을 extension/models/ 에 내려받는다(폐쇄망 반입용·오프라인 동작용).
// 실행: node scripts/download-model.mjs   (재실행 시 크기가 같은 파일은 건너뜀)
import { mkdirSync, existsSync, statSync, createWriteStream, writeFileSync, readFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

export const REPO = 'HuggingFaceTB/SmolVLM-256M-Instruct';
// WebGPU용(fp16/q4)과 CPU(wasm)용(fp32/q8) 두 세트, 합계 약 550MB
export const ONNX = ['embed_tokens_fp16', 'embed_tokens', 'vision_encoder_q4', 'vision_encoder_quantized', 'decoder_model_merged_q4', 'decoder_model_merged_quantized'];

// 설정·토크나이저 전부 + 지정한 onnx 변형(.onnx 와 .onnx_data)
export function selectFiles(tree, onnxNames = ONNX) {
  const want = new Set(onnxNames);
  return tree.filter((f) => f.type === 'file').filter((f) => {
    if (!f.path.startsWith('onnx/')) return /\.(json|jinja|txt)$/.test(f.path) && !f.path.startsWith('.'); // 설정·토크나이저만(safetensors 등 제외)
    return want.has(f.path.slice(5).replace(/\.onnx(_data)?$/, ''));
  });
}

// chrome-extension:// fetch 응답엔 content-length가 없어 Transformers.js가 버퍼를 두 배씩 키우다 OOM → 크기표를 함께 둔다
export function writeSizes(root, list) {
  const p = path.join(root, 'sizes.json');
  const prev = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  for (const f of list) prev[f.path] = f.size;
  writeFileSync(p, JSON.stringify(prev) + '\n');
}

async function main() {
  const root = new URL('../extension/models/', import.meta.url).pathname;
  const dest = path.join(root, REPO);
  const tree = await (await fetch(`https://huggingface.co/api/models/${REPO}/tree/main?recursive=true`)).json();
  const files = selectFiles(tree);
  const total = files.reduce((n, f) => n + (f.size || 0), 0);
  console.log(`${REPO}: ${files.length}개 파일, ${(total / 1e6).toFixed(0)} MB → ${dest}`);
  let done = 0;
  for (const f of files) {
    const out = path.join(dest, f.path);
    mkdirSync(path.dirname(out), { recursive: true });
    if (existsSync(out) && statSync(out).size === f.size) { done += f.size; console.log(`skip ${f.path}`); continue; }
    const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/${f.path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${f.path}`);
    let got = 0, last = 0;
    const counter = new TransformStream({ transform(chunk, c) { got += chunk.length; if (Date.now() - last > 2000) { last = Date.now(); console.log(`${f.path} ${(got / 1e6).toFixed(0)}/${(f.size / 1e6).toFixed(0)} MB  전체 ${(((done + got) / total) * 100).toFixed(1)}%`); } c.enqueue(chunk); } });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(out));
    done += f.size;
    console.log(`ok ${f.path}`);
  }
  writeSizes(root, files.map((f) => ({ path: `${REPO}/${f.path}`, size: f.size })));
  console.log('DONE');
}
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e); process.exit(1); });
