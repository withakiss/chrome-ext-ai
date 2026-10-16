# 분석 노트: 사이드 패널 AI 채팅 확장 (2026-10-16)

목표: Gemini 사이드 패널과 같은 확장을 로컬 LLM(Ollama·LM Studio)으로 동작하게 만들기.

## 설계 방향
- 페이지는 스크린샷 대신 접근성 트리 스냅샷으로 읽는다: `role "name" [ref=e12]` 한 줄 형식, ref는 `Map<ref, Element>` 레지스트리(DOM 속성 안 붙임), 새 스냅샷마다 이전 ref 무효, 동작 뒤엔 diff.
- 조작은 CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`, 가려진 요소면 DOM click으로 대체.
- 모델은 JS REPL 코드(`page`, `snapshot`, `openTab` 등)를 써서 실행한다. Playwright MCP 같은 공개된 접근성 트리 기반 에이전트와 같은 계열.
- 시각 정보가 필요할 때만 선택 영역 이미지를 비전 보조 모델로 설명해 붙인다.

## 현재 상태 (2026-10-16 밤, 핸드오프 — 이어서 작업할 때 먼저 읽기)
- main 최신 c73a74b. 작업 트리 깨끗. 단위 `npm test` 96개, e2e `node test/e2e/run.mjs`(검색·영역 선택·이미지 생성·가림·중지 5 시나리오) 통과. e2e가 멈추면 `pkill -f remote-debugging-port=9333`; CDP 세션 오류로 간혹 중단되면 재실행.
- 설치: `chrome://extensions` → 압축해제 로드 → `extension/`. 코드 바꾼 뒤 확장 카드 새로고침 + 탭 새로고침.
- 모델: vLLM(주소·키는 설정에서 입력, 기본 비움; RunPod 주소·키는 Claude 메모리 runpod-vllm-endpoint), Ollama, LM Studio, Chrome 내장 Gemini Nano(사용자 Chrome 155: available·이미지 입력·한국어 OK), 이미지 생성 서버(OpenAI 호환 /images/generations, 사용자가 내부망에 띄울 예정), 브라우저 내 SmolVLM-256M(`scripts/download-model.mjs`로 extension/models/에 557MB, WebGPU/wasm 모두 확인).
- 디자인(2026-10-16): DESIGN.md 10장 챗봇 규칙 적용(시안 아티팩트 https://claude.ai/artifact/SHUpzUvVmvWqnFtfQhzUzX). 헤더 그라데이션·아이콘 버튼(인라인 SVG symbol), 버블, 빈 화면 예시 질문, 입력창 자동 높이(field-sizing, 최대 7줄), 아이콘 복사 버튼. Pretendard는 설치된 PC만 적용되고 없으면 Apple SD Gothic Neo·맑은 고딕으로 대체(폰트 동봉 안 함).
- 코딩 보조·Rich 응답(2026-10-16, 스펙 `docs/superpowers/specs/2026-10-16-coding-assistant-design.md`): 모드(일반·코딩·화면), 프로젝트 폴더 연결(File System Access, IndexedDB에 핸들), list_files·search_code·read_file, answer 도구(표·코드·차트·구조도·탭·인용·후속 질문, 읽지 않은 인용은 "확인 안 됨"), propose_patch → Diff → 승인 적용·stale·되돌리기·감사 기록, get_page_diagnostics(실패 요청·콘솔 오류), run_tests(Windows PowerShell 호스트 `native-host/`, 선택 설치). Claude API 서버(`lib/claude.js`).
- 미확인: Windows 호스트 실제 실행(이 Mac에 PowerShell 없음), Claude API 실제 키 호출(브라우저 직접 호출 헤더 필요 여부 포함), 사내 vLLM의 tool calling.
- 기능: 사이드 패널 채팅(마크다운 렌더·자동 스크롤·응답 복사=HTML+평문·코드 블록 복사), run_js 에이전트 루프(접근성 트리 스냅샷 + CDP 입력, type/paste 에디터 입력), 화면에서 선택(영역 트리 + 이미지 전사·설명), 첨부(파일·사진·폴더·클립보드·문서 6종 hwp/hwpx/docx/pptx/xlsx/pdf·pdf/hwp 페이지 이미지 설명), generate_image·save_file 도구(카드에 이미지/다운로드 링크), 자동 스크린샷 옵션(기본 꺼짐), 시스템/사용자 프롬프트 편집, 채팅 삭제, 카드 라벨·생각 접기, 질문마다 [현재 탭] 주입, 컨텍스트 초과 자동 접기·재시도.
- 동봉 라이브러리(`extension/vendor/`, 80MB): Transformers.js 4.3.1 + onnxruntime wasm, pdf.js 6.4, rhwp 0.8.7(HWP, 11MB). 전부 오프라인.
- 문서: 스펙 `docs/superpowers/specs/`, 계획 `docs/superpowers/plans/`, 수동 체크리스트 `docs/manual-test.md`(1·5·9·10·11·12·14·15·16 사용자 확인 미완).
- 사용자 확인 대기 중: 한컴 Web 에디터에 `page.keyboard.paste` 삽입이 먹는지, 응답 복사(HTML)가 한컴에 표로 붙는지, 파일 저장 카드 재열기 오류 해소(3109081).
- 알려진 한계: diff 집합 기준(순서 변화 못 잡음), `<all_urls>`+debugger 권한(개인용), SmolVLM 설명은 영어 위주·거침, Gemma 4 E2B 브라우저 구동은 wasm 커널 미지원·WebGPU 크래시로 제외.
- 다음 후보: 세션별 저장 키 분리(저장 비용), 긴 문서 첨부 시 요약 전처리, 한컴 Web 전용 삽입 경로.
