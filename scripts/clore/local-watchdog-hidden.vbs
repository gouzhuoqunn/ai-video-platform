Option Explicit

Dim shell
Dim fso
Dim scriptDir
Dim scriptsDir
Dim command
Dim exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptsDir = fso.GetParentFolderName(scriptDir)

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & scriptDir & "\local-watchdog.ps1" & Chr(34)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
