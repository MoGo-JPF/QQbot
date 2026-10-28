import http from 'node:http';

/**
 * HTTP 传输：
 *  - 上传：本程序起一个 HTTP 服务，NapCat 用「HTTP 上报」把事件 POST 过来
 *  - 下发：本程序用 HTTP POST 调 NapCat 的 HTTP API 发消息
 */
export function createHttpTransport(cfg, { log, onEvent }) {
  const c = {
    host: cfg?.http?.host || '127.0.0.1',
    port: cfg?.http?.port ?? 8080,
    path: cfg?.http?.path || '/onebot',
    secret: cfg?.http?.secret || '',
    api: (cfg?.http?.api || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    accessToken: cfg?.http?.accessToken || '',
  };

  let server = null;

  function authorized(req, url) {
    if (!c.secret) return true;
    const header = String(req.headers.authorization || '');
    if (header === `Bearer ${c.secret}` || header === c.secret) return true;
    const q = url.searchParams.get('access_token');
    return Boolean(q) && q === c.secret;
  }

  function readBody(req, limit = 4 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method !== 'POST' || url.pathname !== c.path) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    if (!authorized(req, url)) {
      log.warn(`拒绝未授权的上报来源 ${req.socket.remoteAddress}`);
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unauthorized');
      return;
    }

    readBody(req)
      .then((body) => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400).end('bad json');
          return;
        }
        // OneBot 允许数组形式的批量上报
        const events = Array.isArray(payload) ? payload : [payload];
        for (const ev of events) {
          if (ev && ev.post_type) {
            try {
              onEvent(ev);
            } catch (err) {
              log.error('处理事件时出错', err);
            }
          }
        }
        res.writeHead(204).end();
      })
      .catch((err) => {
        log.warn('读取上报内容失败', err.message);
        if (!res.headersSent) res.writeHead(400).end('bad request');
      });
  }

  async function call(action, params = {}, timeoutMs = 20000) {
    const url = `${c.api}/${action}`;
    const headers = { 'content-type': 'application/json' };
    if (c.accessToken) headers.authorization = `Bearer ${c.accessToken}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: ac.signal,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`OneBot HTTP ${resp.status}: ${text.slice(0, 200)}`);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`OneBot HTTP 返回非 JSON: ${text.slice(0, 200)}`);
      }
      if (payload.status === 'failed' || (payload.retcode != null && payload.retcode !== 0)) {
        throw new Error(`OneBot 动作失败 retcode=${payload.retcode}: ${payload.message || payload.wording || ''}`);
      }
      return payload.data ?? {};
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'http',
    call,
    isReady: () => Boolean(server),
    async start() {
      server = http.createServer((req, res) => {
        try {
          handle(req, res);
        } catch (err) {
          log.error('HTTP 上报处理异常', err);
          if (!res.headersSent) res.writeHead(500).end('error');
        }
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(c.port, c.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      log.info(`HTTP 上报监听 http://${c.host}:${c.port}${c.path} ，调用 API ${c.api}`);
    },
    async stop() {
      if (!server) return;
      await new Promise((resolve) => server.close(() => resolve()));
      server = null;
    },
  };
}
