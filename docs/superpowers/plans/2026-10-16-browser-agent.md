# 브라우저 에이전트 확장 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사이드 패널에서 접근성 트리 스냅샷으로 페이지를 읽고 CDP로 조작하며, OpenAI 호환 LLM을 골라 쓰는 Chrome MV3 확장을 폴더 하나로 만든다.

**Architecture:** 에이전트 루프는 사이드 패널 페이지에서 돈다. 모델은 도구 `run_js` 하나로 JS를 쓰고, 그 코드는 manifest `sandbox` iframe(`repl.html`)에서 eval된다. 샌드박스의 `page/snapshot/openTab` 호출은 postMessage RPC로 사이드 패널의 `bridge.js`에 전달되어 content script(스냅샷·좌표)와 `chrome.debugger`(마우스·키 입력)로 실행된다.

**Tech Stack:** 순수 JS(ES 모듈), Chrome MV3 API(sidePanel, debugger, tabs, scripting, webNavigation, storage), `node --test`(의존성 0). 번들러·TypeScript·npm 패키지 없음.

**Spec:** `docs/superpowers/specs/2026-10-16-browser-agent-design.md`

## Global Constraints
- 런타임 외부 접속 0건: CDN·웹스토어·npm·브라우저 다운로드 금지. 폰트·스타일·스크립트는 전부 `extension/` 안 파일.
- 설치는 "압축해제된 확장 프로그램 로드" 한 번. 빌드 단계 없음(번들러·TS 미사용).
- 모델 호출은 OpenAI 호환 `POST {baseUrl}/chat/completions` + `stream: true` + `tools` 하나(`run_js`)로 통일. 키 없으면 `Authorization` 헤더 생략.
- 스냅샷 형식: `role "name" [ref=e12] [level=2] [checked] [disabled] [focused] [selected] [placeholder="…"]`, 들여쓰기 2칸, iframe 접두어 `f1e3`, 상한 20,000자.
- 비밀번호·카드·OTP 입력값은 `[value redacted]`.
- REPL: `return` 무시, `console.log`만 반환, 출력 30KB 상한, 1회 120초, 도구 호출 25회/프롬프트, 전체 10분.
- 8턴 지난 `tool` 메시지 본문은 `[이전 출력 생략]`으로 치환.
- 기본 providers: RunPod `https://<vllm-host>/v1` / `openai/gpt-oss-120b`, Ollama `http://localhost:11434/v1`, LM Studio `http://localhost:1234/v1`.
- UI는 라이트 모드만(`data-theme="light"`, `color-scheme: light`). 이모지·장식 금지.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus
1. 스냅샷에 `"`·줄바꿈이 든 name → 한 줄 유지·따옴표 이스케이프(Task 2 테스트 `escapes quotes and newlines`).
2. `tool_calls.arguments`가 여러 SSE 조각으로 쪼개져 오거나 빈 조각이 섞임 → 합쳐서 유효 JSON(Task 6 테스트 `merges split tool_call arguments`).
3. `chrome://`·웹스토어 탭처럼 debugger attach가 거부되는 탭 → run_js 결과로 오류 문자열 반환, 루프는 계속(Task 4 테스트 `attach failure returns error string`).
4. 모델 코드가 `return`만 쓰고 `console.log`가 없음 → 출력 `(출력 없음)`으로 모델에 알림(Task 5 테스트 `no console output yields placeholder`).
5. 모델 서버가 401/404/연결 실패 → 본문 그대로 오류 이벤트, 루프 종료, 중지 버튼 상태 복구(Task 7 테스트 `http error ends loop with error event`).

---

## 파일 구조
```
extension/
  manifest.json
  background.js                 액션 클릭·Cmd+E → 사이드 패널 열기
  sidepanel.html / sidepanel.css / sidepanel.js   UI + 루프 조립
  repl.html / repl.js           샌드박스: RPC 클라이언트 + repl-core 호출
  content/snapshot.js           loader: lib/content-main.js 동적 import
  lib/content-main.js           DOM 워커·ref 레지스트리·메시지 핸들러(탭 안에서 실행)
  lib/snapshot-core.js          순수 함수: role/name/filter/fold/render/diff/truncate
  lib/cdp.js                    chrome.debugger 래퍼: attach/click/insertText/pressKey
  lib/bridge.js                 RPC 서버: page.* 호출 → content script + cdp + tabs
  lib/repl-core.js              순수: 전역 구성·코드 실행·console 캡처·출력 자르기
  lib/openai.js                 SSE 파서·tool_calls 누적·chatStream
  lib/models.js                 provider별 모델 목록 정규화·조회
  lib/agent.js                  루프: run_js 도구·한도·오래된 출력 접기
  lib/store.js                  chrome.storage.local: settings·sessions
  prompts/system.md             시스템 프롬프트
test/
  *.test.mjs                    node --test
  fixture/search.html, fixture/result-1.html … result-5.html
docs/manual-test.md
```

---

### Task 1: 뼈대 — manifest · background · 사이드 패널 · 샌드박스 echo

**Files:**
- Create: `extension/manifest.json`, `extension/background.js`, `extension/sidepanel.html`, `extension/sidepanel.css`, `extension/sidepanel.js`, `extension/repl.html`, `extension/repl.js`, `package.json`
- Test: `test/manifest.test.mjs`

**Interfaces:**
- Produces: repl iframe 메시지 규약 `{type:'run', id, code, tabId}` → `{type:'result', id, output, error}` (이 Task에서는 echo만), RPC `{type:'rpc', id, call, args}` → `{type:'rpc-result', id, ok, value|error}`.

- [ ] **Step 1: 실패하는 manifest 테스트 작성**

```js
// test/manifest.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const m = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));

test('manifest has required MV3 keys', () => {
  assert.equal(m.manifest_version, 3);
  assert.equal(m.side_panel.default_path, 'sidepanel.html');
  for (const p of ['sidePanel','storage','unlimitedStorage','tabs','scripting','debugger','webNavigation','activeTab'])
    assert.ok(m.permissions.includes(p), p);
  assert.deepEqual(m.host_permissions, ['<all_urls>']);
  assert.deepEqual(m.sandbox.pages, ['repl.html']);
  assert.equal(m.content_scripts[0].js[0], 'content/snapshot.js');
  assert.ok(m.web_accessible_resources[0].resources.includes('lib/content-main.js'));
  assert.ok(m.web_accessible_resources[0].resources.includes('lib/snapshot-core.js'));
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/manifest.test.mjs`
Expected: FAIL (ENOENT manifest.json)

- [ ] **Step 3: manifest · package.json 작성**

```json
// extension/manifest.json
{
  "manifest_version": 3,
  "name": "Local Browser Agent",
  "version": "0.1.0",
  "description": "사이드 패널 브라우저 에이전트 (접근성 트리 + CDP, OpenAI 호환 LLM 선택)",
  "minimum_chrome_version": "116",
  "action": { "default_title": "Open agent panel" },
  "side_panel": { "default_path": "sidepanel.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["sidePanel","storage","unlimitedStorage","tabs","scripting","debugger","webNavigation","activeTab"],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [{ "matches": ["<all_urls>"], "js": ["content/snapshot.js"], "run_at": "document_idle", "all_frames": true }],
  "web_accessible_resources": [{ "resources": ["lib/content-main.js","lib/snapshot-core.js"], "matches": ["<all_urls>"] }],
  "sandbox": { "pages": ["repl.html"] },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'",
    "sandbox": "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  },
  "commands": { "_execute_action": { "suggested_key": { "default": "Ctrl+E", "mac": "Command+E" }, "description": "Toggle agent panel" } }
}
```

```json
// package.json
{ "name": "chrome-ext-ai", "private": true, "type": "module", "scripts": { "test": "node --test test/" } }
```

- [ ] **Step 4: background.js**

```js
// extension/background.js
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
```

- [ ] **Step 5: 사이드 패널 뼈대 + 샌드박스 echo**

```html
<!-- extension/sidepanel.html -->
<!doctype html>
<html lang="ko" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent</title>
<link rel="stylesheet" href="sidepanel.css">
</head>
<body>
<div id="app">
  <header id="top"><select id="sessionSelect"></select><button id="newChat">새 채팅</button><button id="settingsBtn">설정</button></header>
  <main id="messages"></main>
  <footer>
    <div id="tabChip"></div>
    <textarea id="input" rows="3" placeholder="메시지를 입력하세요"></textarea>
    <div id="bar"><select id="modelSelect"></select><button id="send">보내기</button><button id="stop" hidden>중지</button></div>
  </footer>
  <section id="settings" hidden></section>
</div>
<iframe id="repl" src="repl.html" sandbox="allow-scripts" hidden></iframe>
<script type="module" src="sidepanel.js"></script>
</body>
</html>
```

```css
/* extension/sidepanel.css */
:root { color-scheme: light; --bg:#fff; --fg:#111; --muted:#666; --line:#e5e5e5; --accent:#1a73e8; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui, sans-serif; }
#app { display:flex; flex-direction:column; height:100vh; }
#top, #bar { display:flex; gap:6px; padding:8px; border-bottom:1px solid var(--line); }
#bar { border-bottom:0; border-top:1px solid var(--line); }
#messages { flex:1; overflow:auto; padding:8px; }
footer { border-top:1px solid var(--line); }
#tabChip { font-size:12px; color:var(--muted); padding:4px 8px; }
textarea { width:100%; border:0; padding:8px; resize:none; font:inherit; }
.msg { margin:6px 0; padding:8px; border-radius:8px; white-space:pre-wrap; }
.msg.user { background:#f1f3f4; }
.msg.assistant { background:#fff; border:1px solid var(--line); }
.msg.error { background:#fdecea; color:#b3261e; }
details.tool { margin:4px 0; font-size:12px; }
details.tool pre { background:#f8f9fa; padding:6px; overflow:auto; max-height:240px; }
button { font:inherit; }
```

```js
// extension/sidepanel.js (Task 1 버전: 샌드박스 echo 확인만)
const repl = document.getElementById('repl');
window.addEventListener('message', (e) => {
  if (e.source !== repl.contentWindow) return;
  console.log('[repl]', e.data);
});
repl.addEventListener('load', () => {
  repl.contentWindow.postMessage({ type: 'run', id: 'ping', code: 'console.log("pong")', tabId: null }, '*');
});
```

