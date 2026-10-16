// 승인 기반 코드 수정. 모델은 찾아 바꾸기(edits)만 제안하고, patchId·기준 해시·적용은 패널이 관리한다. DOM 없음.
import { normPath, readWhole, fileExists, isSecretName, isBinaryName } from './project.js';

export const PROPOSE_PATCH_TOOL = {
  type: 'function',
  function: {
    name: 'propose_patch',
    description: '코드 수정안을 제안한다. 파일은 바로 바뀌지 않고 사용자가 Diff를 보고 승인해야 적용된다. 각 edit의 oldText는 파일에서 정확히 한 번만 나와야 한다(앞뒤 줄을 넉넉히 포함). 새 파일은 oldText를 빈 문자열로.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '수정 이유 한두 문장' },
        edits: { type: 'array', maxItems: 20, items: { type: 'object', properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['path', 'oldText', 'newText'] } },
      },
      required: ['reason', 'edits'],
    },
  },
};

const count = (hay, needle) => { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length || 1; } return n; };

// 한 파일에 edits를 순서대로 적용. oldText가 0회·2회 이상이면 실패 사유와 함께 throw.
export function applyEdits(text, edits, path = '') {
  let out = text;
  for (const [i, e] of edits.entries()) {
    if (e.oldText === '') { if (out !== '') throw new Error(`${path} edit ${i + 1}: 이미 있는 파일에 oldText ""는 쓸 수 없습니다`); out = e.newText; continue; }
    const n = count(out, e.oldText);
    if (n !== 1) throw new Error(`${path} edit ${i + 1}: oldText가 ${n}번 나옵니다(정확히 1번이어야 함). 파일을 다시 읽고 고유한 앞뒤 줄을 포함하세요`);
    out = out.replace(e.oldText, () => e.newText);
  }
  return out;
}

// 줄 단위 LCS diff → unified diff(문맥 3줄). ponytail: O(n·m) 표, 큰 파일(수천 줄²)은 느림 — 필요하면 Myers로 교체.
export function unifiedDiff(a, b, path = 'file', ctx = 3) {
  const A = a === '' ? [] : a.split('\n'), B = b === '' ? [] : b.split('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { ops.push([' ', A[i], i, j]); i++; j++; }
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { ops.push(['-', A[i], i, j]); i++; } // 삭제를 추가보다 먼저
    else { ops.push(['+', B[j], i, j]); j++; }
  }
  const out = [`--- a/${path}`, `+++ b/${path}`]; let add = 0, del = 0;
  for (let k = 0; k < ops.length;) {
    if (ops[k][0] === ' ') { k++; continue; }
    let s = Math.max(0, k - ctx), e = k;
    while (e < ops.length) { // 변경이 이어지거나 문맥 안에 다음 변경이 있으면 한 덩어리
      if (ops[e][0] !== ' ') { e++; continue; }
      let r = e; while (r < ops.length && ops[r][0] === ' ' && r - e < ctx * 2) r++;
      if (r < ops.length && ops[r][0] !== ' ' && r - e < ctx * 2) { e = r; continue; }
      e = Math.min(ops.length, e + ctx); break;
    }
    const h = ops.slice(s, e);
    const aStart = h[0][2] + 1, bStart = h[0][3] + 1;
    const aLen = h.filter((o) => o[0] !== '+').length, bLen = h.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const o of h) { out.push(o[0] + o[1]); if (o[0] === '+') add++; if (o[0] === '-') del++; }
    k = e;
  }
  return { diff: out.join('\n'), add, del };
}

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function writeText(root, path, text) {
  const parts = normPath(path).split('/'); const name = parts.pop();
  let d = root; for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable(); await w.write(text); await w.close();
}

// patch 저장소. 상태: proposed → applied | rejected | stale. 모델이 준 ID는 쓰지 않는다.
export function createPatchStore({ newId = () => crypto.randomUUID(), audit = () => {} } = {}) {
  const patches = new Map();
  return {
    has: (id) => patches.has(id),
    get: (id) => patches.get(id),
    ids: () => new Set(patches.keys()),
    // 제안: 현재 파일을 읽어 edits 적용 결과·diff·기준 해시를 만든다(파일은 안 바꿈)
    async propose(root, projectId, { reason = '', edits = [] }) {
      if (!edits.length) throw new Error('edits가 비었습니다');
      const byPath = new Map();
      for (const e of edits) { const p = normPath(e.path); const name = p.split('/').pop(); if (!p || isSecretName(name) || isBinaryName(name)) throw new Error(`수정할 수 없는 경로: ${e.path}`); (byPath.get(p) || byPath.set(p, []).get(p)).push(e); }
      const files = [];
      for (const [path, es] of byPath) {
        const exists = await fileExists(root, path);
        const base = exists ? await readWhole(root, path) : '';
        if (!exists && es[0].oldText !== '') throw new Error(`파일 없음: ${path} (새 파일은 oldText "")`);
        const next = applyEdits(base, es, path);
        const { diff, add, del } = unifiedDiff(base, next, path);
        files.push({ path, exists, baseHash: await sha256(base), base, newText: next, diff, add, del });
      }
      const id = newId();
      patches.set(id, { id, projectId, reason, files, state: 'proposed', createdAt: Date.now() });
      audit({ action: 'propose', patchId: id, projectId, paths: files.map((f) => f.path) });
      return patches.get(id);
    },
    // 승인 후 적용: 파일별 현재 해시가 기준과 다르면 stale(아무것도 안 씀)
    async apply(root, id) {
      const p = patches.get(id); if (!p) throw new Error('없는 수정안');
      if (p.state !== 'proposed') throw new Error(`적용할 수 없는 상태: ${p.state}`);
      for (const f of p.files) {
        const cur = (await fileExists(root, f.path)) ? await readWhole(root, f.path) : '';
        if ((await sha256(cur)) !== f.baseHash || (!f.exists && cur !== '')) { p.state = 'stale'; audit({ action: 'stale', patchId: id, path: f.path }); return p; }
      }
      for (const f of p.files) { await writeText(root, f.path, f.newText); f.appliedHash = await sha256(f.newText); }
      p.state = 'applied'; p.appliedAt = Date.now();
      audit({ action: 'apply', patchId: id, projectId: p.projectId, paths: p.files.map((f) => f.path) });
      return p;
    },
    reject(id) { const p = patches.get(id); if (p?.state === 'proposed') { p.state = 'rejected'; audit({ action: 'reject', patchId: id }); } return p; },
    // 되돌리기: 현재 내용이 적용 직후와 같을 때만 원문 복원(그 뒤 사람이 고쳤으면 거부)
    async undo(root, id) {
      const p = patches.get(id); if (p?.state !== 'applied') throw new Error('적용된 수정안만 되돌릴 수 있습니다');
      for (const f of p.files) if ((await sha256(await readWhole(root, f.path))) !== f.appliedHash) throw new Error(`${f.path}가 적용 뒤 바뀌어 되돌릴 수 없습니다`);
      for (const f of p.files) await writeText(root, f.path, f.base); // ponytail: 새로 만든 파일은 빈 내용으로 남김(삭제 API 대신)
      p.state = 'reverted'; audit({ action: 'undo', patchId: id });
      return p;
    },
  };
}
