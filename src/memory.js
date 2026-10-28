/**
 * 记忆库：短期记忆（近 N 天的对话原文）+ 长期记忆（值得记住的条目 + 每天的小结）。
 *
 * 设计目标：
 *  1. 每次对话之前，先把"短期记忆"（最近两周聊过什么）整理成一段文字交给模型 —— 这样即使
 *     会话被 /reset、或者隔了好几天，它也知道你们之前聊到哪儿了。
 *  2. 长期记忆是一个可检索的条目库：命中的条目会一起交给模型；用户说"还记得吗"时，
 *     还会额外去翻更早的记录（归档里全文检索）。
 *  3. 全部是本地文件，零依赖，可以直接用记事本看、用 grep 搜、备份就复制一个目录。
 *
 * 目录结构（默认 ~/.dsh/qqbot-memory/）：
 *   archive.jsonl  一行一条消息，永远不删（这就是"可以遍历的以前聊天记录"）
 *   long.json      长期记忆条目（{id,t,cid,kind,text,tags,weight}）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { expandHome } from './config.js';

const DAY = 24 * 60 * 60 * 1000;

/** 用户这句话是不是在"考它记不记得"。命中时会额外翻旧账。 */
const RECALL_RE = /(记得|还记得|记不记得|之前|上次|以前|那次|曾经|回忆|想起来|聊过|说过|提过|忘了没)/;

