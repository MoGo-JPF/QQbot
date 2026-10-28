@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"
title QQbot 菜单

:menu
cls
echo ==========================================
echo   QQ 机器人 · 菜单
echo ==========================================
echo.
echo   1. 打开控制面板（推荐，网页里什么都能干）
echo   2. 只启动机器人
echo   3. 启动 NapCat（要扫码的话在这一步扫）
echo   4. 停止机器人
echo   5. 重建"网上找表情"的索引（约 1 分钟）
echo   6. 打开 NapCat 网页
echo   7. 打开数据目录
echo   8. 把旧数据（~/.dsh）搬到 data\ 里
echo   0. 退出
echo.
set "pick="
set /p "pick=输入数字再回车："

if "%pick%"=="1" goto panel
if "%pick%"=="2" goto bot
if "%pick%"=="3" goto napcat
if "%pick%"=="4" goto stopbot
if "%pick%"=="5" goto memes
if "%pick%"=="6" goto webui
if "%pick%"=="7" goto datadir
if "%pick%"=="8" goto migrate
if "%pick%"=="0" exit /b 0
goto menu

:panel
echo.
echo 正在启动面板……
start "" /min cmd /c "node panel\server.js --config config.json --open"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8899"
goto menu

:bot
echo.
node src\index.js
goto menu

:napcat
echo.
start "" /min "%~dp0start-napcat-log.bat"
echo 已拉起 NapCat。如果需要扫码，去控制面板的「登录·二维码」页看。
timeout /t 3 /nobreak >nul
goto menu

:stopbot
echo.
node tools\stop-bot.js
timeout /t 2 /nobreak >nul
goto menu

:memes
echo.
node tools\fetch-memes.js
pause
goto menu

:webui
echo.
node tools\open-napcat.js
goto menu

:datadir
echo.
if not exist "data" mkdir "data"
start "" explorer "%~dp0data"
goto menu

:migrate
echo.
node tools\migrate-data.js
pause
goto menu
