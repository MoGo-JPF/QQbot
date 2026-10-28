/**
 * 图片与表情包。
 *
 * 两件事：
 *   1. 收到的图能"看懂"：把图下载下来、转成 data URL，交给支持视觉的模型（DeepSeek 的 flash 就支持）。
 *   2. 能让它发表情包：维护一个本地图库（手动放 / 聊天里存 / 自动学你发的表情），
 *      模型在回复里写 [表情:关键词] 或 [图:https://…]，这里负责把标记换成真正发出去的图片段。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { expandHome } from './config.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * 自己发 HTTP 请求拿二进制。
 * 为什么不用 fetch：undici 的默认连接超时是 10 秒且不可调，云镜像站偶尔要 6 秒才连上，
 * 一旦抖动就直接 "fetch failed"，重试也没用；这里用 node:https 能自己设超时、自己重试。
 */
function httpGetBuffer(url, { timeoutMs = 20000, headers = {}, maxBytes = 0, redirects = 3 } = {}) {
  const lib = /^https:/i.test(url) ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers, timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(new Error('重定向太多次'));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        httpGetBuffer(next, { timeoutMs, headers, maxBytes, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks = [];
      let seen = 0;
      res.on('data', (chunk) => {
        seen += chunk.length;
        if (maxBytes > 0 && seen > maxBytes) {
          req.destroy(new Error(`图片太大（>${maxBytes} 字节）`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        resolve({
          buffer: Buffer.concat(chunks),
          mime: String(res.headers['content-type'] || '').split(';')[0].trim() || guessMime(url),
        }),
      );
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`连接超时（${timeoutMs}ms）`)));
    req.on('error', reject);
  });
}

/** 抖动重试：连不上/超时就再来一次，别的错（404 之类）直接抛。 */
async function withRetry(fn, { tries = 3, delayMs = 500 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      last = err;
      const msg = String(err?.message || '');
      const retryable = /超时|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|TLS|EPIPE/i.test(msg);
      if (!retryable || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

/** 从 URL / data: / base64:// 里认出 MIME。 */
function guessMime(url, hint) {
  if (hint) return hint;
  const m = /^data:([^;,]+)[;,]/.exec(url) || /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.exec(url);
  if (!m) return 'image/jpeg';
  const v = m[1].toLowerCase();
  if (v === 'jpg' || v === 'jpeg') return 'image/jpeg';
  if (v === 'png' || v === 'gif' || v === 'webp') return `image/${v}`;
  return 'image/jpeg';
}

/** 中文按二元组切词，英文数字按整词；够用且不引依赖。 */
export function tokenize(text) {
  const out = new Set();
  const s = String(text ?? '').toLowerCase();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length; i += 1) {
      if (i + 1 < run.length) out.add(run.slice(i, i + 2));
      if (i + 2 < run.length) out.add(run.slice(i, i + 3));
    }
    if (run.length === 1) out.add(run);
  }
  return out;
}

/** 图库条目的相关度：标签/备注命中 > 分词重叠。 */
function scoreSticker(item, query) {
  const q = String(query ?? '').trim();
  if (!q) return 0.5;
  const hay = `${item.tags.join(' ')} ${item.note ?? ''}`.toLowerCase();
  if (hay.includes(q.toLowerCase())) return 1;
  const qt = tokenize(q);
  if (qt.size === 0) return 0;
  const it = tokenize(hay);
  let hit = 0;
  for (const t of qt) if (it.has(t)) hit += 1;
  if (hit === 0) return 0;
  return Math.min(0.95, 0.4 + 0.6 * Math.min(1, hit / Math.min(qt.size, 4)));
}

export function createMedia(cfg = {}, { log } = {}) {
  const enabled = cfg.enabled !== false;
  const dir = expandHome(cfg.dir || '~/.dsh/qqbot-memory/media');
  const indexFile = path.join(dir, 'stickers.json');
  const stickerDir = expandHome(cfg.stickerDir || './stickers');
  const autoLearn = cfg.autoLearn !== false;
  const maxItems = Math.max(1, Number(cfg.maxItems ?? 500));
  const maxBytes = Math.max(64 * 1024, Number(cfg.maxBytes ?? 4 * 1024 * 1024));
  const maxInlineImages = Math.max(0, Number(cfg.maxInlineImages ?? 3));
  const timeoutMs = Math.max(1000, Number(cfg.timeoutMs ?? 20000));

  let items = [];
  let dirty = false;
  let saveTimer = null;
  let warned = false;

  function ensureDir() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (err) {
      if (!warned) {
        warned = true;
        log?.warn?.(`图片目录不可写（${dir}）：${err.message}，表情包图库这次只在内存里用。`);
      }
      return false;
    }
  }

  function load() {
    if (!enabled) return;
    ensureDir();
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, ''));
      items = Array.isArray(raw?.items) ? raw.items : [];
    } catch {
      items = [];
    }
    importFromDir();
  }

  function save() {
    if (!enabled) return;
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flush();
    }, 300);
    saveTimer.unref?.();
  }

  function flush() {
    if (!enabled || !dirty) return;
    dirty = false;
    try {
      ensureDir();
      const tmp = `${indexFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, items }, null, 0)}\n`, 'utf8');
      fs.renameSync(tmp, indexFile);
    } catch (err) {
      log?.warn?.(`表情库写盘失败：${err.message}`);
    }
  }

  function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  /** 从项目里的 stickers/ 目录导入（文件名即标签，如 `笑-狗头.png`）。 */
  function importFromDir() {
    let names = [];
    try {
      names = fs.readdirSync(stickerDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) continue;
      const file = path.join(stickerDir, name);
      const id = `dir:${name}`;
      if (items.some((i) => i.id === id)) continue;
      const tags = name
        .replace(/\.[^.]+$/, '')
        .split(/[-_ 、,，]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      items.push({
        id,
        file,
        tags: tags.length > 0 ? tags : ['表情'],
        note: '',
        from: 'folder',
        addedAt: Date.now(),
        uses: 0,
      });
      save();
    }
  }

  function extOf(mime) {
    return mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'jpg';
  }

  /**
   * 只落盘、不进图库。聊天里收到的图先缓存到磁盘（给模型看、给 /存表情 用），
   * 要不要变成"表情包"由 autoLearn / 用户命令决定，别把每张聊天图都塞进图库。
   */
  function cacheImage(buffer, mime) {
    const hash = sha256(buffer);
    const ext = extOf(mime);
    const file = path.join(dir, `${hash.slice(0, 16)}.${ext}`);
    ensureDir();
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
    } catch (err) {
      log?.warn?.(`图片缓存失败：${err.message}`);
    }
    return { id: hash.slice(0, 16), file, hash, ext };
  }

  /** 把一段字节存成文件，返回 { id, file, mime, bytes }。 */
  function storeImage(buffer, mime, { tags = [], note = '', from = 'chat', id } = {}) {
    const hash = sha256(buffer);
    const ext = extOf(mime);
    const file = path.join(dir, `${hash.slice(0, 16)}.${ext}`);
    ensureDir();
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
    } catch (err) {
      log?.warn?.(`图片存盘失败：${err.message}`);
    }
    const existing = items.find((i) => i.id === (id || hash.slice(0, 16)));
    if (existing) {
      for (const t of tags) if (!existing.tags.includes(t)) existing.tags.push(t);
      if (note) existing.note = note;
      save();
      return { ...existing, mime, bytes: buffer.length, hash };
    }
    const item = {
      id: id || hash.slice(0, 16),
      file,
      tags: tags.length > 0 ? tags : ['表情'],
      note,
      from,
      addedAt: Date.now(),
      uses: 0,
    };
    items.push(item);
    if (items.length > maxItems) {
      items.sort((a, b) => (a.uses ?? 0) - (b.uses ?? 0) || (a.addedAt ?? 0) - (b.addedAt ?? 0));
      items = items.slice(items.length - maxItems);
    }
    save();
    return { ...item, mime, bytes: buffer.length, hash };
  }

  /** 下载/读取一张图。ref 支持 http(s)、file://、本地路径、data:。 */
  async function fetchImage(ref, { limit = maxBytes } = {}) {
    const r = String(ref ?? '').trim();
    if (!r) throw new Error('图片地址是空的');
    if (r.startsWith('data:')) {
      const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(r);
      if (!m) throw new Error('看不懂这个 data URL');
      const mime = m[1] || 'image/jpeg';
      const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
      if (buf.length > limit) throw new Error(`图片太大（${buf.length} 字节）`);
      return { buffer: buf, mime };
    }
    if (r.startsWith('base64://')) {
      const buf = Buffer.from(r.slice('base64://'.length), 'base64');
      if (buf.length > limit) throw new Error(`图片太大（${buf.length} 字节）`);
      return { buffer: buf, mime: guessMime(r) };
    }
    if (r.startsWith('file://')) {
      const p = decodeURIComponent(r.slice('file://'.length)).replace(/^\/([A-Za-z]:)/, '$1');
      const buf = fs.readFileSync(p);
      if (buf.length > limit) throw new Error(`图片太大（${buf.length} 字节）`);
      return { buffer: buf, mime: guessMime(p) };
    }
    if (!/^https?:\/\//i.test(r)) {
      const p = expandHome(r);
      const buf = fs.readFileSync(p);
      if (buf.length > limit) throw new Error(`图片太大（${buf.length} 字节）`);
      return { buffer: buf, mime: guessMime(p) };
    }

    const { buffer, mime } = await withRetry(
      () =>
        httpGetBuffer(r, {
          timeoutMs,
          maxBytes: limit,
          headers: { 'user-agent': 'Mozilla/5.0 (qqbot)', accept: 'image/*' },
        }),
      { tries: 3, delayMs: 600 },
    );
    if (!mime.startsWith('image/')) throw new Error(`那个地址返回的不是图片（${mime}）`);
    return { buffer, mime };
  }

  function toDataUrl(buffer, mime) {
    return `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
  }

  /**
   * 收图：下载前几张，转 data URL（给模型看），顺手存一份到本地（方便 /存表情、也免得重复下载）。
   * 返回 [{dataUrl, mime, path, subType, summary, bytes}]
   */
  async function prepareIncoming(images = [], { inline = true } = {}) {
    if (!enabled || !Array.isArray(images) || images.length === 0) return [];
    const out = [];
    const picked = images.slice(0, Math.max(1, maxInlineImages));
    for (const img of picked) {
      const ref = img?.url || img?.file || '';
      try {
        const { buffer, mime } = await fetchImage(ref);
        const cached = cacheImage(buffer, mime);
        out.push({
          dataUrl: inline ? toDataUrl(buffer, mime) : '',
          mime,
          path: cached.file,
          buffer,
          sha: cached.id,
          bytes: buffer.length,
          subType: img?.subType ?? 0,
          summary: img?.summary || '',
        });
      } catch (err) {
        log?.warn?.(`这张图没取到（${String(ref).slice(0, 80)}）：${err.message}`);
        out.push({ dataUrl: '', mime: '', path: '', error: err.message, subType: img?.subType ?? 0 });
      }
    }
    return out;
  }

  // ---------- 图库 ----------

  function list() {
    return items.slice();
  }

  function findMany(query, n = 3) {
    // 第二个参数可以是数量，也可以是 { limit }（面板那边习惯传对象）
    const limit = Math.max(1, Number(typeof n === 'object' && n !== null ? (n.limit ?? 3) : n) || 3);
    const scored = items
      .map((item) => ({ item, score: scoreSticker(item, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.item.addedAt ?? 0) - (a.item.addedAt ?? 0));
    return scored.slice(0, limit).map((x) => ({ ...x.item, score: x.score }));
  }

  function find(query) {
    const q = String(query ?? '').trim();
    if (/^#\d+$/.test(q)) {
      const idx = Number(q.slice(1));
      return items[idx] ? { ...items[idx], score: 1 } : null;
    }
    if (!q) {
      // 没指定就用得最少的那张，避免老是同一张
      const sorted = items.slice().sort((a, b) => (a.uses ?? 0) - (b.uses ?? 0) || (b.addedAt ?? 0) - (a.addedAt ?? 0));
      return sorted[0] ? { ...sorted[0], score: 0.5 } : null;
    }
    const [best] = findMany(q, 1);
    return best && best.score >= 0.34 ? best : null;
  }

  function markUsed(item) {
    const found = items.find((i) => i.id === item.id);
    if (!found) return;
    found.uses = (found.uses ?? 0) + 1;
    found.lastUsed = Date.now();
    save();
  }

  function remove(idOrTag) {
    const key = String(idOrTag ?? '').trim();
    const before = items.length;
    items = items.filter((i) => i.id !== key && !i.tags.includes(key) && !(i.note ?? '').includes(key));
    save();
    return before - items.length;
  }

  /** 改一张图的标签/备注（控制面板用）。 */
  function update(id, patch = {}) {
    const item = items.find((i) => i.id === String(id ?? '').trim());
    if (!item) return null;
    if (patch.tags != null) {
      item.tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，\s]+/))
        .map((t) => String(t).trim())
        .filter(Boolean);
    }
    if (patch.note != null) item.note = String(patch.note).trim();
    save();
    return { ...item };
  }

  // ---------- 回复里的标记 ----------

  const MARKER_RE = /[[【]\s*(表情|表情包|图|图片|搜图|找图|搜表情|找表情)\s*[:：]\s*([^\]】\n]{1,300})\s*[\]】]/g;

  /**
   * 把回复里的 [表情:笑] / [图:https://…] / [搜图:摆烂] 抠出来。
   * 返回 { text: 去掉标记的正文, requests: [{kind:'sticker'|'image'|'search', value}] }
   */
  function parseReplyMarkers(text) {
    const src = String(text ?? '');
    const requests = [];
    const clean = src.replace(MARKER_RE, (_all, kind, value) => {
      const v = String(value).trim();
      if (!v) return '';
      if (/^(图|图片)$/.test(kind)) requests.push({ kind: 'image', value: v });
      else if (/^(搜图|找图|搜表情|找表情)$/.test(kind)) requests.push({ kind: 'search', value: v });
      else requests.push({ kind: 'sticker', value: v });
      return '';
    });
    return { text: clean.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), requests };
  }

  /** 把一个请求变成可以发出去的 OneBot 图片段（base64://，各实现都认）。 */
  async function toImageSegment(request) {
    if (request.kind === 'sticker') {
      const item = find(request.value);
      if (!item) return null;
      const { buffer, mime } = await fetchImage(item.file);
      markUsed(item);
      return { segment: { type: 'image', data: { file: `base64://${buffer.toString('base64')}` } }, mime, item };
    }
    const { buffer, mime } = await fetchImage(request.value);
    return { segment: { type: 'image', data: { file: `base64://${buffer.toString('base64')}` } }, mime, item: null };
  }

  /** 自动学：对方发来的表情（sub_type=1）收进图库。 */
  function learnFromIncoming(prepared = []) {
    if (!enabled || !autoLearn) return 0;
    let n = 0;
    for (const p of prepared) {
      if (!p || p.error || !p.path) continue;
      if (Number(p.subType) !== 1 && !p.summary) continue;
      const tags = ['表情'];
      if (p.summary) tags.push(p.summary);
      storeImage(fs.readFileSync(p.path), p.mime, {
        tags,
        note: p.summary || '',
        from: 'learned',
      });
      n += 1;
    }
    if (n > 0) log?.debug?.(`从聊天里学了 ${n} 张表情`);
    return n;
  }

  function stats() {
    const used = items.filter((i) => (i.uses ?? 0) > 0).length;
    return { items: items.length, used, dir, stickerDir, enabled, autoLearn };
  }

  load();

  return {
    enabled,
    dir,
    stickerDir: () => stickerDir,
    stats,
    fetchImage,
    toDataUrl,
    prepareIncoming,
    learnFromIncoming,
    storeImage,
    list,
    find,
    findMany,
    remove,
    update,
    markUsed,
    parseReplyMarkers,
    toImageSegment,
    flush,
    close() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      flush();
    },
  };
}

export const MEDIA_HELP_LINE = '图片：直接发图我能看懂；[表情:关键词] 让我发表情包，[搜图:关键词] 让我去网上找一张，[图:https://…] 让我发指定图片。';
export { DAY };