/** 中文按二元/三元组切，英文数字按单词切，用来算相关度。 */
const SEPARATOR_RE = /[\s\u3000-\u303f\uff00-\uffef!-/:-@[-`{-~]+/;

export function tokenize(text) {
  const out = new Set();
  const s = String(text ?? '').toLowerCase();
  if (!s) return out;
  for (const w of s.split(SEPARATOR_RE)) {
    if (w.length >= 2 && /[a-z0-9]/.test(w)) out.add(w);
  }
  for (const seg of s.replace(/[^\u4e00-\u9fff]+/g, ' ').trim().split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
    if (seg.length >= 3) {
      for (let i = 0; i + 2 < seg.length; i += 1) out.add(seg.slice(i, i + 3));
    }
  }
  return out;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function dateKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function clockLabel(t) {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayLabel(t) {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 消息正文压成一行，避免把换行塞进记忆块。 */
export function oneLine(text, max = 220) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function who(role) {
  return role === 'assistant' ? '我' : '对方';
}

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

/**
 * 创建记忆库。
 * @param {object} cfg memory 配置块
 */
export function createMemory(cfg = {}, { log } = {}) {
  const enabled = cfg.enabled !== false;
  const dir = expandHome(cfg.dir || '~/.dsh/qqbot-memory');
  const shortDays = Number(cfg.shortDays ?? 14);
  const shortMaxChars = Number(cfg.shortMaxChars ?? 1800);
  const shortLimit = Number(cfg.shortLimit ?? 600);
  const longMaxItems = Number(cfg.longMaxItems ?? 5000);
  const recallLimit = Number(cfg.recallLimit ?? 6);
  const autoDigest = cfg.autoDigest !== false;

  const archiveFile = path.join(dir, 'archive.jsonl');
  const longFile = path.join(dir, 'long.json');

  /** @type {{t:number,cid:string,role:string,text:string}[]} */
  const messages = [];
  /** @type {{id:string,t:number,cid:string,kind:string,text:string,tags:string[],weight:number}[]} */
  let longItems = [];

  let pending = [];
  let flushTimer = null;
  let longTimer = null;
  let lastDigestAt = 0;
  let broken = false;

  function warnOnce(err) {
    if (broken) return;
    broken = true;
    log?.warn(`记忆库写入失败（${dir}）：${err?.message || err}。本轮记忆只在内存里，重启会丢。`);
  }

  // ---------- 载入 ----------

  function load() {
    if (!enabled) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(archiveFile)) {
        const raw = fs.readFileSync(archiveFile, 'utf8');
        const lines = raw.split('\n');
        // 文件特别大时只读尾部，避免启动卡住
        const keep = lines.length > 200000 ? lines.slice(-200000) : lines;
        for (const line of keep) {
          const s = line.trim();
          if (!s) continue;
          try {
            const m = JSON.parse(s);
            if (m && typeof m.t === 'number' && m.cid && m.text) messages.push(m);
          } catch {
            /* 坏行跳过 */
          }
        }
      }
      const saved = readJson(longFile);
      if (saved && Array.isArray(saved.items)) longItems = saved.items;
    } catch (err) {
      warnOnce(err);
    }
    log?.debug?.(`记忆库：${messages.length} 条历史消息，${longItems.length} 条长期记忆`);
  }

  // ---------- 落盘 ----------

  function flush() {
    if (pending.length === 0) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const chunk = pending.join('\n');
    pending = [];
    try {
      fs.appendFileSync(archiveFile, `${chunk}\n`);
    } catch (err) {
      warnOnce(err);
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, 300);
    flushTimer.unref?.();
  }

  function saveLong() {
    if (longTimer) clearTimeout(longTimer);
    longTimer = setTimeout(() => {
      longTimer = null;
      if (longItems.length > longMaxItems) {
        longItems = [...longItems]
          .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1) || b.t - a.t)
          .slice(0, longMaxItems);
      }
      try {
        writeFileAtomic(longFile, JSON.stringify({ version: 1, items: longItems }, null, 1));
      } catch (err) {
        warnOnce(err);
      }
    }, 300);
    longTimer.unref?.();
  }

  // ---------- 写入 ----------

  function record(cid, role, text, { t = Date.now() } = {}) {
    if (!enabled) return null;
    const body = String(text ?? '').trim();
    if (!cid || !body || (role !== 'user' && role !== 'assistant')) return null;
    const msg = { t, cid: String(cid), role, text: body };
    messages.push(msg);
    pending.push(JSON.stringify(msg));
    scheduleFlush();
    return msg;
  }

  // ---------- 检索 ----------

  /** 归档里是否已经有这条（导入旧记录时用来去重）。 */
  function has(cid, role, text) {
    const body = String(text ?? '').trim();
    if (!body) return false;
    return messages.some((m) => m.cid === cid && m.role === role && m.text === body);
  }

  function shortTerm(cid, { now = Date.now(), days = shortDays, skip = 0, limit = shortLimit, maxChars = shortMaxChars } = {}) {
    if (!enabled) return { lines: [], items: [], count: 0, chars: 0 };
    const since = now - days * DAY;
    const pool = messages.filter((m) => m.cid === cid && m.t >= since);
    const count = pool.length;
    const usable = skip > 0 ? pool.slice(0, Math.max(0, pool.length - skip)) : pool;
    const picked = usable.slice(-limit);
    const lines = [];
    const items = [];
    let chars = 0;
    for (let i = picked.length - 1; i >= 0; i -= 1) {
      const line = `[${clockLabel(picked[i].t)}] ${who(picked[i].role)}：${oneLine(picked[i].text, 180)}`;
      if (chars + line.length > maxChars && lines.length > 0) break;
      lines.unshift(line);
      items.unshift(picked[i]);
      chars += line.length + 1;
    }
    return { lines, items, count, chars };
  }

  function score(text, queryTokens) {
    const docTokens = tokenize(text);
    if (docTokens.size === 0 || queryTokens.size === 0) return 0;
    let hit = 0;
    for (const q of queryTokens) if (docTokens.has(q)) hit += 1;
    if (hit === 0) return 0;
    // 分母按"最多看 6 个关键词"算：一句话里带几个关键词就算命中，不会因为句子长而永远低分
    const denom = Math.min(queryTokens.size, 6);
    const coverage = Math.min(1, hit / denom);
    const strength = Math.min(1, hit / 3);
    return 0.75 * coverage + 0.25 * strength;
  }

  /** 在归档里按关键词找以前的对话。 */
  function searchMessages(query, { cid, now = Date.now(), limit = recallLimit, days = 0, excludeLast = 0 } = {}) {
    if (!enabled) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];
    const since = days > 0 ? now - days * DAY : 0;
    const pool = messages.filter((m) => (cid ? m.cid === cid : true) && m.t >= since);
    const usable = excludeLast > 0 ? pool.slice(0, Math.max(0, pool.length - excludeLast)) : pool;
    const scored = [];
    for (const m of usable) {
      const base = score(m.text, queryTokens);
      if (base <= 0) continue;
      // 越近越有用：一个月内几乎不衰减，之后慢慢降
      const ageDays = (now - m.t) / DAY;
      const recency = 1 / (1 + Math.max(0, ageDays - 30) / 90);
      scored.push({ ...m, score: base * (0.6 + 0.4 * recency) });
    }
    scored.sort((a, b) => b.score - a.score || b.t - a.t);
    return scored.slice(0, limit);
  }

  /** 在长期记忆条目里检索。 */
  function searchLong(query, { cid, limit = recallLimit, now = Date.now() } = {}) {
    if (!enabled || longItems.length === 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return [];
    const scored = [];
    for (const item of longItems) {
      if (item.cid && cid && item.cid !== cid) continue;
      const hay = `${item.text} ${(item.tags || []).join(' ')}`;
      const base = score(hay, queryTokens);
      if (base <= 0) continue;
      const ageDays = (now - item.t) / DAY;
      const recency = 1 / (1 + Math.max(0, ageDays - 30) / 120);
      scored.push({ ...item, score: base * (0.7 + 0.3 * recency) * (0.8 + 0.2 * (item.weight ?? 1)) });
    }
    scored.sort((a, b) => b.score - a.score || b.t - a.t);
    return scored.slice(0, limit);
  }

  // ---------- 长期记忆条目 ----------

  function newId(text) {
    return crypto.createHash('sha1').update(String(text).trim()).digest('hex').slice(0, 10);
  }

  function remember({ text, cid = '', kind = 'note', tags = [], weight = 1, t = Date.now(), id = '' } = {}) {
    if (!enabled) return null;
    const body = String(text ?? '').trim();
    if (!body) return null;
    const key = id || newId(`${cid}|${body}`);
    const exist = longItems.find((it) => it.id === key);
    if (exist) {
      exist.t = t;
      exist.text = body;
      exist.weight = Math.max(exist.weight ?? 1, weight);
      saveLong();
      return exist;
    }
    const item = { id: key, t, cid: String(cid || ''), kind, text: body, tags: tags.map(String), weight };
    longItems.push(item);
    saveLong();
    return item;
  }

  function forget(idOrText) {
    if (!enabled) return false;
    const key = String(idOrText ?? '').trim();
    if (!key) return false;
    const before = longItems.length;
    const byId = longItems.findIndex((it) => it.id === key);
    if (byId >= 0) longItems.splice(byId, 1);
    else longItems = longItems.filter((it) => !it.text.includes(key) && !(it.tags || []).includes(key));
    if (longItems.length !== before) {
      saveLong();
      return true;
    }
    return false;
  }

  /** 长期记忆列表（新的在前），给控制面板用。 */
  function listLong({ limit = 200, cid = '', q = '' } = {}) {
    if (!enabled) return [];
    let rows = longItems;
    if (cid) rows = rows.filter((it) => !it.cid || it.cid === cid);
    const kw = String(q ?? '').trim().toLowerCase();
    if (kw) {
      rows = rows.filter(
        (it) => it.text.toLowerCase().includes(kw) || (it.tags || []).some((t) => String(t).toLowerCase().includes(kw)),
      );
    }
    return [...rows].sort((a, b) => b.t - a.t).slice(0, limit);
  }

  /** 改一条长期记忆（文本/标签/权重/分类）。 */
  function updateLong(id, patch = {}) {
    if (!enabled) return null;
    const item = longItems.find((it) => it.id === id);
    if (!item) return null;
    if (patch.text != null && String(patch.text).trim()) item.text = String(patch.text).trim();
    if (patch.tags != null) item.tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，\s]+/)).map(String).filter(Boolean);
    if (patch.kind != null && String(patch.kind).trim()) item.kind = String(patch.kind).trim();
    if (patch.weight != null && Number.isFinite(Number(patch.weight))) item.weight = Number(patch.weight);
    saveLong();
    return item;
  }

  /** 归档里最近的消息（新的在前），可按会话/关键词过滤，给控制面板用。 */
  function recentMessages({ cid = '', q = '', limit = 100 } = {}) {
    if (!enabled) return [];
    let rows = messages;
    if (cid) rows = rows.filter((m) => m.cid === cid);
    const kw = String(q ?? '').trim().toLowerCase();
    if (kw) rows = rows.filter((m) => m.text.toLowerCase().includes(kw));
    return rows.slice(-Math.max(1, limit)).reverse().map((m) => ({ ...m }));
  }

  /** 删掉归档里的一条消息（按 t + cid + role + text 定位），会重写 archive.jsonl。 */
  function deleteMessage({ t, cid, role, text }) {
    if (!enabled) return false;
    const i = messages.findIndex((m) => m.t === t && m.cid === cid && m.role === role && m.text === text);
    if (i < 0) return false;
    messages.splice(i, 1);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const body = messages.map((m) => JSON.stringify(m)).join('\n');
      writeFileAtomic(archiveFile, body ? `${body}\n` : '');
      return true;
    } catch (err) {
      warnOnce(err);
      return false;
    }
  }

  // ---------- 每天小结（长期记忆自动生长） ----------

  function digestDay(cid, dayKeyStr, { now = Date.now() } = {}) {
    const rows = messages.filter((m) => m.cid === cid && dateKey(m.t) === dayKeyStr);
    if (rows.length < 2) return null;
    const id = `day:${cid}:${dayKeyStr}`;
    if (longItems.some((it) => it.id === id)) return null;
    const texts = rows
      .filter((m) => m.role === 'user')
      .map((m) => oneLine(m.text, 60))
      .filter(Boolean);
    const sample = (texts.length ? texts : rows.map((m) => oneLine(m.text, 60))).slice(0, 12).join(' / ');
    return remember({
      id,
      cid,
      kind: 'day',
      t: rows[rows.length - 1].t,
      weight: 0.6,
      text: `${dayKeyStr} 这天聊了 ${rows.length} 句：${sample}`,
      tags: ['日记'],
    });
  }

  /** 把昨天（以及更早没做过的）逐日做成长期记忆。每小时最多跑一次。 */
  function runDailyDigest({ now = Date.now(), days = 3 } = {}) {
    if (!enabled || !autoDigest) return 0;
    if (now - lastDigestAt < 60 * 60 * 1000) return 0;
    lastDigestAt = now;
    const cids = new Set(messages.filter((m) => now - m.t < (days + 1) * DAY).map((m) => m.cid));
    let made = 0;
    for (const cid of cids) {
      for (let i = 1; i <= days; i += 1) {
        const day = dateKey(now - i * DAY);
        if (digestDay(cid, day, { now })) made += 1;
      }
    }
    return made;
  }

  // ---------- 组装注入文本 ----------

  const USAGE_HINT = '用法：这些是背景资料，自然地用在回答里即可；不要逐条复述，也不要动不动就说“根据记忆记录”。除非对方明确问你还记不记得。';

  function context({ cid, text = '', now = Date.now(), skip = 0 } = {}) {
    if (!enabled) return { block: '', shortCount: 0, longHits: 0, recallHits: 0 };

    runDailyDigest({ now });

    const recent = shortTerm(cid, { now, skip });
    const wantsRecall = RECALL_RE.test(String(text));
    // 短期记忆里已经出现过的原话，就不再在"翻旧账"里重复一遍
    const seen = new Set(recent.items.map((m) => `${m.role}|${m.text}`));
    // 平时只吃"高相关"的长期记忆；被问"记不记得"时放宽，并去归档里翻旧账
    const longHits = searchLong(text, { cid, now, limit: recallLimit }).filter((h) => h.score >= (wantsRecall ? 0.12 : 0.3));
    const recallHits = wantsRecall
      ? searchMessages(text, { cid, now, limit: recallLimit * 2, excludeLast: skip })
          .filter((h) => h.score >= 0.12 && !seen.has(`${h.role}|${h.text}`))
          .slice(0, recallLimit)
      : [];

    const sections = [];

    if (recent.lines.length > 0) {
      sections.push(`最近 ${shortDays} 天你们聊过的（共 ${recent.count} 条，较新的在后面）：\n${recent.lines.join('\n')}`);
    }

    if (longHits.length > 0) {
      const lines = longHits.map((h) => `- [${dayLabel(h.t)}] ${oneLine(h.text, 200)}`);
      sections.push(`相关旧记忆：\n${lines.join('\n')}`);
    }

    if (recallHits.length > 0) {
      const lines = recallHits.map((h) => `- [${clockLabel(h.t)}] ${who(h.role)}：${oneLine(h.text, 160)}`);
      sections.push(`翻到的更早的原话：\n${lines.join('\n')}`);
    }

    if (sections.length === 0) return { block: '', shortCount: 0, longHits: 0, recallHits: 0 };

    const block = `【记忆档案｜这是你自己的记忆，不是对方此刻说的话】\n${sections.join('\n\n')}\n${USAGE_HINT}`;
    return { block, shortCount: recent.lines.length, longHits: longHits.length, recallHits: recallHits.length };
  }

  // ---------- 管理 ----------

  function stats() {
    const byCid = new Map();
    for (const m of messages) byCid.set(m.cid, (byCid.get(m.cid) ?? 0) + 1);
    const times = messages.map((m) => m.t);
    return {
      enabled,
      dir,
      messages: messages.length,
      conversations: byCid.size,
      longItems: longItems.length,
      oldest: times.length ? Math.min(...times) : 0,
      newest: times.length ? Math.max(...times) : 0,
      shortDays,
    };
  }

  /** 按天列出某个会话的历史，供"回忆"用。 */
  function timeline(cid, { days = 7, now = Date.now(), maxChars = 1500 } = {}) {
    const since = now - days * DAY;
    const rows = messages.filter((m) => m.cid === cid && m.t >= since);
    const byDay = new Map();
    for (const m of rows) {
      const k = dateKey(m.t);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(m);
    }
    const out = [];
    let chars = 0;
    for (const [k, list] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const line = `${k}（${list.length} 条）：${list.slice(0, 6).map((m) => `${who(m.role)}「${oneLine(m.text, 40)}」`).join(' ')}`;
      if (chars + line.length > maxChars && out.length > 0) break;
      out.push(line);
      chars += line.length + 1;
    }
    return out;
  }

  function close() {
    flush();
    if (longTimer) {
      clearTimeout(longTimer);
      longTimer = null;
      try {
        writeFileAtomic(longFile, JSON.stringify({ version: 1, items: longItems }, null, 1));
      } catch {
        /* 退出时写不进去就算了 */
      }
    }
  }

  load();

  return {
    enabled,
    dir,
    record,
    has,
    shortTerm,
    searchMessages,
    searchLong,
    remember,
    forget,
    listLong,
    updateLong,
    recentMessages,
    deleteMessage,
    digestDay,
    runDailyDigest,
    context,
    timeline,
    stats,
    flush,
    close,
  };
}
