import fs from 'node:fs';
import path from 'node:path';
import { expandHome, dataPaths } from './config.js';

/** 旧版（数据散在 ~/.dsh）的默认位置。 */
export const LEGACY_DIR = '~/.dsh';

function copyFileIfNeeded(from, to, { force = false } = {}) {
  if (!fs.existsSync(from)) return { from, to, skipped: 'missing' };
  if (fs.existsSync(to) && !force) return { from, to, skipped: 'exists' };
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return { from, to, copied: true, bytes: fs.statSync(to).size };
}

function copyTree(from, to, { force = false } = {}) {
  const out = { files: 0, bytes: 0, skipped: 0 };
  if (!fs.existsSync(from)) return out;
  const walk = (src, dst) => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        walk(s, d);
        continue;
      }
      if (fs.existsSync(d) && !force) {
        out.skipped += 1;
        continue;
      }
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      out.files += 1;
      out.bytes += fs.statSync(d).size;
    }
  };
  walk(from, to);
  return out;
}

function countJsonlLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function countLongItems(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(data?.items) ? data.items.length : 0;
  } catch {
    return 0;
  }
}

/**
 * 表情库索引里的 file 是绝对路径，搬家后要改指向新目录，否则面板里全是裂图。
 */
function rewriteStickerPaths(indexFile, fromDir, toDir) {
  let raw;
  try {
    raw = fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return 0;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(data?.items)) return 0;
  const from = path.resolve(fromDir).toLowerCase();
  let changed = 0;
  for (const item of data.items) {
    if (!item?.file) continue;
    const abs = path.resolve(item.file);
    if (abs.toLowerCase().startsWith(from)) {
      const rel = path.relative(fromDir, abs);
      item.file = path.join(toDir, rel);
      changed += 1;
    } else if (fs.existsSync(item.file)) {
      // 指向项目里的 stickers/ 之类，原样拷一份进图库，保证单文件夹自足
      try {
        fs.mkdirSync(toDir, { recursive: true });
        const dest = path.join(toDir, path.basename(item.file));
        if (!fs.existsSync(dest)) fs.copyFileSync(item.file, dest);
        item.file = dest;
        changed += 1;
      } catch {
        /* 拷不动就保持原样 */
      }
    }
  }
  if (changed) {
    const tmp = `${indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: data.items }, null, 1));
    fs.renameSync(tmp, indexFile);
  }
  return changed;
}

/**
 * 把旧位置（默认 ~/.dsh）里的记忆库、表情库、索引、历史搬到项目的 data/ 目录。
 * 已经是新结构时什么都不做，可以反复跑。
 */
export function migrateData(cfg, { from = LEGACY_DIR, force = false, dryRun = false, log } = {}) {
  const fromDir = expandHome(from);
  const p = dataPaths(cfg);
  const report = { from: fromDir, root: p.root, dryRun, items: [] };

  const push = (name, res) => {
    report.items.push({ name, ...res });
    if (res.copied) log?.info?.(`${name}: ${res.from} -> ${res.to}`);
  };

  const jobs = [
    ['记忆归档', path.join(fromDir, 'qqbot-memory', 'archive.jsonl'), p.archive],
    ['长期记忆', path.join(fromDir, 'qqbot-memory', 'long.json'), p.long],
    ['网搜表情索引', path.join(fromDir, 'qqbot-memory', 'memes.json'), p.memes],
    ['会话历史', path.join(fromDir, 'qqbot-history.json'), p.history],
  ];

  if (dryRun) {
    for (const [name, src, dest] of jobs) {
      report.items.push({ name, from: src, to: dest, exists: fs.existsSync(src), targetExists: fs.existsSync(dest) });
    }
    const mediaSrc = path.join(fromDir, 'qqbot-memory', 'media');
    report.items.push({ name: '表情库图片', from: mediaSrc, to: p.media, exists: fs.existsSync(mediaSrc) });
    return report;
  }

  for (const [name, src, dest] of jobs) push(name, copyFileIfNeeded(src, dest, { force }));

  const mediaSrc = path.join(fromDir, 'qqbot-memory', 'media');
  const mediaRes = copyTree(mediaSrc, p.media, { force });
  report.items.push({ name: '表情库图片', ...mediaRes, from: mediaSrc, to: p.media });

  const rewrote = rewriteStickerPaths(p.stickers, mediaSrc, p.media);
  report.stickersRewritten = rewrote;

  // 项目自带的 stickers/ 目录也登记进图库（文件名即标签）
  report.archiveLines = countJsonlLines(p.archive);
  report.longItems = countLongItems(p.long);
  report.stickerItems = countLongItems(p.stickers);
  report.memesCount = countLongItems(p.memes);
  return report;
}

/** 旧数据还在不在（面板用它决定要不要提示"导入"）。 */
export function legacyAvailable(from = LEGACY_DIR) {
  const dir = expandHome(from);
  const candidates = [
    path.join(dir, 'qqbot-memory', 'archive.jsonl'),
    path.join(dir, 'qqbot-memory', 'long.json'),
    path.join(dir, 'qqbot-memory', 'media'),
    path.join(dir, 'qqbot-history.json'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}