```html
<!-- extension/repl.html -->
<!doctype html><html><head><meta charset="utf-8"></head><body><script src="repl.js"></script></body></html>
```

```js
// extension/repl.js (Task 1 버전: echo. Task 5에서 repl-core 연결)
window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const { type, id, code } = e.data || {};
  if (type !== 'run') return;
  window.parent.postMessage({ type: 'result', id, output: `echo: ${code}`, error: null }, '*');
});
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `node --test test/manifest.test.mjs`
Expected: PASS

- [ ] **Step 7: 수동 확인**

`chrome://extensions` → 개발자 모드 → 압축해제된 확장 프로그램 로드 → `extension/`. 툴바 아이콘 클릭 → 사이드 패널이 열리고, 패널 우클릭 → 검사 → 콘솔에 `[repl] {type:'result', id:'ping', output:'echo: console.log("pong")'}`.

- [ ] **Step 8: 커밋**

```bash
git add package.json extension test/manifest.test.mjs
git commit -m "feat: 확장 뼈대(manifest, 사이드 패널, 샌드박스 echo)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: snapshot-core — 순수 함수 (role/name/filter/fold/render/diff/truncate)

**Files:**
- Create: `extension/lib/snapshot-core.js`
- Test: `test/snapshot-core.test.mjs`

**Interfaces:**
- Produces(모두 export):
  - `computeRole({tag, attrs})` → string
  - `computeName({tag, attrs, text, value}, labelText='')` → string (`isSensitive`면 값 대신 `[value redacted]`)
  - `isSensitive({attrs})` → boolean
  - `INTERACTIVE_ROLES`: Set
  - Node 타입: `{role, name, ref?, level?, hidden?, checked?, disabled?, focused?, selected?, placeholder?, children: Node[]}`; 텍스트 잎은 `{role:'text', name, children:[]}`
  - `filterInteractive(node)` → Node|null (상호작용 노드 또는 그 자손을 가진 노드만)
  - `foldLeafText(node)` → Node (제자리 수정 후 반환)
  - `renderTree(root)` → string
  - `truncateTree(text, max=20000)` → string
  - `diffLines(prev, next)` → string

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/snapshot-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRole, computeName, isSensitive, filterInteractive, foldLeafText, renderTree, truncateTree, diffLines } from '../extension/lib/snapshot-core.js';

const el = (tag, attrs = {}, text = '', value = '') => ({ tag, attrs, text, value });

test('computeRole maps tags and respects role attr', () => {
  assert.equal(computeRole(el('a')), 'link');
  assert.equal(computeRole(el('input', { type: 'checkbox' })), 'checkbox');
  assert.equal(computeRole(el('input', { type: 'submit' })), 'button');
  assert.equal(computeRole(el('input')), 'textbox');
  assert.equal(computeRole(el('select')), 'combobox');
  assert.equal(computeRole(el('h2')), 'heading');
  assert.equal(computeRole(el('div', { role: 'dialog' })), 'dialog');
  assert.equal(computeRole(el('span')), 'generic');
});

test('computeName priority: aria-label > placeholder > title > alt > label > text > value', () => {
  assert.equal(computeName(el('input', { 'aria-label': 'Search', placeholder: 'x' })), 'Search');
  assert.equal(computeName(el('input', { placeholder: '검색' })), '검색');
  assert.equal(computeName(el('img', { alt: 'logo' })), 'logo');
  assert.equal(computeName(el('input', {}), 'Email'), 'Email');
  assert.equal(computeName(el('button', {}, '  Go  ')), 'Go');
  assert.equal(computeName(el('input', { type: 'text' }, '', 'hello')), 'hello');
  assert.equal(computeName(el('input', { type: 'text' }, '', 'x'.repeat(60))), '');
});

test('sensitive inputs are redacted', () => {
  assert.ok(isSensitive(el('input', { type: 'password' })));
  assert.ok(isSensitive(el('input', { autocomplete: 'cc-number' })));
  assert.ok(isSensitive(el('input', { autocomplete: 'one-time-code' })));
  assert.equal(computeName(el('input', { type: 'password' }, '', 'secret')), '[value redacted]');
  assert.equal(computeName(el('input', { type: 'password' }, '', '')), '');
});

const tree = () => ({ role: 'fragment', name: '', children: [
  { role: 'generic', name: '', children: [
    { role: 'text', name: 'hello', children: [] },
    { role: 'button', name: 'OK', ref: 'e1', children: [] },
  ]},
  { role: 'paragraph', name: '', children: [{ role: 'text', name: 'plain', children: [] }] },
]});

test('filterInteractive keeps only interactive nodes and their ancestors', () => {
  const out = filterInteractive(tree());
  assert.equal(out.children.length, 1);
  assert.equal(out.children[0].children.length, 1);
  assert.equal(out.children[0].children[0].ref, 'e1');
});

test('foldLeafText merges text-only children into parent name', () => {
  const n = { role: 'link', name: '', ref: 'e2', children: [
    { role: 'text', name: 'Read', children: [] }, { role: 'text', name: 'more', children: [] } ] };
  foldLeafText(n);
  assert.equal(n.name, 'Read more');
  assert.equal(n.children.length, 0);
});

test('renderTree prints one line per node with attributes', () => {
  const root = { role: 'fragment', name: '', children: [
    { role: 'heading', name: 'Title', level: 2, children: [] },
    { role: 'checkbox', name: 'Agree', ref: 'e3', checked: true, disabled: true, children: [] },
    { role: 'textbox', name: '', ref: 'e4', placeholder: 'Search', focused: true, children: [] },
  ]};
  assert.equal(renderTree(root), [
    'heading "Title" [level=2]',
    'checkbox "Agree" [ref=e3] [checked] [disabled]',
    'textbox [ref=e4] [focused] [placeholder="Search"]',
  ].join('\n'));
});

test('renderTree indents children by two spaces', () => {
  const root = { role: 'fragment', name: '', children: [
    { role: 'list', name: '', ref: 'e1', children: [{ role: 'listitem', name: 'a', ref: 'e2', children: [] }] } ]};
  assert.equal(renderTree(root), 'list [ref=e1]\n  listitem "a" [ref=e2]');
});

test('escapes quotes and newlines in names', () => {
  const root = { role: 'fragment', name: '', children: [{ role: 'button', name: 'Say "hi"\nnow', ref: 'e1', children: [] }] };
  assert.equal(renderTree(root), 'button "Say \\"hi\\" now" [ref=e1]');
});

test('truncateTree cuts at limit with a note', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const out = truncateTree(text, 200);
  assert.ok(out.length < 320);
  assert.match(out, /\[… \d+줄 생략, selector로 범위를 좁히세요\]$/);
  assert.equal(truncateTree('short', 200), 'short');
});

test('diffLines shows added and removed lines', () => {
  assert.equal(diffLines('a\nb\nc', 'a\nc\nd'), '- b\n+ d');
  assert.equal(diffLines('a', 'a'), '(변경 없음)');
  assert.equal(diffLines('', 'a'), '+ a');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/snapshot-core.test.mjs`
Expected: FAIL (Cannot find module snapshot-core.js)

- [ ] **Step 3: 구현**

```js
// extension/lib/snapshot-core.js
const TAG_ROLES = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'image', nav: 'navigation',
  main: 'main', header: 'banner', footer: 'contentinfo', section: 'region', article: 'article', aside: 'complementary',
  form: 'form', table: 'table', ul: 'list', ol: 'list', li: 'listitem', label: 'label', p: 'paragraph', dialog: 'dialog',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', option: 'option' };
const INPUT_ROLES = { submit: 'button', button: 'button', reset: 'button', image: 'button', file: 'button', checkbox: 'checkbox', radio: 'radio' };
export const INTERACTIVE_ROLES = new Set(['link','button','textbox','checkbox','radio','combobox','option','listitem','tab','menuitem','slider','switch','searchbox']);
const SENSITIVE_AUTOCOMPLETE = ['current-password','new-password','one-time-code','cc-number','cc-csc','cc-exp','cc-exp-month','cc-exp-year'];

export function computeRole({ tag, attrs }) {
  if (attrs.role) return attrs.role;
  if (tag === 'input') return INPUT_ROLES[(attrs.type || '').toLowerCase()] || 'textbox';
  return TAG_ROLES[tag] || 'generic';
}

export function isSensitive({ attrs }) {
  const t = (attrs.type || '').toLowerCase();
  if (t === 'password' || t === 'hidden') return true;
  const ac = (attrs.autocomplete || '').toLowerCase();
  return SENSITIVE_AUTOCOMPLETE.some((k) => ac.includes(k));
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

export function computeName(el, labelText = '') {
  const { tag, attrs, text, value } = el;
  for (const k of ['aria-label', 'placeholder', 'title', 'alt']) if (clean(attrs[k])) return clean(attrs[k]);
  if (clean(labelText)) return clean(labelText);
  if (tag === 'input' || tag === 'textarea') {
    if (isSensitive(el)) return value ? '[value redacted]' : '';
    if (tag === 'input' && (attrs.type || '').toLowerCase() === 'submit' && clean(attrs.value)) return clean(attrs.value);
    return value && value.length < 50 ? clean(value) : '';
  }
  return clean(text);
}

export function filterInteractive(node) {
  const kids = node.children.map(filterInteractive).filter(Boolean);
  const keep = INTERACTIVE_ROLES.has(node.role) && node.ref;
  if (!keep && kids.length === 0) return null;
  return { ...node, children: kids };
}

export function foldLeafText(node) {
  for (const c of node.children) if (c.role !== 'text') foldLeafText(c);
  if (!node.ref || node.name || node.children.length === 0 || node.children.length > 3) return node;
  if (!node.children.every((c) => c.role === 'text' && c.name)) return node;
  node.name = clean(node.children.map((c) => c.name).join(' '));
  node.children = [];
  return node;
}

const esc = (s) => clean(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function lineOf(n) {
  const p = [n.role];
  if (n.name) p.push(`"${esc(n.name)}"`);
  if (n.ref) p.push(`[ref=${n.ref}]`);
  if (n.level) p.push(`[level=${n.level}]`);
  for (const f of ['hidden','scrollable','checked','disabled','focused','selected']) if (n[f]) p.push(`[${f}]`);
  if (n.placeholder) p.push(`[placeholder="${esc(n.placeholder)}"]`);
  return p.join(' ');
}

export function renderTree(root) {
  const lines = [];
  const walk = (n, depth) => {
    if (n.role !== 'fragment') lines.push('  '.repeat(depth) + (n.role === 'text' ? `text "${esc(n.name)}"` : lineOf(n)));
    const d = n.role === 'fragment' ? depth : depth + 1;
    for (const c of n.children) walk(c, d);
  };
  walk(root, 0);
  return lines.join('\n');
}

export function truncateTree(text, max = 20000) {
  if (text.length <= max) return text;
  const kept = text.slice(0, max);
  const cut = kept.lastIndexOf('\n');
  const head = cut > 0 ? kept.slice(0, cut) : kept;
  const omitted = text.slice(head.length).split('\n').length - 1;
  return `${head}\n[… ${omitted}줄 생략, selector로 범위를 좁히세요]`;
}

export function diffLines(prev, next) {
  const a = prev ? prev.split('\n') : [], b = next ? next.split('\n') : [];
  const setA = new Set(a), setB = new Set(b);
  const out = [];
  for (const l of a) if (!setB.has(l)) out.push(`- ${l}`);
  for (const l of b) if (!setA.has(l)) out.push(`+ ${l}`);
  return out.length ? out.join('\n') : '(변경 없음)';
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/snapshot-core.test.mjs`
Expected: PASS (10 tests)

