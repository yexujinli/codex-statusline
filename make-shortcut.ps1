$ErrorActionPreference = "Stop"

$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "CodexStatusline.lnk"
$launcher = Join-Path $PSScriptRoot "plugins\turn-stats-bar\statusline\launch-codex-debug.ps1"

$codex = Get-Process ChatGPT -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Path
if (-not $codex) {
  $candidate = Get-ChildItem "C:\Program Files\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  if ($candidate) { $codex = $candidate }
}
if (-not $codex) { Write-Error "Codex exe not found" }

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "powershell.exe"
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
$lnk.IconLocation = "$codex,0"
$lnk.Description = "Start Codex with statusline (debug port 9224)"
$lnk.Save()

Write-Output "Created: $lnkPath"

# Best-effort pin to taskbar (may not work on all Windows versions)
try {
  $shell = New-Object -ComObject Shell.Application
  $folder = $shell.Namespace($desktop)
  $item = $folder.ParseName("CodexStatusline.lnk")
  if ($item) {
    $item.InvokeVerb("taskbarpin")
    Write-Output "Pinned to taskbar (best effort)"
  }
} catch {
  Write-Output "Pin failed (right-click the shortcut -> Pin to taskbar manually)"
}
