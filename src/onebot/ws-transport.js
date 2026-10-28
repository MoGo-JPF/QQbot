/**
 * 正向 WebSocket 传输：本程序作为客户端，连到 NapCat 的 WebSocket 服务端。
 * 用 Node 24 自带的全局 WebSocket，不依赖 ws 包。
 */
export function createWsTransport(cfg, { log, onEvent }) {
  const wsCfg = {
    url: cfg?.ws?.url || 'ws://127.0.0.1:3001',
    accessToken: cfg?.ws?.accessToken || '',
    reconnectMs: cfg?.ws?.reconnectMs ?? 3000,
    maxReconnectMs: cfg?.ws?.maxReconnectMs ?? 60000,
    keepAliveMs: cfg?.ws?.keepAliveMs ?? 30000,
  };

  let ws = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer = null;
  let keepAliveTimer = null;
  let echoSeq = 0;
  const pending = new Map();

  function buildUrl() {
    const u = new URL(wsCfg.url);
    if (wsCfg.accessToken) u.searchParams.set('access_token', wsCfg.accessToken);
    return u.toString();
  }

  function isReady() {
    return Boolean(ws) && ws.readyState === 1; // OPEN
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const base = Math.max(500, wsCfg.reconnectMs);
    const delay = Math.min(base * 2 ** Math.min(attempt, 5), wsCfg.maxReconnectMs);
    attempt += 1;
    log.warn(`WebSocket ${delay}ms 后重连（第 ${attempt} 次），目标 ${wsCfg.url}`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function failPending(reason) {
    for (const [echo, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pending.delete(echo);
    }
  }

  function handleFrame(raw) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      log.debug('收到无法解析的 WebSocket 帧，已忽略');
      return;
    }
    if (payload && payload.echo != null && pending.has(String(payload.echo))) {
      const p = pending.get(String(payload.echo));
      clearTimeout(p.timer);
      pending.delete(String(payload.echo));
      if (payload.status === 'failed' || (payload.retcode != null && payload.retcode !== 0)) {
        p.reject(new Error(`OneBot 动作失败 retcode=${payload.retcode}: ${payload.message || payload.wording || ''}`));
      } else {
        p.resolve(payload.data ?? {});
      }
      return;
    }
    if (payload && payload.post_type) {
      try {
        onEvent(payload);
      } catch (err) {
        log.error('处理事件时出错', err);
      }
      return;
    }
    if (payload && payload.meta_event_type) {
      log.trace(`meta 事件 ${payload.meta_event_type}`);
      return;
    }
    log.debug('未知帧', raw);
  }

  function startKeepAlive() {
    stopKeepAlive();
    if (!wsCfg.keepAliveMs) return;
    keepAliveTimer = setInterval(async () => {
      if (!isReady()) return;
      try {
        await call('get_status', {}, 8000);
      } catch (err) {
        log.warn('心跳失败，主动断开重连', err.message);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      }
    }, wsCfg.keepAliveMs);
    keepAliveTimer.unref?.();
  }

  function stopKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  function connect() {
    if (stopped) return;
    let url;
    try {
      url = buildUrl();
    } catch (err) {
      log.error(`onebot.ws.url 不合法：${wsCfg.url}`, err);
      scheduleReconnect();
      return;
    }

    log.info(`连接 OneBot WebSocket: ${wsCfg.url}`);
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      log.error('创建 WebSocket 失败', err);
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener('open', async () => {
      attempt = 0;
      log.info('OneBot WebSocket 已连接');
      startKeepAlive();
      try {
        const info = await call('get_login_info', {}, 8000);
        log.info(`登录账号：${info?.nickname ?? '?'} (${info?.user_id ?? '?'})`);
      } catch (err) {
        log.warn('get_login_info 失败（不影响收发）:', err.message);
      }
    });

    socket.addEventListener('message', (ev) => {
      handleFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
    });

    socket.addEventListener('error', (ev) => {
      const msg = ev?.error?.message || ev?.message || 'unknown error';
      log.warn(`WebSocket 出错: ${msg}`);
    });

    socket.addEventListener('close', (ev) => {
      stopKeepAlive();
      failPending('WebSocket 已断开');
      ws = null;
      if (stopped) return;
      log.warn(`WebSocket 关闭 code=${ev?.code} reason=${ev?.reason || '-'}`);
      scheduleReconnect();
    });
  }

  async function call(action, params = {}, timeoutMs = 20000) {
    if (!isReady()) throw new Error(`WebSocket 未连接，无法执行 ${action}`);
    const echo = `e${++echoSeq}`;
    const frame = JSON.stringify({ action, params, echo });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`OneBot 动作超时 ${action} (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(frame);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(echo);
        reject(err);
      }
    });
  }

  return {
    name: 'ws',
    call,
    isReady,
    start() {
      stopped = false;
      connect();
    },
    async stop() {
      stopped = true;
      stopKeepAlive();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      failPending('传输层已停止');
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      ws = null;
    },
  };
}
