// run_js 코드 한 덩이를 사람이 읽을 짧은 라벨로. 첫 줄 주석이 있으면 그걸 쓰고, 없으면 호출된 API 순서로 만든다.
const RULES = [
  [/\.fill\(\s*(['"`])([\s\S]*?)\1/g, (m) => `'${m[2].slice(0, 20)}' 입력`],
  [/\.press\(\s*(['"`])([^'"`]+)\1/g, (m) => m[2]],
  [/\.selectOption\(/g, () => '옵션 선택'],
  [/\.(?:click|dblclick)\(/g, () => '클릭'],
  [/\.hover\(/g, () => '호버'],
  [/\.goto\(\s*(['"`])([^'"`]+)\1/g, (m) => { try { return `${new URL(m[2]).host} 이동`; } catch { return '이동'; } }],
  [/\bopenTab\(/g, () => '새 탭'],
  [/\bcloseTab\(/g, () => '탭 닫기'],
  [/\bsnapshot\(/g, () => '스냅샷'],
  [/\.title\(\)/g, () => '제목 확인'],
  [/\.url\(\)/g, () => 'URL 확인'],
];

export function labelForCode(code = '') {
  const first = code.trim().split('\n')[0];
  const c = first.match(/^\s*\/\/\s*(.+)/);
  if (c) return c[1].trim().slice(0, 60);
  const hits = [];
  for (const [re, fmt] of RULES) for (const m of code.matchAll(re)) hits.push({ i: m.index, text: fmt(m) });
  hits.sort((a, b) => a.i - b.i);
  const parts = []; for (const h of hits) if (parts.at(-1) !== h.text) parts.push(h.text);
  const label = parts.join(' · ');
  return label ? (label.length > 60 ? `${label.slice(0, 57)}…` : label) : 'run_js';
}
