import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createBot } from '../src/bot.js';
import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { createMedia } from '../src/media.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeMedia(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-bot-'));
  return createMedia({ stickerDir: path.join(dir, 'none'), ...opts, dir }, { log: silentLog() });
}

function makeCfg(patch = {}) {
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), {
    policy: {
      private: { allow: 'whitelist', users: ['10001'] },
      group: { allow: 'whitelist', groups: ['555'], requireAt: true, prefix: '', replyToMe: true },
    },
    ...patch,
  });
  cfg.log = { level: 'error', file: '' };
  return cfg;
}

function silentLog() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop, trace: noop, child: () => ({ error: noop, warn: noop, info: noop, debug: noop }) };
}

function makeTransport() {
  const calls = [];
  return {
    name: 'fake',
    calls,
    isReady: true,
    async start() {},
    async stop() {},
    async call(action, params) {
      calls.push({ action, params });
      return { message_id: 1000 + calls.length };
    },
  };
}

function makeEngine(impl) {
  const engine = {
    name: 'fake',
    managesHistory: false,
    calls: [],
    resetCalls: [],
    async chat(args) {
      engine.calls.push(args);
      if (impl) return impl(args);
      return { text: `echo:${args.text}` };
    },
    async reset(cid) {
      engine.resetCalls.push(cid);
    },
  };
  return engine;
}

function privateEvent(text, userId = 10001) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 42,
    user_id: userId,
    message_id: Math.floor(Math.random() * 1e6),
    time: Math.floor(Date.now() / 1000),
    sender: { nickname: '小明' },
    message: text,
  };
}

function groupEvent(segments, userId = 10001, groupId = 555) {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 42,
    user_id: userId,
    group_id: groupId,
    message_id: Math.floor(Math.random() * 1e6),
    time: Math.floor(Date.now() / 1000),
    sender: { card: '小明' },
    message: segments,
  };
}

function sentText(call) {
  return (call.params.message || [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data.text)
    .join('');
}

test('白名单私聊会调用引擎并回复', async () => {
  const transport = makeTransport();
  const engine = makeEngine();
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await bot.handle(privateEvent('你好'));

  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].conversationId, 'private:10001');
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].action, 'send_private_msg');
  assert.equal(transport.calls[0].params.user_id, 10001);
  assert.equal(sentText(transport.calls[0]), 'echo:你好');
});

test('两行回复会拆成两条消息发', async () => {
  const transport = makeTransport();
  const engine = makeEngine(async () => ({ text: '醒着呢。\n干嘛，大清早掀我被子？' }));
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await bot.handle(privateEvent('醒醒'));

  assert.equal(transport.calls.length, 2, '应该发两条');
  assert.equal(sentText(transport.calls[0]), '醒着呢。');
  assert.equal(sentText(transport.calls[1]), '干嘛，大清早掀我被子？');
});

test('关掉 reply.split 就还是发一条', async () => {
  const transport = makeTransport();
  const engine = makeEngine(async () => ({ text: '醒着呢。\n干嘛，大清早掀我被子？' }));
  const bot = createBot({
    cfg: makeCfg({ reply: { split: false } }),
    log: silentLog(),
    engine,
    transport,
    history: null,
  });

  await bot.handle(privateEvent('醒醒'));

  assert.equal(transport.calls.length, 1);
  assert.match(sentText(transport.calls[0]), /醒着呢。/);
  assert.match(sentText(transport.calls[0]), /掀我被子/);
});

test('指令输出不会被拆散（帮助只有一条）', async () => {
  const transport = makeTransport();
  const engine = makeEngine();
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await bot.handle(privateEvent('/help'));

  assert.equal(transport.calls.length, 1);
  assert.match(sentText(transport.calls[0]), /可用指令/);
});

test('不在白名单的私聊完全不理', async () => {  const transport = makeTransport();
  const engine = makeEngine();
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await bot.handle(privateEvent('你好', 20002));

  assert.equal(engine.calls.length, 0);
  assert.equal(transport.calls.length, 0);
});

test('群里不 @ 不说话，@ 了才回并带上 at', async () => {
  const transport = makeTransport();
  const engine = makeEngine();
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await bot.handle(groupEvent([{ type: 'text', data: { text: '随便聊聊' } }]));
  assert.equal(transport.calls.length, 0);

  await bot.handle(groupEvent([{ type: 'at', data: { qq: '42' } }, { type: 'text', data: { text: ' 在吗' } }]));
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].action, 'send_group_msg');
  assert.equal(transport.calls[0].params.group_id, 555);
  assert.deepEqual(transport.calls[0].params.message[0], { type: 'at', data: { qq: '10001' } });
  assert.equal(sentText(transport.calls[0]), 'echo:在吗');
});

