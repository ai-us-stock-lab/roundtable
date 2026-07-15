@echo off
rem Roundtable opener: start server if not running, then open browser
powershell -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:7777/api/config -TimeoutSec 2 | Out-Null } catch { Start-Process -WindowStyle Hidden 'C:\Users\xiaoJ\Documents\Roundtable\start-server.cmd'; Start-Sleep 4 }"
start "" http://127.0.0.1:7777

