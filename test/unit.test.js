import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { deepMerge, loadConfig, validateConfig, DEFAULT_CONFIG } from '../src/config.js';
import { createHistory } from '../src/history.js';
import { describeMessage, normalizeEvent } from '../src/onebot/events.js';
import { decide, stripPrefix } from '../src/policy.js';
import { preview, splitBubbles, splitMessage, stripCQ, tidy } from '../src/util/text.js';

const tmpRoot = path.join(import.meta.dirname, '..', '.tmp-test');
fs.mkdirSync(tmpRoot, { recursive: true });

function tmpFile(name) {
  return path.join(tmpRoot, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

// ---------------------------------------------------------------- 文本

test('splitMessage 短文本原样返回', () => {
  assert.deepEqual(splitMessage('你好'), ['你好']);
  assert.deepEqual(splitMessage('   '), []);
});

test('splitMessage 优先在换行处切', () => {
  const text = `${'a'.repeat(600)}\n${'b'.repeat(600)}`;
  const parts = splitMessage(text, { limit: 700, maxParts: 4 });
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith('a'));
  assert.ok(parts[1].startsWith('b'));
});

test('splitMessage 单行超长硬切并限制段数', () => {
  const parts = splitMessage('x'.repeat(5000), { limit: 1000, maxParts: 3 });
  assert.equal(parts.length, 3);
  assert.match(parts[2], /已省略/);
});

test('splitBubbles 短回复不拆', () => {
  assert.deepEqual(splitBubbles('在呢。'), ['在呢。']);
  assert.deepEqual(splitBubbles('   '), []);
});

test('splitBubbles 按空行分段发', () => {
  const out = splitBubbles('你又没出啥事，我瞎发啥消息。\n\n……而且我又不会自己冒出来，得你来找我。');
  assert.equal(out.length, 2);
  assert.equal(out[0], '你又没出啥事，我瞎发啥消息。');
  assert.equal(out[1], '……而且我又不会自己冒出来，得你来找我。');
});

test('splitBubbles 一行一句就发几条（哪怕都不长）', () => {
  const out = splitBubbles('醒着呢。\n干嘛，大清早掀我被子？');
  assert.deepEqual(out, ['醒着呢。', '干嘛，大清早掀我被子？']);
});

test('splitBubbles 条数有上限，多余的均分合并', () => {
  // 每行 4 个字，避免触发"碎片粘连"
  const out = splitBubbles('甲甲甲。\n乙乙乙。\n丙丙丙。\n丁丁丁。\n戊戊戊。', { max: 3 });
  assert.equal(out.length, 3);
  // 5 段、上限 3 → 均分成 2/2/1（而不是全堆在最后一条）
  assert.deepEqual(out, ['甲甲甲。\n乙乙乙。', '丙丙丙。\n丁丁丁。', '戊戊戊。']);
});

test('splitBubbles 带代码块就整条不拆', () => {
  const text = '看这个：\n```js\nconsole.log(1)\n```\n对吧。';
  assert.deepEqual(splitBubbles(text), [text]);
});

test('splitBubbles 一整段够长才按句子切', () => {
  const short = '嗯，行吧。';
  assert.deepEqual(splitBubbles(short, { minTotal: 60 }), [short]);

  const long = `${'一'.repeat(40)}。${'二'.repeat(40)}。`;
  const out = splitBubbles(long, { minTotal: 20, maxChars: 45 });
  assert.equal(out.length, 2);
  assert.match(out[0], /一/);
  assert.match(out[1], /二/);
});

test('stripCQ / tidy / preview', () => {
  assert.equal(stripCQ('hi[CQ:face,id=1] there'), 'hi there');
  assert.equal(tidy('a  \n\n\n\nb  '), 'a\n\nb');
  assert.equal(preview('x'.repeat(200), 10), `${'x'.repeat(10)}…`);
});

// ---------------------------------------------------------------- 权限

const policy = {
  private: { allow: 'whitelist', users: ['10001'] },
  group: { allow: 'whitelist', groups: ['555'], requireAt: true, prefix: '' },
  denyUsers: ['99999'],
};

test('私聊白名单', () => {
  assert.equal(decide({ kind: 'private', userId: '10001', text: 'hi' }, policy).respond, true);
  assert.equal(decide({ kind: 'private', userId: '10002', text: 'hi' }, policy).reason, 'private-not-in-whitelist');
  assert.equal(decide({ kind: 'private', userId: '10001', text: 'x' }, { ...policy, denyUsers: ['10001'] }).reason, 'user-denied');
  assert.equal(decide({ kind: 'private', userId: '10001', text: 'x' }, { private: { allow: 'none' } }).reason, 'private-disabled');
  assert.equal(decide({ kind: 'private', userId: '1', text: 'x' }, { private: { allow: 'all' } }).respond, true);
});

test('群聊要 @ 或前缀或回复我', () => {
  const base = { kind: 'group', userId: '10001', groupId: '555' };
  assert.equal(decide({ ...base, text: 'hi' }, policy).reason, 'group-not-addressed');
  assert.equal(decide({ ...base, text: 'hi', atSelf: true }, policy).reason, 'group-at');
  assert.equal(decide({ ...base, text: 'hi' }, policy, { isReplyToMe: true }).reason, 'group-reply');
  assert.equal(decide({ kind: 'group', userId: '1', groupId: '666', text: 'hi', atSelf: true }, policy).reason, 'group-not-in-whitelist');

  const withPrefix = { ...policy, group: { ...policy.group, prefix: '小助手' } };
  assert.equal(decide({ ...base, text: '小助手 你好' }, withPrefix).reason, 'group-prefix');
  assert.equal(stripPrefix('小助手 你好', '小助手'), '你好');
});

// ---------------------------------------------------------------- 事件解析

test('normalizeEvent 解析数组消息段', () => {
  const msg = normalizeEvent(
    {
      post_type: 'message',
      message_type: 'group',
      self_id: 42,
      user_id: 10001,
      group_id: 555,
      message_id: 7,
      sender: { card: '小明' },
      message: [
        { type: 'at', data: { qq: '42' } },
        { type: 'text', data: { text: ' 你好' } },
        { type: 'image', data: { url: 'https://x/y.png' } },
      ],
    },
    { selfId: 42 },
  );
  assert.equal(msg.kind, 'group');
  assert.equal(msg.conversationId, 'group:555:10001');
  assert.equal(msg.atSelf, true);
  assert.equal(msg.nickname, '小明');
  assert.match(msg.text, /你好/);
  assert.equal(msg.images.length, 1);
  assert.equal(msg.images[0].url, 'https://x/y.png');
  assert.equal(msg.images[0].subType, 0);
  assert.equal(msg.hasMedia, true);
  assert.equal(describeMessage(msg), '群555 小明(10001)');
});

test('normalizeEvent 认出表情（sub_type=1）和 CQ 里的图片参数', () => {
  const fromArray = normalizeEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 42,
    user_id: 10001,
    message: [{ type: 'image', data: { url: 'https://x/s.png', file: 'abc.gif', sub_type: 1, summary: '狗头' } }],
  });
  assert.equal(fromArray.images[0].subType, 1);
  assert.equal(fromArray.images[0].summary, '狗头');
  assert.equal(fromArray.images[0].file, 'abc.gif');

  const fromCQ = normalizeEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 42,
    user_id: 10001,
    message: '[CQ:image,file=a.png,url=https://x/a.png,sub_type=1,summary=笑]',
  });
  assert.equal(fromCQ.images[0].url, 'https://x/a.png');
  assert.equal(fromCQ.images[0].subType, 1);
  assert.equal(fromCQ.images[0].summary, '笑');
});

