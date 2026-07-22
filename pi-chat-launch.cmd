@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "MODE=%~1"
if /i "%MODE%"=="" set "MODE=web"
if /i "%MODE%"=="web" goto :mode-ok
if /i "%MODE%"=="pwa" goto :mode-ok
echo Usage: pi-chat-launch.cmd [web^|pwa]
exit /b 2

:mode-ok
set "URL=http://127.0.0.1:30170"
set "PWA_APP_ID=geogmfmioogonffbmpjonolpkgepgafd"
set "EDGE_PWA=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge_proxy.exe"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\pi-chat-port-ready.ps1"
if not errorlevel 1 goto :open

rem A source checkout rebuilds so local changes apply. The Windows release ZIP
rem contains a prebuilt dist/ tree and intentionally starts without npm tooling.
if exist "%~dp0src\server\index.ts" (
  echo Building current Pi Chat source...
  call npm run build
  if errorlevel 1 exit /b 1
) else if not exist "%~dp0dist\server\server\index.js" (
  echo Pi Chat distribution is incomplete: dist\server\server\index.js was not found.
  exit /b 1
)

echo Starting Pi Chat service...
rem Pass the working directory through the environment. Embedding %%~dp0 in
rem PowerShell source breaks when the checkout path contains an apostrophe.
set "PI_CHAT_PROJECT_DIR=%~dp0"
if not defined PI_CHAT_SERVER_OUT set "PI_CHAT_SERVER_OUT=%TEMP%\pi-chat-server.stdout.log"
if not defined PI_CHAT_SERVER_ERR set "PI_CHAT_SERVER_ERR=%TEMP%\pi-chat-server.stderr.log"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'node.exe' -ArgumentList @('dist\server\server\index.js','--port','30170') -WorkingDirectory $env:PI_CHAT_PROJECT_DIR -WindowStyle Hidden -RedirectStandardOutput $env:PI_CHAT_SERVER_OUT -RedirectStandardError $env:PI_CHAT_SERVER_ERR | Out-Null"
if errorlevel 1 exit /b 1

set /a ATTEMPTS=0
:wait
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\pi-chat-port-ready.ps1"
if not errorlevel 1 goto :open
set /a ATTEMPTS+=1
if %ATTEMPTS% GEQ 60 (
  echo Pi Chat did not start within 30 seconds.
  exit /b 1
)
powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 1"
goto :wait

:open
rem The WinForms start UI may own browser/PWA open so the splash can hide first.
if /i "%PI_CHAT_SKIP_OPEN%"=="1" exit /b 0
if /i "%MODE%"=="pwa" goto :pwa
start "" "%URL%"
exit /b 0

:pwa
if exist "%EDGE_PWA%" (
  start "Pi Chat Edge PWA" "%EDGE_PWA%" --profile-directory=Default --app-id=%PWA_APP_ID% --app-url=%URL% --app-launch-source=4 --new-window
  exit /b 0
)
echo Edge PWA launcher was not found. Opening the web version instead.
start "" "%URL%"
exit /b 0
