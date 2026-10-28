// 把以前存在 ~/.dsh/qqbot-history.json 里的对话导入记忆库。
//
// 为什么要这一步：记忆库是这个版本才加的，之前的聊天只存在 history.json（只保留最近几轮），
// 导进 archive.jsonl 之后，它就"从今天开始"记得更早的事了。
//
// 用法：
//   node tools/import-history.js            # 导入
//   node tools/import-history.js --dry-run  # 只看会导多少条
//
// 说明：history.json 里没有时间戳，这里按文件最后修改时间往前每条间隔 1 分钟推算，
// 所以导入的消息时间只是"大概"，用来让记忆有先后顺序。

import fs from 'node:fs';
import path from 'node:path';

import { expandHome, loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';
import { createMemory } from '../src/memory.js';

const dryRun = process.argv.includes('--dry-run');
const GAP_MS = 60 * 1000;

const cfg = loadConfig();
const log = createLog({ level: 'warn', file: '', toStderr: true });
const memory = createMemory(cfg.memory, { log });

const file = expandHome(cfg.history.file);
if (!fs.existsSync(file)) {
  console.log(`没有找到 ${file}，没什么可导的。`);
  process.exit(0);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
} catch (err) {
  console.error(`读不了 ${file}：${err.message}`);
  process.exit(1);
}

const mtime = fs.statSync(file).mtimeMs;
let total = 0;
let skipped = 0;

for (const [cid, entry] of Object.entries(raw)) {
  const list = Array.isArray(entry?.messages) ? entry.messages : Array.isArray(entry) ? entry : [];
  if (list.length === 0) continue;
  // 最后一条落在文件修改时间上，往前每条退一分钟
  const base = mtime - (list.length - 1) * GAP_MS;
  list.forEach((m, i) => {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : '';
    const text = String(m?.content ?? '').trim();
    if (!role || !text) return;
    if (memory.has(cid, role, text)) {
      skipped += 1;
      return;
    }
    if (!dryRun) memory.record(cid, role, text, { t: base + i * GAP_MS });
    total += 1;
  });
}

memory.close();
console.log(
  `${dryRun ? '会导入' : '已导入'} ${total} 条，跳过重复 ${skipped} 条。` +
    (dryRun ? '' : `\n存档：${path.join(memory.dir, 'archive.jsonl')}`),
);
