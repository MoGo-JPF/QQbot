import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createMemes,
  parseArchivePage,
  scoreItem,
  splitTitle,
} from '../src/memes.js';

const CARD = (id, title, cat) =>
  `<div class="ar-card"><span class="ar-thumbwrap"><a class="ar-thumblink" href="/zh/meme/${id}" title="${title}">` +
  `<img class="ar-thumb" src="https://img.aigengtu.com/0_preview/meme/${id}.webp" alt="#${id} ${title}"></a></span>` +
  `<span class="ar-txt"><span class="ar-num">#${id}<i class="ar-cat">${cat}</i></span>` +
  `<a class="ar-alt" href="/zh/meme/${id}">${title}</a></span></div>`;

const PAGE = (page, items) =>
  `<p id="ar-stats">馆藏 2450 枚 · 差分 10 组 · 第 ${page}/41 页 · 更新于 2026-10-27</p><div id="ar-grid">${items.join('')}</div>`;

function silentLog() {
  const noop = () => {};
  return { error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

function tmpIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-memes-'));
  return path.join(dir, 'memes.json');
}

test('拆标题：角色、台词、情绪都拆得出来', () => {
  const info = splitTitle('#001 DeepSeek娘『真当我是便宜货啊』气鼓鼓表情包', 'DeepSeek娘');
  assert.equal(info.quote, '真当我是便宜货啊');
  assert.equal(info.emotion, '气鼓鼓');
  assert.equal(info.cat, 'DeepSeek娘');

  const two = splitTitle('DeepSeek鲸娘『晚安』表情包', 'DeepSeek鲸娘');
  assert.equal(two.emotion, '');
  assert.equal(two.quote, '晚安');

  // 没有分类提示时也不能崩，情绪会退化成"角色名后面的那一段"
  const three = splitTitle('DeepSeek娘『哦鲸鲸…』呆滞无语表情包');
  assert.equal(three.quote, '哦鲸鲸…');
  assert.ok(three.title.startsWith('DeepSeek'));
});

test('解析目录页：拿到 id、标题、分类', () => {
  const html = PAGE(1, [
    CARD('001', 'DeepSeek娘『真当我是便宜货啊』气鼓鼓表情包', 'DeepSeek娘'),
    CARD('002', 'DeepSeek『又错了，我再换另一种方法』委屈落泪表情包', 'DeepSeek'),
  ]);
  const page = parseArchivePage(html);
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 2450);
  assert.equal(page.pages, 41);
  assert.equal(page.items[0].id, '001');
  assert.equal(page.items[0].emotion, '气鼓鼓');
  assert.equal(page.items[1].cat, 'DeepSeek');
  assert.equal(parseArchivePage('').items.length, 0);
});

test('打分：原词 > 同义词 > 无关', () => {
  const item = { id: '001', title: '气鼓鼓表情包', cat: 'DeepSeek娘', quote: '', emotion: '气鼓鼓', tags: [] };
  assert.equal(scoreItem(item, '气鼓鼓'), 1);
  assert.ok(scoreItem(item, '生气') >= 0.7, '同义词"生气"应该能命中气鼓鼓');
  assert.ok(scoreItem(item, '完全无关的词汇啊') < 0.34);
});

test('建索引会把目录页抓下来并存成文件', async () => {
  const indexFile = tmpIndex();
  const memes = createMemes({ indexFile, pages: 2, timeoutMs: 4000 }, { log: silentLog() });
  const page1 = PAGE(1, [CARD('001', 'DeepSeek娘『哈』开心表情包', 'DeepSeek娘')]);
  const page2 = PAGE(2, [CARD('002', 'DeepSeek娘『哼』生气表情包', 'DeepSeek娘')]);
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = String(url).includes('p=2') ? page2 : page1;
    return { ok: true, status: 200, text: async () => body };
  };
  try {
    const res = await memes.build({ maxPages: 2 });
    assert.equal(res.count, 2);
    assert.equal(urls.length, 2);
    const saved = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    assert.equal(saved.items.length, 2);
    assert.equal(saved.builtAt > 0, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('已经有索引就本地搜，不再联网', async () => {
  const indexFile = tmpIndex();
  fs.writeFileSync(
    indexFile,
    JSON.stringify({
      version: 1,
      builtAt: Date.now(),
      items: [
        { id: '001', title: '气鼓鼓表情包', cat: 'DeepSeek娘', quote: '', emotion: '气鼓鼓', tags: [] },
        { id: '002', title: '晚安表情包', cat: 'DeepSeek娘', quote: '晚安', emotion: '', tags: [] },
      ],
    }),
  );
  const memes = createMemes({ indexFile }, { log: silentLog() });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('不该联网');
  };
  try {
    const res = await memes.ensure();
    assert.equal(res.count, 2);
    const hits = memes.search('生气');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, '001');
    assert.equal(memes.search('压根不存在的词').length, 0);
    assert.equal(memes.stats().count, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('原图 / 预览 / 详情页地址拼得对', () => {
  const memes = createMemes({ indexFile: tmpIndex() }, { log: silentLog() });
  assert.equal(memes.imageUrl('001'), 'https://img.aigengtu.com/meme/001.webp');
  assert.equal(memes.previewUrl({ id: '007' }), 'https://img.aigengtu.com/0_preview/meme/007.webp');
  assert.equal(memes.pageUrl('007'), 'https://aigengtu.com/zh/meme/007');
  assert.deepEqual(memes.tagsOf({ emotion: '生气', cat: 'DeepSeek娘', quote: '哼', tags: ['生气'] }), [
    '生气',
    'DeepSeek娘',
    '哼',
  ]);
});
