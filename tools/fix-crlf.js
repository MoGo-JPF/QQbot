// 把 .bat 文件统一成 CRLF —— cmd.exe 按 CRLF 切行，LF 会把行从中间截断。
// 用法: node tools/fix-crlf.js 启动面板.bat 菜单.bat start-napcat-log.bat
import fs from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node tools/fix-crlf.js <file.bat> [...]');
  process.exit(2);
}

let bad = 0;
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const fixed = raw.replace(/\r?\n/g, '\r\n');
  if (fixed !== raw) fs.writeFileSync(file, fixed, 'utf8');
  const check = fs.readFileSync(file, 'utf8');
  const crlf = (check.match(/\r\n/g) || []).length;
  const bareLf = (check.replace(/\r\n/g, '').match(/\n/g) || []).length;
  if (bareLf > 0) bad++;
  console.log(`${file}: ${crlf} 行 CRLF，裸 LF ${bareLf} 个${fixed !== raw ? '（已修正）' : ''}`);
}
process.exit(bad === 0 ? 0 : 1);
