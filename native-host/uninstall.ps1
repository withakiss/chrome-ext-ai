# 테스트 실행기 제거: 레지스트리 등록과 생성한 매니페스트만 지운다.
$name = 'com.local.agent.tests'
foreach ($browser in 'Google\Chrome', 'Microsoft\Edge') { Remove-Item -Path "HKCU:\Software\$browser\NativeMessagingHosts\$name" -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "$name.json") -Force -ErrorAction SilentlyContinue
Write-Host '제거 완료'
