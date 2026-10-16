// 프로젝트 소스 접근(File System Access 디렉터리 핸들). 사용자가 고른 루트 안만 읽는다. DOM 없음.
export const LIMITS = { listMax: 500, searchHits: 100, searchFiles: 5000, fileBytes: 1_000_000, readLines: 400, readBytes: 30_000 };
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', '.idea', '.gradle', 'coverage']);
const SECRET = [/^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|jks|keystore)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^secrets?\./i, /^credentials/i];
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|7z|rar|jar|war|class|exe|dll|so|dylib|bin|wasm|onnx|mp[34]|mov|avi|woff2?|ttf|otf|eot|psd|hwp|docx?|xlsx?|pptx?|db|sqlite)$/i;

export const isSecretName = (name) => SECRET.some((r) => r.test(name));
export const isBinaryName = (name) => BINARY.test(name);

// 상대 경로만 허용. 루트 이탈·절대 경로·역슬래시·빈 조각은 거부.
export function normPath(p = '') {
  const s = String(p).trim();
  if (s.includes('\\')) throw new Error('경로에 \\ 를 쓸 수 없습니다(/ 사용)');
  if (/^[a-z]+:/i.test(s) || s.startsWith('~') || s.startsWith('/')) throw new Error('절대 경로는 허용되지 않습니다');
  const parts = s.replace(/^\.\/+/, '').replace(/\/+$/, '').split('/').filter((x) => x !== '' && x !== '.');
  if (parts.some((x) => x === '..')) throw new Error('프로젝트 루트 밖 경로는 허용되지 않습니다');
  return parts.join('/');
}

async function dirAt(root, rel) {
  let d = root;
  for (const name of rel ? rel.split('/') : []) {
    if (SKIP_DIRS.has(name)) throw new Error(`제외된 폴더입니다: ${name}`);
    d = await d.getDirectoryHandle(name).catch(() => { throw new Error(`폴더 없음: ${rel}`); });
  }
  return d;
}
async function fileAt(root, rel) {
  const parts = rel.split('/'); const name = parts.pop();
  if (isSecretName(name)) throw new Error(`비밀 파일은 읽지 않습니다: ${rel}`);
  if (isBinaryName(name)) throw new Error(`바이너리 파일은 읽지 않습니다: ${rel}`);
  const d = await dirAt(root, parts.join('/'));
  return d.getFileHandle(name).catch(() => { throw new Error(`파일 없음: ${rel}`); });
}

// 파일 순회(제외 규칙 적용). visit(path, handle) → false 반환 시 중단.
export async function walk(root, start, visit) {
  const stack = [[await dirAt(root, start), start]];
  while (stack.length) {
    const [d, prefix] = stack.pop();
    const entries = []; for await (const e of d.entries()) entries.push(e);
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, h] of entries) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'directory') { if (!SKIP_DIRS.has(name)) stack.push([h, path]); continue; }
      if (isSecretName(name)) continue;
      if ((await visit(path, h)) === false) return;
    }
  }
}

export async function listFiles(root, { dir = '', limit = LIMITS.listMax } = {}) {
  const base = normPath(dir); const files = []; let more = false;
  await walk(root, base, (p) => { if (files.length >= Math.min(limit, LIMITS.listMax)) { more = true; return false; } files.push(p); });
  return { files, truncated: more };
}

const globToRe = (g) => new RegExp(`(^|/)${g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`, 'i');
const hasNul = (buf) => new Uint8Array(buf.slice(0, 8192)).includes(0);

export async function searchCode(root, { query, regex = false, glob = '', dir = '', limit = LIMITS.searchHits } = {}) {
  if (!query) throw new Error('query가 비었습니다');
  const re = regex ? new RegExp(query, 'i') : null;
  const q = String(query).toLowerCase();
  const g = glob ? globToRe(glob) : null;
  const hits = []; let scanned = 0, truncated = false;
  await walk(root, normPath(dir), async (path, h) => {
    if (isBinaryName(path) || (g && !g.test(path))) return;
    if (++scanned > LIMITS.searchFiles) { truncated = true; return false; }
    const f = await h.getFile(); if (f.size > LIMITS.fileBytes) return;
    const buf = await f.arrayBuffer(); if (hasNul(buf)) return;
    const lines = new TextDecoder().decode(buf).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re ? re.test(lines[i]) : lines[i].toLowerCase().includes(q)) {
        hits.push({ path, line: i + 1, text: maskSecrets(lines[i].trim().slice(0, 200)) });
        if (hits.length >= Math.min(limit, LIMITS.searchHits)) { truncated = true; return false; }
      }
    }
  });
  return { hits, truncated, scanned: Math.min(scanned, LIMITS.searchFiles) };
}

