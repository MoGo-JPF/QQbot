@echo off
rem 面板 / 菜单共用：关掉正在跑的 QQ，再由 NapCat 拉起 QQ（NapCat 必须自己拉 QQ 才能注入）
setlocal
cd /d "%~dp0"

taskkill /im QQ.exe >nul 2>nul
timeout /t 3 /nobreak >nul
taskkill /f /im QQ.exe >nul 2>nul
timeout /t 2 /nobreak >nul

call "%~dp0start-napcat-log.bat"
