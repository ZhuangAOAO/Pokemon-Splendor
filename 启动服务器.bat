@echo off
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if($p){ Write-Host 'Server is already running. Opening browser...'; Start-Process 'http://localhost:3000'; exit 0 } else { exit 1 }"
if %errorlevel%==0 exit /b

echo Starting server...
start "Splendor Pokemon Server" cmd /k "node server.js"
ping -n 3 127.0.0.1 >nul
start "" http://localhost:3000
exit /b
