' Launch watchdog fully hidden (no console window). Used by the scheduled task.
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\AI\projects\codex-statusline\plugins\turn-stats-bar\statusline\watchdog.ps1""", 0, False
