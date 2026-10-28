// 面板接口冒烟测试：起一个真 HTTP 服务，用 fetch 打它的路由。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createPanel } from '../panel/server.js';

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeWorkspace({ token = '', pin = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-panel-'));
  const configFile = path.join(dir, 'config.json');
  const cfg = {
    storage: { root: path.join(dir, 'data') },
    panel: { enabled: true, host: '127.0.0.1', port: 0, token, pin },
    engine: 'openai',
    persona: { name: '测试', file: '' },
    policy: { private: { users: [10001] }, group: { groups: [] } },
    engines: { openai: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test-123456', model: 'deepseek-chat' } },
    media: { webSearch: { enabled: false } },
    napcat: { dir: path.join(dir, 'napcat') },
  };
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
  return { dir, configFile };
}

async function withPanel(options, fn) {
  const ws = makeWorkspace(options);
  // allowExit:false —— 面板的「关闭面板」接口会 process.exit，测试里必须拦住
  const panel = createPanel({ config: ws.configFile, allowExit: false });
  await new Promise((resolve) => panel.server.listen(0, '127.0.0.1', resolve));
  const { port } = panel.server.address();
  const base = `http://127.0.0.1:${port}`;

  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: r.status, data, headers: r.headers };
  };

  try {
    return await fn({ base, call, panel, ws });
  } finally {
    panel.server.closeAllConnections?.();
    await new Promise((resolve) => panel.server.close(resolve));
    fs.rmSync(ws.dir, { recursive: true, force: true });
  }
}

test('status 给出机器人 / OneBot / 数据目录信息', async () => {
  await withPanel({}, async ({ call }) => {
    const r = await call('GET', '/api/status');
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.engine, 'openai');
    assert.equal(typeof r.data.bot.running, 'boolean');
    assert.equal(typeof r.data.onebot.ok, 'boolean');
    assert.ok(r.data.storage.root.endsWith('data'));
    assert.equal(typeof r.data.counts.stickers, 'number');
  });
});

test('config 读得到，密钥打码', async () => {
  await withPanel({}, async ({ call }) => {
    const r = await call('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.data.config.engine, 'openai');
    assert.ok(r.data.paths.root, 'should expose resolved paths');
    const key = r.data.config.engines?.openai?.apiKey;
    // 面板要把密钥藏起来：要么没有，要么被截断成 sk-xxx…xxxx
    assert.ok(!key || key !== 'sk-test-123456', `apiKey 不该原样给出去，实际是 ${key}`);
  });
});

test('表情库：上传 / 列表 / 看图 / 改标签 / 删除', async () => {
  await withPanel({}, async ({ call }) => {
    const add = await call('POST', '/api/stickers', { dataUrl: PNG_1x1, tags: ['测试', '一像素'], note: '面板上传' });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    const id = add.data.item.id;

    const list = await call('GET', '/api/stickers');
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length, 1);
    assert.deepEqual([...list.data.items[0].tags].sort(), ['一像素', '测试']);
    assert.equal(list.data.items[0].hasFile, true);

    const img = await call('GET', `/api/stickers/image?id=${encodeURIComponent(id)}`);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type') || '', /image\//);

    const patched = await call('PATCH', `/api/stickers?id=${encodeURIComponent(id)}`, { tags: '新标签', note: '改过了' });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.data.item.tags, ['新标签']);

    const filtered = await call('GET', '/api/stickers?q=新标签');
    assert.equal(filtered.data.items.length, 1);

    const removed = await call('DELETE', `/api/stickers?id=${encodeURIComponent(id)}`);
    assert.equal(removed.status, 200);
    const after = await call('GET', '/api/stickers');
    assert.equal(after.data.items.length, 0);
  });
});

test('表情库：缺图给 400', async () => {
  await withPanel({}, async ({ call }) => {
    const r = await call('POST', '/api/stickers', { tags: ['空'] });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /缺图片/);
  });
});

