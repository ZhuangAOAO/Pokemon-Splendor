@echo off
cd /d "%~dp0"

netstat -ano | findstr /C:":3000 " | findstr /C:"LISTENING" >nul
if %errorlevel%==0 (
  echo Server is already running. Opening browser...
  start "" http://localhost:3000
  timeout /t 3 /nobreak >nul
  exit /b
)

echo Starting server...
start "Splendor Pokemon Server" cmd /k "node server.js"
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
exit /b
