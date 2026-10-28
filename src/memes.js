/**
 * 联网找表情包：梗鲸（aigengtu.com）的蓝色大肥鱼档案馆。
 *
 * 站点没有可用的检索接口（/search 404、/api/memes 401、?q= 是前端过滤），
 * 但目录页 /archive?p=N 上有整整 2450 张图的「编号 + 角色 + 台词 + 情绪」标题。
 * 所以这里的做法是：把 41 页目录爬成一个本地索引（几百 KB），
 * 之后搜表情包全在本地做分词打分，只有真正要发的时候才去下载那一张原图。
 *
 * 好处：平时零网络开销、搜索瞬时；对站点也客气（建索引 41 个请求，之后基本不打扰）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { expandHome } from './config.js';
import { tokenize } from './media.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DAY = 24 * 60 * 60 * 1000;

/** 用户嘴上说的词 → 站里标题可能用的词。命中这些同义词，搜索才不"听不懂人话"。 */
const SYNONYMS = {
  生气: ['气鼓鼓', '暴怒', '生气', '火大', '怒', '哼'],
  愤怒: ['暴怒', '气鼓鼓', '怒'],
  火大: ['暴怒', '气鼓鼓', '生气'],
  无语: ['无语', '沉默', '翻白眼', '无奈'],
  无奈: ['无奈', '无语', '叹气'],
  开心: ['开心', '笑', '哈哈', '高兴', '乐'],
  高兴: ['开心', '高兴', '笑'],
  笑: ['笑', '哈哈', '开心', '乐'],
  哭: ['哭', '委屈落泪', '眼泪', '泪'],
  委屈: ['委屈', '委屈落泪', '可怜'],
  害羞: ['害羞', '脸红', '羞'],
  疑惑: ['疑惑不解', '疑惑', '问号', '懵'],
  懵: ['懵', '疑惑不解', '呆'],
  震惊: ['震惊', '惊', '瞪'],
  累: ['疲惫', '累', '躺', '瘫'],
  摆烂: ['摆烂', '躺平', '瘫', '累'],
  可爱: ['可爱', '萌', '卖萌'],
  撒娇: ['撒娇', '可爱', '抱抱'],
  抱抱: ['抱抱', '拥抱', '贴贴'],
  鄙视: ['鄙视', '嫌弃', '白眼'],
  嫌弃: ['嫌弃', '鄙视', '嫌弃脸'],
  得意: ['得意', '骄傲', '嚣张'],
  哭唧唧: ['委屈落泪', '哭'],
  无语凝噎: ['无语', '沉默'],
};

