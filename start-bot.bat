@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title QQbot

echo ==========================================
echo   QQ 机器人启动中...
echo   关掉这个窗口 = 停掉机器人
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

node src/index.js
set "code=%ERRORLEVEL%"
echo.
if not "%code%"=="0" echo [qqbot] node 退出码 %code%
goto done

:no_node
echo [x] 找不到 Node.js。
echo     请先安装 Node.js 20 或更新版本：https://nodejs.org/
echo     装完重开这个窗口。

:done
echo.
echo 按任意键关闭窗口。
pause >nul