- [ ] **Step 5: 커밋**

```bash
git add extension/lib/snapshot-core.js test/snapshot-core.test.mjs
git commit -m "feat: 스냅샷 순수 함수(role/name/filter/fold/render/diff)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: content script — DOM 워커·ref 레지스트리·메시지 핸들러

**Files:**
- Create: `extension/content/snapshot.js`, `extension/lib/content-main.js`
- Test: 수동(`test/fixture/search.html`은 Task 10에서 생성; 이 Task에서는 임의 페이지로 확인)

**Interfaces:**
- Consumes: Task 2 export 전부.
- Produces: `chrome.runtime.onMessage` 핸들러. 요청/응답(최상위 프레임만 응답, `all_frames`지만 `window.top === window`일 때만 처리):
  - `{type:'snapshot', interactive?:boolean, showHidden?:boolean, selector?:string, ref?:string}` → `{tree:string}` (truncate 적용 전 원문; truncate는 bridge에서)
  - `{type:'elementPoint', ref}` → `{x, y, obscured:boolean}` (scrollIntoView 후 viewport 좌표)
  - `{type:'domClick', ref}` → `{ok:true}`
  - `{type:'focusAndClear', ref}` → `{ok:true}`
  - `{type:'selectOption', ref, value}` → `{ok:true}`
  - ref를 못 찾으면 `{error:'unknown ref e12 (take a new snapshot)'}`

- [ ] **Step 1: loader 작성**

```js
// extension/content/snapshot.js
(() => {
  if (window.top !== window) return; // 교차 출처 iframe 내부는 다루지 않음(동일 출처는 top에서 직접 순회)
  import(chrome.runtime.getURL('lib/content-main.js'));
})();
```

- [ ] **Step 2: content-main.js 작성**

```js
// extension/lib/content-main.js
import { computeRole, computeName, filterInteractive, foldLeafText, renderTree, INTERACTIVE_ROLES } from './snapshot-core.js';

const registry = new Map();            // ref -> Element
let counter = 0;

const attrsOf = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('');
const labelFor = (el) => (el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || '';

function isHidden(el) {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return true;
  const r = el.getBoundingClientRect();
  return r.width === 0 && r.height === 0 && el.tagName !== 'OPTION';
}

function toNode(el, prefix, showHidden) {
  const tag = el.tagName.toLowerCase();
  if (['script','style','noscript','template','svg','path','meta','link','head'].includes(tag)) return null;
  const hidden = isHidden(el);
  if (hidden && !showHidden) return null;
  const view = { tag, attrs: attrsOf(el), text: ownText(el), value: el.value ?? '' };
  const role = computeRole(view);
  const node = { role, name: computeName(view, labelFor(el)), children: [], hidden };
  if (/^h[1-6]$/.test(tag)) node.level = Number(tag[1]);
  if (el.checked) node.checked = true;
  if (el.disabled) node.disabled = true;
  if (el.ownerDocument.activeElement === el) node.focused = true;
  if (el.selected) node.selected = true;
  if (view.attrs.placeholder && node.name !== view.attrs.placeholder) node.placeholder = view.attrs.placeholder;
  if (el.scrollHeight > el.clientHeight + 8 && getComputedStyle(el).overflowY !== 'visible') node.scrollable = true;
  const interactive = INTERACTIVE_ROLES.has(role) || el.onclick || el.hasAttribute('onclick') || tag === 'input';
  if (interactive) { const ref = `${prefix}e${++counter}`; registry.set(ref, el); node.ref = ref; }
  if (tag === 'iframe') {
    let doc = null; try { doc = el.contentDocument; } catch {}
    const ref = `${prefix}f${++counter}`;
    if (!doc) return { ...node, role: 'iframe', ref, name: node.name || el.src, crossOrigin: true, children: [] };
    registry.set(ref, el);
    node.ref = ref; node.role = 'iframe';
    node.children = [...doc.body?.children ?? []].map((c) => toNode(c, `${ref}`, showHidden)).filter(Boolean);
    return node;
  }
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { const t = child.textContent.replace(/\s+/g, ' ').trim(); if (t && !node.name) node.children.push({ role: 'text', name: t, children: [] }); }
    else if (child.nodeType === Node.ELEMENT_NODE) { const n = toNode(child, prefix, showHidden); if (n) node.children.push(n); }
  }
  return node;
}

function snapshot({ interactive = false, showHidden = false, selector, ref } = {}) {
  let rootEl = document.body;
  if (ref) { rootEl = registry.get(ref); if (!rootEl) return { error: `unknown ref ${ref} (take a new snapshot)` }; }
  else if (selector) { rootEl = document.querySelector(selector); if (!rootEl) return { error: `no element matches ${selector}` }; }
  registry.clear(); counter = 0;
  let root = { role: 'fragment', name: '', children: [toNode(rootEl, '', showHidden)].filter(Boolean) };
  foldLeafText(root);
  if (interactive) root = filterInteractive(root) || { role: 'fragment', name: '', children: [] };
  const header = `page "${document.title.replace(/"/g, '\\"')}" ${location.href}`;
  return { tree: `${header}\n${renderTree(root)}` };
}

const byRef = (ref) => registry.get(ref);

function elementPoint(ref) {
  const el = byRef(ref); if (!el) return { error: `unknown ref ${ref} (take a new snapshot)` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, obscured: !!hit && hit !== el && !el.contains(hit) && !hit.contains(el) };
}

const handlers = {
  snapshot: (m) => snapshot(m),
  elementPoint: (m) => elementPoint(m.ref),
  domClick: (m) => { const el = byRef(m.ref); if (!el) return { error: `unknown ref ${m.ref}` }; el.click(); return { ok: true }; },
  focusAndClear: (m) => { const el = byRef(m.ref); if (!el) return { error: `unknown ref ${m.ref}` }; el.focus();
    if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (el.isContentEditable) { el.textContent = ''; }
    return { ok: true }; },
  selectOption: (m) => { const el = byRef(m.ref); if (!el) return { error: `unknown ref ${m.ref}` };
    el.value = m.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const h = handlers[msg?.type]; if (!h) return false;
  try { reply(h(msg)); } catch (e) { reply({ error: String(e?.message || e) }); }
  return false;
});
```

- [ ] **Step 3: 수동 확인**

확장 새로고침 → 아무 사이트 열기 → 사이드 패널 검사 콘솔에서
```js
const [t] = await chrome.tabs.query({active:true, currentWindow:true});
(await chrome.tabs.sendMessage(t.id, {type:'snapshot', interactive:true})).tree.split('\n').slice(0,20)
```
Expected: `page "…" https://…` 다음에 `link "…" [ref=e1]` 형태 줄들. `elementPoint`로 `{x,y,obscured}`가 나오는지도 확인.

- [ ] **Step 4: 커밋**

```bash
git add extension/content extension/lib/content-main.js
git commit -m "feat: content script 스냅샷·ref 레지스트리·좌표 핸들러

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: cdp.js + bridge.js — page API 호스트 구현

**Files:**
- Create: `extension/lib/cdp.js`, `extension/lib/bridge.js`
- Test: `test/bridge.test.mjs`

**Interfaces:**
- Consumes: Task 3 메시지 규약, Task 2 `truncateTree`, `diffLines`.
- Produces:
  - `cdp.js`: `KEYS` (key → `{key, code, keyCode, text?}`), `attach(tabId)`, `detach(tabId)`, `send(tabId, method, params)`, `click(tabId, {x,y,clickCount=1})`, `hover(tabId,{x,y})`, `insertText(tabId, text)`, `pressKey(tabId, combo)` (`'Enter'`, `'Shift+Tab'`, `'Meta+a'`).
  - `bridge.js`: `createBridge({ chrome, cdp, sendToTab })` → `{ handle(call, args) }`. `sendToTab(tabId, msg)`는 `chrome.tabs.sendMessage` 래퍼(테스트 주입용). `handle`의 call 목록과 args:
    - `snapshot {tabId, interactive?, showHidden?, selector?, ref?}` → `{tree, diff}`
    - `locator.click {tabId, ref, dblClick?}` / `locator.hover {tabId, ref}` / `locator.fill {tabId, ref, text}` / `locator.press {tabId, ref, key}` / `locator.selectOption {tabId, ref, value}` → `{ok:true}`
    - `page.goto {tabId, url}` → `{url}` / `page.url {tabId}` → string / `page.title {tabId}` → string
    - `openTab {url?}` → `{tabId}` / `closeTab {tabId}` → `{ok}` / `tabs {}` → `[{tabId, title, url, active}]`
    - 오류는 throw(Error) → repl에 문자열로 전달.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../extension/lib/bridge.js';
import { KEYS, parseCombo } from '../extension/lib/cdp.js';

function fakes() {
  const calls = [];
  const cdp = {
    attach: async (t) => { calls.push(['attach', t]); if (t === 99) throw new Error('Cannot attach to this target'); },
    detach: async () => {}, click: async (t, p) => calls.push(['click', t, p]), hover: async (t, p) => calls.push(['hover', t, p]),
    insertText: async (t, s) => calls.push(['insertText', t, s]), pressKey: async (t, k) => calls.push(['pressKey', t, k]),
  };
  const tabMsgs = [];
  const sendToTab = async (tabId, msg) => {
    tabMsgs.push([tabId, msg]);
    if (msg.type === 'snapshot') return { tree: `page "T" http://x\nbutton "OK" [ref=e1]` };
    if (msg.type === 'elementPoint') return msg.ref === 'e9' ? { error: 'unknown ref e9 (take a new snapshot)' } : { x: 10, y: 20, obscured: msg.ref === 'e2' };
    return { ok: true };
  };
  const chrome = { tabs: { get: async (id) => ({ id, url: 'http://x', title: 'T' }), update: async () => ({}), create: async () => ({ id: 7 }), remove: async () => {}, query: async () => [{ id: 1, title: 'T', url: 'http://x', active: true }] },
    webNavigation: { onCompleted: { addListener: (f) => setTimeout(() => f({ tabId: 1, frameId: 0 }), 0), removeListener: () => {} } } };
  return { calls, tabMsgs, bridge: createBridge({ chrome, cdp, sendToTab }) };
}

