@echo off
REM Restart the ERPNext stack on Railway in dependency order.
REM Double-click to run, or invoke from PowerShell.
REM
REM First-time setup (once):
REM   npm i -g @railway/cli
REM   railway login
REM   railway link    (pick this project)
REM
REM Recovery flow:
REM   1. Redeploy MariaDB (Frappe's DB — if hung, ERPNext can't boot).
REM      Wait long enough for InnoDB crash recovery + 'ready for connections'.
REM   2. Redeploy Redis instances (cheap; clears stale state).
REM   3. Redeploy ERPNext last (so it boots against a ready stack).
REM
REM Postgres is deliberately NOT restarted — it's the Berpal app's DB,
REM not Frappe's, and is independent of this issue.

setlocal
echo.
echo === Restarting ERPNext stack ===
echo.

echo [1/4] Redeploying mariadb-_mo1 (Frappe's database) ...
call railway redeploy --service mariadb-_mo1 --yes
if errorlevel 1 goto :err

echo.
echo Waiting 90s for MariaDB to finish InnoDB crash recovery
echo and start accepting connections. Be patient.
timeout /t 90 /nobreak >nul

echo.
echo [2/4] Redeploying redis-cache-4yaI ...
call railway redeploy --service redis-cache-4yaI --yes
if errorlevel 1 goto :err

echo.
echo [3/4] Redeploying redis-queue-EXeb ...
call railway redeploy --service redis-queue-EXeb --yes
if errorlevel 1 goto :err

echo.
echo Waiting 15s for Redis to come back up ...
timeout /t 15 /nobreak >nul

echo.
echo [4/4] Redeploying erpnext-docker ...
call railway redeploy --service erpnext-docker --yes
if errorlevel 1 goto :err

echo.
echo === Done. Tail logs with: ===
echo   railway logs --service erpnext-docker
echo.
echo If ERPNext still crashes, check MariaDB readiness first:
echo   railway logs --service mariadb-_mo1
echo   (look for "ready for connections")
echo.
pause
exit /b 0

:err
echo.
echo ERROR: a redeploy command failed. Check the message above.
echo If Railway CLI isn't installed: npm i -g @railway/cli
echo If not linked to a project:    railway link
echo.
pause
exit /b 1