test('normalizeEvent 解析 CQ 码字符串', () => {
  const msg = normalizeEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: 42,
    user_id: 10001,
    message: '[CQ:reply,id=33]hi[CQ:face,id=1]',
  });
  assert.equal(msg.kind, 'private');
  assert.equal(msg.replyId, '33');
  assert.equal(msg.text, 'hi');
});

test('normalizeEvent 忽略非消息事件和自己发的消息', () => {
  assert.equal(normalizeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), null);
  assert.equal(normalizeEvent({ post_type: 'notice', notice_type: 'group_increase' }), null);
  assert.equal(
    normalizeEvent({ post_type: 'message', message_type: 'private', self_id: 42, user_id: 42, message: 'x' }),
    null,
  );
});

// ---------------------------------------------------------------- 配置

test('loadConfig 深度合并 + 环境变量覆盖', () => {
  const file = tmpFile('cfg');
  fs.writeFileSync(file, JSON.stringify({ policy: { private: { allow: 'all' }, group: { allow: 'all' } } }));
  const cfg = loadConfig({ file, env: { QQBOT_ENGINE: 'harness' } });
  assert.equal(cfg.engine, 'harness');
  assert.equal(cfg.policy.private.allow, 'all');
  assert.deepEqual(cfg.policy.private.users, []);
  assert.equal(cfg.reply.limit, DEFAULT_CONFIG.reply.limit);
  assert.equal(cfg.__fileExists, true);
  fs.unlinkSync(file);
});

test('validateConfig 拦住明显错配', () => {
  assert.throws(() => validateConfig(structuredClone(DEFAULT_CONFIG)), /白名单|users 是空的/);
  const noKey = structuredClone(DEFAULT_CONFIG);
  noKey.engine = 'openai';
  noKey.policy.private.users = ['1'];
  noKey.policy.group.groups = ['2'];
  assert.throws(() => validateConfig(noKey), /apiKey/);
  const badUrl = structuredClone(noKey);
  badUrl.engine = 'harness';
  badUrl.onebot.ws.url = 'http://nope';
  assert.throws(() => validateConfig(badUrl), /ws:\/\//);
});

test('deepMerge 数组整体替换', () => {
  const out = deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 9 } });
  assert.deepEqual(out, { a: [3], b: { c: 1, d: 9 } });
});

// ---------------------------------------------------------------- 历史

test('history 追加、裁剪、清空、落盘', async () => {
  const file = tmpFile('hist');
  const h = createHistory({ file, maxConversations: 10 });
  h.append('c1', 'user', '你好', { maxTurns: 1 });
  h.append('c1', 'assistant', '嗨', { maxTurns: 1 });
  h.append('c1', 'user', '第二句', { maxTurns: 1 });
  assert.equal(h.get('c1').length, 2, 'maxTurns=1 只留最近两条');
  assert.equal(h.get('c1').at(-1).content, '第二句');

  h.append('c2', 'user', 'x');
  assert.equal(h.size(), 2);

  h.close();
  const reloaded = createHistory({ file });
  assert.equal(reloaded.get('c1').length, 2);
  reloaded.clear('c1');
  assert.equal(reloaded.get('c1').length, 0);
  reloaded.close();
  fs.rmSync(file, { force: true });
});

test('history 按 maxConversations 淘汰最旧', () => {
  const h = createHistory({ maxConversations: 2 });
  h.append('a', 'user', '1');
  h.append('b', 'user', '2');
  h.append('c', 'user', '3');
  assert.equal(h.size(), 2);
  assert.equal(h.get('a').length, 0);
  h.close();
});

void os;
