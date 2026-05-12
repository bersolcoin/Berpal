@echo off
setlocal
cd /d "%~dp0"
echo [create-template] running setup script...
echo.
node scripts\create-confirmation-template.js
echo.
pause
endlocal