test('记忆库：新增 / 列表 / 搜索 / 修改 / 删除', async () => {
  await withPanel({}, async ({ call }) => {
    const add = await call('POST', '/api/memory', { text: '我最喜欢的饮料是美式咖啡，不加糖', tags: '饮料,偏好' });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    const id = add.data.item.id;

    const list = await call('GET', '/api/memory?kind=long');
    assert.equal(list.status, 200);
    assert.equal(list.data.items.length, 1);
    assert.equal(list.data.items[0].text, '我最喜欢的饮料是美式咖啡，不加糖');

    const search = await call('GET', `/api/memory?kind=long&q=${encodeURIComponent('咖啡')}`);
    assert.equal(search.data.items.length, 1);
    const miss = await call('GET', `/api/memory?kind=long&q=${encodeURIComponent('不存在的词')}`);
    assert.equal(miss.data.items.length, 0);

    const patch = await call('PATCH', `/api/memory?id=${id}`, { text: '我喝美式，不加糖', tags: ['饮料'] });
    assert.equal(patch.status, 200);
    assert.equal(patch.data.item.text, '我喝美式，不加糖');

    const recent = await call('GET', '/api/memory?kind=recent');
    assert.equal(recent.status, 200);
    assert.ok(Array.isArray(recent.data.messages));
    assert.ok(Array.isArray(recent.data.conversations));

    const del = await call('DELETE', `/api/memory?id=${id}`);
    assert.equal(del.status, 200);
    const after = await call('GET', '/api/memory?kind=long');
    assert.equal(after.data.items.length, 0);
  });
});

test('记忆库：空内容 400', async () => {
  await withPanel({}, async ({ call }) => {
    const r = await call('POST', '/api/memory', { text: '   ' });
    assert.equal(r.status, 400);
  });
});

test('设置：PATCH 写回 config.json 并立即生效', async () => {
  await withPanel({}, async ({ call, ws }) => {
    const r = await call('PATCH', '/api/config', {
      patch: { persona: { name: '新名字' }, policy: { private: { users: [22222] } } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const onDisk = JSON.parse(fs.readFileSync(ws.configFile, 'utf8'));
    assert.equal(onDisk.persona.name, '新名字');
    assert.deepEqual(onDisk.policy.private.users, [22222]);
    // 原有字段不能被冲掉
    assert.equal(onDisk.engine, 'openai');
    assert.equal(onDisk.engines.openai.model, 'deepseek-chat');
  });
});

test('换数据目录：写进 config 并给出新路径', async () => {
  await withPanel({}, async ({ call, ws }) => {
    const target = path.join(ws.dir, 'other-data');
    const r = await call('POST', '/api/storage', { root: target });
    assert.equal(r.status, 200);
    assert.ok(r.data.root.endsWith('other-data'));
    const onDisk = JSON.parse(fs.readFileSync(ws.configFile, 'utf8'));
    assert.equal(onDisk.storage.root, target);
  });
});

test('迁移接口 dry-run 不写文件', async () => {
  await withPanel({}, async ({ call, ws }) => {
    const before = fs.existsSync(path.join(ws.dir, 'data'));
    const r = await call('POST', '/api/migrate', { from: path.join(ws.dir, 'nothing-here'), dryRun: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.report.dryRun, true);
    assert.equal(fs.existsSync(path.join(ws.dir, 'data')), before);
  });
});

test('日志接口：没有文件时给空数组而不是报错', async () => {
  await withPanel({}, async ({ call }) => {
    const r = await call('GET', '/api/logs?lines=10');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.lines));
  });
});

test('设了令牌就要令牌', async () => {
  await withPanel({ token: 'secret-123' }, async ({ call }) => {
    const noToken = await call('GET', '/api/status');
    assert.equal(noToken.status, 401);
    const withToken = await call('GET', '/api/status?token=secret-123');
    assert.equal(withToken.status, 200);
  });
});

test('未知接口 404，静态首页能打开', async () => {
  await withPanel({}, async ({ base, call }) => {
    const miss = await call('GET', '/api/nope');
    assert.equal(miss.status, 404);
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /控制面板|QQ/);
  });
});

// ---------- 模型 API 配置 ----------

test('读配置时 apiKey 打码，但告诉你有配过', async () => {
  await withPanel({}, async ({ call }) => {
    const r = await call('GET', '/api/config');
    assert.equal(r.status, 200);
    const o = r.data.config.engines.openai;
    assert.equal(o.apiKeySet, true);
    assert.ok(o.apiKey.includes('…'), '应该是打码形式');
    assert.notEqual(o.apiKey, 'sk-test-123456');
  });
});

test('把打码值存回去不会覆盖真 key', async () => {
  await withPanel({}, async ({ call, ws }) => {
    await call('PATCH', '/api/config', { patch: { engines: { openai: { apiKey: 'sk-test-123456' } } } });
    const before = JSON.parse(fs.readFileSync(ws.configFile, 'utf8'));
    assert.equal(before.engines.openai.apiKey, 'sk-test-123456');

    // 面板拿到的是掩码，原样回写
    const shown = (await call('GET', '/api/config')).data.config.engines.openai.apiKey;
    const r = await call('PATCH', '/api/config', { patch: { engines: { openai: { apiKey: shown, model: 'deepseek-chat' } } } });
    assert.equal(r.status, 200);
    const after = JSON.parse(fs.readFileSync(ws.configFile, 'utf8'));
    assert.equal(after.engines.openai.apiKey, 'sk-test-123456', '真 key 必须还在');
    assert.equal(after.engines.openai.model, 'deepseek-chat');
  });
});

test('__clear__ 会把 key 清空', async () => {
  await withPanel({}, async ({ call, ws }) => {
    // 先切到 harness（openai 引擎没 key 是不允许保存的，这是故意的）
    await call('PATCH', '/api/config', { patch: { engine: 'harness' } });
    const r = await call('PATCH', '/api/config', { patch: { engines: { openai: { apiKey: '__clear__' } } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const cfg = JSON.parse(fs.readFileSync(ws.configFile, 'utf8'));
    assert.equal(cfg.engines.openai.apiKey, '');
    const shown = await call('GET', '/api/config');
    assert.equal(shown.data.config.engines.openai.apiKeySet, false);
  });
});

test('会起不来的配置不允许保存，旧配置原样保留', async () => {
  await withPanel({}, async ({ call, ws }) => {
    const before = fs.readFileSync(ws.configFile, 'utf8');
    // 引擎是 openai：把 key 清掉 + 白名单清掉，两条校验都过不去
    const r = await call('PATCH', '/api/config', {
      patch: { engines: { openai: { apiKey: '__clear__' } }, policy: { private: { users: [] } } },
    });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /保存被拒绝/);
    assert.equal(fs.readFileSync(ws.configFile, 'utf8'), before, 'config.json 不该被改坏');
  });
});

test('POST /api/engine/test 能跑通一轮（用本地假 Harness）', async () => {
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reply: '在，我是假的', sessionId: 's-1', turn: 1 }));
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address();
  try {
    await withPanel({}, async ({ call }) => {
      const p = await call('PATCH', '/api/config', {
        patch: {
          engine: 'harness',
          engines: { harness: { baseUrl: `http://127.0.0.1:${port}`, path: '/api/qqbot/chat', token: 't', timeoutMs: 5000 } },
        },
      });
      assert.equal(p.status, 200);
      const r = await call('POST', '/api/engine/test', {});
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.ok, true);
      assert.equal(r.data.reply, '在，我是假的');
      assert.equal(r.data.engine, 'harness');
      assert.equal(typeof r.data.ms, 'number');
    });
  } finally {
    await new Promise((resolve) => stub.close(resolve));
  }
});