// 줄 범위 읽기. 반환 { path, start, end, total, text(줄 번호 붙음) }
export async function readFile(root, { path, start = 1, end } = {}) {
  const rel = normPath(path); if (!rel) throw new Error('path가 비었습니다');
  const f = await (await fileAt(root, rel)).getFile();
  if (f.size > LIMITS.fileBytes) throw new Error(`파일이 너무 큽니다(${f.size} B)`);
  const buf = await f.arrayBuffer(); if (hasNul(buf)) throw new Error('바이너리 파일입니다');
  const all = new TextDecoder().decode(buf).split('\n');
  const s = Math.max(1, Number(start) || 1);
  let e = Math.min(all.length, Number(end) || s + LIMITS.readLines - 1, s + LIMITS.readLines - 1);
  const out = []; let bytes = 0;
  for (let i = s; i <= e; i++) { const l = `${i}\t${all[i - 1]}`; bytes += l.length + 1; if (bytes > LIMITS.readBytes) { e = i - 1; break; } out.push(l); }
  return { path: rel, start: s, end: Math.max(s, e), total: all.length, text: maskSecrets(out.join('\n')) };
}

export async function readWhole(root, path) { const f = await (await fileAt(root, normPath(path))).getFile(); return f.text(); }
export async function fileExists(root, path) { try { await fileAt(root, normPath(path)); return true; } catch { return false; } }

// 모델 전송 전 비밀값 가리기
export function maskSecrets(s) {
  return String(s)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[masked private key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[masked]')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[masked]')
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{4,})/gi, '$1[masked]');
}

// 읽기 장부: path → 읽은 [start,end] 목록
export function createLedger() {
  const m = new Map();
  return { add(path, s, e) { (m.get(path) || m.set(path, []).get(path)).push([s, e]); }, map: m };
}

// ---- 프로젝트 저장(IndexedDB, 브라우저 전용) ----
const DB = 'agent-projects';
function db() { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function tx(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('projects', mode); const r = fn(t.objectStore('projects')); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); }); }
export const projectStore = {
  list: () => tx('readonly', (s) => s.getAll()),
  get: (id) => tx('readonly', (s) => s.get(id)),
  put: (p) => tx('readwrite', (s) => s.put(p)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
};
export async function ensurePermission(handle, mode = 'read', ask = false) {
  const o = { mode };
  if ((await handle.queryPermission(o)) === 'granted') return true;
  return ask ? (await handle.requestPermission(o)) === 'granted' : false;
}

// ---- 모델 도구 정의 ----
export const LIST_FILES_TOOL = { type: 'function', function: { name: 'list_files', description: '연결된 프로젝트의 파일 목록(상대 경로). node_modules·.git·비밀 파일 제외, 최대 500개.', parameters: { type: 'object', properties: { dir: { type: 'string', description: '하위 폴더(생략 시 루트)' } } } } };
export const SEARCH_CODE_TOOL = { type: 'function', function: { name: 'search_code', description: '프로젝트에서 문자열(또는 정규식)을 찾아 경로:줄과 그 줄을 돌려준다. 최대 100건.', parameters: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' }, glob: { type: 'string', description: '파일 이름 패턴, 예 *.ts' }, dir: { type: 'string' } }, required: ['query'] } } };
export const READ_FILE_TOOL = { type: 'function', function: { name: 'read_file', description: '파일의 줄 범위를 줄 번호와 함께 읽는다(한 번에 최대 400줄). 근거로 인용하려면 반드시 먼저 읽는다.', parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] } } };
