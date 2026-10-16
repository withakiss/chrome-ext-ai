// 첨부(파일·사진·폴더·클립보드 이미지)를 모델 메시지 텍스트로 조립하는 순수 함수.
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'zsh', 'bash', 'sql', 'toml', 'ini', 'cfg', 'conf', 'env', 'log', 'svg']);

const DOC_EXT = new Set(['docx', 'pptx', 'xlsx', 'hwpx', 'hwp', 'pdf']);
export function classifyFile({ name = '', type = '' }) {
  if (type.startsWith('image/')) return 'image';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (DOC_EXT.has(ext)) return 'doc'; // 문서: docs.js로 본문 추출 후 text처럼 첨부
  if (type.startsWith('text/') || TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

export function clipText(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… ${text.length - max}자 생략]`;
}

export const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

export function folderTreeText(entries, max = 500) {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.slice(0, max).map((e) => `${e.path} (${fmtSize(e.size)})`);
  if (sorted.length > max) lines.push(`[… ${sorted.length - max}개 더 있음]`);
  return lines.join('\n');
}

// attachments: { kind: 'image'|'text'|'other'|'folder', name, text?, description?, size?, entries? }
export function buildAttachmentBlocks(attachments, maxTotal = 60000) {
  const blocks = [];
  let used = 0;
  attachments.forEach((a, i) => {
    const n = i + 1;
    let block;
    if (a.kind === 'image') block = a.description ? `[첨부 ${n}: ${a.name} — 이미지 내용(비전 보조 모델이 글자를 그대로 옮기고 화면을 설명한 것. 원본 URL·파일을 요구하지 말고 이 내용으로 답하라)]\n${a.description}` : `[첨부 ${n}: ${a.name} — 이미지, 내용 읽기 불가(비전 모델 없음)]`;
    else if (a.kind === 'text' || a.kind === 'doc') { if (a.kind === 'doc' && a.error) { block = `[첨부 ${n}: ${a.name} — 문서 읽기 실패: ${a.error}]`; used += block.length; blocks.push(block); return; } const room = Math.max(1000, maxTotal - used); block = `[첨부 ${n}: ${a.name}]\n${clipText(a.text || '', Math.min(50000, room))}`; if (a.pageNotes?.length) block += `\n\n[페이지 이미지 설명 — 비전 보조 모델]\n${a.pageNotes.join('\n')}`; }
    else if (a.kind === 'folder') block = `[첨부 ${n}: 폴더 ${a.name} — ${a.entries?.length ?? 0}개 항목]\n${folderTreeText(a.entries || [])}`;
    else block = `[첨부 ${n}: ${a.name} — ${fmtSize(a.size || 0)}, 내용은 읽지 못함]`;
    used += block.length;
    blocks.push(block);
  });
  return blocks.join('\n\n');
}

export const countFiles = (atts) => atts.reduce((n, a) => n + (a.kind === 'folder' ? (a.entries?.length || 0) : 1), 0);
