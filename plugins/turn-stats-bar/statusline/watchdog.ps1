$ErrorActionPreference = "Continue"

$launcher = Join-Path $PSScriptRoot "launch-codex-debug.ps1"
$stateFile = Join-Path $env:TEMP "codex-statusline-watchdog.txt"
$intervalSec = 15
$graceSec = 12
$cooldownSec = 60

$lastRestart = 0
if (Test-Path -LiteralPath $stateFile) {
  $lastRestart = [int](Get-Content -LiteralPath $stateFile -ErrorAction SilentlyContinue)
}

Start-Sleep -Seconds 20   # avoid racing the logon launcher

while ($true) {
  $chat = Get-Process ChatGPT -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1

  if ($chat) {
    $portOk = $false
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:9224/json" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $portOk = $true }
    } catch {}

    $injectorUp = $false
    try {
      $inj = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like "*codex-statusline*statusline*injector.mjs*" }
      if ($inj) { $injectorUp = $true }
    } catch {}

    if (-not $portOk -or -not $injectorUp) {
      $now = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      if ($now - $lastRestart -ge $cooldownSec) {
        Start-Sleep -Seconds $graceSec
        $stillBroken = $false
        try {
          $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:9224/json" -UseBasicParsing -TimeoutSec 3
          if ($r2.StatusCode -ne 200) { $stillBroken = $true }
        } catch { $stillBroken = $true }
        if ($stillBroken) {
          & powershell -NoProfile -ExecutionPolicy Bypass -File $launcher
          Set-Content -LiteralPath $stateFile ([string]$now) -Encoding ASCII
        }
      }
    }
  }

  Start-Sleep -Seconds $intervalSec
}
