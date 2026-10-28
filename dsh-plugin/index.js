/**
 * qqbot-bridge —— DeepSeek Harness Host 插件
 *
 * 作用：在 Harness 的 webServer 上挂两条本地路由，把 QQ bot（../src/）转来的消息
 * 交给正在运行的 Harness agent 回复。
 *
 *   POST /api/qqbot/chat         { conversationId, text, images?, persona? } -> { ok, reply, sessionId }
 *   POST /api/qqbot/chat/health  -> 存活检查
 *
 * persona：bot 端配置的人格文本，只在新建会话的第一条消息里带上。
 *
 * 鉴权：Authorization: Bearer <token>，token 存在 ~/.dsh/qqbot-token（bot 也从这里读）。
 * 会话：每个 conversationId 对应一个 Harness 会话，映射存 ~/.dsh/qqbot-sessions.json。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

export const name = 'qqbot-bridge';
export const inject = ['sessionController', 'webServer'];

const VERSION = '1.0.0';
const DEFAULT_ROUTE = '/api/qqbot/chat';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 32000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const INTRO =
  '（下面这条是 QQ 上真人发来的聊天消息，不是开发任务。请像聊天一样直接回复，简短自然；' +
  '不要用 Markdown 标题、表格和长列表，不要 @ 任何人，除非确实需要否则别输出代码块。）\n\n';

const DEFAULTS = {
  path: DEFAULT_ROUTE,
  token: '',
  tokenFile: '~/.dsh/qqbot-token',
  endpointFile: '~/.dsh/qqbot-endpoint.json',
  sessionsFile: '~/.dsh/qqbot-sessions.json',
  logFile: '~/.dsh/qqbot-plugin.log',
  cwd: '',
  agentPreset: '',
  timeZone: 'Asia/Shanghai',
  timeoutMs: 300000,
  intro: true,
  maxSessions: 200,
};

// ---------------------------------------------------------------- 小工具

function expandHome(p) {
  const s = String(p ?? '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return nodePath.join(os.homedir(), s.slice(2));
  return s;
}

function normalizePath(p) {
  let s = String(p || DEFAULT_ROUTE).trim();
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/+$/, '');
  return s || DEFAULT_ROUTE;
}

function writeFileAtomic(file, data, mode) {
  const dir = nodePath.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function preview(s, n = 100) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function createLogger(file) {
  const target = file ? expandHome(file) : '';
  let lines = 0;
  if (target) {
    try {
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      if (fs.statSync(target).size > LOG_MAX_BYTES) {
        try {
          fs.renameSync(target, `${target}.1`);
        } catch {
          fs.writeFileSync(target, '');
        }
      }
    } catch {
      /* 日志不可写就算了，别影响插件 */
    }
  }
  function emit(level, msg) {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
    try {
      console.error(`[qqbot-bridge] ${line}`);
    } catch {
      /* ignore */
    }
    if (!target) return;
    try {
      fs.appendFileSync(target, `${line}\n`);
      if (++lines > 200) {
        lines = 0;
        const st = fs.statSync(target);
        if (st.size > LOG_MAX_BYTES) fs.renameSync(target, `${target}.1`);
      }
    } catch {
      /* ignore */
    }
  }
  return {
    error: (m) => emit('ERROR', m),
    warn: (m) => emit('WARN', m),
    info: (m) => emit('INFO', m),
    debug: (m) => emit('DEBUG', m),
    file: target,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 2MB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  try {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

function textOfAssistant(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function isStaleSession(err) {
  const text = `${err?.code || ''} ${err?.message || ''}`;
  return /not[\s_-]?found|unknown session|no such session|invalid session|does not exist|expired|不存在|未找到/i.test(text);
}

function nextFrame(iter, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    iter.next().then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------- 插件主体

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) };
  cfg.path = normalizePath(cfg.path);
  cfg.timeoutMs = Math.max(1000, Number(cfg.timeoutMs) || DEFAULTS.timeoutMs);
  cfg.intro = cfg.intro !== false;

  const log = createLogger(cfg.logFile);
  const startedAt = Date.now();
  const routePath = cfg.path;
  const token = resolveToken(cfg, log);
  const store = createStore(cfg, log);
  const tails = new Map();
  const endpoint = { url: '', file: expandHome(cfg.endpointFile) };

  const controller = ctx.sessionController;
  if (!controller || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new Error('qqbot-bridge 需要 sessionController 服务（create/prompt/follow），当前 Harness 里没找到。');
  }

  log.info(
    `v${VERSION} 启动：路由 ${routePath} / ${routePath}/health，令牌文件 ${expandHome(cfg.tokenFile)}，` +
      `超时 ${Math.round(cfg.timeoutMs / 1000)}s，已有会话映射 ${store.size()} 条`,
  );

  // ---------- 会话映射

  function createStore(config, logger) {
    const file = expandHome(config.sessionsFile);
    const max = Math.max(1, Number(config.maxSessions) || DEFAULTS.maxSessions);
    const map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const src = raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : raw;
      for (const [key, value] of Object.entries(src || {})) {
        if (typeof value === 'string') map.set(key, { sessionId: value, lastUsed: 0 });
        else if (value && typeof value.sessionId === 'string') {
          map.set(key, { sessionId: value.sessionId, lastUsed: Number(value.lastUsed) || 0 });
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') logger.warn(`会话映射读取失败（忽略）：${err.message}`);
    }
    function save() {
      const sessions = {};
      for (const [key, value] of map) sessions[key] = value;
      try {
        writeJsonAtomic(file, { version: 1, sessions });
      } catch (err) {
        logger.warn(`会话映射写入失败：${err.message}`);
      }
    }
    function trim() {
      while (map.size > max) {
        let oldestKey = null;
        let oldest = Infinity;
        for (const [key, value] of map) {
          if (value.lastUsed < oldest) {
            oldest = value.lastUsed;
            oldestKey = key;
          }
        }
        if (oldestKey === null) break;
        map.delete(oldestKey);
      }
    }
    return {
      file,
      get(key) {
        const entry = map.get(key);
        return entry ? entry.sessionId : null;
      },
      set(key, sessionId) {
        map.set(key, { sessionId, lastUsed: Date.now() });
        trim();
        save();
      },
      remove(key) {
        if (map.delete(key)) save();
      },
      size() {
        return map.size;
      },
    };
  }

  // ---------- endpoint 自动发现文件

  function writeEndpoint(url) {
    if (!url) return;
    endpoint.url = url;
    try {
      writeJsonAtomic(endpoint.file, {
        plugin: 'qqbot-bridge',
        version: VERSION,
        url,
        chatUrl: `${url}${routePath}`,
        tokenFile: expandHome(cfg.tokenFile),
        updatedAt: new Date().toISOString(),
      });
      log.info(`Harness 地址已写入 ${endpoint.file}：${url}`);
    } catch (err) {
      log.warn(`写入 ${endpoint.file} 失败：${err.message}`);
    }
  }

  function removeEndpointIfOurs() {
    try {
      const cur = JSON.parse(fs.readFileSync(endpoint.file, 'utf8'));
      if (cur?.plugin === 'qqbot-bridge') fs.unlinkSync(endpoint.file);
    } catch {
      /* ignore */
    }
  }

  function noteOrigin(req) {
    const host = req?.headers?.host;
    if (!host) return;
    const url = `http://${host}`;
    if (endpoint.url !== url) writeEndpoint(url);
  }

  // ---------- 鉴权

  function authorized(req) {
    const raw = req.headers?.authorization || req.headers?.['x-qqbot-token'] || '';
    const given = String(raw).replace(/^Bearer\s+/i, '').trim();
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---------- 每会话串行

  function serialize(key, task) {
    const prev = tails.get(key) || Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  }

  // ---------- 一轮对话

  async function createSession() {
    const request = {};
    if (cfg.cwd) request.cwd = String(cfg.cwd);
    if (cfg.agentPreset) request.agentPreset = String(cfg.agentPreset);
    const value = await controller.create(request);
    const sessionId = typeof value === 'string' ? value : value?.sessionId;
    if (!sessionId) throw new Error('sessionController.create 没有返回 sessionId');
    return sessionId;
  }

  async function runTurn(sessionId, text) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    timer.unref?.();
    let iter = null;
    let timedOut = false;
    let targetTurn = null;
    let reply = '';
    let reason = null;
    let toolCalls = 0;
    try {
      const stream = controller.follow({ address: { kind: 'session', sessionId } }, ac.signal);
      iter = stream[Symbol.asyncIterator]();
      const first = await nextFrame(iter, ac.signal);
      if (first.done) throw new Error('follow 流立即结束，拿不到会话事件');
      log.debug(`follow 已连接 ${sessionId}，首帧 ${first.value?.type || '?'}`);

      await controller.prompt(
        {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: cfg.timeZone,
        },
        ac.signal,
      );

      for (;;) {
        const step = await nextFrame(iter, ac.signal);
        if (step.done) break;
        const frame = step.value;
        if (!frame || frame.type !== 'event') continue;
        const ev = frame.event;
        if (!ev || typeof ev.type !== 'string') continue;

        if (ev.type === 'turn/start') {
          if (targetTurn === null && typeof ev.data?.turn === 'number') targetTurn = ev.data.turn;
          continue;
        }
        if (ev.type === 'tool/call') {
          toolCalls += 1;
          continue;
        }
        if (ev.type === 'assistant/message') {
          const turn = ev.data?.turn;
          if (targetTurn === null && typeof turn === 'number') targetTurn = turn;
          if (typeof turn === 'number' && turn === targetTurn) {
            const text2 = textOfAssistant(ev.data?.message);
            if (text2) reply = text2;
          }
          continue;
        }
        if (ev.type === 'turn/end') {
          const turn = ev.data?.turn;
          if (targetTurn === null && typeof turn === 'number') targetTurn = turn;
          if (typeof turn === 'number' && turn === targetTurn) {
            reason = ev.data?.reason ?? null;
            break;
          }
        }
      }
    } catch (err) {
      const aborted = err?.name === 'AbortError' || /abort/i.test(String(err?.message || ''));
      if (!aborted) throw err;
      timedOut = true;
      log.warn(`等待 ${sessionId} 回复超时（${Math.round(cfg.timeoutMs / 1000)}s），取消该轮`);
    } finally {
      clearTimeout(timer);
      if (timedOut) {
        try {
          await controller.cancel({ sessionId });
        } catch (err) {
          log.warn(`cancel ${sessionId} 失败：${err.message}`);
        }
      }
      try {
        await Promise.race([
          Promise.resolve(iter?.return?.()),
          new Promise((resolve) => {
            const t = setTimeout(resolve, 2000);
            t.unref?.();
          }),
        ]);
      } catch {
        /* ignore */
      }
    }
    return { reply: reply.trim(), turn: targetTurn, reason, timedOut, toolCalls };
  }

  async function chat(conversationId, text, images, persona = '', memory = '') {
    const started = Date.now();
    let created = false;
    let sessionId = store.get(conversationId);

    const compose = (body) => {
      // 人格只在新建会话时发一次：会话里已经有了，后面重复发没用还费 token
      const who = created && persona ? `${persona}\n\n` : '';
      const head = created && cfg.intro ? INTRO : '';
      // 记忆档案每轮都带：它随时在变，而且 Harness 那边不知道 QQ 上的历史
      const mem = memory ? `${memory}\n\n` : '';
      const tail =
        images.length > 0 ? `\n\n（消息里的图片链接，你看不到图，需要的话可以让对方描述：${images.join(' ')}）` : '';
      return `${who}${head}${mem}${body}${tail}`;
    };

    if (!sessionId) {
      sessionId = await createSession();
      created = true;
      store.set(conversationId, sessionId);
    }
    log.info(`[${conversationId}] → ${sessionId}${created ? '（新建会话）' : ''}：${preview(text, 120)}`);

    let outcome;
    try {
      outcome = await runTurn(sessionId, compose(text));
    } catch (err) {
      if (!isStaleSession(err)) throw err;
      log.warn(`会话 ${sessionId} 已失效（${err.message}），重建`);
      store.remove(conversationId);
      sessionId = await createSession();
      store.set(conversationId, sessionId);
      outcome = await runTurn(sessionId, compose(text));
    }

    const elapsedMs = Date.now() - started;
    const payload = {
      ok: true,
      conversationId,
      sessionId,
      turn: outcome.turn,
      reply: outcome.reply,
      reason: outcome.reason,
      toolCalls: outcome.toolCalls,
      elapsedMs,
    };

    if (outcome.timedOut) {
      payload.warning = `等待超时（${Math.round(cfg.timeoutMs / 1000)}s），已取消这一轮`;
      if (!payload.reply) {
        log.warn(`[${conversationId}] 超时且没有内容`);
        return {
          status: 504,
          payload: { ok: false, conversationId, sessionId, error: 'Agent 太久了，这一轮被我取消了。你可以换个说法再问一次。' },
        };
      }
    }

    const kind = outcome.reason?.kind;
    if (!payload.reply && kind === 'error') {
      const msg = outcome.reason?.error?.message || '未知错误';
      log.error(`[${conversationId}] Agent 出错：${msg}`);
      return {
        status: 502,
        payload: { ok: false, conversationId, sessionId, error: `Agent 出错了：${preview(msg, 200)}` },
      };
    }
    if (!payload.reply && kind) payload.warning = payload.warning || `这一轮结束原因：${kind}`;

    log.info(
      `[${conversationId}] ← ${preview(payload.reply, 140) || '（空回复）'} ` +
        `(${elapsedMs}ms, turn=${outcome.turn ?? '?'}, 工具 ${outcome.toolCalls} 次)`,
    );
    return { status: 200, payload };
  }

  // ---------- 路由处理

  async function handleChat(req, res) {
    noteOrigin(req);
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只接受 POST' });
    if (!authorized(req)) {
      log.warn(`拒绝未授权请求（${req.socket?.remoteAddress || '?'}）`);
      return send(res, 401, { ok: false, error: '未授权：Bearer 令牌缺失或不正确' });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return send(res, 400, { ok: false, error: err.message });
    }
    if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });

    const conversationId = String(body.conversationId || body.conversation || 'default').slice(0, 300);

    if (body.reset) {
      try {
        const result = await serialize(conversationId, async () => {
          const old = store.get(conversationId);
          store.remove(conversationId);
          if (old) {
            try {
              await controller.cancel({ sessionId: old });
            } catch {
              /* 会话可能已经结束了 */
            }
          }
          log.info(`[${conversationId}] 已忘记会话（下次重新开一个）`);
          return { status: 200, payload: { ok: true, reset: true, conversationId, forgotten: old || null } };
        });
        return send(res, result.status, result.payload);
      } catch (err) {
        log.error(`[${conversationId}] reset 失败：${err?.message || err}`);
        return send(res, 500, { ok: false, conversationId, error: `reset 失败：${err?.message || err}` });
      }
    }

    const text = typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT) : '';
    const images = Array.isArray(body.images)
      ? body.images
          .filter((x) => typeof x === 'string' && /^https?:\/\//i.test(x))
          .slice(0, 6)
      : [];
    const persona = typeof body.persona === 'string' ? body.persona.slice(0, 8000).trim() : '';
    const memory = typeof body.memory === 'string' ? body.memory.slice(0, 12000).trim() : '';
    if (!text.trim() && images.length === 0) return send(res, 400, { ok: false, error: '消息是空的' });

    try {
      const result = await serialize(conversationId, () => chat(conversationId, text, images, persona, memory));
      return send(res, result.status, result.payload);
    } catch (err) {
      log.error(`[${conversationId}] 处理失败：${err?.stack || err?.message || err}`);
      return send(res, 500, { ok: false, conversationId, error: `桥接插件出错：${err?.message || err}` });
    }
  }

  async function handleHealth(req, res) {
    noteOrigin(req);
    if (!authorized(req)) return send(res, 401, { ok: false, error: '未授权' });
    return send(res, 200, {
      ok: true,
      plugin: 'qqbot-bridge',
      version: VERSION,
      route: routePath,
      sessions: store.size(),
      timeoutMs: cfg.timeoutMs,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      logFile: log.file,
    });
  }

  // ---------- 注册（随插件卸载一起清理）

  function registerRoutes() {
    const offs = [
      ctx.webServer.register({ kind: 'exact', path: routePath, handler: handleChat }),
      ctx.webServer.register({ kind: 'exact', path: `${routePath}/health`, handler: handleHealth }),
    ];
    return () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      removeEndpointIfOurs();
      log.info('qqbot-bridge 已卸载，路由已撤销');
    };
  }

  if (typeof ctx.effect === 'function') ctx.effect(registerRoutes);
  else registerRoutes();
  log.info(`路由已注册：POST ${routePath}`);

  // 尽早把地址写给 bot；拿不到就等第一条请求的 Host 头
  try {
    const origin = ctx.webServer.getOrigin?.();
    if (origin && typeof origin.then === 'function') origin.then((u) => u && writeEndpoint(String(u))).catch(() => {});
    else if (origin) writeEndpoint(String(origin));
  } catch (err) {
    log.debug(`getOrigin 不可用：${err.message}`);
  }
}

// ---------------------------------------------------------------- 令牌

function resolveToken(cfg, log) {
  if (cfg.token) {
    log.info('鉴权令牌来自插件配置');
    return String(cfg.token).trim();
  }
  const env = String(process.env.QQBOT_HARNESS_TOKEN || '').trim();
  if (env) {
    log.info('鉴权令牌来自环境变量 QQBOT_HARNESS_TOKEN');
    return env;
  }
  const file = expandHome(cfg.tokenFile);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      log.info(`鉴权令牌来自 ${file}`);
      return existing;
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') log.warn(`读取令牌文件失败（将重新生成）：${err.message}`);
  }
  const fresh = crypto.randomBytes(24).toString('hex');
  try {
    writeFileAtomic(file, `${fresh}\n`, 0o600);
    log.warn(`已生成新令牌并写入 ${file}（QQ bot 也从这里读，重启 bot 即可）`);
  } catch (err) {
    log.error(`令牌写入 ${file} 失败：${err.message}。请手写这个文件，或在配置里填 token。`);
  }
  return fresh;
}
