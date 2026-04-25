Set WshShell = CreateObject("WScript.Shell")
Dim ps1Path
ps1Path = Replace(WScript.ScriptFullName, "watchdog.vbs", "watchdog.ps1")
WshShell.Run "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1Path & """", 0, False