test('snapshot returns tree and diff against previous', async () => {
  const { bridge } = fakes();
  const a = await bridge.handle('snapshot', { tabId: 1, interactive: true });
  assert.match(a.tree, /button "OK" \[ref=e1\]/);
  assert.equal(a.diff, '(변경 없음)');
});

test('locator.click attaches, resolves point, dispatches mouse', async () => {
  const { bridge, calls } = fakes();
  await bridge.handle('locator.click', { tabId: 1, ref: 'e1' });
  assert.deepEqual(calls[0], ['attach', 1]);
  assert.deepEqual(calls[1], ['click', 1, { x: 10, y: 20, clickCount: 1 }]);
});

test('obscured target falls back to DOM click', async () => {
  const { bridge, calls, tabMsgs } = fakes();
  await bridge.handle('locator.click', { tabId: 1, ref: 'e2' });
  assert.ok(!calls.some((c) => c[0] === 'click'));
  assert.ok(tabMsgs.some(([, m]) => m.type === 'domClick' && m.ref === 'e2'));
});

test('unknown ref throws with hint', async () => {
  const { bridge } = fakes();
  await assert.rejects(bridge.handle('locator.click', { tabId: 1, ref: 'e9' }), /unknown ref e9/);
});

test('fill clears then inserts text', async () => {
  const { bridge, calls, tabMsgs } = fakes();
  await bridge.handle('locator.fill', { tabId: 1, ref: 'e1', text: 'abc' });
  assert.ok(tabMsgs.some(([, m]) => m.type === 'focusAndClear'));
  assert.deepEqual(calls.at(-1), ['insertText', 1, 'abc']);
});

test('attach failure returns error string', async () => {
  const { bridge } = fakes();
  await assert.rejects(bridge.handle('locator.click', { tabId: 99, ref: 'e1' }), /Cannot attach/);
});

test('page.goto waits for navigation and returns url', async () => {
  const { bridge } = fakes();
  assert.deepEqual(await bridge.handle('page.goto', { tabId: 1, url: 'http://x' }), { url: 'http://x' });
});

test('parseCombo splits modifiers', () => {
  assert.deepEqual(parseCombo('Shift+Tab'), { modifiers: 8, key: KEYS.Tab });
  assert.deepEqual(parseCombo('Enter'), { modifiers: 0, key: KEYS.Enter });
  assert.throws(() => parseCombo('Nope'), /unsupported key/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/bridge.test.mjs`
Expected: FAIL (Cannot find module)

- [ ] **Step 3: cdp.js 구현**

```js
// extension/lib/cdp.js
export const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 }, Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 }, End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

export function parseCombo(combo) {
  const parts = combo.split('+');
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) { if (!(m in MODS)) throw new Error(`unsupported modifier ${m}`); modifiers |= MODS[m]; }
  let key = KEYS[name];
  if (!key && name.length === 1) key = { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: modifiers ? undefined : name };
  if (!key) throw new Error(`unsupported key ${name}`);
  return { modifiers, key };
}

const attached = new Set();
const dbg = (fn, ...a) => new Promise((res, rej) => fn(...a, (r) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)));

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  await dbg(chrome.debugger.attach, { tabId }, '1.3');
  attached.add(tabId);
}
export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await dbg(chrome.debugger.detach, { tabId }); } catch {}
}
export const send = (tabId, method, params = {}) => dbg(chrome.debugger.sendCommand, { tabId }, method, params);

chrome.debugger?.onDetach?.addListener?.(({ tabId }) => attached.delete(tabId));

export async function hover(tabId, { x, y }) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}
export async function click(tabId, { x, y, clickCount = 1 }) {
  await hover(tabId, { x, y });
  for (let i = 1; i <= clickCount; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: i });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: i });
  }
}
export const insertText = (tabId, text) => send(tabId, 'Input.insertText', { text });
export async function pressKey(tabId, combo) {
  const { modifiers, key } = parseCombo(combo);
  const base = { modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
  await send(tabId, 'Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, text: key.text });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
```

- [ ] **Step 4: bridge.js 구현**

```js
// extension/lib/bridge.js
import { truncateTree, diffLines } from './snapshot-core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBridge({ chrome, cdp, sendToTab }) {
  const lastTree = new Map(); // tabId -> tree

  const ask = async (tabId, msg) => {
    const r = await sendToTab(tabId, msg);
    if (!r) throw new Error('content script not reachable (reload the tab)');
    if (r.error) throw new Error(r.error);
    return r;
  };

  async function pointOf(tabId, ref) {
    await cdp.attach(tabId);
    return ask(tabId, { type: 'elementPoint', ref });
  }

  function waitNav(tabId, timeout = 30000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { chrome.webNavigation.onCompleted.removeListener(f); rej(new Error('navigation timeout')); }, timeout);
      const f = (d) => { if (d.tabId === tabId && d.frameId === 0) { clearTimeout(t); chrome.webNavigation.onCompleted.removeListener(f); res(); } };
      chrome.webNavigation.onCompleted.addListener(f);
    });
  }

  const handlers = {
    async snapshot({ tabId, ...opts }) {
      const { tree } = await ask(tabId, { type: 'snapshot', ...opts });
      const text = truncateTree(tree);
      const diff = diffLines(lastTree.get(tabId) || '', text);
      lastTree.set(tabId, text);
      return { tree: text, diff };
    },
    async 'locator.click'({ tabId, ref, dblClick }) {
      const p = await pointOf(tabId, ref);
      if (p.obscured) { await ask(tabId, { type: 'domClick', ref }); }
      else await cdp.click(tabId, { x: p.x, y: p.y, clickCount: dblClick ? 2 : 1 });
      await sleep(80);
      return { ok: true };
    },
    async 'locator.hover'({ tabId, ref }) { const p = await pointOf(tabId, ref); await cdp.hover(tabId, p); return { ok: true }; },
    async 'locator.fill'({ tabId, ref, text }) {
      await handlers['locator.click']({ tabId, ref });
      await ask(tabId, { type: 'focusAndClear', ref });
      await cdp.insertText(tabId, text);
      return { ok: true };
    },
    async 'locator.press'({ tabId, ref, key }) { if (ref) await handlers['locator.click']({ tabId, ref }); await cdp.pressKey(tabId, key); return { ok: true }; },
    async 'locator.selectOption'({ tabId, ref, value }) { await ask(tabId, { type: 'selectOption', ref, value }); return { ok: true }; },
    async 'page.goto'({ tabId, url }) { const nav = waitNav(tabId); await chrome.tabs.update(tabId, { url }); await nav; return { url: (await chrome.tabs.get(tabId)).url }; },
    async 'page.url'({ tabId }) { return (await chrome.tabs.get(tabId)).url; },
    async 'page.title'({ tabId }) { return (await chrome.tabs.get(tabId)).title; },
    async openTab({ url }) { const t = await chrome.tabs.create({ url: url || 'about:blank', active: true }); if (url) await waitNav(t.id).catch(() => {}); return { tabId: t.id }; },
    async closeTab({ tabId }) { await cdp.detach(tabId); await chrome.tabs.remove(tabId); lastTree.delete(tabId); return { ok: true }; },
    async tabs() { return (await chrome.tabs.query({})).map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active })); },
  };

  return {
    async handle(call, args = {}) {
      const h = handlers[call];
      if (!h) throw new Error(`unknown call ${call}`);
      return h(args);
    },
    async releaseAll() { for (const id of [...lastTree.keys()]) await cdp.detach(id); lastTree.clear(); },
  };
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --test test/bridge.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 6: 커밋**

