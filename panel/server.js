import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, expandHome, dataPaths, readJsonFile } from '../src/config.js';
import { createMemory } from '../src/memory.js';
import { createMedia } from '../src/media.js';
import { createMemes } from '../src/memes.js';
import { migrateData, legacyAvailable } from '../src/migrate.js';
import { createEngine } from '../src/engines/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const ROOT = path.resolve(HERE, '..');

// ---------- 小工具 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const COOKIE_NAME = 'qqbot_panel';

/** 把 Cookie 头拆成对象（够用就行，不处理引号和转义） */
function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 拿本机在局域网里的 IPv4（给手机输入/扫码用） */
function lanAddresses() {
  const skip = /vmware|vmnet|virtualbox|vbox|hyper-v|vethernet|loopback|bluetooth|npcap|docker|wsl|zerotier|tailscale|虚拟/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    if (skip.test(name)) continue;
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (item.address.startsWith('169.254.')) continue;
      out.push({ name, address: item.address });
    }
  }
  // 无线 / 有线排前面：手机最可能连的就是这两个
  const rank = (n) => (/wlan|wi-?fi|无线/i.test(n) ? 0 : /ethernet|以太网|本地连接/i.test(n) ? 1 : 2);
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  if (res.headersSent) return;
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

function readBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readLockPid(file) {
  try {
    const n = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(n) ? n : 0;
  } catch {
    return 0;
  }
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function tailLines(file, count = 200) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - count));
  } catch {
    return [];
  }
}

function onebotProbe(url, token = '', timeoutMs = 2500) {
  return new Promise((resolve) => {
    const withToken = token ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url;
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(payload);
    };
    let ws;
    try {
      ws = new WebSocket(withToken);
    } catch (err) {
      return resolve({ ok: false, error: String(err?.message || err) });
    }
    const echo = `panel-${Date.now()}`;
    const timer = setTimeout(() => finish({ ok: false, error: '超时' }), timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo }));
    });
    ws.addEventListener('message', (ev) => {
      let data;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data?.echo !== echo) return;
      clearTimeout(timer);
      const d = data?.data || {};
      finish({ ok: data?.status === 'ok' || data?.retcode === 0, userId: String(d.user_id || ''), nickname: String(d.nickname || '') });
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      finish({ ok: false, error: '连不上（NapCat 没起或者端口不对）' });
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      finish({ ok: false, error: '连接被关闭' });
    });
  });
}

/**
 * 面板回显的密钥是打码的（sk-abcd…1234 / ***）。如果原样回写 config.json，
 * 真 key 就被盖成掩码了。所以保存前把"看起来像掩码/空值"的密钥字段整条删掉。
 */
export function sanitizeSecrets(patch) {
  if (!patch || typeof patch !== 'object') return patch;
  const SECRET_KEYS = new Set(['apikey', 'token', 'webuitoken', 'accesstoken', 'secret']);
  const walk = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(v);
        continue;
      }
      if (!SECRET_KEYS.has(k.toLowerCase()) || typeof v !== 'string') continue;
      // '__clear__' 是面板"清掉这个 key"的显式信号
      if (v === '__clear__') {
        obj[k] = '';
        continue;
      }
      if (!v.trim() || v.includes('…') || v.includes('***')) delete obj[k];
    }
  };
  walk(patch);
  return patch;
}

// ---------- 主程序 ----------

/** 深合并：数组整体替换，对象递归合并。 */
function mergeDeep(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = mergeDeep(target[k] && typeof target[k] === 'object' && !Array.isArray(target[k]) ? target[k] : {}, v);
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
}

