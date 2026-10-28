// 单实例锁：防止同时开两个机器人，把一条消息回两遍。
//
// 做法很土但够用：在项目目录写一个 .qqbot.lock，内容是自己的 pid。
// 启动时先看锁文件：里面的进程还活着就拒绝启动；进程没了（上次崩了/被强杀）就接管。

import fs from 'node:fs';
import path from 'node:path';

const LOCK_NAME = '.qqbot.lock';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但没权限发信号，也算活着
    return err?.code === 'EPERM';
  }
}

export function acquireLock(dir, { pid = process.pid, file: name = LOCK_NAME } = {}) {
  const file = path.join(dir, name);

  let holder = 0;
  try {
    holder = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    holder = 0;
  }

  if (holder && holder !== pid && pidAlive(holder)) {
    return { ok: false, pid: holder, file, release: () => {} };
  }

  const release = () => {
    try {
      if (Number(fs.readFileSync(file, 'utf8').trim()) === pid) fs.unlinkSync(file);
    } catch {
      // 文件已经不在了，无所谓
    }
  };

  try {
    fs.writeFileSync(file, String(pid));
  } catch {
    // 目录不可写（比如沙箱）时不要因此起不来，只是少了这层保护
    return { ok: true, pid, file, release: () => {}, degraded: true };
  }

  return { ok: true, pid, file, release };
}
