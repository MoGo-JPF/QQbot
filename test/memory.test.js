import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemory, dateKey, oneLine, tokenize } from '../src/memory.js';

const DAY = 24 * 60 * 60 * 1000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-mem-'));
}

const noop = () => {};
function quietLog() {
  const logger = { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
  logger.child = () => logger;
  return logger;
}

function make(cfg = {}) {
  return createMemory({ dir: tmpDir(), shortDays: 14, ...cfg }, { log: quietLog() });
}

test('tokenize 能切开中文和英文', () => {
  const t = tokenize('我喜欢吃火锅 hotpot');
  assert.ok(t.has('火锅'));
  assert.ok(t.has('火锅'.slice(0, 2)));
  assert.ok(t.has('hotpot') || t.has('hot'));
});

test('oneLine 压掉换行并截断', () => {
  assert.equal(oneLine('a\n\nb   c'), 'a b c');
  assert.ok(oneLine('x'.repeat(50), 10).endsWith('…'));
});

test('短期记忆只装最近 N 天，并带时间戳', () => {
  const now = Date.now();
  const m = make();
  m.record('private:1', 'user', '三周前说的话', { t: now - 21 * DAY });
  m.record('private:1', 'user', '昨天说的话', { t: now - DAY });
  m.record('private:1', 'assistant', '刚说的话', { t: now - 1000 });
  const s = m.shortTerm('private:1', { now });
  assert.equal(s.count, 2);
  assert.ok(s.lines.some((l) => l.includes('昨天说的话')));
  assert.ok(s.lines.some((l) => l.includes('刚说的话')));
  assert.ok(!s.lines.some((l) => l.includes('三周前')));
  // 时间戳格式 [MM-DD HH:mm]
  assert.match(s.lines[0], /^\[\d{2}-\d{2} \d{2}:\d{2}\] /);
  m.close();
});

test('短期记忆受字数上限约束，丢掉最旧的', () => {
  const now = Date.now();
  const m = make({ shortMaxChars: 60 });
  for (let i = 0; i < 10; i += 1) {
    m.record('c', 'user', `第${i}条消息内容比较长一点点`, { t: now - (10 - i) * 60000 });
  }
  const s = m.shortTerm('c', { now });
  assert.ok(s.lines.length > 0);
  assert.ok(s.chars <= 60 + 40);
  assert.ok(s.lines[s.lines.length - 1].includes('第9条'));
  m.close();
});

test('skip 参数把已经出现在上下文里的最近几条让出去', () => {
  const now = Date.now();
  const m = make();
  for (let i = 0; i < 6; i += 1) m.record('c', 'user', `消息${i}`, { t: now - (6 - i) * 1000 });
  const all = m.shortTerm('c', { now });
  const skipped = m.shortTerm('c', { now, skip: 2 });
  assert.equal(all.count, 6);
  assert.equal(skipped.count, 6);
  assert.equal(skipped.lines.length, 4);
  assert.ok(!skipped.lines.some((l) => l.includes('消息5')));
  m.close();
});

test('长期记忆：记住、按关键词检索、去重、遗忘', () => {
  const m = make();
  const a = m.remember({ cid: 'c', text: '我不吃香菜', tags: ['偏好'], weight: 2 });
  assert.ok(a.id);
  const again = m.remember({ cid: 'c', text: '我不吃香菜' });
  assert.equal(again.id, a.id);
  assert.equal(m.stats().longItems, 1);

  const hits = m.searchLong('香菜能吃吗', { cid: 'c' });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].text.includes('香菜'));

  const miss = m.searchLong('量子力学', { cid: 'c' });
  assert.equal(miss.length, 0);

  assert.ok(m.forget(a.id));
  assert.equal(m.stats().longItems, 0);
  m.close();
});

test('遗忘支持按关键词', () => {
  const m = make();
  m.remember({ cid: 'c', text: '我住在杭州', tags: ['地址'] });
  assert.ok(m.forget('杭州'));
  assert.equal(m.stats().longItems, 0);
  assert.equal(m.forget('杭州'), false);
  m.close();
});

test('归档检索能翻到短期记忆之外的老消息', () => {
  const now = Date.now();
  const m = make();
  m.record('c', 'user', '我们去年去吃了火锅', { t: now - 120 * DAY });
  m.record('c', 'user', '今天天气不错', { t: now - DAY });
  const hits = m.searchMessages('你还记得火锅吗', { cid: 'c', now });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].text.includes('火锅'));
  m.close();
});

