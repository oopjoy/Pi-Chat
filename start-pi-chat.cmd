@echo off
cd /d "%~dp0"
if not exist "dist\server\server\index.js" (
  echo Pi Chat has not been built. Running npm build...
  call npm run build
  if errorlevel 1 exit /b 1
)
start "Pi Chat Server" cmd /k node dist\server\server\index.js --port 30170 --cwd "%USERPROFILE%"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:30170"
