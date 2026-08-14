$ErrorActionPreference = "Stop"

$injector = Join-Path $PSScriptRoot "injector.mjs"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

# 1. locate the Codex desktop app (packaged Windows app)
$codex = Get-Process ChatGPT -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Path
if (-not $codex) {
  $candidate = Get-ChildItem "C:\Program Files\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  if ($candidate) { $codex = $candidate }
}
if (-not $codex) {
  Write-Error "Codex desktop app not found. Start Codex once, then run this script."
  exit 1
}
Write-Host "Codex path: $codex"

# 2. idempotent: if Codex already runs with debug port 9224, skip restart
$alreadyOk = $false
try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:9224/json" -UseBasicParsing -TimeoutSec 3
  if ($resp.StatusCode -eq 200) {
    $chatWithPort = Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" |
      Where-Object { $_.CommandLine -like "*--remote-debugging-port=9224*" }
    if ($chatWithPort) { $alreadyOk = $true }
  }
} catch {}

if ($alreadyOk) {
  Write-Host "Codex already running with debug port 9224; skipping restart."
} else {
  # 3. close Codex (this ends the current conversation, save your work first)
  Write-Host "Stopping Codex ..."
  Get-Process ChatGPT, codex -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3

  # 4. restart with the debug port
  Write-Host "Starting Codex with --remote-debugging-port=9224 ..."
  Start-Process -FilePath $codex -ArgumentList "--remote-debugging-port=9224"
  Start-Sleep -Seconds 8
}

# 5. start the statusline injector (background)
Write-Host "Starting statusline injector ..."
$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*statusline\injector.mjs*" }
if ($existing) {
  $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Start-Process -FilePath $node -ArgumentList "`"$injector`"" -WindowStyle Hidden

Write-Host ""
Write-Host "Done. Debug port 9224 is active; injector is running in background."
Write-Host "Every new conversation will show a single-line status bar above the input box."
