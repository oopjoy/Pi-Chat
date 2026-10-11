@echo off
setlocal EnableExtensions
powershell.exe -NoLogo -NoProfile -NonInteractive:$false -ExecutionPolicy Bypass -File "%~dp0scripts\pi-chat-setup.ps1" %*
exit /b %ERRORLEVEL%
