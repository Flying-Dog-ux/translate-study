@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 逐句译 · Translate Study
echo.
echo   逐句译 · Translate Study
echo   正在启动本地服务...
echo.
call npm start
if errorlevel 1 (
  echo.
  echo 启动失败：请确认已安装 Node.js 20+，且端口 5180 未被占用。
)
echo.
pause
