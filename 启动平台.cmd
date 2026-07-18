@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launcher\PlatformLauncher.ps1" -Action gui
endlocal
