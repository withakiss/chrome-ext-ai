# 테스트 실행기 설치: 호스트 매니페스트를 만들고 현재 사용자 레지스트리(HKCU)에 등록한다. 관리자 권한 불필요.
# 사용: powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <확장 설정 화면에 보이는 ID>
param([Parameter(Mandatory = $true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)
$ErrorActionPreference = 'Stop'
$name = 'com.local.agent.tests'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifest = Join-Path $dir "$name.json"
@{ name = $name; description = 'Local Browser Agent test runner'; path = (Join-Path $dir 'host.bat'); type = 'stdio'; allowed_origins = @("chrome-extension://$ExtensionId/") } |
  ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding UTF8
foreach ($browser in 'Google\Chrome', 'Microsoft\Edge') {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$name"
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifest
}
Write-Host "설치 완료: $manifest"
Write-Host '확장 설정 → 프로젝트 → "테스트 실행기 확인"으로 연결을 확인하세요.'
