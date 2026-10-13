@echo off
REM ERP local PostgreSQL launcher (double-click friendly)
REM Uses %~dp0 so the path stays ASCII-safe regardless of where the repo lives.
pushd "%~dp0.."
node scripts\db.mjs start
if errorlevel 1 (
  echo.
  echo [db-start] failed. See message above.
)
popd
pause