```bash
git add extension/lib/cdp.js extension/lib/bridge.js test/bridge.test.mjs
git commit -m "feat: CDP 래퍼와 page API 브리지

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: repl-core + 샌드박스 연결

**Files:**
- Create: `extension/lib/repl-core.js`
- Modify: `extension/repl.js` (Task 1 echo 교체), `extension/repl.html` (`<script type="module">`로 변경)
- Test: `test/repl-core.test.mjs`

**Interfaces:**
- Consumes: Task 4 `bridge.handle(call,args)` 규약(샌드박스에서는 `rpc(call,args)`로 호출).
- Produces: `createRepl({ rpc, timeoutMs = 120000 })` → `{ run(code, { tabId }) → Promise<{output:string, error:string|null}> }`, `truncateOutput(s, max=30000)`, `formatError(e)`.
- 샌드박스 메시지(Task 1 규약 유지): parent→iframe `{type:'run', id, code, tabId}`, iframe→parent `{type:'result', id, output, error}`, iframe→parent `{type:'rpc', id, call, args}`, parent→iframe `{type:'rpc-result', id, ok, value|error}`.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/repl-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepl, truncateOutput, formatError } from '../extension/lib/repl-core.js';

const mkRpc = (log) => async (call, args) => { log.push([call, args]); if (call === 'snapshot') return { tree: 'page "T"\nbutton "OK" [ref=e1]', diff: '(변경 없음)' }; if (call === 'page.url') return 'http://x'; return { ok: true }; };

test('console output is captured; return is ignored', async () => {
  const repl = createRepl({ rpc: mkRpc([]) });
  const r = await repl.run('console.log("a", 1, {b:2}); return 5;', { tabId: 1 });
  assert.equal(r.error, null);
  assert.equal(r.output, 'a 1 {"b":2}');
});

test('no console output yields placeholder', async () => {
  const r = await createRepl({ rpc: mkRpc([]) }).run('const x = 1;', { tabId: 1 });
  assert.equal(r.output, '(출력 없음 — console.log로 결과를 출력하세요)');
});

test('page.locator(ref).click calls rpc with tabId', async () => {
  const log = [];
  await createRepl({ rpc: mkRpc(log) }).run('await page.locator("e1").click(); console.log(await page.url())', { tabId: 3 });
  assert.deepEqual(log[0], ['locator.click', { tabId: 3, ref: 'e1', dblClick: false }]);
  assert.deepEqual(log[1], ['page.url', { tabId: 3 }]);
});

test('snapshot(page, opts) forwards options', async () => {
  const log = [];
  const r = await createRepl({ rpc: mkRpc(log) }).run('const s = await snapshot(page, {interactive:true}); console.log(s.tree)', { tabId: 1 });
  assert.deepEqual(log[0], ['snapshot', { tabId: 1, interactive: true }]);
  assert.match(r.output, /button "OK"/);
});

test('errors are formatted with message', async () => {
  const r = await createRepl({ rpc: async () => { throw new Error('unknown ref e9'); } }).run('await page.locator("e9").click()', { tabId: 1 });
  assert.match(r.error, /Error: unknown ref e9/);
});

test('syntax error is reported', async () => {
  const r = await createRepl({ rpc: mkRpc([]) }).run('const = 1', { tabId: 1 });
  assert.match(r.error, /SyntaxError/);
});

test('timeout rejects', async () => {
  const r = await createRepl({ rpc: mkRpc([]), timeoutMs: 20 }).run('await sleep(1000)', { tabId: 1 });
  assert.match(r.error, /timeout/);
});

test('truncateOutput and formatError', () => {
  assert.equal(truncateOutput('x'.repeat(10), 5), 'xxxxx\n[출력 5자 초과, 생략]');
  assert.match(formatError(new TypeError('bad')), /^TypeError: bad/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/repl-core.test.mjs`
Expected: FAIL

- [ ] **Step 3: repl-core.js 구현**

```js
// extension/lib/repl-core.js
export function truncateOutput(s, max = 30000) {
  return s.length <= max ? s : `${s.slice(0, max)}\n[출력 ${max}자 초과, 생략]`;
}
export function formatError(e) {
  if (!(e instanceof Error)) return `Error: ${String(e)}`;
  const stack = (e.stack || '').split('\n').slice(1, 5).filter((l) => !l.includes('repl-core')).join('\n');
  return `${e.name}: ${e.message}${stack ? '\n' + stack : ''}`;
}
const fmt = (v) => typeof v === 'string' ? v : (v instanceof Error ? formatError(v) : JSON.stringify(v));

function makePage(tabId, rpc) {
  const page = {
    tabId,
    locator: (ref) => ({
      click: (o = {}) => rpc('locator.click', { tabId, ref, dblClick: !!o.dblClick }),
      dblclick: () => rpc('locator.click', { tabId, ref, dblClick: true }),
      hover: () => rpc('locator.hover', { tabId, ref }),
      fill: (text) => rpc('locator.fill', { tabId, ref, text: String(text) }),
      press: (key) => rpc('locator.press', { tabId, ref, key }),
      selectOption: (value) => rpc('locator.selectOption', { tabId, ref, value: String(value) }),
    }),
    goto: (url) => rpc('page.goto', { tabId, url }),
    url: () => rpc('page.url', { tabId }),
    title: () => rpc('page.title', { tabId }),
    keyboard: { press: (key) => rpc('locator.press', { tabId, ref: null, key }) },
  };
  return page;
}

export function createRepl({ rpc, timeoutMs = 120000 }) {
  return {
    async run(code, { tabId }) {
      const lines = [];
      const console = { log: (...a) => lines.push(a.map(fmt).join(' ')), warn: (...a) => lines.push(a.map(fmt).join(' ')), error: (...a) => lines.push(a.map(fmt).join(' ')) };
      const page = makePage(tabId, rpc);
      const globals = {
        page, console,
        snapshot: (p, opts = {}) => rpc('snapshot', { tabId: p?.tabId ?? tabId, ...opts }),
        openTab: async (url) => makePage((await rpc('openTab', { url })).tabId, rpc),
        closeTab: (p) => rpc('closeTab', { tabId: p?.tabId ?? tabId }),
        tabs: () => rpc('tabs', {}),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      };
      let error = null;
      try {
        const fn = new Function(...Object.keys(globals), `return (async () => {\n${code}\n})();`);
        await Promise.race([
          fn(...Object.values(globals)),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${timeoutMs}ms 초과`)), timeoutMs)),
        ]);
      } catch (e) { error = formatError(e); }
      const output = lines.length ? truncateOutput(lines.join('\n')) : '(출력 없음 — console.log로 결과를 출력하세요)';
      return { output, error };
    },
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/repl-core.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: 샌드박스 repl.js를 repl-core에 연결**

```html
<!-- extension/repl.html -->
<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="repl.js"></script></body></html>
```

```js
// extension/repl.js
import { createRepl } from './lib/repl-core.js';

const pending = new Map();
let seq = 0;
const rpc = (call, args) => new Promise((res, rej) => {
  const id = `r${++seq}`;
  pending.set(id, { res, rej });
  window.parent.postMessage({ type: 'rpc', id, call, args }, '*');
});
const repl = createRepl({ rpc });

window.addEventListener('message', async (e) => {
  if (e.source !== window.parent) return;
  const m = e.data || {};
  if (m.type === 'rpc-result') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.res(m.value) : p.rej(new Error(m.error)); return; }
  if (m.type === 'run') { const r = await repl.run(m.code, { tabId: m.tabId }); window.parent.postMessage({ type: 'result', id: m.id, ...r }, '*'); }
});
```

주의: 샌드박스 페이지는 `chrome-extension://` 출처의 모듈을 `script-src 'self'`로 불러올 수 있다(`manifest.sandbox` CSP에 `'self'` 포함). 안 되면 `repl.html`에서 `<script src="lib/repl-core.js">`를 일반 스크립트로 바꾸고 `export`를 `window.createRepl =`로 보강한다.

- [ ] **Step 6: 수동 확인**

확장 새로고침 → 사이드 패널 콘솔에 Task 1의 `[repl] {…, output:'pong', error:null}`이 찍히는지 확인(echo가 실제 실행으로 바뀜).

- [ ] **Step 7: 커밋**

```bash
git add extension/lib/repl-core.js extension/repl.js extension/repl.html test/repl-core.test.mjs
git commit -m "feat: 샌드박스 REPL 코어(전역 구성·console 캡처·타임아웃)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: openai.js — SSE 파서·tool_calls 누적·chatStream

**Files:**
- Create: `extension/lib/openai.js`
- Test: `test/openai.test.mjs`

**Interfaces:**
- Produces:
  - `parseSSE(text)` → 이 chunk에서 완성된 `data:` JSON 객체 배열과 남은 버퍼: `{events, rest}`
  - `createAccumulator()` → `{ push(chunkJson) → [{type:'content'|'reasoning', text}] , result() → {content, reasoning, toolCalls:[{id,name,arguments}], finishReason} }`
  - `chatStream({ baseUrl, apiKey, model, messages, tools, signal, onDelta })` → Promise<result>. HTTP 오류는 `Error('HTTP 401: <body 앞 300자>')` throw.
  - `RUN_JS_TOOL` 상수(OpenAI tools 형식).

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/openai.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, createAccumulator, chatStream } from '../extension/lib/openai.js';

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;

test('parseSSE splits complete events and keeps remainder', () => {
  const { events, rest } = parseSSE('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, 'data: {"c"');
  assert.deepEqual(parseSSE('data: [DONE]\n\n').events, []);
});

test('accumulator separates content and reasoning', () => {
  const acc = createAccumulator();
  const ev = [...acc.push({ choices: [{ delta: { reasoning: 'think' } }] }), ...acc.push({ choices: [{ delta: { content: 'hi' } }] })];
  assert.deepEqual(ev, [{ type: 'reasoning', text: 'think' }, { type: 'content', text: 'hi' }]);
  assert.equal(acc.result().content, 'hi');
  assert.equal(acc.result().reasoning, 'think');
});

test('merges split tool_call arguments', () => {
  const acc = createAccumulator();
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_js', arguments: '{"co' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '' } }] } }] });
  acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'de":"1"}' } }] }, finish_reason: 'tool_calls' }] });
  const r = acc.result();
  assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'run_js', arguments: '{"code":"1"}' }]);
  assert.equal(r.finishReason, 'tool_calls');
});

function fakeFetch(body, status = 200) {
  return async (url, init) => ({ ok: status < 400, status, text: async () => body, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), _init: init });
}

test('chatStream streams deltas and returns result', async () => {
  const body = chunk({ content: 'Hel' }) + chunk({ content: 'lo' }, 'stop') + 'data: [DONE]\n\n';
  const deltas = [];
  const r = await chatStream({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', messages: [], tools: [], fetch: fakeFetch(body), onDelta: (d) => deltas.push(d.text) });
  assert.equal(deltas.join(''), 'Hello');
  assert.equal(r.content, 'Hello');
});

test('chatStream throws on http error with body', async () => {
  await assert.rejects(chatStream({ baseUrl: 'http://x/v1', model: 'm', messages: [], fetch: fakeFetch('{"error":"bad key"}', 401) }), /HTTP 401: .*bad key/);
});

test('omits Authorization when apiKey empty', async () => {
  let seen;
  const f = async (u, i) => { seen = i; return fakeFetch(chunk({ content: 'x' }, 'stop'))(u, i); };
  await chatStream({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', messages: [], fetch: f });
  assert.equal(seen.headers.Authorization, undefined);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/openai.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

```js
// extension/lib/openai.js
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
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
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
  const body = { model, messages, stream: true };
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
    buf += dec.decode(value, { stream: true });
    const { events, rest } = parseSSE(buf); buf = rest;
    for (const ev of events) for (const d of acc.push(ev)) onDelta(d);
  }
  return acc.result();
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/openai.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add extension/lib/openai.js test/openai.test.mjs
git commit -m "feat: OpenAI 호환 스트리밍 클라이언트(SSE·tool_calls 누적)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: agent.js — 루프·한도·오래된 출력 접기

