@echo off
rem Skill Lab 一键启动（双击即可）
rem 会在需要时自动下载便携版 Node 运行时，无需预装环境。

setlocal
cd /d "%~dp0"

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上面的提示。
  pause
)
endlocal
