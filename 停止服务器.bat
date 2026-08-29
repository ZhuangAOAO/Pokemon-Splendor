@echo off

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue|Select-Object -ExpandProperty OwningProcess -Unique; $n=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"|Where-Object{$_.CommandLine -like '*server.js*'}|Select-Object -ExpandProperty ProcessId; $w=Get-Process cmd -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowTitle -like '*Splendor*'}|Select-Object -ExpandProperty Id; $all=@($p)+@($n)+@($w)|Sort-Object -Unique|Where-Object{$_}; $all|ForEach-Object{Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue}; if(@($p)+@($n)|Where-Object{$_}){Write-Host 'Server stopped.'}else{Write-Host 'No server is running.'}"
ping -n 3 127.0.0.1 >nul
exit /b