export function createPanel(options = {}) {
  let configFile = options.config || path.join(ROOT, 'config.json');
  let cfg = loadConfig({ file: configFile });
  if (options.port) cfg.panel = { ...cfg.panel, port: Number(options.port) };
  if (options.host) cfg.panel = { ...cfg.panel, host: String(options.host) };
  const state = { botPid: 0, botStartedAt: 0, note: '' };

  const log = {
    info: (m) => console.log(`[panel] ${m}`),
    warn: (m) => console.warn(`[panel] ${m}`),
  };

  function reloadConfig() {
    cfg = loadConfig({ file: configFile });
    return cfg;
  }

  function paths() {
    return dataPaths(cfg);
  }

  function memory() {
    return createMemory({ ...cfg.memory, dir: cfg.memory.dir }, { log });
  }

  function media() {
    return createMedia({ ...cfg.media, dir: cfg.media.dir }, { log });
  }

  function memes() {
    return createMemes({ ...cfg.media.webSearch }, { log });
  }

  // ----- 机器人进程 -----

  function botStatus() {
    const lockPid = readLockPid(paths().lock);
    const pid = pidAlive(lockPid) ? lockPid : pidAlive(state.botPid) ? state.botPid : 0;
    return {
      running: pid > 0,
      pid,
      lockPid,
      startedAt: pid > 0 && pid === state.botPid ? state.botStartedAt : 0,
      consoleLog: path.join(paths().logsDir, 'bot-console.log'),
    };
  }

  function startBot() {
    const st = botStatus();
    if (st.running) return { ok: false, error: `已经在跑了（进程 ${st.pid}）` };
    fs.mkdirSync(paths().logsDir, { recursive: true });
    const out = fs.openSync(path.join(paths().logsDir, 'bot-console.log'), 'a');
    const child = spawn(process.execPath, ['src/index.js', '--config', configFile], {
      cwd: path.dirname(path.resolve(configFile)),
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    state.botPid = child.pid;
    state.botStartedAt = Date.now();
    log.info(`启动机器人 pid=${child.pid}`);
    return { ok: true, pid: child.pid };
  }

  function stopBot() {
    const st = botStatus();
    if (!st.running) return { ok: false, error: '本来就没在跑' };
    try {
      process.kill(st.pid, 'SIGTERM');
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
    // Windows 上等一会儿，还在就强杀
    setTimeout(() => {
      if (pidAlive(st.pid)) {
        try {
          process.kill(st.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 4000).unref?.();
    return { ok: true, pid: st.pid };
  }

  // ----- NapCat -----

  function napcatStatus() {
    const dir = expandHome(cfg.napcat?.dir || './napcat');
    const qrFile = path.join(dir, 'cache', 'qrcode.png');
    const launcher = path.join(dir, cfg.napcat?.launcher || 'launcher-win10.bat');
    const mtime = fileMtime(qrFile);
    return {
      dir,
      exists: fs.existsSync(dir),
      launcher,
      launcherExists: fs.existsSync(launcher),
      qrFile,
      qrExists: mtime > 0,
      qrAgeSec: mtime > 0 ? Math.round((Date.now() - mtime) / 1000) : -1,
      webui: cfg.napcat?.webui || '',
      webuiToken: cfg.napcat?.webuiToken || '',
      qq: cfg.napcat?.qq || '',
    };
  }

  function startNapcat() {
    const n = napcatStatus();
    if (!n.launcherExists) return { ok: false, error: `找不到启动器：${n.launcher}` };
    // 先关掉已经在跑的 QQ（NapCat 必须自己拉起 QQ 才能注入），再拉启动器。
    // 用 restart-napcat.bat 做这件事：外面套一层 .bat 比在 spawn 里拼带引号的命令可靠得多。
    const bootBat = path.join(ROOT, 'restart-napcat.bat');
    const logBat = path.join(ROOT, 'start-napcat-log.bat');
    const inner = fs.existsSync(bootBat)
      ? bootBat
      : fs.existsSync(logBat)
        ? `taskkill /im QQ.exe >nul 2>nul & timeout /t 3 /nobreak >nul & call "${logBat}"`
        : n.launcher;
    const child = spawn('cmd.exe', ['/c', inner], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true, note: '会先关掉 QQ 再拉 NapCat；如果弹出 UAC 请点是，之后可能要扫码' };
  }

  function stopNapcat() {
    const script = `Get-Process NapCatWinBootMain,QQ -ErrorAction SilentlyContinue | Stop-Process -Force`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-Command','${script.replace(/'/g, "''")}'`],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    return { ok: true, note: '需要管理员权限，请在 UAC 里点【是】' };
  }

  // ----- 配置读写 -----

  function readRawConfig() {
    return readJsonFile(configFile) || {};
  }

  function patchConfig(patch) {
    const raw = readRawConfig();
    sanitizeSecrets(patch);
    const merge = (target, src) => {
      for (const [k, v] of Object.entries(src)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          target[k] = merge(target[k] && typeof target[k] === 'object' ? target[k] : {}, v);
        } else if (v !== undefined) {
          target[k] = v;
        }
      }
      return target;
    };
    const next = merge(structuredClone(raw), patch);
    const prev = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
    fs.writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    try {
      reloadConfig();
    } catch (err) {
      // 校验没过就别留下一个起不来的配置
      if (prev === null) fs.rmSync(configFile, { force: true });
      else fs.writeFileSync(configFile, prev, 'utf8');
      try {
        reloadConfig();
      } catch {
        /* 旧配置本来就坏的话，保持原样 */
      }
      throw new Error(`保存被拒绝：${String(err?.message || err).replace(/^.*?[:：]\s*/, '')}`);
    }
    return next;
  }

  function publicConfig() {
    const c = structuredClone(cfg);
    delete c.__file;
    delete c.__fileExists;
    delete c.__baseDir;
    if (c.engines?.openai?.apiKey) {
      const k = String(c.engines.openai.apiKey);
      c.engines.openai.apiKey = `${k.slice(0, 6)}…${k.slice(-4)}`;
      c.engines.openai.apiKeySet = true;
    } else {
      c.engines.openai.apiKeySet = false;
    }
    if (c.engines?.harness?.token) c.engines.harness.token = '***';
    if (c.panel?.token) c.panel.token = '***';
    if (c.napcat?.webuiToken) c.napcat.webuiToken = '***';
    return c;
  }

  // ----- 路由 -----

  async function apiStatus() {
    const p = paths();
    const bot = botStatus();
    const n = napcatStatus();
    const mem = memory();
    const md = media();
    const me = memes();
    const onebot = await onebotProbe(cfg.onebot.ws.url, cfg.onebot.ws.accessToken);
    const memStats = mem.stats();
    const mediaStats = md.stats();
    const memesStats = me.stats();
    mem.close?.();
    md.close?.();
    return {
      ok: true,
      now: Date.now(),
      project: ROOT,
      configFile,
      engine: cfg.engine,
      persona: { name: cfg.persona?.name || '', file: expandHome(cfg.persona?.file || '') },
      bot,
      onebot,
      napcat: n,
      storage: {
        root: p.root,
        memory: p.memory,
        media: p.media,
        memes: p.memes,
        log: p.log,
        legacyAvailable: legacyAvailable(),
      },
      counts: {
        messages: memStats.messages,
        conversations: memStats.conversations,
        longItems: memStats.longItems,
        stickers: mediaStats.items,
        memes: memesStats.count,
        memesAgeDays: memesStats.ageDays,
      },
      uptimeSec: Math.round(process.uptime()),
    };
  }

  const routes = [
    ['GET', '/api/status', async (req, res) => sendJson(res, 200, await apiStatus())],

    [
      'POST',
      '/api/bot/start',
      async (req, res) => {
        const r = startBot();
        sendJson(res, r.ok ? 200 : 409, r);
      },
    ],
    [
      'POST',
      '/api/bot/stop',
      async (req, res) => {
        const r = stopBot();
        sendJson(res, r.ok ? 200 : 409, r);
      },
    ],
    [
      'POST',
      '/api/bot/restart',
      async (req, res) => {
        const st = botStatus();
        if (st.running) {
          stopBot();
          await new Promise((r) => setTimeout(r, 1500));
          if (pidAlive(st.pid)) {
            try {
              process.kill(st.pid, 'SIGKILL');
            } catch {
              /* ignore */
            }
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        const r = startBot();
        sendJson(res, r.ok ? 200 : 500, r);
      },
    ],

    [
      'POST',
      '/api/panel/stop',
      async (req, res) => {
        // 先把响应发回去，再退——不然浏览器那边只会看到连接被重置
        sendJson(res, 200, {
          ok: true,
          note: '面板要关了。机器人是独立进程，不受影响（要停机器人请用「停止机器人」）。',
        });
        if (options.allowExit === false) return; // 测试用：只验接口，不退进程
        log.info('收到关闭面板的请求，0.4 秒后退出');
        setTimeout(() => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
          process.exit(0);
        }, 400).unref?.();
      },
    ],

    [
      'GET',
      '/api/logs',
      async (req, res, url) => {
        const n = Math.min(2000, Number(url.searchParams.get('lines') || 200));
        const file = url.searchParams.get('file') === 'console' ? path.join(paths().logsDir, 'bot-console.log') : paths().log;
        sendJson(res, 200, { ok: true, file, lines: tailLines(file, n) });
      },
    ],

    [
      'GET',
      '/api/napcat/qr',
      async (req, res) => {
        const n = napcatStatus();
        if (!n.qrExists) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ ok: false, error: '还没有二维码（NapCat 没起来，或者已经登录了）' }));
        }
        const buf = fs.readFileSync(n.qrFile);
        const ext = path.extname(n.qrFile).toLowerCase();
        res.writeHead(200, {
          'content-type': MIME[ext] || 'image/png',
          'content-length': buf.length,
          'cache-control': 'no-store',
        });
        res.end(buf);
      },
    ],
    ['POST', '/api/napcat/start', async (req, res) => sendJson(res, 200, startNapcat())],
    ['POST', '/api/napcat/stop', async (req, res) => sendJson(res, 200, stopNapcat())],

    [
      'GET',
      '/api/stickers',
      async (req, res, url) => {
        const q = url.searchParams.get('q') || '';
        const md = media();
        const items = (q ? md.findMany(q, 500) : md.list()).map((it) => ({
          id: it.id,
          tags: it.tags || [],
          note: it.note || '',
          from: it.from || '',
          uses: it.uses || 0,
          addedAt: it.addedAt || 0,
          hasFile: Boolean(it.file && fs.existsSync(it.file)),
          file: it.file || '',
        }));
        md.close?.();
        sendJson(res, 200, { ok: true, items });
      },
    ],
    [
      'GET',
      '/api/stickers/image',
      async (req, res, url) => {
        const id = url.searchParams.get('id') || '';
        const md = media();
        const item = md.list().find((it) => it.id === id);
        md.close?.();
        if (!item?.file || !fs.existsSync(item.file)) return sendText(res, 404, '没有这张图');
        const buf = fs.readFileSync(item.file);
        res.writeHead(200, {
          'content-type': MIME[path.extname(item.file).toLowerCase()] || 'application/octet-stream',
          'content-length': buf.length,
          'cache-control': 'public, max-age=60',
        });
        res.end(buf);
      },
    ],
    [
      'POST',
      '/api/stickers',
      async (req, res) => {
        const body = await readBody(req);
        const md = media();
        const ref = body.dataUrl || body.path || body.url;
        if (!ref) {
          md.close?.();
          return sendJson(res, 400, { ok: false, error: '缺图片（dataUrl / path / url）' });
        }
        try {
          const { buffer, mime } = await md.fetchImage(ref);
          const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,，\s]+/).filter(Boolean);
          const item = md.storeImage(buffer, mime, { tags, note: body.note || '', from: body.from || 'panel' });
          md.close?.();
          sendJson(res, 200, { ok: true, item });
        } catch (err) {
          md.close?.();
          sendJson(res, 400, { ok: false, error: String(err?.message || err) });
        }
      },
    ],
    [
      'PATCH',
      '/api/stickers',
      async (req, res, url) => {
        const id = url.searchParams.get('id') || '';
        const body = await readBody(req);
        const md = media();
        const item = md.update(id, { tags: body.tags, note: body.note });
        md.close?.();
        sendJson(res, item ? 200 : 404, { ok: Boolean(item), item, error: item ? undefined : '没有这一条' });
      },
    ],
    [
      'DELETE',
      '/api/stickers',
      async (req, res, url) => {
        const id = url.searchParams.get('id') || '';
        const md = media();
        const removed = md.remove(id);
        md.close?.();
        sendJson(res, removed > 0 ? 200 : 404, { ok: removed > 0, removed, error: removed > 0 ? undefined : '没有这一条' });
      },
    ],
    [
      'POST',
      '/api/stickers/search',
      async (req, res) => {
        const body = await readBody(req);
        const q = String(body.q || '').trim();
        if (!q) return sendJson(res, 400, { ok: false, error: '给个关键词' });
        const me = memes();
        const md = media();
        try {
          await me.ensure({ blocking: false });
          const hits = me.search(q, { limit: 12 });
          if (hits.length === 0) return sendJson(res, 404, { ok: false, error: `没搜到「${q}」`, hits: [] });
          const tried = [];
          for (const hit of hits.slice(0, 3)) {
            try {
              const { buffer, mime } = await md.fetchImage(me.imageUrl(hit));
              const item = md.storeImage(buffer, mime, { id: `net:${hit.id}`, tags: me.tagsOf(hit), note: hit.title, from: 'aigengtu' });
              md.close?.();
              return sendJson(res, 200, { ok: true, item, hit });
            } catch (err) {
              tried.push(`#${hit.id} ${err?.message || err}`);
            }
          }
          sendJson(res, 502, { ok: false, error: `图找到了但下载失败：${tried.join('；')}` });
        } finally {
          md.close?.();
        }
      },
    ],

    [
      'GET',
      '/api/memory',
      async (req, res, url) => {
        const kind = url.searchParams.get('kind') || 'long';
        const q = url.searchParams.get('q') || '';
        const cid = url.searchParams.get('cid') || '';
        const limit = Math.min(1000, Number(url.searchParams.get('limit') || 200));
        const mem = memory();
        const out =
          kind === 'recent'
            ? { messages: mem.recentMessages({ cid, q, limit }) }
            : { items: mem.listLong({ q, cid, limit }) };
        out.stats = mem.stats();
        out.conversations = [...new Set(mem.recentMessages({ limit: 5000 }).map((m) => m.cid))];
        mem.close?.();
        sendJson(res, 200, { ok: true, kind, ...out });
      },
    ],
    [
      'POST',
      '/api/memory',
      async (req, res) => {
        const body = await readBody(req);
        const mem = memory();
        const text = String(body.text || '').trim();
        if (!text) {
          mem.close?.();
          return sendJson(res, 400, { ok: false, error: '内容不能为空' });
        }
        const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,，\s]+/).filter(Boolean);
        const item = mem.remember({ text, tags, cid: body.cid || '', kind: body.kind || 'note' });
        mem.close?.();
        sendJson(res, 200, { ok: true, item });
      },
    ],
    [
      'PATCH',
      '/api/memory',
      async (req, res, url) => {
        const id = url.searchParams.get('id') || '';
        const body = await readBody(req);
        const mem = memory();
        const item = mem.updateLong(id, body);
        mem.close?.();
        sendJson(res, item ? 200 : 404, { ok: Boolean(item), item, error: item ? undefined : '没有这一条' });
      },
    ],
    [
      'DELETE',
      '/api/memory',
      async (req, res, url) => {
        const id = url.searchParams.get('id') || '';
        const mem = memory();
        if (url.searchParams.get('kind') === 'message') {
          const t = Number(url.searchParams.get('t'));
          const ok = mem.deleteMessage({ t, cid: url.searchParams.get('cid') || '', role: url.searchParams.get('role') || '', text: url.searchParams.get('text') || '' });
          mem.close?.();
          return sendJson(res, ok ? 200 : 404, { ok, error: ok ? undefined : '没找到这条消息' });
        }
        const ok = mem.forget(id);
        mem.close?.();
        sendJson(res, ok ? 200 : 404, { ok, error: ok ? undefined : '没有这一条' });
      },
    ],
    [
      'POST',
      '/api/memes/rebuild',
      async (req, res) => {
        const me = memes();
        try {
          const report = await me.build();
          sendJson(res, 200, { ok: true, ...report, stats: me.stats() });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
      },
    ],

    [
      'POST',
      '/api/engine/test',
      async (req, res) => {
        const body = await readBody(req);
        const text = String(body.text || '你好，用一句话说明你在线。').slice(0, 500);
        // 面板上还没保存的改动（尤其是刚粘进来的 Key）也要能测：
        // 传了 patch 就先叠到配置副本上再建引擎。
        let testCfg = cfg;
        if (body.patch && typeof body.patch === 'object') {
          testCfg = mergeDeep(structuredClone(cfg), sanitizeSecrets(body.patch));
          if (testCfg.engines?.openai?.apiKey === '__clear__') testCfg.engines.openai.apiKey = '';
        }
        // 用配置副本临时造一个引擎，打完就扔，不影响正在跑的机器人
        const stubHistory = { get: () => [], append() {}, clear() {}, size: () => 0, flush() {}, close() {} };
        const quiet = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child: () => quiet };
        let engine;
        try {
          engine = createEngine(testCfg, { log: quiet, history: stubHistory });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: `配置有问题：${String(err?.message || err)}` });
        }
        const keyEnvVal = process.env[testCfg.engines?.openai?.apiKeyEnv || ''] || '';
        if (engine.name === 'openai' && !(testCfg.engines?.openai?.apiKey || keyEnvVal)) {
          return sendJson(res, 400, { ok: false, error: '还没填 API Key' });
        }
        const started = Date.now();
        try {
          const reply = await Promise.race([
            engine.chat({ conversationId: 'panel:selftest', text, images: [] }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('超时（90 秒）')), 90_000).unref?.()),
          ]);
          sendJson(res, 200, {
            ok: true,
            engine: engine.name,
            model: engine.name === 'openai' ? testCfg.engines?.openai?.model || '' : 'harness',
            reply: String(reply?.text || '').slice(0, 2000),
            ms: Date.now() - started,
          });
        } catch (err) {
          sendJson(res, 502, { ok: false, error: String(err?.message || err), ms: Date.now() - started });
        }
      },
    ],
    [
      'GET',
      '/api/senders',
      async (req, res) => {
        // 最近的会话，用来一键加白名单
        const mem = memory();
        const rows = mem.recentMessages({ limit: 4000 });
        mem.close?.();
        const map = new Map();
        for (const r of rows) {
          const cid = String(r.cid || '');
          if (!cid) continue;
          const at = map.get(cid) || { cid, count: 0, last: 0 };
          at.count += 1;
          at.last = Math.max(at.last, Number(r.t) || 0);
          map.set(cid, at);
        }
        const priv = [];
        const groups = [];
        const isQQ = (v) => /^\d{4,15}$/.test(String(v || ''));
        for (const v of map.values()) {
          if (v.cid.startsWith('private:')) {
            const qq = v.cid.slice(8);
            if (!isQQ(qq)) continue; // 自检用的 private:selftest 之类，别混进白名单
            priv.push({ cid: v.cid, qq, count: v.count, last: v.last });
          } else if (v.cid.startsWith('group:')) {
            const [, gid, qq] = v.cid.split(':');
            if (!isQQ(gid)) continue;
            const g = groups.find((x) => x.gid === gid) || (groups.push({ cid: `group:${gid}`, gid, count: 0, last: 0, senders: [] }), groups.at(-1));
            g.count += v.count;
            g.last = Math.max(g.last, v.last);
            if (qq && !g.senders.includes(qq)) g.senders.push(qq);
          }
        }
        priv.sort((a, b) => b.last - a.last);
        groups.sort((a, b) => b.last - a.last);
        sendJson(res, 200, {
          ok: true,
          private: priv,
          groups,
          allow: {
            private: cfg.policy?.private?.users || [],
            groups: cfg.policy?.group?.groups || [],
          },
        });
      },
    ],
    [
      'GET',
      '/api/config',
      async (req, res) => sendJson(res, 200, { ok: true, config: publicConfig(), file: configFile, paths: paths() }),
    ],
    [
      'PATCH',
      '/api/config',
      async (req, res) => {
        const body = await readBody(req);
        try {
          patchConfig(body.patch || body);
          sendJson(res, 200, { ok: true, config: publicConfig() });
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String(err?.message || err) });
        }
      },
    ],
    [
      'POST',
      '/api/storage',
      async (req, res) => {
        const body = await readBody(req);
        const root = String(body.root || '').trim();
        if (!root) return sendJson(res, 400, { ok: false, error: '给个目录' });
        const oldRoot = paths().root;
        patchConfig({ storage: { root } });
        const created = paths().root;
        sendJson(res, 200, {
          ok: true,
          root: created,
          previous: oldRoot,
          note: '已写入 config.json。数据还在老目录的话，点"把旧数据搬过来"。',
        });
      },
    ],
    [
      'POST',
      '/api/migrate',
      async (req, res) => {
        const body = await readBody(req);
        try {
          const report = migrateData(cfg, { from: body.from || undefined, force: Boolean(body.force), dryRun: Boolean(body.dryRun), log });
          sendJson(res, 200, { ok: true, report });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
      },
    ],
  ];

  const isLoopback = (req) => {
    const a = String(req.socket?.remoteAddress || '');
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  };

  /** 登录成功后写进 cookie 的值：有 token 就用 token，否则用 pin 派生（别让人瞎猜） */
  function cookieValue() {
    const token = String(cfg.panel?.token || '').trim();
    if (token) return token;
    const pin = String(cfg.panel?.pin || '').trim();
    if (!pin) return '';
    return `pin:${crypto.createHash('sha256').update(`qqbot-panel|${pin}`).digest('hex').slice(0, 32)}`;
  }

  function authorized(req, url) {
    const token = String(cfg.panel?.token || '').trim();
    const pin = String(cfg.panel?.pin || '').trim();
    if (!token && !pin) return true;
    const header = String(req.headers.authorization || '');
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (token && bearer === token) return true;
    if (token && url.searchParams.get('token') === token) return true;
    // 手机登录过就记在 cookie 里，省得 URL 里老带 token
    const cookie = parseCookies(req)[COOKIE_NAME];
    const expect = cookieValue();
    if (cookie && expect && cookie === expect) return true;
    // 本机（面板所在电脑）不用再输密码——pin 只是给手机/局域网用的
    if (!token && isLoopback(req)) return true;
    return false;
  }

  /** 手机端登录：用 PIN（或直接给 token）换一个 cookie */
  const loginFails = new Map();
  async function handleLogin(req, res) {
    const ip = String(req.socket?.remoteAddress || '');
    const now = Date.now();
    const rec = loginFails.get(ip);
    if (rec && rec.resetAt > now && rec.count >= 8) {
      return sendJson(res, 429, { ok: false, error: '试太多次了，等一分钟再来' });
    }
    const body = await readBody(req).catch(() => ({}));
    const token = String(cfg.panel?.token || '').trim();
    const pin = String(cfg.panel?.pin || '').trim();
    const given = String(body.pin || body.token || '').trim();
    const ok = given && ((pin && given === pin) || (token && given === token));
    if (!ok) {
      const base = rec && rec.resetAt > now ? rec : { count: 0, resetAt: now + 60000 };
      loginFails.set(ip, { count: base.count + 1, resetAt: base.resetAt });
      return sendJson(res, 401, { ok: false, error: pin || token ? '密码不对' : '面板没设密码（config.json 里 panel.pin）' });
    }
    loginFails.delete(ip);
    res.setHeader('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(cookieValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return sendJson(res, 200, { ok: true });
  }

  /** 手机上要用的信息：局域网地址、有没有设密码 */
  function mobileInfo() {
    const host = cfg.panel?.host || '127.0.0.1';
    const port = Number(cfg.panel?.port || 8899);
    const lan = host === '0.0.0.0' || host === '::' || host === '' ? lanAddresses() : [];
    return {
      ok: true,
      host,
      port,
      lanEnabled: host === '0.0.0.0' || host === '::' || host === '',
      urls: lan.map((n) => ({ ...n, url: `http://${n.address}:${port}/m` })),
      pinSet: Boolean(String(cfg.panel?.pin || '').trim()),
      tokenSet: Boolean(String(cfg.panel?.token || '').trim()),
    };
  }

  function serveStatic(req, res, url) {
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    if (rel === '/m' || rel === '/m/') rel = '/m.html';
    const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC)) return sendText(res, 403, 'forbidden');
    fs.readFile(file, (err, buf) => {
      if (err) return sendText(res, 404, 'not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store, no-cache, must-revalidate', pragma: 'no-cache' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const startedAt = Date.now();
    {
      // 每一次请求都记，连静态页面也算：这样能判断手机到底有没有连上这台电脑
      res.on('finish', () => {
        const ip = String(req.socket?.remoteAddress || '').replace('::ffff:', '');
        const ua = String(req.headers['user-agent'] || '');
        const who = /VivoBrowser/i.test(ua) ? 'vivo' : /MicroMessenger/i.test(ua) ? '微信' : /Android/i.test(ua) ? '安卓' : /iPhone|iPad/i.test(ua) ? 'iOS' : '电脑';
        log.info(`${req.method} ${url.pathname} → ${res.statusCode} ${Date.now() - startedAt}ms（${ip}，${who}）`);
      });
    }
    try {
      // 登录接口自己就要求不带令牌访问（不然没法登录）
      if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
      if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: '需要面板令牌' });
      if (url.pathname === '/api/mobile' && req.method === 'GET') return sendJson(res, 200, mobileInfo());
      const route = routes.find(([method, p]) => method === req.method && p === url.pathname);
      if (!route) return sendJson(res, 404, { ok: false, error: `没有这个接口：${req.method} ${url.pathname}` });
      await route[2](req, res, url);
    } catch (err) {
      console.error('[panel] 出错了', err);
      sendJson(res, 500, { ok: false, error: String(err?.message || err) });
    }
  });

  return {
    server,
    start() {
      const host = cfg.panel?.host || '127.0.0.1';
      const port = Number(cfg.panel?.port || 8899);
      // 开了局域网访问却没设密码：自动生成一个 PIN，别让同 WiFi 的人随便关机器人
      const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      if (!loopback && !String(cfg.panel?.token || '').trim() && !String(cfg.panel?.pin || '').trim()) {
        const pin = String(Math.floor(100000 + Math.random() * 900000));
        try {
          patchConfig({ panel: { pin } });
          console.log(`\n  手机访问密码（自动生成）：${pin}\n  在手机浏览器打开 http://<这台电脑的IP>:${port}/m 后输入它。\n`);
        } catch (err) {
          console.log(`[!] 想自动生成手机访问密码但没写进 config.json：${err?.message || err}`);
        }
      }
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening);
          if (err?.code === 'EADDRINUSE') {
            const e = new Error(`端口 ${port} 已经被占用了`);
            e.code = 'EADDRINUSE';
            e.port = port;
            e.host = host;
            return reject(e);
          }
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const addr = server.address();
          log.info(`控制面板：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}/`);
          resolve({ host, port: addr.port });
        };
        server.once('error', onError);
        server.listen(port, host, onListening);
      });
    },
    reloadConfig,
    get config() {
      return cfg;
    },
  };
}