test('context：平时给短期记忆，被问"记得吗"时额外翻旧账', () => {
  const now = Date.now();
  const m = make();
  m.remember({ cid: 'c', text: '对方养了一只叫豆豆的猫', tags: ['宠物'], weight: 2 });
  // 30 天前，已经在短期窗口（14 天）之外，只能靠翻旧账找回来
  m.record('c', 'user', '豆豆昨天又把杯子打碎了', { t: now - 30 * DAY });
  m.record('c', 'user', '今天好困', { t: now - 1000 });

  const normal = m.context({ cid: 'c', text: '今天有点累', now });
  assert.ok(normal.block.includes('最近 14 天你们聊过的'));
  assert.ok(normal.block.includes('记忆档案'));
  assert.ok(normal.block.includes('不要逐条复述'));
  assert.equal(normal.recallHits, 0, '平时不该翻旧账');

  const recall = m.context({ cid: 'c', text: '你还记得豆豆吗', now });
  assert.ok(recall.longHits >= 1);
  assert.ok(recall.recallHits >= 1);
  assert.ok(recall.block.includes('豆豆'));
  assert.ok(recall.block.includes('翻到的更早的原话'));
  m.close();
});

test('context：短期记忆里已经有的原话，不在"翻旧账"里重复', () => {
  const now = Date.now();
  const m = make();
  m.record('c', 'user', '我最喜欢喝美式咖啡', { t: now - 2 * DAY });
  const ctx = m.context({ cid: 'c', text: '你还记得我最喜欢喝什么吗', now });
  assert.ok(ctx.block.includes('美式咖啡'));
  assert.equal(ctx.recallHits, 0, '已经写在短期记忆里的不该再列一遍');
  const times = ctx.block.split('美式咖啡').length - 1;
  assert.equal(times, 1);
  m.close();
});

test('context：没有内容时返回空块，不浪费 token', () => {
  const m = make();
  const ctx = m.context({ cid: 'nobody', text: '你好', now: Date.now() });
  assert.equal(ctx.block, '');
  m.close();
});

test('关掉记忆库时什么都不做', () => {
  const m = make({ enabled: false });
  m.record('c', 'user', '这句话不该被记住');
  assert.deepEqual(m.shortTerm('c', { now: Date.now() }).lines, []);
  assert.equal(m.context({ cid: 'c', text: '你好' }).block, '');
  assert.equal(m.remember({ cid: 'c', text: '记住也没用' }), null);
  m.close();
});

test('重开进程还能读回来（archive.jsonl + long.json）', () => {
  const dir = tmpDir();
  const now = Date.now();
  const m1 = createMemory({ dir }, { log: quietLog() });
  m1.record('private:9', 'user', '记住我喜欢喝美式', { t: now - DAY });
  m1.remember({ cid: 'private:9', text: '他喜欢喝美式', tags: ['偏好'] });
  m1.close();

  const m2 = createMemory({ dir }, { log: quietLog() });
  const s = m2.stats();
  assert.equal(s.messages, 1);
  assert.equal(s.longItems, 1);
  assert.ok(m2.shortTerm('private:9', { now }).lines[0].includes('美式'));
  assert.equal(m2.searchLong('美式', { cid: 'private:9' }).length, 1);
  m2.close();
});

test('timeline 按天归拢最近的聊天', () => {
  const now = Date.now();
  const m = make();
  m.record('c', 'user', '昨天第一句', { t: now - DAY });
  m.record('c', 'assistant', '昨天第二句', { t: now - DAY + 1000 });
  m.record('c', 'user', '今天的话', { t: now - 1000 });
  const rows = m.timeline('c', { days: 3, now });
  assert.equal(rows.length, 2);
  assert.ok(rows[0].startsWith(dateKey(now - DAY)));
  assert.ok(rows[0].includes('2 条'));
  m.close();
});

test('每天自动小结会变成长期记忆条目', () => {
  const now = Date.now();
  const m = make();
  m.record('c', 'user', '昨天聊了火锅', { t: now - DAY });
  m.record('c', 'assistant', '嗯，火锅好吃', { t: now - DAY + 1000 });
  const made = m.runDailyDigest({ now });
  assert.ok(made >= 1);
  const dayItems = m.searchLong('日记', { cid: 'c', limit: 10 }).filter((i) => i.kind === 'day');
  assert.equal(dayItems.length, 1);
  assert.ok(dayItems[0].text.includes('火锅'));
  // 同样的一天不会重复生成
  assert.equal(m.runDailyDigest({ now: now + 2 * 60 * 60 * 1000 }), 0);
  m.close();
});

test('两种引擎拿到的记忆格式一致：都是字符串', () => {
  const now = Date.now();
  const m = make();
  m.record('c', 'user', '在吗', { t: now - 1000 });
  const ctx = m.context({ cid: 'c', text: '在吗', now });
  assert.equal(typeof ctx.block, 'string');
  assert.ok(ctx.block.length > 0);
  m.close();
});
