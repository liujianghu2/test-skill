@echo off
rem ===============================================================
rem  Skill Lab - one click start
rem  Double click this file: it prepares the Node runtime if needed,
rem  starts the server and opens the page in your default browser.
rem  (Chinese messages are printed by start.ps1.)
rem ===============================================================

setlocal
cd /d "%~dp0"

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Open %*
if errorlevel 1 (
  echo.
  echo Start failed. See the messages above.
  pause
)
endlocal