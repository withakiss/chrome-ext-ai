import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const m = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));

test('manifest has required MV3 keys', () => {
  assert.equal(m.manifest_version, 3);
  assert.equal(m.side_panel.default_path, 'sidepanel.html');
  for (const p of ['sidePanel', 'storage', 'unlimitedStorage', 'tabs', 'scripting', 'debugger', 'webNavigation', 'activeTab', 'offscreen'])
    assert.ok(m.permissions.includes(p), p);
  assert.deepEqual(m.host_permissions, ['<all_urls>']);
  assert.deepEqual(m.sandbox.pages, ['repl.html']);
  // 동적 import()는 Chrome 155에서 "Unsafe attempt to load URL" 로 막힘 → 일반 스크립트 2개를 순서대로 주입
  assert.deepEqual(m.content_scripts[0].js, ['lib/snapshot-core.js', 'lib/content-main.js']);
  assert.equal(m.content_scripts[0].all_frames, false);
  assert.equal(m.web_accessible_resources, undefined);
  assert.match(m.content_security_policy.extension_pages, /'wasm-unsafe-eval'/); // 브라우저 내 SmolVLM(onnxruntime wasm)
});

test('sandbox CSP blocks network from model code', () => {
  const csp = m.content_security_policy.sandbox;
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /default-src 'none'/);
});
