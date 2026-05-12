@echo off
setlocal
cd /d "%~dp0"
echo [reset] clearing conversation state...
echo.
node scripts\reset-conversations.js
echo.
pause
endlocal