**Files:**
- Create: `extension/lib/agent.js`
- Test: `test/agent.test.mjs`

**Interfaces:**
- Consumes: Task 6 `chatStream`, `RUN_JS_TOOL`.
- Produces:
  - `compactOldToolOutputs(messages, keepTurns = 8)` → 제자리 수정. "턴" = assistant 메시지 하나. 최근 keepTurns개 assistant 메시지 이전의 `role:'tool'` content를 `[이전 출력 생략]`으로.
  - `runAgent({ messages, provider:{baseUrl, apiKey}, model, runJs(code)→Promise<string>, chatStream, onEvent, signal, maxTools=25, maxMs=600000 })` → Promise<void>. `messages`에 assistant/tool 메시지를 append. `onEvent` 종류: `{type:'content', text}`, `{type:'reasoning', text}`, `{type:'tool_call', id, code}`, `{type:'tool_output', id, output}`, `{type:'done'}`, `{type:'error', message}`.
  - 도구 결과 문자열 형식: `output` 뒤에 error가 있으면 `\n\n<error>\n${error}\n</error>`.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/agent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, compactOldToolOutputs } from '../extension/lib/agent.js';

const scripted = (steps) => { let i = 0; return async ({ onDelta }) => { const s = steps[i++]; for (const t of s.content || []) onDelta({ type: 'content', text: t }); return { content: (s.content || []).join(''), reasoning: '', toolCalls: s.toolCalls || [], finishReason: s.toolCalls ? 'tool_calls' : 'stop' }; }; };

test('runs tool calls until model stops', async () => {
  const events = [];
  const messages = [{ role: 'user', content: 'go' }];
  const ran = [];
  await runAgent({ messages, provider: { baseUrl: 'x' }, model: 'm', onEvent: (e) => events.push(e),
    runJs: async (code) => { ran.push(code); return 'out1'; },
    chatStream: scripted([{ toolCalls: [{ id: 't1', name: 'run_js', arguments: '{"code":"console.log(1)"}' }] }, { content: ['done'] }]) });
  assert.deepEqual(ran, ['console.log(1)']);
  assert.equal(messages.at(-1).content, 'done');
  assert.equal(messages.find((m) => m.role === 'tool').content, 'out1');
  assert.equal(events.at(-1).type, 'done');
});

test('stops after maxTools with error event', async () => {
  const events = [];
  const loop = { toolCalls: [{ id: 't', name: 'run_js', arguments: '{"code":"1"}' }] };
  await runAgent({ messages: [{ role: 'user', content: 'x' }], provider: {}, model: 'm', maxTools: 2, onEvent: (e) => events.push(e), runJs: async () => 'o', chatStream: scripted([loop, loop, loop, loop]) });
  assert.equal(events.filter((e) => e.type === 'tool_call').length, 2);
  assert.match(events.at(-1).message, /도구 호출 한도/);
});

test('http error ends loop with error event', async () => {
  const events = [];
  await runAgent({ messages: [{ role: 'user', content: 'x' }], provider: {}, model: 'm', onEvent: (e) => events.push(e), runJs: async () => '', chatStream: async () => { throw new Error('HTTP 401: nope'); } });
  assert.deepEqual(events.at(-1), { type: 'error', message: 'HTTP 401: nope' });
});

test('invalid tool arguments are reported back to the model', async () => {
  const messages = [{ role: 'user', content: 'x' }];
  await runAgent({ messages, provider: {}, model: 'm', onEvent: () => {}, runJs: async () => 'never',
    chatStream: scripted([{ toolCalls: [{ id: 't', name: 'run_js', arguments: '{bad' }] }, { content: ['ok'] }]) });
  assert.match(messages.find((m) => m.role === 'tool').content, /arguments JSON 파싱 실패/);
});

