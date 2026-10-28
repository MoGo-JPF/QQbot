import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';

import { createEngine } from '../src/engines/index.js';
import { createHarnessEngine } from '../src/engines/harness.js';
import { createHistory } from '../src/history.js';

const tmpDir = path.join(import.meta.dirname, '..', '.tmp-test', `engines-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const logs = [];
const log = {
  error: (m) => logs.push(`E ${m}`),
  warn: (m) => logs.push(`W ${m}`),
  info: (m) => logs.push(`I ${m}`),
  debug: () => {},
  trace: () => {},
};

function sseChunks(pieces) {
  return pieces
    .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('openai 引擎：流式累加、写入历史、带历史重发', async () => {
  const seen = [];
  const history = createHistory({ file: path.join(tmpDir, 'h.json') });

  await withServer(
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseChunks(['你好', '，', '我是模型']));
      });
    },
    async (baseUrl) => {
      const engine = createEngine(
        { engine: 'openai', engines: { openai: { baseUrl, apiKey: 'k', model: 'm', historyTurns: 2 } } },
        { log, history },
      );

      const first = await engine.chat({ conversationId: 'c1', text: '在吗' });
      assert.equal(first.text, '你好，我是模型');
      assert.equal(history.get('c1').length, 2);
      assert.equal(history.get('c1')[0].content, '在吗');

      const second = await engine.chat({ conversationId: 'c1', text: '继续' });
      assert.equal(second.text, '你好，我是模型');
      const lastMessages = seen.at(-1).messages;
      assert.equal(lastMessages[0].role, 'system');
      assert.deepEqual(
        lastMessages.slice(1).map((m) => m.role),
        ['user', 'assistant', 'user'],
        '第二轮要把历史带上',
      );
    },
  );
  history.close();
});

test('openai 引擎：非流式 + 错误信息人话化', async () => {
  await withServer(
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid api key' }));
      });
    },
    async (baseUrl) => {
      const engine = createEngine(
        { engine: 'openai', engines: { openai: { baseUrl, apiKey: 'bad', model: 'm' } } },
        { log, history: createHistory({}) },
      );
      await assert.rejects(() => engine.chat({ conversationId: 'c', text: 'x' }), /鉴权失败/);
    },
  );
});

test('harness 引擎：POST 到插件路由并解析回复', async () => {
  const requests = [];
  const tokenFile = path.join(tmpDir, 'token');
  fs.writeFileSync(tokenFile, 'abc123\n');

  await withServer(
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reply: '来自 Harness', sessionId: 'sess-9', turn: 3 }));
      });
    },
    async (baseUrl) => {
      const engine = createHarnessEngine({ baseUrl, tokenFile, timeoutMs: 5000 }, { log });
      const result = await engine.chat({ conversationId: 'private:1', text: '你好' });
      assert.equal(result.text, '来自 Harness');
      assert.equal(result.sessionId, 'sess-9');

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/api/qqbot/chat');
      assert.equal(requests[0].auth, 'Bearer abc123');
      assert.deepEqual(requests[0].body.conversationId, 'private:1');
    },
  );
});

test('harness 引擎：没有令牌时给出可操作的错误', async () => {
  const engine = createHarnessEngine(
    { baseUrl: 'http://127.0.0.1:1', tokenFile: path.join(tmpDir, 'missing-token'), timeoutMs: 2000 },
    { log },
  );
  await assert.rejects(() => engine.chat({ conversationId: 'c', text: 'x' }), /没有 Harness 令牌/);
});

test('harness 引擎：401 提示核对令牌', async () => {
  const tokenFile = path.join(tmpDir, 'token2');
  fs.writeFileSync(tokenFile, 'wrong\n');
  await withServer(
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '未授权' }));
      });
    },
    async (baseUrl) => {
      const engine = createHarnessEngine({ baseUrl, tokenFile, timeoutMs: 5000 }, { log });
      await assert.rejects(() => engine.chat({ conversationId: 'c', text: 'x' }), /核对/);
    },
  );
});

test('harness 引擎：连不上时提示启动 Harness', async () => {
  const tokenFile = path.join(tmpDir, 'token3');
  fs.writeFileSync(tokenFile, 't\n');
  const engine = createHarnessEngine({ baseUrl: 'http://127.0.0.1:1', tokenFile, timeoutMs: 3000 }, { log });
  await assert.rejects(() => engine.chat({ conversationId: 'c', text: 'x' }), /连不上 Harness/);
});
