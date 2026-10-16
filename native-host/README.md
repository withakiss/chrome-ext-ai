# 테스트 실행기 (선택 설치, Windows)

브라우저 확장은 명령을 실행할 수 없어서, 코딩 보조의 `run_tests`만 이 작은 호스트가 맡는다. Windows 기본 PowerShell만 쓰며 추가 설치는 없다.

## 설치
1. 이 폴더를 PC의 고정 위치에 복사한다(예: `C:\Tools\agent-host`). 옮기면 다시 설치한다.
2. 확장 설정 → 프로젝트 칸에 보이는 확장 ID를 확인한다.
3. PowerShell에서 실행한다.
   ```
   powershell -ExecutionPolicy Bypass -File C:\Tools\agent-host\install.ps1 -ExtensionId <확장 ID>
   ```
4. 테스트할 프로젝트 루트에 `.assistant\tests.json`을 만든다(`tests.example.json` 참고). 여기에 적은 명령만 실행된다.
5. 확장 설정 → 프로젝트 → "테스트 실행 경로"에 프로젝트 절대 경로를 넣고 "테스트 실행기 확인"을 누른다.

## 규칙
- 모델은 템플릿 ID만 고를 수 있다. 명령 문자열은 받지 않는다.
- 작업 폴더는 프로젝트 루트, 시간 120초, 출력은 끝 64KB만 돌려준다.
- 레지스트리는 현재 사용자(HKCU)에만 등록한다. 관리자 권한이 필요 없다.

## 제거
```
powershell -ExecutionPolicy Bypass -File C:\Tools\agent-host\uninstall.ps1
```

## 알려진 제약
- 회사 그룹 정책이 `-ExecutionPolicy Bypass`나 HKCU 레지스트리 쓰기를 막으면 동작하지 않는다.
- Mac에서는 확인하지 않았다(Windows 전용).
