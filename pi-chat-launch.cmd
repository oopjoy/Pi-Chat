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
rem %%~dp0 ends with a backslash. A trailing backslash immediately before a
rem quoted PowerShell argument can escape its closing quote in Windows argv
rem parsing, so normalize it to an explicit child path first.
set "PI_CHAT_PROJECT_DIRECTORY=%~dp0."
set "PWA_APP_ID=geogmfmioogonffbmpjonolpkgepgafd"
set "EDGE_PWA=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge_proxy.exe"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\pi-chat-port-ready.ps1" -ProjectDirectory "%PI_CHAT_PROJECT_DIRECTORY%"
if not errorlevel 1 goto :open
if errorlevel 2 goto :stale

rem Startup is offline and read-only until the service is launched. A checkout
rem must be prepared explicitly; a release must already contain its whole build.
if not exist "%~dp0scripts\pi-chat-preflight.ps1" (
  echo Pi Chat launcher files are missing. Fully extract the Windows release ZIP again.
  exit /b 1
)
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\pi-chat-preflight.ps1" -ProjectDirectory "%PI_CHAT_PROJECT_DIRECTORY%"
if errorlevel 1 exit /b 1

echo Starting Pi Chat service...
rem Pass the working directory through the environment. Embedding %%~dp0 in
rem PowerShell source breaks when the checkout path contains an apostrophe.
set "PI_CHAT_PROJECT_DIR=%~dp0"
if not defined PI_CHAT_SERVER_OUT set "PI_CHAT_SERVER_OUT=%TEMP%\pi-chat-server.stdout.log"
if not defined PI_CHAT_SERVER_ERR set "PI_CHAT_SERVER_ERR=%TEMP%\pi-chat-server.stderr.log"
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\pi-chat-start-server.ps1" -ProjectDirectory "%PI_CHAT_PROJECT_DIRECTORY%"
if errorlevel 1 exit /b 1
goto :open

:stale
rem A verified Pi Chat is listening on this port, but its build identity does
rem not match this checkout's dist. It may be another checkout or installation.
rem Never shut it down automatically: that could interrupt work in progress.
echo A different Pi Chat build is already running on port 30170.
echo Open that instance in its own window and close it, or use its own
echo restart/shutdown controls, then start this version again.
exit /b 1

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
