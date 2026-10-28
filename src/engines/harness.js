import fs from 'node:fs';

import { expandHome } from '../config.js';

/**
 * Harness 引擎：把消息 POST 给 DeepSeek Harness 里的 Host 插件（dsh-plugin/），
 * 由 Harness 里正在运行的 agent 回复；上下文由 Harness 会话保存。
 *
 * baseUrl 留空时从 ~/.dsh/qqbot-endpoint.json 自动发现（GUI 每次启动端口可能变）。
 */
export function createHarnessEngine(cfg, { log }) {
  const routePath = cfg.path || '/api/qqbot/chat';
  const timeoutMs = cfg.timeoutMs ?? 300000;
  const persona = String(cfg.persona || '').trim();
  const endpointFile = expandHome(cfg.endpointFile || '~/.dsh/qqbot-endpoint.json');
  const tokenFile = cfg.tokenFile ? expandHome(String(cfg.tokenFile)) : expandHome('~/.dsh/qqbot-token');

  function baseUrl() {
    const configured = String(cfg.baseUrl || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    try {
      const j = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
      if (j?.url) return String(j.url).replace(/\/+$/, '');
    } catch {
      /* 插件还没启动过 */
    }
    return 'http://127.0.0.1:59257';
  }

  function token() {
    if (cfg.token) return String(cfg.token);
    try {
      const t = fs.readFileSync(tokenFile, 'utf8').trim();
      if (t) return t;
    } catch (err) {
      if (err?.code !== 'ENOENT') log.warn(`读取令牌文件失败 ${tokenFile}: ${err.message}`);
    }
    throw new Error(
      `没有 Harness 令牌。请先在 DeepSeek Harness 里启用 qqbot-bridge 插件（它会生成 ${tokenFile}），` +
        '或在 config.json 里填 engines.harness.token。',
    );
  }

  function url() {
    const p = routePath.startsWith('/') ? routePath : `/${routePath}`;
    return `${baseUrl()}${p}`;
  }

  async function post(body, timeout = timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    timer.unref?.();
    const target = url();
    try {
      const resp = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token()}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const raw = await resp.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { ok: false, error: raw.slice(0, 300) };
      }
      if (resp.status === 401) {
        throw new Error(`Harness 拒绝了令牌（401）。核对 ${tokenFile} 与 config.json 里的 engines.harness.token。`);
      }
      if (!resp.ok || payload.ok === false) {
        throw new Error(`Harness 返回错误（${resp.status}）：${payload.error || raw.slice(0, 300)}`);
      }
      return payload;
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`Harness 超时（${Math.round(timeout / 1000)}s）：Agent 还在干活，或者窗口没开着。`);
      }
      const code = err?.cause?.code || '';
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || /fetch failed/i.test(String(err.message))) {
        throw new Error(
          `连不上 Harness（${target}）。确认 DeepSeek Harness 正在运行、qqbot-bridge 插件已启用；` +
            `如果端口变了，删掉 ${endpointFile} 让它重新生成。`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'harness',
    managesHistory: false,

    async chat({ conversationId, text, images = [], meta = {}, memory = '' }) {
      const started = Date.now();
      // Harness 里的 agent 看不到 QQ 的图片 URL，所以把图存到本地再把路径告诉它（它可以用工具打开）
      const pics = (images || []).filter((p) => p && !p.error);
      const notes = pics
        .filter((p) => p.path)
        .map((p) => `（对方发来一张图片，已存到本地：${p.path}${p.summary ? `，表情名：${p.summary}` : ''}）`);
      const body = notes.length > 0 ? [text, ...notes].filter(Boolean).join('\n') : text;
      const payload = await post({ conversationId, text: body, images: [], meta, persona, memory });
      const reply = String(payload.reply ?? '').trim();
      log.debug(
        `harness 完成 ${conversationId} 用时 ${Date.now() - started}ms ` +
          `session=${payload.sessionId ?? '?'} turn=${payload.turn ?? '?'}`,
      );
      return { text: reply, engine: 'harness', sessionId: payload.sessionId };
    },

    async reset(conversationId) {
      return await post({ conversationId, reset: true }, 20000);
    },

    async health() {
      const resp = await fetch(`${url()}/health`, { headers: { authorization: `Bearer ${token()}` } });
      return await resp.json();
    },
  };
}
