# Local Browser Agent 테스트 실행기 (Chrome Native Messaging 호스트, Windows PowerShell 5.1+, 추가 설치 없음)
# 받는 메시지: {type:'ping'} | {type:'list', testPath} | {type:'run', testPath, templateId}
# 실행 규칙: testPath\.assistant\tests.json 에 등록된 템플릿만, 셸 문자열 없이 실행, 120초·출력 64KB 상한.
$ErrorActionPreference = 'Stop'
$TimeoutMs = 120000
$MaxOut = 65536
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Message {
  $len = New-Object byte[] 4
  $n = $stdin.Read($len, 0, 4)
  if ($n -lt 4) { return $null }
  $size = [BitConverter]::ToInt32($len, 0)
  if ($size -le 0 -or $size -gt 1048576) { return $null }
  $buf = New-Object byte[] $size
  $off = 0
  while ($off -lt $size) { $r = $stdin.Read($buf, $off, $size - $off); if ($r -le 0) { return $null }; $off += $r }
  return ([Text.Encoding]::UTF8.GetString($buf) | ConvertFrom-Json)
}

function Send-Message($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $stdout.Write([BitConverter]::GetBytes([int32]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Get-Templates($testPath) {
  if (-not $testPath -or -not [IO.Path]::IsPathRooted($testPath)) { throw '테스트 실행 경로는 절대 경로여야 합니다' }
  $root = (Resolve-Path -LiteralPath $testPath).Path
  $cfg = Join-Path $root '.assistant\tests.json'
  if (-not (Test-Path -LiteralPath $cfg)) { throw "허용 목록 없음: $cfg" }
  $j = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8 | ConvertFrom-Json
  return @{ root = $root; templates = @($j.templates) }
}

function Quote-Arg([string]$a) {
  if ($a -notmatch '[\s"]') { return $a }
  return '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Tail([string]$s) { if ($s.Length -gt $MaxOut) { return '[앞부분 생략]' + $s.Substring($s.Length - $MaxOut) } return $s }

function Run-Template($msg) {
  $t = Get-Templates $msg.testPath
  $tpl = $t.templates | Where-Object { $_.id -eq $msg.templateId } | Select-Object -First 1
  if (-not $tpl) { throw "허용되지 않은 템플릿: $($msg.templateId)" }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = [string]$tpl.command
  $psi.Arguments = (@($tpl.args) | ForEach-Object { Quote-Arg ([string]$_) }) -join ' '
  $psi.WorkingDirectory = $t.root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  $timedOut = -not $p.WaitForExit($TimeoutMs)
  if ($timedOut) { try { & taskkill /PID $p.Id /T /F | Out-Null } catch {} }
  $p.WaitForExit()
  return @{ ok = $true; templateId = $tpl.id; command = "$($tpl.command) $($psi.Arguments)"; exitCode = $(if ($timedOut) { $null } else { $p.ExitCode }); timedOut = $timedOut; ms = $sw.ElapsedMilliseconds; stdout = (Tail $o.Result); stderr = (Tail $e.Result) }
}

while ($true) {
  $msg = Read-Message
  if ($null -eq $msg) { break }
  try {
    switch ($msg.type) {
      'ping' { Send-Message @{ ok = $true; version = '1.0' } }
      'list' { $t = Get-Templates $msg.testPath; Send-Message @{ ok = $true; templates = @($t.templates | ForEach-Object { @{ id = $_.id; label = $_.label } }) } }
      'run'  { Send-Message (Run-Template $msg) }
      default { Send-Message @{ ok = $false; error = "알 수 없는 요청: $($msg.type)" } }
    }
  } catch { Send-Message @{ ok = $false; error = $_.Exception.Message } }
}
