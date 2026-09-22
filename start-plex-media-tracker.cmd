@echo off
cd /d "%~dp0"
start "" http://localhost:7000
node src\server.ts
pause
