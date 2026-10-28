#!/usr/bin/env node
// 停止正在跑的机器人：读 .qqbot.lock 里的 pid，发 SIGTERM，等它退出。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, dataPaths } from '../src/config.js';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const args = process.argv.slice(2);
const cfgIndex = args.indexOf('--config');
const configFile = cfgIndex >= 0 ? args[cfgIndex + 1] : 'config.json';
const cfg = loadConfig({ file: configFile });
const paths = dataPaths(cfg);
const lockFile = paths.lock;

if (!fs.existsSync(lockFile)) {
  console.log('机器人没在跑（没有锁文件）。');
  process.exit(0);
}

const raw = fs.readFileSync(lockFile, 'utf8').trim();
const pid = Number.parseInt(raw, 10);
if (!Number.isInteger(pid) || pid <= 0) {
  console.log(`锁文件内容不正常（${raw}），删掉它。`);
  fs.rmSync(lockFile, { force: true });
  process.exit(0);
}

if (!alive(pid)) {
  console.log(`机器人没在跑（记录的进程 ${pid} 已经不在了），删掉锁文件。`);
  fs.rmSync(lockFile, { force: true });
  process.exit(0);
}

try {
  process.kill(pid, 'SIGTERM');
  console.log(`已经让机器人退出（进程 ${pid}）。`);
} catch (err) {
  console.error(`停不掉进程 ${pid}：${err.message}`);
  console.error('可以手动到任务管理器里结束那个 node.exe。');
  process.exit(1);
}

// 最多等 5 秒
for (let i = 0; i < 25; i += 1) {
  if (!alive(pid)) {
    fs.rmSync(lockFile, { force: true });
    console.log('已退出。');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log('它还活着（可能在收尾）。稍等一下再看，或者到任务管理器里结束。');
