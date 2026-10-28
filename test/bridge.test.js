import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

import { apply } from '../dsh-plugin/index.js';

const tmpDir = path.join(import.meta.dirname, '..', '.tmp-test', `bridge-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fileCfg(extra = {}) {
  return {
    token: 'test-token',
    tokenFile: path.join(tmpDir, 'token'),
    endpointFile: path.join(tmpDir, 'endpoint.json'),
    sessionsFile: path.join(tmpDir, 'sessions.json'),
    logFile: path.join(tmpDir, 'plugin.log'),
    timeoutMs: 5000,
    ...extra,
  };
}

function makeCtx({ script = [], createImpl, promptImpl, hang = false } = {}) {
  const routes = new Map();
  const disposers = [];
  const state = { createCalls: [], promptCalls: [], cancelCalls: [], followCalls: [] };

  const ctx = {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    webServer: {
      register(route) {
        const key = `${route.kind}:${route.path}`;
        if (routes.has(key)) throw new Error(`路由重复注册 ${key}`);
        routes.set(key, route);
        return () => routes.delete(key);
      },
      getOrigin: () => 'http://127.0.0.1:4321',
    },
    sessionController: {
      async create(request) {
        state.createCalls.push(request);
        if (createImpl) return await createImpl(request, state);
        return { sessionId: `sess-${state.createCalls.length}` };
      },
      async prompt(request, signal) {
        state.promptCalls.push(request);
        if (promptImpl) return await promptImpl(request, signal, state);
        return { accepted: true };
      },
      follow(request, signal) {
        state.followCalls.push(request);
        const events = typeof script === 'function' ? script(state) : script;
        return (async function* gen() {
          yield { type: 'snapshot', header: { id: 'x' }, cursor: 0, records: [], hasMore: false, projections: {} };
          for (const event of events) {
            if (signal?.aborted) return;
            yield { type: 'event', event };
          }
          if (hang) {
            // 模拟 agent 卡住：一直不结束，直到被取消
            await new Promise((resolve) => {
              if (signal?.aborted) return resolve();
              signal?.addEventListener('abort', () => resolve(), { once: true });
            });
          }
        })();
      },
      async cancel(request) {
        state.cancelCalls.push(request);
        return { accepted: true };
      },
    },
  };

  return { ctx, routes, disposers, state };
}

function fakeReq({ method = 'POST', headers = {}, body } = {}) {
  const payload = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const stream = Readable.from(payload);
  stream.method = method;
  stream.headers = { host: '127.0.0.1:4321', ...headers };
  stream.socket = { remoteAddress: '127.0.0.1' };
  return stream;
}

function fakeRes() {
  return {
    statusCode: 0,
    headersSent: false,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
      this.done = true;
    },
    destroy() {},
    json() {
      return JSON.parse(this.body);
    },
  };
}

async function callRoute(routes, routePath, { method = 'POST', headers = {}, body } = {}) {
  const route = routes.get(`exact:${routePath}`);
  assert.ok(route, `路由不存在：${routePath}`);
  const res = fakeRes();
  await route.handler(fakeReq({ method, headers, body }), res);
  return res;
}

const AUTH = { authorization: 'Bearer test-token' };

function happyScript(reply = '你好呀') {
  return [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: {
        turn: 1,
        step: 0,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: reply }] },
        stream: [],
      },
    },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
}

test('注册两条路由并写入 endpoint 文件', () => {
  const { ctx, routes, disposers } = makeCtx({ script: happyScript() });
  apply(ctx, fileCfg());

  assert.ok(routes.has('exact:/api/qqbot/chat'));
  assert.ok(routes.has('exact:/api/qqbot/chat/health'));

  const endpoint = JSON.parse(fs.readFileSync(path.join(tmpDir, 'endpoint.json'), 'utf8'));
  assert.equal(endpoint.url, 'http://127.0.0.1:4321');
  assert.equal(endpoint.chatUrl, 'http://127.0.0.1:4321/api/qqbot/chat');
  assert.equal(endpoint.plugin, 'qqbot-bridge');

  assert.equal(disposers.length, 1);
  disposers[0]();
  assert.equal(routes.size, 0, '卸载后路由应撤销');
  assert.equal(fs.existsSync(path.join(tmpDir, 'endpoint.json')), false, '卸载后应删掉 endpoint 文件');
});

test('没令牌返回 401，不碰会话', async () => {
  const { ctx, routes, state } = makeCtx({ script: happyScript() });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-401.json'), sessionsFile: path.join(tmpDir, 's-401.json') }));

  const res = await callRoute(routes, '/api/qqbot/chat', { body: { conversationId: 'private:1', text: 'hi' } });
  assert.equal(res.statusCode, 401);
  assert.equal(state.createCalls.length, 0);

  const bad = await callRoute(routes, '/api/qqbot/chat', {
    headers: { authorization: 'Bearer nope' },
    body: { conversationId: 'private:1', text: 'hi' },
  });
  assert.equal(bad.statusCode, 401);
});

test('正常一轮：拿到最后一条 assistant 文本', async () => {
  const { ctx, routes, state } = makeCtx({ script: happyScript('你好呀') });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-ok.json'), sessionsFile: path.join(tmpDir, 's-ok.json') }));

  const res = await callRoute(routes, '/api/qqbot/chat', {
    headers: AUTH,
    body: { conversationId: 'private:10001', text: '在吗', images: ['https://img/x.png', 'not-a-url'] },
  });

  assert.equal(res.statusCode, 200);
  const payload = res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.reply, '你好呀');
  assert.equal(payload.turn, 1);
  assert.equal(payload.sessionId, 'sess-1');

  assert.equal(state.followCalls.length, 1);
  assert.deepEqual(state.followCalls[0].address, { kind: 'session', sessionId: 'sess-1' });

  assert.equal(state.promptCalls.length, 1);
  const p = state.promptCalls[0];
  assert.equal(p.sessionId, 'sess-1');
  assert.equal(p.mode, 'queue');
  assert.equal(typeof p.requestId, 'string');
  assert.equal(p.content[0].type, 'text');
  assert.match(p.content[0].text, /^^（下面这条是 QQ 上真人发来的聊天消息/);
  assert.match(p.content[0].text, /在吗/);
  assert.match(p.content[0].text, /https:\/\/img\/x\.png/, '图片链接应附在文本里');
  assert.doesNotMatch(p.content[0].text, /not-a-url/);
});

test('人格只在新建会话的第一条消息里带上', async () => {
  const { ctx, routes, state } = makeCtx({ script: happyScript('好') });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-persona.json'), sessionsFile: path.join(tmpDir, 's-persona.json') }));

  const persona = '你叫小满，说话很懒。';
  await callRoute(routes, '/api/qqbot/chat', {
    headers: AUTH,
    body: { conversationId: 'private:7', text: '你好', persona },
  });
  const first = state.promptCalls[0].content[0].text;
  assert.ok(first.startsWith(persona), '第一条应以人格开头');
  assert.match(first, /QQ 上真人发来的聊天消息/, '人格之后仍要有开场说明');

  await callRoute(routes, '/api/qqbot/chat', {
    headers: AUTH,
    body: { conversationId: 'private:7', text: '再来', persona },
  });
  const second = state.promptCalls[1].content[0].text;
  assert.doesNotMatch(second, /小满/, '复用会话时不再重复发人格');
});

test('同一个会话复用 session，第二次不再 create', async () => {
  const { ctx, routes, state } = makeCtx({ script: happyScript('嗯') });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-reuse.json'), sessionsFile: path.join(tmpDir, 's-reuse.json') }));

  await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'group:555:10001', text: 'a' } });
  const second = await callRoute(routes, '/api/qqbot/chat', {
    headers: AUTH,
    body: { conversationId: 'group:555:10001', text: 'b' },
  });

  assert.equal(state.createCalls.length, 1);
  assert.equal(second.json().sessionId, 'sess-1');
  assert.equal(state.promptCalls.length, 2);
  assert.doesNotMatch(state.promptCalls[1].content[0].text, /QQ 上真人/, '开场说明只加一次');
});

test('多步 turn 取最后一条 assistant 文本', async () => {
  const script = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 2 } },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 2, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: '我查一下' }] } } },
    { type: 'tool/call', seq: 3, time: 3, data: { turn: 2, call: { id: 't1', name: 'bash' } } },
    { type: 'assistant/message', seq: 4, time: 4, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '查到了：今天晴' }] } } },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  const { ctx, routes } = makeCtx({ script });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-multi.json'), sessionsFile: path.join(tmpDir, 's-multi.json') }));

  const res = await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'private:1', text: '天气' } });
  assert.equal(res.json().reply, '查到了：今天晴');
  assert.equal(res.json().toolCalls, 1);
});

test('turn 以 error 结束且没有文本时返回 502', async () => {
  const script = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'error', error: { message: '额度用完了' } } } },
  ];
  const { ctx, routes } = makeCtx({ script });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-err.json'), sessionsFile: path.join(tmpDir, 's-err.json') }));

  const res = await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'private:1', text: 'hi' } });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /额度用完了/);
});

test('会话失效会自动重建', async () => {
  let first = true;
  const { ctx, routes, state } = makeCtx({
    script: happyScript('重建成功'),
    promptImpl: async () => {
      if (first) {
        first = false;
        throw new Error('session not found: sess-1');
      }
      return { accepted: true };
    },
  });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-stale.json'), sessionsFile: path.join(tmpDir, 's-stale.json') }));

  const res = await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'private:1', text: 'hi' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reply, '重建成功');
  assert.equal(state.createCalls.length, 2);

  const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 's-stale.json'), 'utf8'));
  assert.equal(saved.sessions['private:1'].sessionId, 'sess-2');
});

test('超时会取消这一轮并返回 504', async () => {
  const { ctx, routes, state } = makeCtx({
    script: [{ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }],
    hang: true,
  });
  apply(
    ctx,
    fileCfg({
      timeoutMs: 1000,
      endpointFile: path.join(tmpDir, 'ep-timeout.json'),
      sessionsFile: path.join(tmpDir, 's-timeout.json'),
    }),
  );

  const started = Date.now();
  const res = await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'private:1', text: 'hi' } });
  const elapsed = Date.now() - started;

  assert.equal(res.statusCode, 504);
  assert.ok(elapsed < 4000, `不该等太久（实际 ${elapsed}ms）`);
  assert.equal(state.cancelCalls.length, 1);
  assert.equal(state.cancelCalls[0].sessionId, 'sess-1');
});

test('reset 忘掉会话映射', async () => {
  const { ctx, routes, state } = makeCtx({ script: happyScript('hi') });
  const sessionsFile = path.join(tmpDir, 's-reset.json');
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-reset.json'), sessionsFile }));

  await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'private:1', text: 'a' } });
  const reset = await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'private:1', reset: true } });
  assert.equal(reset.json().reset, true);
  assert.equal(reset.json().forgotten, 'sess-1');
  assert.equal(state.cancelCalls.length, 1);

  await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'private:1', text: 'b' } });
  assert.equal(state.createCalls.length, 2, 'reset 之后应重建会话');
});

test('health 路由需要令牌并返回状态', async () => {
  const { ctx, routes } = makeCtx({ script: [] });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-h.json'), sessionsFile: path.join(tmpDir, 's-h.json') }));

  const unauth = await callRoute(routes, '/api/qqbot/chat/health', { method: 'GET' });
  assert.equal(unauth.statusCode, 401);

  const res = await callRoute(routes, '/api/qqbot/chat/health', { method: 'GET', headers: AUTH });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().plugin, 'qqbot-bridge');
});

test('空消息被拒绝', async () => {
  const { ctx, routes } = makeCtx({ script: [] });
  apply(ctx, fileCfg({ endpointFile: path.join(tmpDir, 'ep-empty.json'), sessionsFile: path.join(tmpDir, 's-empty.json') }));
  const res = await callRoute(routes, '/api/qqbot/chat', { headers: AUTH, body: { conversationId: 'private:1', text: '   ' } });
  assert.equal(res.statusCode, 400);
});

test('自定义 route path 生效', async () => {
  const { ctx, routes } = makeCtx({ script: [] });
  apply(
    ctx,
    fileCfg({
      path: 'qq/custom',
      endpointFile: path.join(tmpDir, 'ep-custom.json'),
      sessionsFile: path.join(tmpDir, 's-custom.json'),
    }),
  );
  assert.ok(routes.has('exact:/qq/custom'));
  assert.ok(routes.has('exact:/qq/custom/health'));
});
