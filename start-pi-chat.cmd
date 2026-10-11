@echo off
setlocal EnableExtensions
call "%~dp0pi-chat-launch.cmd" web
set "PI_CHAT_EXIT_CODE=%ERRORLEVEL%"
if "%PI_CHAT_EXIT_CODE%"=="0" exit /b 0
echo.
echo Pi Chat could not start. See the error and recovery steps above.
echo For the graphical launcher with saved logs, run start-pi-chat-ui.ps1.
rem Keep double-click failures visible; automation must explicitly opt out.
if /i not "%PI_CHAT_NONINTERACTIVE%"=="1" pause
exit /b %PI_CHAT_EXIT_CODE%
