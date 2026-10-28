#!/usr/bin/env node
/**
 * 抓取 / 检索 aigengtu.com 的表情包索引。
 *
 *   node tools/fetch-memes.js                  # 全量抓 41 页，写索引
 *   node tools/fetch-memes.js --pages 3        # 只抓前 3 页（试水）
 *   node tools/fetch-memes.js --search 生气     # 本地检索，不联网
 *   node tools/fetch-memes.js --search 摆烂 --limit 8
 */

import { loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';
import { createMemes } from '../src/memes.js';

function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const cfg = loadConfig();
const log = createLog({ level: process.env.QQBOT_LOG_LEVEL || 'warn', file: '', toStderr: true });
const memes = createMemes(cfg.media?.webSearch ?? {}, { log });

const search = argOf('search', null);
if (typeof search === 'string' || search === true) {
  memes.ensure({ blocking: false });
  const q = search === true ? '' : search;
  const limit = Number(argOf('limit', 8));
  const hits = memes.search(q, { limit });
  if (!hits.length) {
    console.log(`没搜到「${q}」。（索引 ${memes.stats().count} 条；先跑一次 node tools/fetch-memes.js 建索引）`);
    process.exitCode = 1;
  } else {
    console.log(`「${q}」命中 ${hits.length} 条：`);
    for (const h of hits) {
      console.log(`  #${h.id}  ${(h.score).toFixed(2)}  ${h.title}`);
      console.log(`         ${memes.imageUrl(h)}`);
    }
  }
} else {
  const pages = Number(argOf('pages', cfg.media?.webSearch?.pages ?? 41));
  console.log(`开始抓取 ${pages} 页目录…`);
  const res = await memes.build({ maxPages: pages });
  console.log(`索引完成：${res.count} 条 → ${memes.stats().indexFile}`);
}
