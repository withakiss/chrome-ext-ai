// chrome.storage.local 래퍼: settings(providers·selected)와 sessions.
export const DEFAULT_SETTINGS = {
  providers: [
    { id: 'runpod', label: 'vLLM', kind: 'openai', baseUrl: '', apiKey: '', model: 'openai/gpt-oss-120b', models: ['openai/gpt-oss-120b'] }, // 주소는 설정에서 입력(소스에 공개 엔드포인트를 두지 않음)
    { id: 'ollama', label: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '', models: [] },
    { id: 'lmstudio', label: 'LM Studio', kind: 'lmstudio', baseUrl: 'http://localhost:1234/v1', apiKey: '', model: '', models: [] },
    { id: 'claude', label: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-opus-5-5', models: [] },
    { id: 'builtin', label: 'Chrome 내장', kind: 'builtin', baseUrl: '', apiKey: '', model: 'gemini-nano', models: ['gemini-nano'] },
    { id: 'imagegen', label: '이미지 생성 서버', kind: 'image-gen', baseUrl: '', apiKey: '', model: '', models: [] }, // OpenAI 호환 /images/generations (내부망 vLLM 등)
  ],
  selected: { providerId: 'runpod', model: 'openai/gpt-oss-120b' },
  visionAssist: true, // 화면에서 선택 시 내장 모델로 이미지 설명을 덧붙임
  docPageImages: true, // pdf·hwp 첨부 시 앞 3쪽을 이미지로 렌더해 비전 보조 설명을 덧붙임
  autoScreenshot: false, // 도구 호출마다 보이는 화면을 캡처해 비전 보조 설명을 출력에 덧붙임(느려짐)
  systemPrompt: '', // 비우면 prompts/system.md 기본값
};

export function createStore(storage = chrome.storage.local) {
  const get = async (k, d) => (await storage.get(k))[k] ?? d;
  return {
    async getSettings() { // 예전 저장본에 새 기본 provider·옵션이 없으면 채운다
      const s = await get('settings', structuredClone(DEFAULT_SETTINGS));
      s.providers ||= []; s.selected ||= structuredClone(DEFAULT_SETTINGS.selected); // 일부만 저장된 설정에서도 시작이 멈추지 않게
      for (const d of DEFAULT_SETTINGS.providers) if (!s.providers.some((p) => p.id === d.id)) s.providers.push(structuredClone(d));
      for (const k of ['visionAssist', 'docPageImages', 'autoScreenshot', 'systemPrompt']) if (s[k] === undefined) s[k] = DEFAULT_SETTINGS[k];
      for (const p of s.providers) if (p.id === 'runpod' && /RunPod/.test(p.label)) p.label = 'vLLM'; // 이름 변경(2026-10-16)
      return s;
    },
    saveSettings: (settings) => storage.set({ settings }),
    async listSessions() { const all = await get('sessions', {}); return Object.values(all).sort((a, b) => b.createdAt - a.createdAt).map(({ id, title, createdAt, model }) => ({ id, title, createdAt, model })); },
    async getSession(id) { return (await get('sessions', {}))[id] || null; },
    async saveSession(s) { const all = await get('sessions', {}); all[s.id] = s; await storage.set({ sessions: all }); },
    async deleteSession(id) { const all = await get('sessions', {}); delete all[id]; await storage.set({ sessions: all }); },
    clearSessions: () => storage.set({ sessions: {} }),
    async newSession({ model }) { const s = { id: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`, title: '새 채팅', createdAt: Date.now(), model, messages: [] }; await this.saveSession(s); return s; },
  };
}