test('测试连接会用上还没保存的地址（不用先点保存）', async () => {
  const hits = [];
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, reply: '临时地址也能通', sessionId: 's-2', turn: 1 }));
    });
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address();
  try {
    await withPanel({}, async ({ call }) => {
      // 注意：这里没有 PATCH，直接把面板上"没保存"的值塞进 patch 去测
      const r = await call('POST', '/api/engine/test', {
        patch: {
          engine: 'harness',
          engines: { harness: { baseUrl: `http://127.0.0.1:${port}`, path: '/api/qqbot/chat', token: 't', timeoutMs: 5000 } },
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal(r.data.reply, '临时地址也能通');
      assert.equal(hits.length, 1, '应该真的打到临时地址上');
    });
  } finally {
    await new Promise((resolve) => stub.close(resolve));
  }
});

// ---------- 白名单 ----------

test('白名单能加能删，策略能改', async () => {
  await withPanel({}, async ({ call, ws }) => {
    const r = await call('PATCH', '/api/config', {
      patch: { policy: { private: { allow: 'whitelist', users: [10001, 20002] }, group: { allow: 'none', groups: [55555] } } },
    });
    assert.equal(r.status, 200);
    const cfg = JSON.parse(fs.readFileSync(ws.configFile, 'utf8'));
    assert.deepEqual(cfg.policy.private.users, [10001, 20002]);
    assert.equal(cfg.policy.private.allow, 'whitelist');
    assert.deepEqual(cfg.policy.group.groups, [55555]);
    assert.equal(cfg.policy.group.allow, 'none');

    await call('PATCH', '/api/config', { patch: { policy: { private: { users: [10001] } } } });
    const after = JSON.parse(fs.readFileSync(ws.configFile, 'utf8'));
    assert.deepEqual(after.policy.private.users, [10001]);
    assert.equal(after.policy.group.allow, 'none', '没动的字段不该被冲掉');
  });
});

test('GET /api/senders 把人按私聊 / 群归纳出来', async () => {
  await withPanel({}, async ({ call, ws }) => {
    const dir = path.join(ws.dir, 'data', 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const lines = [
      { t: now - 3000, cid: 'private:3580323035', role: 'user', text: '在吗' },
      { t: now - 2000, cid: 'private:3580323035', role: 'assistant', text: '在' },
      { t: now - 1000, cid: 'group:1106670002:3580323035', role: 'user', text: '群里' },
      { t: now, cid: 'group:1106670002:99999', role: 'user', text: '另一个人' },
    ];
    fs.writeFileSync(path.join(dir, 'archive.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

    const r = await call('GET', '/api/senders');
    assert.equal(r.status, 200);
    const priv = r.data.private.find((p) => p.qq === '3580323035');
    assert.ok(priv, '私聊应该出现');
    assert.equal(priv.count, 2);
    const g = r.data.groups.find((x) => x.gid === '1106670002');
    assert.ok(g, '群应该出现');
    assert.equal(g.count, 2);
    assert.deepEqual(g.senders.sort(), ['3580323035', '99999']);
  });
});

test('手机页 /m 和 manifest 能打开（不用令牌也能拿到页面）', async () => {
  await withPanel({ token: 'sec123' }, async ({ call }) => {
    const page = await call('GET', '/m');
    assert.equal(page.status, 200);
    assert.match(page.data.raw, /鲸鲸遥控器/);
    assert.match(page.data.raw, /输入访问密码/, '带登录浮层');
    assert.match(page.headers.get('content-type'), /text\/html/);

    const man = await call('GET', '/manifest.webmanifest');
    assert.equal(man.status, 200);
    assert.match(man.headers.get('content-type'), /manifest\+json/);
    const icons = await call('GET', '/icons/icon-192.png');
    assert.equal(icons.status, 200, '图标要在（不然加到主屏幕没图）');
  });
});

test('手机用 PIN 登录换 cookie，之后不带令牌也能看状态', async () => {
  await withPanel({ token: 'sec123', pin: '135790' }, async ({ base, call }) => {
    // 没凭据：挡住
    assert.equal((await call('GET', '/api/status')).status, 401);

    // 密码不对：挡住
    const bad = await call('POST', '/api/login', { pin: '000000' });
    assert.equal(bad.status, 401);
    assert.match(bad.data.error, /密码不对/);

    // 密码对：给 cookie
    const ok = await call('POST', '/api/login', { pin: '135790' });
    assert.equal(ok.status, 200);
    const cookie = String(ok.headers.get('set-cookie') || '');
    assert.match(cookie, /qqbot_panel=/);
    assert.match(cookie, /HttpOnly/);

    // 带 cookie 打状态：放行
    const withCookie = await fetch(`${base}/api/status`, { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(withCookie.status, 200);
    const st = await withCookie.json();
    assert.equal(st.ok, true);
  });
});

test('直接拿 token 当密码也能登录', async () => {
  await withPanel({ token: 'sec123', pin: '' }, async ({ call }) => {
    const ok = await call('POST', '/api/login', { token: 'sec123' });
    assert.equal(ok.status, 200);
  });
});

test('GET /api/mobile 说清手机该打开哪个地址', async () => {
  await withPanel({}, async ({ call }) => {
    const r = await call('GET', '/api/mobile');
    assert.equal(r.status, 200);
    assert.equal(r.data.lanEnabled, false, '默认只听本机');
    assert.deepEqual(r.data.urls, []);
    assert.equal(r.data.pinSet, false);
    assert.equal(r.data.tokenSet, false);
  });
});

test('关闭面板的接口存在，且不会把机器人一起带走', async () => {
  await withPanel({}, async ({ call }) => {
    const r = await call('POST', '/api/panel/stop', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.match(r.data.note, /机器人/);
    // 答复先发出去，进程延后 0.4 秒才退（测试里用 allowExit:false 拦住）
    const after = await call('GET', '/api/status');
    assert.equal(after.status, 200, '接口返回后面板仍然活着');
  });
});

