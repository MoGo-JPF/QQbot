import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireLock } from '../src/lock.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-lock-'));
}

test('拿到锁会写文件，release 会删掉', () => {
  const dir = tmpDir();
  const lock = acquireLock(dir, { pid: 4321 });
  assert.equal(lock.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, '.qqbot.lock'), 'utf8'), '4321');
  lock.release();
  assert.equal(fs.existsSync(path.join(dir, '.qqbot.lock')), false);
});

test('已经有人在跑就拒绝启动', () => {
  const dir = tmpDir();
  // 用本进程的 pid 冒充"另一个还活着的机器人"
  fs.writeFileSync(path.join(dir, '.qqbot.lock'), String(process.pid));
  const lock = acquireLock(dir, { pid: process.pid + 1 });
  assert.equal(lock.ok, false);
  assert.equal(lock.pid, process.pid);
});

test('锁文件里的进程已经死了，就接管它', () => {
  const dir = tmpDir();
  // 一个几乎不可能存在的 pid
  fs.writeFileSync(path.join(dir, '.qqbot.lock'), '999999');
  const lock = acquireLock(dir, { pid: 1234 });
  assert.equal(lock.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, '.qqbot.lock'), 'utf8'), '1234');
  lock.release();
});

test('锁文件内容坏了照样能启动', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.qqbot.lock'), 'not-a-pid');
  const lock = acquireLock(dir, { pid: 5678 });
  assert.equal(lock.ok, true);
  lock.release();
});

test('目录不可写时降级成"没锁"，但别拦着启动', () => {
  const dir = path.join(tmpDir(), 'nope', 'deeper');
  const lock = acquireLock(dir, { pid: 777 });
  assert.equal(lock.ok, true);
  assert.equal(lock.degraded, true);
  assert.doesNotThrow(() => lock.release());
});
