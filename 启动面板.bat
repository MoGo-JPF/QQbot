@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title QQbot 控制面板

echo ==========================================
echo   QQ 机器人 · 控制面板
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 找不到 node。先装 Node.js（https://nodejs.org）再回来。
  goto end
)

if not exist "config.json" (
  echo [x] 找不到 config.json，这个文件夹好像不完整。
  goto end
)

rem 面板已经开着了？那就直接开浏览器，不再起第二个
netstat -ano | findstr /c:":8899 " | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo 面板已经在跑了，直接给你打开：http://127.0.0.1:8899
  start "" "http://127.0.0.1:8899"
  timeout /t 2 /nobreak >nul
  goto end
)

echo 面板地址：http://127.0.0.1:8899
echo 关掉这个窗口就等于关掉面板（机器人不受影响）。
echo.
node panel\server.js --config config.json --open
set "code=%ERRORLEVEL%"
if not "%code%"=="0" (
  echo.
  echo [x] 面板退出了，退出码 %code%
)

:end
echo.
echo 按任意键关闭窗口。
pause >nul
