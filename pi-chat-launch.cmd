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
rem The server defaults its workspace to the current user's home directory.
rem Omit --cwd here to avoid cmd.exe nested-quote corruption on Windows.
start "Pi Chat Server" /min cmd.exe /d /c "node dist\server\server\index.js --port 30170"

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
if /i "%MODE%"=="pwa" goto :pwa
start "" "%URL%"
exit /b 0

:pwa
if exist "%EDGE_PWA%" (
  start "Pi Chat Edge PWA" "%EDGE_PWA%" --profile-directory=Default --app-id=%PWA_APP_ID% --app-url=%URL% --app-launch-source=4
  exit /b 0
)
echo Edge PWA launcher was not found. Opening the web version instead.
start "" "%URL%"
exit /b 0