test('群前缀触发并剥掉前缀', async () => {
  const transport = makeTransport();
  const engine = makeEngine();
  const bot = createBot({
    cfg: makeCfg({ policy: { group: { allow: 'all', prefix: '小助手', requireAt: true } } }),
    log: silentLog(),
    engine,
    transport,
    history: null,
  });

  await bot.handle(groupEvent([{ type: 'text', data: { text: '小助手 今天几号' } }]));
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].text, '今天几号');
});

test('/help 不调用模型', async () => {
  const transport = makeTransport();
  const engine = makeEngine();
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await bot.handle(privateEvent('/help'));
  assert.equal(engine.calls.length, 0);
  assert.match(sentText(transport.calls[0]), /可用指令/);
});

test('/reset 清空引擎与历史', async () => {
  const transport = makeTransport();
  const engine = makeEngine();
  const cleared = [];
  const history = { clear: (cid) => cleared.push(cid), size: () => 0 };
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history });

  await bot.handle(privateEvent('/reset'));
  assert.deepEqual(engine.resetCalls, ['private:10001']);
  assert.deepEqual(cleared, ['private:10001']);
});

test('长回复会拆成多条', async () => {
  const transport = makeTransport();
  const engine = makeEngine(async () => ({ text: `${'字'.repeat(1600)}` }));
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await bot.handle(privateEvent('说长点'));
  assert.equal(transport.calls.length, 2);
  assert.ok(sentText(transport.calls[0]).length <= 1500);
});

test('引擎报错时回一句人话', async () => {
  const transport = makeTransport();
  const engine = makeEngine(async () => {
    throw new Error('模型接口限流（429）');
  });
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await bot.handle(privateEvent('你好'));
  assert.match(sentText(transport.calls.at(-1)), /抱歉，出错了：模型接口限流/);
});

test('同一会话串行处理', async () => {
  const order = [];
  const transport = makeTransport();
  const engine = makeEngine(async ({ text }) => {
    order.push(`start:${text}`);
    await new Promise((r) => setTimeout(r, 30));
    order.push(`end:${text}`);
    return { text };
  });
  const bot = createBot({ cfg: makeCfg(), log: silentLog(), engine, transport, history: null });

  await Promise.all([bot.handle(privateEvent('A')), bot.handle(privateEvent('B'))]);
  assert.deepEqual(order, ['start:A', 'end:A', 'start:B', 'end:B']);
});

test('收到图片会下载下来交给引擎，并自动记进图库', async () => {
  const media = makeMedia();
  const transport = makeTransport();
  const engine = makeEngine(async ({ text, images }) => {
    assert.equal(images.length, 1);
    assert.ok(images[0].dataUrl.startsWith('data:image/png;base64,'));
    return { text: `图我看到了：${text}` };
  });
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media });

  await bot.handle(
    privateEvent([{ type: 'image', data: { url: `data:image/png;base64,${PNG.toString('base64')}` } }]),
  );

  assert.equal(engine.calls.length, 1);
  assert.match(engine.calls[0].text, /图片/);
  assert.equal(media.list().length, 0, '普通聊天图不会自己变成表情包');
  media.close();
});

test('回复里写 [表情:笑] 会真的把图发出去', async () => {
  const media = makeMedia();
  media.storeImage(PNG, 'image/png', { tags: ['笑'] });
  const transport = makeTransport();
  const engine = makeEngine(async () => ({ text: '行吧[表情:笑]' }));
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media });

  await bot.handle(privateEvent('讲个笑话'));

  const images = transport.calls.flatMap((c) => (c.params.message || []).filter((s) => s.type === 'image'));
  assert.equal(images.length, 1);
  assert.ok(images[0].data.file.startsWith('base64://'));
  assert.ok(!sentText(transport.calls.at(-1)).includes('表情:'), '标记不能露给用户');
  media.close();
});

test('回复里写 [图:https://…] 会下载后发出去', async () => {
  const media = makeMedia();
  const transport = makeTransport();
  const engine = makeEngine(async () => ({ text: '给你看[图:data:image/png;base64,' + PNG.toString('base64') + ']' }));
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media });

  await bot.handle(privateEvent('来张图'));

  const images = transport.calls.flatMap((c) => (c.params.message || []).filter((s) => s.type === 'image'));
  assert.equal(images.length, 1);
  media.close();
});

test('/表情 命令直接发一张库里的图', async () => {
  const media = makeMedia();
  media.storeImage(PNG, 'image/png', { tags: ['狗头'] });
  const transport = makeTransport();
  const engine = makeEngine();
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media });

  await bot.handle(privateEvent('/表情 狗头'));

  assert.equal(engine.calls.length, 0, '发图不用问模型');
  const images = transport.calls.flatMap((c) => (c.params.message || []).filter((s) => s.type === 'image'));
  assert.equal(images.length, 1);
  media.close();
});

