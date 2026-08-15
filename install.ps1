$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$plugin = Join-Path $repo "plugins\turn-stats-bar"
$server = Join-Path $plugin "server"
$mcp = Join-Path $plugin ".mcp.json"

# 1. install server dependencies
if (-not (Test-Path (Join-Path $server "node_modules"))) {
  Write-Host "Installing server dependencies (npm install) ..."
  Push-Location $server
  try { npm install --no-audit --no-fund } finally { Pop-Location }
}

# 2. patch .mcp.json to absolute server path
#    (Codex launches plugin MCP servers with cwd = workspace, so relative paths fail)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
$json = Get-Content -Raw -LiteralPath $mcp | ConvertFrom-Json
$json.mcpServers.'turn-stats-bar'.command = $node
$json.mcpServers.'turn-stats-bar'.args = @((Join-Path $server "index.js"))
$json | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $mcp -Encoding UTF8

# 3. register the local marketplace so Codex can install this plugin
codex plugin marketplace add $repo

# 4. scheduled task: revive the watchdog every 5 minutes (fully hidden via wscript)
$watchdogVbs = Join-Path $plugin "statusline\watchdog-hidden.vbs"
$taskCmd = 'wscript.exe "' + $watchdogVbs + '"'
schtasks /Create /TN "codex-statusline-watchdog" /TR $taskCmd /SC MINUTE /MO 5 /F | Out-Null
Write-Host "Scheduled task created: codex-statusline-watchdog (every 5 min)"

# 5. startup entry: auto-start Codex with statusline at logon (fully hidden)
$startupDir = [Environment]::GetFolderPath("Startup")
$startupVbs = Join-Path $plugin "statusline\startup-hidden.vbs"
$startupDest = Join-Path $startupDir "codex-statusline.vbs"
Copy-Item -LiteralPath $startupVbs -Destination $startupDest -Force
Write-Host "Startup entry created: $startupDest"

# 6. desktop shortcut: one-click entry that launches Codex with the debug port
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "make-shortcut.ps1")

Write-Host ""
Write-Host "Done."
Write-Host "Setup completed: dependencies, marketplace, scheduled task, startup, shortcut."
Write-Host "Start the statusline now (restarts Codex once with the debug port):"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$plugin\statusline\launch-codex-debug.ps1`""
Write-Host "Optional (MCP widget, not required for the statusline):"
Write-Host "  codex plugin add turn-stats-bar@codex-statusline"
