// 面板要用到的管理方法：记忆的增删改查、表情的改标签、findMany 的两种调用姿势
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemory } from '../src/memory.js';
import { createMedia } from '../src/media.js';

const silent = { error() {}, warn() {}, info() {}, debug() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-admin-'));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeMemory() {
  const dir = tmp();
  return { dir, mem: createMemory({ enabled: true, dir }, { log: silent }) };
}

test('记忆：listLong 能列全部、按会话过滤、按关键词过滤', () => {
  const { mem, dir } = makeMemory();
  mem.remember({ text: '他喜欢美式咖啡', tags: ['饮料'], cid: 'private:1' });
  mem.remember({ text: '他住在杭州', tags: ['城市'], cid: 'private:2' });

  assert.equal(mem.listLong().length, 2);
  assert.equal(mem.listLong({ cid: 'private:1' }).length, 1);
  assert.equal(mem.listLong({ q: '咖啡' }).length, 1);
  assert.equal(mem.listLong({ q: '杭州' })[0].text, '他住在杭州');
  assert.equal(mem.listLong({ q: '不存在' }).length, 0);
  // 按时间倒序
  assert.ok(mem.listLong()[0].t >= mem.listLong()[1].t);
  mem.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('记忆：updateLong 改内容和标签，落盘后还在', () => {
  const { mem, dir } = makeMemory();
  const item = mem.remember({ text: '他喜欢美式', tags: ['饮料'] });
  const updated = mem.updateLong(item.id, { text: '他喜欢美式，不加糖', tags: '饮料,偏好' });
  assert.equal(updated.text, '他喜欢美式，不加糖');
  assert.deepEqual(updated.tags, ['饮料', '偏好']);
  mem.close();

  const again = createMemory({ enabled: true, dir }, { log: silent });
  const found = again.listLong().find((i) => i.id === item.id);
  assert.equal(found.text, '他喜欢美式，不加糖');
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('记忆：updateLong 改不存在的 id 返回 null', () => {
  const { mem, dir } = makeMemory();
  assert.equal(mem.updateLong('nope', { text: 'x' }), null);
  mem.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('记忆：recentMessages 最新的在前，能按会话和关键词过滤', () => {
  const { mem, dir } = makeMemory();
  const now = Date.now();
  mem.record('private:1', 'user', '第一句', { t: now - 3000 });
  mem.record('private:1', 'assistant', '第二句', { t: now - 2000 });
  mem.record('private:2', 'user', '别的会话', { t: now - 1000 });
  mem.flush();

  const all = mem.recentMessages({ limit: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[0].text, '别的会话');

  const one = mem.recentMessages({ cid: 'private:1' });
  assert.equal(one.length, 2);
  assert.equal(one[0].text, '第二句');

  const hit = mem.recentMessages({ q: '第一句' });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].text, '第一句');

  mem.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('记忆：deleteMessage 删掉一条原话，其它不动', () => {
  const { mem, dir } = makeMemory();
  const t = Date.now() - 5000;
  mem.record('private:1', 'user', '要删的这句', { t });
  mem.record('private:1', 'assistant', '留着的这句', { t: t + 1 });
  mem.flush();

  const ok = mem.deleteMessage({ t, cid: 'private:1', role: 'user', text: '要删的这句' });
  assert.equal(ok, true);
  const left = mem.recentMessages({ limit: 10 });
  assert.equal(left.length, 1);
  assert.equal(left[0].text, '留着的这句');
  // 删不存在的返回 false
  assert.equal(mem.deleteMessage({ t: 1, cid: 'x', role: 'user', text: '没有' }), false);
  mem.close();

  // 落盘后也不回来
  const again = createMemory({ enabled: true, dir }, { log: silent });
  assert.equal(again.recentMessages({ limit: 10 }).length, 1);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('表情：update 改标签和备注', () => {
  const dir = tmp();
  const mk = () => createMedia({ dir, stickerDir: path.join(dir, 'none') }, { log: silent });
  const a = mk();
  const item = a.storeImage(PNG, 'image/png', { tags: ['旧'], note: '旧备注', from: 'test' });
  const updated = a.update(item.id, { tags: '新,更细', note: '新备注' });
  assert.deepEqual(updated.tags, ['新', '更细']);
  assert.equal(updated.note, '新备注');
  a.close();

  const b = mk();
  const again = b.list().find((i) => i.id === item.id);
  assert.deepEqual(again.tags, ['新', '更细']);
  assert.equal(b.update('nope', { tags: 'x' }), null);
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('表情：findMany 第二参数可以是数字也可以是 {limit}', () => {
  const dir = tmp();
  const m = createMedia({ dir, stickerDir: path.join(dir, 'none') }, { log: silent });
  for (const [i, tag] of ['生气', '生气', '开心'].entries()) {
    m.storeImage(Buffer.concat([PNG, Buffer.from(`${tag}-${i}`)]), 'image/png', { tags: [tag], from: 'test' });
  }
  assert.equal(m.findMany('生气').length, 2);
  assert.equal(m.findMany('生气', 1).length, 1);
  assert.equal(m.findMany('生气', { limit: 1 }).length, 1);
  assert.equal(m.findMany('生气', { limit: 500 }).length, 2);
  assert.equal(m.findMany('没有这个词').length, 0);
  m.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