test('/存表情 把对方刚发的图存进库', async () => {
  const media = makeMedia({ autoLearn: false });
  const transport = makeTransport();
  const engine = makeEngine(async () => ({ text: '嗯' }));
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none'), autoLearn: false } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media });

  await bot.handle(
    privateEvent([{ type: 'image', data: { url: `data:image/png;base64,${PNG.toString('base64')}` } }]),
  );
  assert.equal(media.list().length, 0, 'autoLearn 关着时不会自动收');

  await bot.handle(privateEvent('/存表情 气鼓鼓'));
  assert.equal(media.list().length, 1);
  assert.ok(media.find('气鼓鼓'));
  media.close();
});

test('只有一张图、没有文字，也会回一句', async () => {
  const media = makeMedia();
  const transport = makeTransport();
  const engine = makeEngine(async ({ text }) => ({ text: `收到了 ${text}` }));
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media });

  await bot.handle(
    privateEvent([{ type: 'image', data: { url: `data:image/png;base64,${PNG.toString('base64')}` } }]),
  );

  assert.equal(engine.calls.length, 1);
  assert.doesNotMatch(engine.calls[0].text, /object Object/);
  assert.equal(transport.calls.length, 1);
  media.close();
});

test('对方发表情（sub_type=1）会自动收进图库', async () => {
  const media = makeMedia();
  const transport = makeTransport();
  const engine = makeEngine(async () => ({ text: '这个表情不错' }));
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media });

  await bot.handle(
    privateEvent([{ type: 'image', data: { url: `data:image/png;base64,${PNG.toString('base64')}`, sub_type: 1, summary: '狗头' } }]),
  );

  assert.equal(media.list().length, 1);
  assert.ok(media.find('狗头'));
  media.close();
});

/** 假的梗鲸索引：不走网络，只验证接线。 */
function makeMemes(hits = [{ id: '328', title: '气了', emotion: '气鼓鼓', cat: 'DeepSeek娘', quote: '', score: 1 }]) {
  return {
    enabled: true,
    searched: [],
    stats: () => ({ count: 2438 }),
    ensure: async () => ({ count: 2438 }),
    search(query) {
      this.searched.push(query);
      return hits;
    },
    imageUrl: (h) => `https://img.aigengtu.com/meme/${h.id}.webp`,
    tagsOf: (h) => [h.emotion, h.cat].filter(Boolean),
    pageUrl: (h) => `https://aigengtu.com/zh/meme/${h.id}`,
  };
}

test('/搜图 去网上找一张表情包发出去', async () => {
  const media = makeMedia();
  media.fetchImage = async () => ({ buffer: PNG, mime: 'image/png' });
  const memes = makeMemes();
  const transport = makeTransport();
  const engine = makeEngine();
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media, memes });

  await bot.handle(privateEvent('/搜图 生气'));

  assert.equal(engine.calls.length, 0, '找图不问模型');
  assert.deepEqual(memes.searched, ['生气']);
  const images = transport.calls.flatMap((c) => (c.params.message || []).filter((s) => s.type === 'image'));
  assert.equal(images.length, 1);
  assert.match(images[0].data.file, /^base64:\/\//);
  const stored = media.list();
  assert.equal(stored.length, 1, '下载过的图要进图库');
  assert.equal(stored[0].id, 'net:328');
  assert.equal(stored[0].from, 'aigengtu');
  media.close();
});

test('模型写 [搜图:摆烂] 时自动去网上找图发出去', async () => {
  const media = makeMedia();
  media.fetchImage = async () => ({ buffer: PNG, mime: 'image/png' });
  const memes = makeMemes([{ id: '053', title: '摆烂', emotion: '摆烂', cat: 'DeepSeek娘', quote: '', score: 1 }]);
  const transport = makeTransport();
  const engine = makeEngine(async () => ({ text: '[搜图:摆烂]' }));
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media, memes });

  await bot.handle(privateEvent('好累啊'));

  const images = transport.calls.flatMap((c) => (c.params.message || []).filter((s) => s.type === 'image'));
  assert.equal(images.length, 1);
  const texts = transport.calls.flatMap((c) => (c.params.message || []).filter((s) => s.type === 'text'));
  assert.equal(texts.length, 0, '标记要剥掉，别把 [搜图:…] 发出去');
  assert.deepEqual(memes.searched, ['摆烂']);
  media.close();
});

test('/搜图 没找到时给一句人话', async () => {
  const media = makeMedia();
  const memes = makeMemes([]);
  const transport = makeTransport();
  const engine = makeEngine();
  const cfg = makeCfg({ media: { ...DEFAULT_CONFIG.media, dir: media.dir, stickerDir: path.join(media.dir, 'none') } });
  const bot = createBot({ cfg, log: silentLog(), engine, transport, history: null, media, memes });

  await bot.handle(privateEvent('/搜图 完全不搭界的词'));

  assert.equal(transport.calls.length, 1);
  assert.match(sentText(transport.calls[0]), /没找到/);
  media.close();
});
