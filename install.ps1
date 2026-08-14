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

Write-Host ""
Write-Host "Done."
Write-Host "Optional (MCP widget, not required for the statusline):"
Write-Host "  codex plugin add turn-stats-bar@codex-statusline"
Write-Host "Start the statusline (must restart Codex once with debug port):"
Write-Host "  powershell -ExecutionPolicy Bypass -File `"$plugin\statusline\launch-codex-debug.ps1`""