test('compactOldToolOutputs keeps recent turns', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', tool_call_id: `t${i}`, content: `out${i}` });
  compactOldToolOutputs(msgs, 8);
  assert.equal(msgs[1].content, '[이전 출력 생략]');
  assert.equal(msgs[3].content, '[이전 출력 생략]');
  assert.equal(msgs[5].content, 'out2');
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/agent.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

```js
// extension/lib/agent.js
import { RUN_JS_TOOL, chatStream as defaultChatStream } from './openai.js';

export function compactOldToolOutputs(messages, keepTurns = 8) {
  const idx = messages.map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  const cutoff = idx.length > keepTurns ? idx[idx.length - keepTurns] : 0;
  for (let i = 0; i < cutoff; i++) if (messages[i].role === 'tool' && messages[i].content !== '[이전 출력 생략]') messages[i].content = '[이전 출력 생략]';
}

export async function runAgent({ messages, provider, model, runJs, chatStream = defaultChatStream, onEvent, signal, maxTools = 25, maxMs = 600000 }) {
  const started = Date.now();
  let toolCount = 0;
  try {
    for (;;) {
      if (Date.now() - started > maxMs) throw new Error('시간 한도(10분) 초과');
      compactOldToolOutputs(messages);
      const r = await chatStream({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, messages, tools: [RUN_JS_TOOL], signal, onDelta: onEvent });
      const assistant = { role: 'assistant', content: r.content || '' };
      if (r.reasoning) assistant.reasoning = r.reasoning;
      if (r.toolCalls.length) assistant.tool_calls = r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      messages.push(assistant);
      if (!r.toolCalls.length) { onEvent({ type: 'done' }); return; }
      for (const call of r.toolCalls) {
        if (++toolCount > maxTools) throw new Error(`도구 호출 한도(${maxTools}회) 초과`);
        let code, out;
        try { code = JSON.parse(call.arguments || '{}').code ?? ''; }
        catch (e) { out = `arguments JSON 파싱 실패: ${e.message}\n받은 값: ${call.arguments}`; }
        if (code !== undefined) { onEvent({ type: 'tool_call', id: call.id, code }); out = await runJs(code); }
        onEvent({ type: 'tool_output', id: call.id, output: out });
        messages.push({ role: 'tool', tool_call_id: call.id, content: out });
      }
    }
  } catch (e) {
    onEvent({ type: 'error', message: e?.name === 'AbortError' ? '중지됨' : String(e?.message || e) });
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/agent.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add extension/lib/agent.js test/agent.test.mjs
git commit -m "feat: 에이전트 루프(run_js 도구·한도·출력 접기)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: store.js + models.js — 설정·세션 저장, 모델 목록

**Files:**
- Create: `extension/lib/store.js`, `extension/lib/models.js`
- Test: `test/models.test.mjs`, `test/store.test.mjs`

**Interfaces:**
- Produces:
  - `store.js`: `DEFAULT_SETTINGS`, `getSettings()`, `saveSettings(s)`, `listSessions()` → `[{id,title,createdAt,model}]` 최신순, `getSession(id)`, `saveSession(s)`, `newSession({model})` → session `{id, title:'새 채팅', createdAt, model, messages:[]}`. 모두 `chrome.storage.local` 사용(`storage` 인자로 주입 가능: `createStore(storage)`; 기본은 `chrome.storage.local`).
  - `models.js`: `normalizeModels(kind, json)` → `string[]` (`kind`: `'ollama'` → `json.models[].name`, `'lmstudio'|'openai'` → `json.data[].id`), `fetchModels(provider, fetch=globalThis.fetch)` → `string[]` (kind별 URL: ollama `${baseUrl 에서 /v1 제거}/api/tags`, lmstudio/openai `${baseUrl}/models`). 실패 시 `provider.models || []`.

- [ ] **Step 1: 실패하는 테스트 작성**

```js
// test/models.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModels, fetchModels, modelsUrl } from '../extension/lib/models.js';

test('normalizeModels per kind', () => {
  assert.deepEqual(normalizeModels('ollama', { models: [{ name: 'llama3:8b' }] }), ['llama3:8b']);
  assert.deepEqual(normalizeModels('openai', { data: [{ id: 'openai/gpt-oss-120b' }] }), ['openai/gpt-oss-120b']);
  assert.deepEqual(normalizeModels('lmstudio', { data: [{ id: 'qwen' }] }), ['qwen']);
});

test('modelsUrl per kind', () => {
  assert.equal(modelsUrl({ kind: 'ollama', baseUrl: 'http://localhost:11434/v1' }), 'http://localhost:11434/api/tags');
  assert.equal(modelsUrl({ kind: 'openai', baseUrl: 'https://h/v1/' }), 'https://h/v1/models');
});

test('fetchModels falls back to manual list on failure', async () => {
  const p = { kind: 'openai', baseUrl: 'http://x/v1', models: ['manual'] };
  assert.deepEqual(await fetchModels(p, async () => { throw new Error('offline'); }), ['manual']);
  assert.deepEqual(await fetchModels(p, async () => ({ ok: true, json: async () => ({ data: [{ id: 'a' }] }) })), ['a']);
});
```

```js
// test/store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, DEFAULT_SETTINGS } from '../extension/lib/store.js';

const mem = () => { const d = {}; return { get: async (k) => ({ [k]: d[k] }), set: async (o) => Object.assign(d, o) }; };

test('settings default and roundtrip', async () => {
  const s = createStore(mem());
  const def = await s.getSettings();
  assert.equal(def.providers.length, 3);
  assert.equal(def.providers[0].model, 'openai/gpt-oss-120b');
  await s.saveSettings({ ...def, selected: { providerId: 'ollama', model: 'llama3' } });
  assert.equal((await s.getSettings()).selected.model, 'llama3');
});

test('sessions list newest first', async () => {
  const s = createStore(mem());
  const a = await s.newSession({ model: 'm' }); a.createdAt = 1; await s.saveSession(a);
  const b = await s.newSession({ model: 'm' }); b.createdAt = 2; await s.saveSession(b);
  assert.deepEqual((await s.listSessions()).map((x) => x.id), [b.id, a.id]);
  assert.equal((await s.getSession(a.id)).messages.length, 0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --test test/models.test.mjs test/store.test.mjs`
Expected: FAIL

- [ ] **Step 3: 구현**

```js
// extension/lib/models.js
export function normalizeModels(kind, json) {
  if (kind === 'ollama') return (json.models || []).map((m) => m.name).filter(Boolean);
  return (json.data || []).map((m) => m.id).filter(Boolean);
}
export function modelsUrl({ kind, baseUrl }) {
  const b = baseUrl.replace(/\/+$/, '');
  return kind === 'ollama' ? `${b.replace(/\/v1$/, '')}/api/tags` : `${b}/models`;
}
export async function fetchModels(provider, fetch = globalThis.fetch) {
  try {
    const headers = provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {};
    const res = await fetch(modelsUrl(provider), { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = normalizeModels(provider.kind, await res.json());
    return list.length ? list : (provider.models || []);
  } catch { return provider.models || []; }
}
```

```js
// extension/lib/store.js
export const DEFAULT_SETTINGS = {
  providers: [
    { id: 'runpod', label: 'RunPod vLLM', kind: 'openai', baseUrl: 'https://<vllm-host>/v1', apiKey: '', model: 'openai/gpt-oss-120b', models: ['openai/gpt-oss-120b'] },
    { id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '', models: [] },
    { id: 'lmstudio', label: 'LM Studio', kind: 'lmstudio', baseUrl: 'http://localhost:1234/v1', apiKey: '', model: '', models: [] },
  ],
  selected: { providerId: 'runpod', model: 'openai/gpt-oss-120b' },
};

export function createStore(storage = chrome.storage.local) {
  const get = async (k, d) => (await storage.get(k))[k] ?? d;
  return {
    getSettings: () => get('settings', structuredClone(DEFAULT_SETTINGS)),
    saveSettings: (settings) => storage.set({ settings }),
    async listSessions() { const all = await get('sessions', {}); return Object.values(all).sort((a, b) => b.createdAt - a.createdAt).map(({ id, title, createdAt, model }) => ({ id, title, createdAt, model })); },
    async getSession(id) { return (await get('sessions', {}))[id] || null; },
    async saveSession(s) { const all = await get('sessions', {}); all[s.id] = s; await storage.set({ sessions: all }); },
    async newSession({ model }) { const s = { id: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`, title: '새 채팅', createdAt: Date.now(), model, messages: [] }; await this.saveSession(s); return s; },
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `node --test test/`
Expected: 모든 테스트 PASS

- [ ] **Step 5: 커밋**

```bash
git add extension/lib/store.js extension/lib/models.js test/models.test.mjs test/store.test.mjs
git commit -m "feat: 설정·세션 저장소와 모델 목록 조회

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: 시스템 프롬프트 + 사이드 패널 UI 조립

**Files:**
- Create: `extension/prompts/system.md`
- Modify: `extension/sidepanel.js` (Task 1 버전 전면 교체), `extension/sidepanel.css`(필요 시 보강)
- Test: 수동

**Interfaces:**
- Consumes: Task 4 `createBridge`·`cdp`, Task 5 샌드박스 메시지 규약, Task 6/7 `runAgent`, Task 8 `createStore`·`fetchModels`.
- Produces: 동작하는 UI.

- [ ] **Step 1: 시스템 프롬프트 작성**

```markdown
<!-- extension/prompts/system.md -->
너는 Chrome 안에서 동작하는 브라우저 에이전트다. 도구 `run_js`로 JavaScript를 실행해 페이지를 읽고 조작한다. 사용자에게는 한국어로, 짧고 직접적으로 답한다. 이모지와 장식 문구는 쓰지 않는다.

# REPL 전역
```ts
page.locator(ref: string): { click(opts?:{dblClick?:boolean}), dblclick(), hover(), fill(text), press(key), selectOption(value) }  // 모두 Promise
page.goto(url), page.url(), page.title(), page.keyboard.press(key)
snapshot(page, { interactive?: boolean, showHidden?: boolean, selector?: string, ref?: string }): Promise<{ tree: string, diff: string }>
openTab(url?): Promise<Page>   closeTab(page)   tabs(): Promise<{tabId,title,url,active}[]>   sleep(ms)
console.log(...)   // 결과를 돌려받는 유일한 방법. return 은 무시된다.
```
키 이름: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp/Down, 한 글자, 조합은 `Shift+Tab`, `Meta+a`.

# 작업 규칙
- 항상 `snapshot(page, { interactive: true })`로 시작한다. 필요한 정보가 없을 때만 `snapshot(page)`(전체)를 본다. 큰 페이지는 `selector`로 범위를 좁힌다.
- 스냅샷은 `role "name" [ref=e12]` 한 줄 트리다. ref는 가상 ID다. CSS 선택자에 섞지 말고 `page.locator('e12')`에 그대로 넘긴다.
- 새 스냅샷을 찍으면 이전 ref는 모두 무효다. 동작한 뒤에는 반드시 새 스냅샷을 찍고, 출력은 `diff`만 한다(`console.log(s2.diff)`).
- ref·선택자·페이지 내용을 추측하지 않는다. 트리를 `slice`·`substring`으로 자르지 않는다.
- 동작과 스냅샷은 한 번의 run_js에 묶는다. 다음 동작이 새 ref에 의존하면 호출을 나눈다.
- 실패하면 새 스냅샷을 찍고 다시 시도한다. 같은 방법이 2~3회 실패하면 전략을 바꾼다. "obscured"면 가리는 요소(팝업·배너)를 먼저 닫는다.
- 쿠키 배너·모달·팝업은 먼저 닫는다. URL은 잘 알려진 사이트가 아니면 추측하지 않는다.
- `page.goto`·`click`은 로딩을 기다린다. 스냅샷이 아직 바뀌는 중일 때만 `sleep`을 쓴다.
- 비밀번호·결제 정보는 사용자가 직접 입력하게 요청한다.
- 도구 출력은 사용자에게 보이지 않는다. 최종 답에는 확인한 사실을 말로 요약한다.
```

- [ ] **Step 2: sidepanel.js 작성**

```js
// extension/sidepanel.js
import { createStore } from './lib/store.js';
import { fetchModels } from './lib/models.js';
import { createBridge } from './lib/bridge.js';
import * as cdp from './lib/cdp.js';
import { runAgent } from './lib/agent.js';

const $ = (id) => document.getElementById(id);
const store = createStore();
const bridge = createBridge({ chrome, cdp, sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => null) });
const SYSTEM = await (await fetch(chrome.runtime.getURL('prompts/system.md'))).text();

let settings, session, abort = null;

// ---- 샌드박스 REPL ----
let repl = $('repl');
const pendingRuns = new Map();
window.addEventListener('message', async (e) => {
  if (e.source !== repl.contentWindow) return;
  const m = e.data || {};
  if (m.type === 'rpc') {
    try { const value = await bridge.handle(m.call, m.args); repl.contentWindow.postMessage({ type: 'rpc-result', id: m.id, ok: true, value }, '*'); }
    catch (err) { repl.contentWindow.postMessage({ type: 'rpc-result', id: m.id, ok: false, error: String(err?.message || err) }, '*'); }
  } else if (m.type === 'result') { const p = pendingRuns.get(m.id); if (p) { pendingRuns.delete(m.id); p(m); } }
});
function resetRepl() { // 타임아웃·중지 시 강제 종료: iframe 재생성
  const n = repl.cloneNode(); repl.replaceWith(n); repl = n; pendingRuns.clear();
  return new Promise((r) => repl.addEventListener('load', r, { once: true }));
}
async function runJs(code) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = `run${Date.now()}`;
  const res = await new Promise((resolve) => { pendingRuns.set(id, resolve); repl.contentWindow.postMessage({ type: 'run', id, code, tabId: tab?.id ?? null }, '*'); });
  return res.error ? `${res.output}\n\n<error>\n${res.error}\n</error>` : res.output;
}

// ---- 렌더링 ----
function addMsg(role, text) { const d = document.createElement('div'); d.className = `msg ${role}`; d.textContent = text; $('messages').append(d); d.scrollIntoView(); return d; }
function addTool(code) { const d = document.createElement('details'); d.className = 'tool'; d.innerHTML = `<summary>run_js</summary><pre class="code"></pre><pre class="out"></pre>`; d.querySelector('.code').textContent = code; $('messages').append(d); return d; }
function renderSession() {
  $('messages').innerHTML = '';
  for (const m of session.messages) {
    if (m.role === 'user') addMsg('user', m.content);
    else if (m.role === 'assistant') { if (m.content) addMsg('assistant', m.content); for (const c of m.tool_calls || []) { let code = ''; try { code = JSON.parse(c.function.arguments).code; } catch {} addTool(code).dataset.id = c.id; } }
    else if (m.role === 'tool') { const t = [...document.querySelectorAll('details.tool')].find((x) => x.dataset.id === m.tool_call_id); if (t) t.querySelector('.out').textContent = m.content; }
  }
}
async function refreshTabChip() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); $('tabChip').textContent = t ? `${t.title} — ${t.url}` : ''; }
chrome.tabs.onActivated.addListener(refreshTabChip); chrome.tabs.onUpdated.addListener(refreshTabChip);

// ---- 세션·모델 ----
async function loadSessions() {
  const list = await store.listSessions();
  $('sessionSelect').innerHTML = list.map((s) => `<option value="${s.id}">${s.title}</option>`).join('');
  if (session) $('sessionSelect').value = session.id;
}
function renderModels() {
  const opts = [];
  for (const p of settings.providers) for (const m of (p.models.length ? p.models : [p.model]).filter(Boolean)) opts.push(`<option value="${p.id}|${m}">${p.label}: ${m}</option>`);
  $('modelSelect').innerHTML = opts.join('');
  $('modelSelect').value = `${settings.selected.providerId}|${settings.selected.model}`;
}
$('modelSelect').onchange = async () => { const [providerId, model] = $('modelSelect').value.split('|'); settings.selected = { providerId, model }; await store.saveSettings(settings); };
$('sessionSelect').onchange = async () => { session = await store.getSession($('sessionSelect').value); renderSession(); };
$('newChat').onclick = async () => { session = await store.newSession({ model: settings.selected.model }); await loadSessions(); renderSession(); };

// ---- 설정 ----
function renderSettings() {
  const s = $('settings');
  s.innerHTML = settings.providers.map((p, i) => `
    <fieldset data-i="${i}"><legend>${p.label}</legend>
      <label>Base URL <input name="baseUrl" value="${p.baseUrl}"></label>
      <label>API Key <input name="apiKey" type="password" value="${p.apiKey}"></label>
      <label>모델(수동) <input name="model" value="${p.model}"></label>
      <button class="refresh">모델 목록 새로고침</button> <span class="status"></span>
    </fieldset>`).join('') + `<button id="closeSettings">닫기</button>`;
  s.querySelectorAll('input').forEach((inp) => inp.onchange = async () => { const p = settings.providers[inp.closest('fieldset').dataset.i]; p[inp.name] = inp.value; if (inp.name === 'model' && inp.value) p.models = [...new Set([inp.value, ...p.models])]; await store.saveSettings(settings); renderModels(); });
  s.querySelectorAll('.refresh').forEach((b) => b.onclick = async () => { const fs = b.closest('fieldset'); const p = settings.providers[fs.dataset.i]; fs.querySelector('.status').textContent = '조회 중…'; const list = await fetchModels(p); p.models = list; fs.querySelector('.status').textContent = list.length ? `${list.length}개` : '실패(수동 모델 사용)'; await store.saveSettings(settings); renderModels(); });
  s.querySelector('#closeSettings').onclick = () => { s.hidden = true; };
}
$('settingsBtn').onclick = () => { renderSettings(); $('settings').hidden = !$('settings').hidden; };

// ---- 보내기·중지 ----
$('send').onclick = send;
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('stop').onclick = () => { abort?.abort(); resetRepl(); };

async function send() {
  const text = $('input').value.trim(); if (!text || abort) return;
  $('input').value = '';
  if (!session) session = await store.newSession({ model: settings.selected.model });
  if (session.messages.length === 0) { session.title = text.slice(0, 30); session.messages.push({ role: 'system', content: SYSTEM }); }
  session.messages.push({ role: 'user', content: text });
  addMsg('user', text);
  const provider = settings.providers.find((p) => p.id === settings.selected.providerId);
  abort = new AbortController(); $('stop').hidden = false; $('send').disabled = true;
  let cur = null, think = null, tool = null;
  await runAgent({ messages: session.messages, provider, model: settings.selected.model, runJs, signal: abort.signal, onEvent: async (ev) => {
    if (ev.type === 'content') { cur ||= addMsg('assistant', ''); cur.textContent += ev.text; }
    else if (ev.type === 'reasoning') { think ||= Object.assign(addMsg('assistant', ''), { style: 'color:#888;font-size:12px' }); think.textContent += ev.text; }
    else if (ev.type === 'tool_call') { cur = null; think = null; tool = addTool(ev.code); tool.dataset.id = ev.id; }
    else if (ev.type === 'tool_output') { if (tool) tool.querySelector('.out').textContent = ev.output; }
    else if (ev.type === 'error') addMsg('error', ev.message);
    await store.saveSession(session);
  } });
  abort = null; $('stop').hidden = true; $('send').disabled = false;
  await store.saveSession(session); await loadSessions();
}

// ---- 시작 ----
settings = await store.getSettings();
renderModels(); await loadSessions(); await refreshTabChip();
const first = (await store.listSessions())[0];
if (first) { session = await store.getSession(first.id); renderSession(); }
```

- [ ] **Step 3: CSS 보강**

`extension/sidepanel.css` 끝에 추가:
```css
#settings { position:absolute; inset:48px 0 0 0; background:#fff; overflow:auto; padding:8px; border-top:1px solid var(--line); }
#settings fieldset { border:1px solid var(--line); border-radius:8px; margin-bottom:8px; }
#settings label { display:block; font-size:12px; margin:4px 0; }
#settings input { width:100%; font:inherit; padding:4px; }
#app { position:relative; }
```

- [ ] **Step 4: 수동 확인**

1. 확장 새로고침, 패널 열기. 설정 → Ollama "모델 목록 새로고침"(Ollama가 떠 있으면 목록, 없으면 "실패").
2. 모델 드롭다운에서 RunPod 선택, 설정에 API 키 입력.
3. 아무 사이트에서 "이 페이지에 어떤 링크가 있어?" → run_js 카드에 `snapshot` 코드와 출력, 이어서 요약 답변.
4. 중지 버튼으로 도중 중단 → "중지됨" 메시지, 보내기 버튼 복구.

- [ ] **Step 5: 커밋**

```bash
git add extension/prompts/system.md extension/sidepanel.js extension/sidepanel.css
git commit -m "feat: 사이드 패널 UI·시스템 프롬프트·루프 조립

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 고정 테스트 페이지 · 수동 테스트 문서 · README

**Files:**
- Create: `test/fixture/search.html`, `test/fixture/result-1.html` … `result-5.html`, `docs/manual-test.md`, `README.md`
- Test: 수동 체크리스트 수행

- [ ] **Step 1: 고정 페이지 작성**

```html
<!-- test/fixture/search.html -->
<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>테스트 검색</title></head>
<body>
<div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div style="background:#fff;margin:80px auto;width:240px;padding:16px">쿠키 안내 <button onclick="document.getElementById('banner').remove()">동의</button></div></div>
<h1>테스트 검색</h1>
<form onsubmit="event.preventDefault(); render(q.value)">
  <input id="q" placeholder="검색어" autocomplete="off"><button type="submit">검색</button>
</form>
<ul id="results"></ul>
<script>
function render(q){ const ul=document.getElementById('results'); ul.innerHTML='';
  for(let i=1;i<=5;i++){ const li=document.createElement('li'); li.innerHTML=`<a href="result-${i}.html">${q} 결과 ${i}</a> <span>설명 ${i}</span>`; ul.append(li);} }
</script>
</body></html>
```

`result-N.html`(N=1..5, 셸로 생성):
```bash
for i in 1 2 3 4 5; do printf '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>결과 %s</title></head><body><h1>결과 %s 페이지</h1><p>본문 %s</p><a href="search.html">뒤로</a></body></html>' $i $i $i > test/fixture/result-$i.html; done
```

- [ ] **Step 2: 수동 테스트 문서**

```markdown
<!-- docs/manual-test.md -->
# 수동 테스트 체크리스트

사전: `chrome://extensions` 개발자 모드, `extension/` 로드. 고정 페이지는 `file:///…/test/fixture/search.html`(확장 세부정보에서 "파일 URL에 대한 액세스 허용" 켜기).

| # | 항목 | 절차 | 기대 |
|---|---|---|---|
| 1 | 오프라인 로드 | 와이파이 끄고 확장 로드·패널 열기 | 패널 UI 정상, 콘솔 네트워크 오류 없음 |
| 2 | 검색→결과 열기 | search.html에서 "테스트 검색해서 두 번째 결과 열어" | 배너 닫기 → 입력 → Enter → 2번 클릭 → `결과 2 페이지` 보고. 스크린샷 없음 |
| 3 | 모델 전환 | Ollama 모델 선택 후 같은 요청 | 동일 동작(응답 품질 차이는 허용) |
| 4 | 중지 | 긴 작업 중 중지 | "중지됨" 표시, 보내기 복구, 탭 debugger 해제 |
| 5 | 보호된 탭 | chrome://extensions 탭에서 요청 | run_js 출력에 attach 오류, 모델이 다른 탭 사용 또는 안내 |
| 6 | 민감 입력 | password 필드가 있는 페이지 스냅샷 | `[value redacted]` |
| 7 | 32k 대응 | 긴 페이지(뉴스 메인)에서 여러 번 조작 | 8턴 지난 도구 출력이 `[이전 출력 생략]` |
```

- [ ] **Step 3: README**

```markdown
<!-- README.md -->
# chrome-ext-ai — 로컬 브라우저 에이전트 확장

사이드 패널에서 접근성 트리 스냅샷으로 페이지를 읽고 CDP로 클릭·입력하는 Chrome 확장. 모델은 OpenAI 호환 서버(RunPod vLLM, 내부망 vLLM, Ollama, LM Studio)를 설정에서 고른다. Node·데몬·CDN 없음.

## 설치
1. `chrome://extensions` → 개발자 모드 → 압축해제된 확장 프로그램 로드 → `extension/`
2. 패널 열기(툴바 아이콘 또는 Cmd+E) → 설정 → Base URL·API 키·모델 입력

## 테스트
`npm test` (node --test). 수동: `docs/manual-test.md`.

## 문서
설계 `docs/superpowers/specs/2026-10-16-browser-agent-design.md`, 분석 노트 `NOTES.md`.
```

- [ ] **Step 4: 체크리스트 1·2·4·6 수행 후 결과를 `docs/manual-test.md` 표 끝에 "결과(날짜)" 열로 기록**

- [ ] **Step 5: 커밋**

```bash
git add test/fixture docs/manual-test.md README.md
git commit -m "test: 고정 페이지·수동 테스트 체크리스트·README

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 자체 검토 결과
- 스펙 커버리지: 구조(T1), 스냅샷(T2·T3), 조작(T4), REPL(T5), 모델 호출(T6), 루프·한도·접기(T7), 저장·모델 목록(T8), 프롬프트·UI·오류 표시·중지(T9), 테스트·반입 절차(T10·README). 교차 출처 iframe은 `[cross-origin]` 표시만(스펙 그대로).
- 타입 일관성: RPC call 이름(`locator.click` 등)은 T4·T5·T9에서 동일. 메시지 타입(`run/result/rpc/rpc-result`)은 T1·T5·T9 동일. `createStore` 반환 메서드는 T8·T9 동일.
- Review Focus 5건 모두 해당 Task 테스트에 포함.
