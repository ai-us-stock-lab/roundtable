@echo off
rem Roundtable resident server launcher (used by Startup folder autostart)
cd /d "%~dp0"
node src\server.js
