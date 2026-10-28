#!/usr/bin/env node
// 把旧位置（~/.dsh）的记忆库、表情库、索引、历史搬进项目的 data/ 目录。
//   node tools/migrate-data.js              搬家（已存在的文件不覆盖）
//   node tools/migrate-data.js --force      覆盖目标
//   node tools/migrate-data.js --dry-run    只看会搬什么
//   node tools/migrate-data.js --from D:\old
import { loadConfig, dataPaths } from '../src/config.js';
import { migrateData, legacyAvailable } from '../src/migrate.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const value = (f, def) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const cfg = loadConfig({ file: value('--config', 'config.json') });
const from = value('--from', undefined);
const dryRun = has('--dry-run');
const force = has('--force');

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

console.log(`项目数据目录：${cfg.storage.root}`);
console.log(`旧数据目录　：${from || '~/.dsh'}`);

if (!from && !legacyAvailable()) {
  console.log('\n没有找到旧数据（可能已经搬过了）。');
  process.exit(0);
}

const report = migrateData(cfg, { from, dryRun, force, log });
if (dryRun) {
  console.log('\n--- 预演（什么都没写） ---');
  for (const it of report.items) {
    const state = it.exists === false ? '缺失' : it.targetExists ? '已存在，会跳过' : '将复制';
    console.log(`  ${it.name}: ${state}\n    ${it.from}\n -> ${it.to}`);
  }
  process.exit(0);
}

console.log('\n--- 结果 ---');
for (const it of report.items) {
  if (it.skipped === 'missing') continue;
  if (it.skipped === 'exists') {
    console.log(`  ${it.name}: 目标已存在，跳过（要覆盖加 --force）`);
    continue;
  }
  if (it.files != null) console.log(`  ${it.name}: ${it.files} 个文件，${(it.bytes / 1024).toFixed(0)} KB`);
  else if (it.copied) console.log(`  ${it.name}: 已复制 ${(it.bytes / 1024).toFixed(1)} KB`);
}
console.log(`\n汇总：归档 ${report.archiveLines} 条消息、长期记忆 ${report.longItems} 条、表情 ${report.stickerItems} 张、网搜索引 ${report.memesCount} 条`);
if (report.stickersRewritten) console.log(`表情索引里有 ${report.stickersRewritten} 条路径改指向新目录。`);
console.log(`\n数据目录：${dataPaths(cfg).root}`);
