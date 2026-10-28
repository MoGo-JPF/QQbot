@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem 登录方式：先扫码（第一次必须扫码）。扫码成功后 QQ 会记住登录记录，
rem 之后开机由 NapCat 的 -q 快速登录直接进去，不用再扫。
rem 如果哪天快速登录又失效、又扫不了码，可以把下面两行打开当兜底：
rem   set "ACCOUNT=3991745047"
rem   set "NAPCAT_QUICK_PASSWORD=你的密码"

if not exist "%~dp0napcat\launcher-win10.bat" (
  echo [x] 找不到 %~dp0napcat\launcher-win10.bat
  exit /b 1
)

if not exist "%~dp0data\logs" mkdir "%~dp0data\logs"

cd /d "%~dp0napcat"
rem 全部输出写到 data\logs\napcat-run.log，方便排查登录问题
call "%~dp0napcat\launcher-win10.bat" -q 3991745047 >> "%~dp0data\logs\napcat-run.log" 2>&1
