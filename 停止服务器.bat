@echo off

set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":3000 " ^| findstr /C:"LISTENING"') do (
  set FOUND=1
  taskkill /F /PID %%a >/dev/null 2>&1
)

if %FOUND%==1 (
  echo Server stopped.
) else (
  echo No server is running.
)
timeout /t 3 /nobreak >nul
exit /b
