@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo [run] node_modules not found, installing...
  call npm install || goto :error
)

if not exist .env (
  echo [run] WARNING: .env not found. Copy .env.example to .env and fill in your Twilio credentials.
  echo.
)

echo [run] starting Next.js dev server on http://localhost:3000
echo [run] webhook:  POST http://localhost:3000/api/webhook
echo [run] homepage: http://localhost:3000/
echo [run] press Ctrl+C to stop
echo.
call npx next dev
echo.
echo [run] server exited (code %errorlevel%). Press any key to close.
pause >nul
goto :end

:error
echo.
echo [run] failed to start. See errors above.
pause
exit /b 1

:end
endlocal
