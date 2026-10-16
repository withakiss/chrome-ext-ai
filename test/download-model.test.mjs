import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFiles, REPO } from '../scripts/download-model.mjs';

test('selectFiles keeps configs and only the requested onnx variants (.onnx and .onnx_data)', () => {
  const tree = [
    { type: 'file', path: 'config.json', size: 1 }, { type: 'file', path: 'tokenizer.json', size: 1 }, { type: 'file', path: '.gitattributes', size: 1 }, { type: 'file', path: 'model.safetensors', size: 1 },
    { type: 'file', path: 'onnx/decoder_model_merged_q4.onnx', size: 1 }, { type: 'file', path: 'onnx/decoder_model_merged_q4.onnx_data', size: 1 },
    { type: 'file', path: 'onnx/decoder_model_merged_fp16.onnx', size: 1 }, { type: 'file', path: 'onnx/embed_tokens.onnx', size: 1 },
    { type: 'file', path: 'onnx/embed_tokens_fp16.onnx', size: 1 }, { type: 'directory', path: 'onnx' },
  ];
  assert.deepEqual(selectFiles(tree, ['decoder_model_merged_q4', 'embed_tokens']).map((f) => f.path),
    ['config.json', 'tokenizer.json', 'onnx/decoder_model_merged_q4.onnx', 'onnx/decoder_model_merged_q4.onnx_data', 'onnx/embed_tokens.onnx']);
  assert.equal(REPO, 'HuggingFaceTB/SmolVLM-256M-Instruct');
});