function trimTitle(title) {
  return String(title ?? '').replace(/^#\d+\s*/, '').replace(/\s+/g, ' ').trim();
}

/**
 * 从「DeepSeek娘『真当我是便宜货啊』气鼓鼓表情包」里拆出角色、台词、情绪。
 * 目录页的卡片自带分类（DeepSeek娘 / DeepSeek鲸娘 …），有 hint 时最准：
 * 把分类前缀剥掉，剩下紧挨着"表情包"的那一小段就是情绪。
 */
export function splitTitle(raw, catHint = '') {
  const title = trimTitle(raw);
  const quote = /『([^』]+)』/.exec(title)?.[1] ?? '';
  const rest = (quote ? title.replace(/『[^』]*』/, '') : title).replace(/表情包$/, '').trim();
  const cat = String(catHint || '').trim();
  let emotion = '';
  let guessCat = rest;
  if (cat && rest.startsWith(cat)) {
    emotion = rest.slice(cat.length).trim();
    guessCat = cat;
  } else {
    // 没有分类提示：把开头的英文/数字部分当角色名，剩下的当情绪
    const m = /^([A-Za-z][A-Za-z0-9 ]*)?([\u4e00-\u9fff]{1,8}(?:娘|女仆娘))?([\s\S]*)$/.exec(rest);
    guessCat = `${m?.[1] ?? ''}${m?.[2] ?? ''}`.trim() || rest;
    emotion = (m?.[3] ?? '').trim();
  }
  return { title, quote, emotion, cat: guessCat };
}

/** 解析一页目录 HTML，拿到 [{id,title,cat,quote,emotion}]。 */
export function parseArchivePage(html) {
  const items = [];
  // 卡片结构：<a class="ar-thumblink" href="/zh/meme/001" title="…"><img …></a> …
  // <i class="ar-cat">DeepSeek娘</i> … </div>  —— 分类在卡片后半段，所以要一直吃到 </div>
  const re = /<a class="ar-thumblink" href="\/zh\/meme\/(\d+)" title="([^"]*)">([\s\S]*?)<\/div>/g;
  for (const m of String(html ?? '').matchAll(re)) {
    const id = m[1];
    const rawTitle = m[2];
    const cat = /<i class="ar-cat">([^<]*)<\/i>/.exec(m[3])?.[1] ?? '';
    const info = splitTitle(rawTitle, cat);
    items.push({
      id,
      title: info.title,
      cat: cat || info.cat,
      quote: info.quote,
      emotion: info.emotion,
    });
  }
  // 有些页面结构变了会拿不到 ar-cat，退化成只认 alt
  if (items.length === 0) {
    for (const m of String(html ?? '').matchAll(/alt="(#(\d{3,4})[^"]*)"/g)) {
      const info = splitTitle(m[1]);
      items.push({ id: m[2], title: info.title, cat: info.cat, quote: info.quote, emotion: info.emotion });
    }
  }
  const stats = /馆藏\s*(\d+)\s*枚[\s\S]*?第\s*(\d+)\/(\d+)\s*页/.exec(String(html ?? ''));
  return {
    items,
    total: stats ? Number(stats[1]) : null,
    page: stats ? Number(stats[2]) : null,
    pages: stats ? Number(stats[3]) : null,
  };
}

/** 一个条目的搜索用文本。 */
function haystack(item) {
  return [item.title, item.cat, item.quote, item.emotion, ...(item.tags ?? [])].filter(Boolean).join(' ');
}

/** 相关度打分：原词出现在标题里最高，其次是同义词命中与分词重叠。 */
export function scoreItem(item, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 0.3;
  const hay = haystack(item).toLowerCase();
  if (hay.includes(q)) return 1;
  let best = 0;
  for (const [key, words] of Object.entries(SYNONYMS)) {
    if (!q.includes(key)) continue;
    if (words.some((w) => hay.includes(w.toLowerCase()))) best = Math.max(best, 0.8);
  }
  const qt = tokenize(q);
  if (qt.size === 0) return best;
  const it = tokenize(hay);
  let hit = 0;
  for (const t of qt) if (it.has(t)) hit += 1;
  const overlap = hit === 0 ? 0 : 0.35 + 0.45 * Math.min(1, hit / Math.min(qt.size, 4));
  return Math.max(best, overlap);
}

