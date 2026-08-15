' Auto-start Codex with statusline at logon (fully hidden).
' install.ps1 copies this file into the Windows Startup folder.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\launch-codex-debug.ps1""", 0, False
