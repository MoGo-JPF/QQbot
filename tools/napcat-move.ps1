#requires -RunAsAdministrator
# 把 C:\NapCat 搬进项目目录（需要管理员：要结束以管理员身份运行的 QQ / NapCat 进程）
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\jpf\Desktop\DeepSeek\QQbot'
$src = 'C:\NapCat'
$dst = Join-Path $root 'napcat'
$log = Join-Path $root 'data\logs\napcat-move.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Say($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding utf8
}

Say "开始：结束 QQ / NapCat 进程"
for ($i = 1; $i -le 10; $i++) {
  Get-Process NapCatWinBootMain -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process QQ -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1500
  $left = @(Get-Process NapCatWinBootMain, QQ -ErrorAction SilentlyContinue).Count
  Say "第 $i 轮，剩余 $left"
  if ($left -eq 0) { break }
}
Start-Sleep -Seconds 2

if (-not (Test-Path $src)) {
  if (Test-Path $dst) { Say "源目录已不在，目标已存在，视为完成"; exit 0 }
  Say "错误：源目录 $src 不存在"; exit 1
}

Say "移动 $src -> $dst"
try {
  Move-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
  Say "移动完成"
} catch {
  Say ("移动失败：" + $_.Exception.Message)
  Say "改为复制..."
  robocopy $src $dst /E /R:2 /W:1 /NFL /NDL /NJH /NJS | Out-Null
  Say ("复制结束，退出码 " + $LASTEXITCODE)
}

if (Test-Path $dst) {
  $s = Get-ChildItem $dst -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
  Say ("目标现有 {0} 个文件，{1:N1} MB" -f $s.Count, ($s.Sum / 1MB))
}
if (Test-Path $src) {
  $left = @(Get-ChildItem $src -Recurse -File -ErrorAction SilentlyContinue).Count
  Say "旧目录还残留 $left 个文件（可以稍后手动删）"
} else {
  Say "旧目录已清空"
}
Say "完成"