export function createMemes(cfg = {}, { log } = {}) {
  const enabled = cfg.enabled !== false;
  const baseUrl = String(cfg.baseUrl || 'https://aigengtu.com').replace(/\/+$/, '');
  const imgBase = String(cfg.imgBase || 'https://img.aigengtu.com').replace(/\/+$/, '');
  const indexFile = expandHome(cfg.indexFile || '~/.dsh/qqbot-memory/memes.json');
  const pages = Math.max(1, Number(cfg.pages ?? 41));
  const maxAgeDays = Math.max(0, Number(cfg.maxAgeDays ?? 30));
  const timeoutMs = Math.max(2000, Number(cfg.timeoutMs ?? 20000));

  let items = [];
  let loaded = false;
  let builtAt = 0;
  let building = null;

  function load() {
    if (loaded) return items;
    loaded = true;
    try {
      const raw = fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      items = Array.isArray(data.items) ? data.items : [];
      builtAt = Number(data.builtAt || 0);
    } catch (err) {
      if (err.code !== 'ENOENT') log?.warn?.(`表情索引读不出来（${indexFile}）：${err.message}`);
      items = [];
    }
    return items;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(indexFile), { recursive: true });
      const tmp = `${indexFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, source: 'aigengtu', builtAt, count: items.length, items }));
      fs.renameSync(tmp, indexFile);
      return true;
    } catch (err) {
      log?.warn?.(`表情索引存不下来（${indexFile}）：${err.message}`);
      return false;
    }
  }

  async function fetchText(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        signal: ac.signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 从站点爬全量目录，写成索引文件。41 页、约 2450 条。 */
  async function build({ maxPages = pages } = {}) {
    const started = Date.now();
    const out = [];
    const seen = new Set();
    let lastPage = maxPages;
    for (let p = 1; p <= maxPages; p += 1) {
      let page;
      try {
        page = parseArchivePage(await fetchText(`${baseUrl}/archive?p=${p}`));
      } catch (err) {
        log?.warn?.(`拉目录第 ${p} 页失败：${err.message}`);
        if (p === 1) throw err;
        break;
      }
      if (page.pages) lastPage = Math.min(maxPages, page.pages);
      for (const it of page.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
      if (page.items.length === 0) break;
      if (p < lastPage) await new Promise((r) => setTimeout(r, 120));
    }
    items = out.sort((a, b) => Number(a.id) - Number(b.id));
    builtAt = Date.now();
    loaded = true;
    save();
    log?.info?.(`表情索引已更新：${items.length} 条（用时 ${Math.round((Date.now() - started) / 1000)}s）`);
    return { count: items.length, pages: lastPage };
  }

  /** 索引没有 / 太旧就重建；有就立刻返回，重建在后台悄悄做。 */
  async function ensure({ rebuild = false, blocking = false } = {}) {
    load();
    const stale = !items.length || (maxAgeDays > 0 && Date.now() - builtAt > maxAgeDays * DAY);
    if (!rebuild && !stale) return { count: items.length, rebuilt: false };
    if (blocking || !items.length) return { ...(await build()), rebuilt: true };
    if (!building) {
      building = build().catch((err) => log?.warn?.(`表情索引后台更新失败：${err.message}`)).finally(() => { building = null; });
    }
    return { count: items.length, rebuilt: false, background: true };
  }

  /** 本地检索。返回按相关度排序的条目（含 score），只给过线的。 */
  function search(query, { limit = 6, min = 0.34 } = {}) {
    load();
    const q = String(query ?? '').trim();
    if (!items.length) return [];
    if (!q) return items.slice(0, limit).map((item) => ({ ...item, score: 0.3 }));
    const scored = [];
    for (const item of items) {
      const score = scoreItem(item, q);
      if (score >= min) scored.push({ ...item, score });
    }
    scored.sort((a, b) => b.score - a.score || Number(a.id) - Number(b.id));
    return scored.slice(0, limit);
  }

  /** 原图地址：目录页只给预览，原图在 img.aigengtu.com/meme/<id>.webp。 */
  function imageUrl(item) {
    const id = typeof item === 'string' ? item : item?.id;
    return `${imgBase}/meme/${id}.webp`;
  }

  function previewUrl(item) {
    const id = typeof item === 'string' ? item : item?.id;
    return `${imgBase}/0_preview/meme/${id}.webp`;
  }

  function pageUrl(item) {
    const id = typeof item === 'string' ? item : item?.id;
    return `${baseUrl}/zh/meme/${id}`;
  }

  function stats() {
    load();
    return { enabled, count: items.length, builtAt, indexFile, ageDays: builtAt ? (Date.now() - builtAt) / DAY : null };
  }

  function tagsOf(item) {
    return [...new Set([item.emotion, item.cat, item.quote, ...(item.tags ?? [])].filter(Boolean))];
  }

  return {
    enabled,
    build,
    ensure,
    search,
    imageUrl,
    previewUrl,
    pageUrl,
    stats,
    tagsOf,
    get items() {
      load();
      return items;
    },
  };
}
