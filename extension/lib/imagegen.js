// 이미지 생성: OpenAI 호환 POST {baseUrl}/images/generations (vLLM·내부망 서버·RunPod 공통).
export const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: '텍스트 설명으로 이미지를 생성한다. 사용자가 그림·이미지·사진을 "그려줘/만들어줘"라고 하면 이 도구를 쓴다. 결과는 채팅에 바로 표시된다.',
    parameters: { type: 'object', properties: { prompt: { type: 'string', description: '생성할 이미지 설명(영어가 품질이 좋음)' }, size: { type: 'string', description: '가로x세로 픽셀, 예: 1024x1024, 512x512', default: '1024x1024' } }, required: ['prompt'] },
  },
};

export async function generateImage({ baseUrl, apiKey = '', model = '', prompt, size = '1024x1024' }, fetch = globalThis.fetch) {
  if (!baseUrl) throw new Error('이미지 생성 서버 주소가 설정되지 않았습니다(설정 → 이미지 생성 서버)');
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/images/generations`, { method: 'POST', headers, body: JSON.stringify({ model, prompt, size, n: 1, response_format: 'b64_json' }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = (await res.json()).data?.[0];
  if (d?.b64_json) return `data:image/png;base64,${d.b64_json}`;
  if (d?.url) return d.url;
  throw new Error('응답에 이미지가 없습니다(data[0].b64_json 또는 url)');
}
