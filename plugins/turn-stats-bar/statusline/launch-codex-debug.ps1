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

# Official way: IApplicationActivationManager activates the MSIX packaged app with args.
# Normal shell:AppsFolder launch strips command-line args, losing --remote-debugging-port.
function Start-CodexActivated {
  try {
    $aumid = (Get-StartApps -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'ChatGPT' } |
      Select-Object -First 1).AppID
    if (-not $aumid) {
      $family = (Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
        Select-Object -First 1).PackageFamilyName
      if ($family) { $aumid = "$family!App" }
    }
    if (-not $aumid) { return $false }

    Add-Type -Path (Join-Path $PSScriptRoot "CodexActivator.cs") -ErrorAction Stop

    $procId = [uint32]0
    $hr = [CodexActivator]::Activate($aumid, "--remote-debugging-port=9224 --remote-allow-origins=*", [ref]$procId)
    if ($hr -eq 0) {
      Write-Host "Activated Codex via IApplicationActivationManager (pid $procId)"
      return $true
    }
    Write-Host "ActivateApplication HRESULT: $hr; falling back to direct exe launch"
    return $false
  } catch {
    Write-Host "COM activation failed: $($_.Exception.Message); falling back to direct exe launch"
    return $false
  }
}

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
  $activated = Start-CodexActivated
  if (-not $activated) {
    Start-Process -FilePath $codex -ArgumentList "--remote-debugging-port=9224 --remote-allow-origins=*"
  }
  # 5. verify the debug port comes up; retry once (handles Codex auto-start races)
  $portOk = $false
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 3
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:9224/json" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $portOk = $true; break }
    } catch {}
  }
  if (-not $portOk) {
    Write-Host "Debug port not up; retrying once ..."
    Get-Process ChatGPT, codex -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    $activated2 = Start-CodexActivated
    if (-not $activated2) {
      Start-Process -FilePath $codex -ArgumentList "--remote-debugging-port=9224 --remote-allow-origins=*"
    }
    Start-Sleep -Seconds 10
  }
}

# 6. start the statusline injector (background)
Write-Host "Starting statusline injector ..."
$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*statusline\injector.mjs*" }
if ($existing) {
  $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Start-Process -FilePath $node -ArgumentList "`"$injector`"" -WindowStyle Hidden

# 7. ensure the watchdog is running (auto-fix after manual Codex restarts/updates)
$watchdog = Join-Path $PSScriptRoot "watchdog.ps1"
$watchdogUp = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*statusline*watchdog.ps1*" }
if (-not $watchdogUp) {
  Start-Process powershell -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","`"$watchdog`"" -WindowStyle Hidden
  Write-Host "Watchdog started."
}

Write-Host ""
Write-Host "Done. Debug port 9224 is active; injector is running in background."
Write-Host "Every new conversation will show a single-line status bar above the input box."
