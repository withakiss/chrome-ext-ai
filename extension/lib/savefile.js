// save_file 도구: 모델이 만든 텍스트를 파일로 내려받게 한다(채팅 카드에 다운로드 링크).
export const SAVE_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'save_file',
    description: '텍스트 내용을 파일로 저장해 사용자가 내려받게 한다. 사용자가 "파일로 저장", "txt/csv/md로 만들어줘"라고 하면 이 도구를 쓴다. 저장 후 채팅에 다운로드 링크가 표시된다.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: '파일 이름(확장자 포함), 예: restaurants.txt' }, content: { type: 'string', description: '파일 전체 내용' } }, required: ['name', 'content'] },
  },
};

const MIME = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', js: 'text/javascript', py: 'text/x-python', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml' };

export function toDataUrl(content, name = 'file.txt') {
  const ext = (name.split('.').pop() || 'txt').toLowerCase();
  const mime = MIME[ext] || 'text/plain';
  const bytes = new TextEncoder().encode(content);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return `data:${mime};charset=utf-8;base64,${btoa(bin)}`;
}