// 直接跑：node panel/server.js [--config config.json] [--port 8899] [--host 127.0.0.1]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const val = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const configFile = val('--config', path.join(ROOT, 'config.json'));
  const panel = createPanel({ config: configFile, port: val('--port', ''), host: val('--host', '') });
  const cfg = panel.config;
  const openIt = (u) => spawn('cmd.exe', ['/c', 'start', '', u], { detached: true, stdio: 'ignore' }).unref();

  let info;
  try {
    info = await panel.start();
  } catch (err) {
    const host = cfg.panel?.host === '0.0.0.0' ? '127.0.0.1' : cfg.panel?.host || '127.0.0.1';
    const port = err?.port || cfg.panel?.port || 8899;
    const url = `http://${host}:${port}/`;
    if (err?.code === 'EADDRINUSE') {
      // 十有八九是面板已经开着了（双击了两次 / 上次的窗口还在）——直接帮你打开那个
      const mine = await fetch(`${url}api/status`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
      console.log('');
      if (mine) {
        console.log('  面板已经在跑了，不用再开一个。');
        console.log(`  已经帮你打开：${url}`);
      } else {
        console.log(`  端口 ${port} 被别的程序占用了。`);
        console.log(`  换一个端口：node panel\\server.js --port ${port + 1}`);
      }
      console.log('');
      if (mine) openIt(url);
      process.exit(mine ? 0 : 1);
    }
    console.error(`[x] 面板起不来：${String(err?.message || err)}`);
    process.exit(1);
  }

  const url = `http://${cfg.panel.host === '0.0.0.0' ? '127.0.0.1' : cfg.panel.host}:${info.port}/`;
  console.log('');
  console.log('  QQ 机器人控制面板');
  console.log(`  ${url}`);
  console.log(`  数据目录：${dataPaths(cfg).root}`);
  console.log('  关掉这个窗口 = 关掉面板（机器人不受影响）');
  console.log('');
  if (argv.includes('--open')) openIt(url);
}
