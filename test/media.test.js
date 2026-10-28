import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createMedia, tokenize } from '../src/media.js';

// 1x1 的 PNG，最小的合法图片
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const silentLog = () => ({ error() {}, warn() {}, info() {}, debug() {}, trace() {} });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-media-'));
}

function make(extra = {}) {
  const dir = tmpDir();
  return createMedia({ dir, stickerDir: path.join(dir, 'none'), ...extra }, { log: silentLog() });
}

test('tokenize 切中文二元组和英文单词', () => {
  const t = tokenize('狗头doge');
  assert.ok(t.has('狗头'));
  assert.ok(t.has('doge'));
  assert.equal(tokenize('').size, 0);
});

test('fetchImage 支持 data: / base64:// / 本地文件', async () => {
  const m = make();
  const dir = tmpDir();
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, PNG);

  const a = await m.fetchImage(`data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(a.mime, 'image/png');
  assert.equal(a.buffer.length, PNG.length);

  const b = await m.fetchImage(`base64://${PNG.toString('base64')}`);
  assert.equal(b.buffer.length, PNG.length);

  const c = await m.fetchImage(file);
  assert.equal(c.buffer.length, PNG.length);
  m.close();
});

test('fetchImage 拒绝过大的图', async () => {
  const m = make({ maxBytes: 64 * 1024 });
  const big = Buffer.alloc(70 * 1024, 7).toString('base64');
  await assert.rejects(() => m.fetchImage(`data:image/png;base64,${big}`), /太大/);
  m.close();
});

test('storeImage 存盘 + 同图去重 + 标签合并', () => {
  const m = make();
  const a = m.storeImage(PNG, 'image/png', { tags: ['笑'], note: '' });
  assert.ok(fs.existsSync(a.file));
  const b = m.storeImage(PNG, 'image/png', { tags: ['狗头'], note: '很无语' });
  assert.equal(a.id, b.id, '同一张图不该存两份');
  assert.ok(b.tags.includes('笑') && b.tags.includes('狗头'));
  assert.equal(b.note, '很无语');
  assert.equal(m.list().length, 1);
  m.close();
});

test('find 按标签/备注找，找不到返回 null，空查询随便给一张', () => {
  const m = make();
  m.storeImage(PNG, 'image/png', { tags: ['笑', '狗头'] });
  assert.ok(m.find('狗头'));
  assert.ok(m.find('笑'));
  assert.equal(m.find('完全不相干的东西'), null);
  assert.ok(m.find(''), '没指定关键词时也该给一张');
  assert.ok(m.find('#0'));
  m.close();
});

test('remove 按标签或 id 删', () => {
  const m = make();
  const a = m.storeImage(PNG, 'image/png', { tags: ['笑'] });
  assert.equal(m.remove('笑'), 1);
  assert.equal(m.list().length, 0);
  m.storeImage(PNG, 'image/png', { tags: ['哭'] });
  assert.equal(m.remove(a.id), 1);
  m.close();
});

test('parseReplyMarkers 抠出标记，正文保持干净', () => {
  const m = make();
  const r = m.parseReplyMarkers('行吧。[表情:无语] 你自己看 [图:https://x/a.png] 嗯。');
  assert.equal(r.requests.length, 2);
  assert.deepEqual(r.requests[0], { kind: 'sticker', value: '无语' });
  assert.deepEqual(r.requests[1], { kind: 'image', value: 'https://x/a.png' });
  assert.ok(!r.text.includes('表情:'));
  assert.ok(!r.text.includes('图:'));

  const cjk = m.parseReplyMarkers('【表情：笑】好');
  assert.deepEqual(cjk.requests[0], { kind: 'sticker', value: '笑' });

  const none = m.parseReplyMarkers('普通一句话');
  assert.equal(none.requests.length, 0);
  assert.equal(none.text, '普通一句话');
  m.close();
});

test('prepareIncoming 下载图片并给出 dataUrl 和本地路径', async () => {
  const m = make();
  const prepared = await m.prepareIncoming([{ url: `data:image/png;base64,${PNG.toString('base64')}`, subType: 0 }]);
  assert.equal(prepared.length, 1);
  assert.ok(prepared[0].dataUrl.startsWith('data:image/png;base64,'));
  assert.ok(fs.existsSync(prepared[0].path));
  assert.equal(prepared[0].mime, 'image/png');
  m.close();
});

test('prepareIncoming 抓不到图时不炸，只是标记 error', async () => {
  const m = make();
  const prepared = await m.prepareIncoming([{ url: 'https://127.0.0.1:1/none.png' }]);
  assert.equal(prepared.length, 1);
  assert.ok(prepared[0].error);
  m.close();
});

test('learnFromIncoming 把对方发的表情收进图库', async () => {
  const m = make({ autoLearn: true });
  const prepared = await m.prepareIncoming([{ url: `data:image/png;base64,${PNG.toString('base64')}`, subType: 1, summary: '狗头' }]);
  const n = m.learnFromIncoming(prepared);
  assert.equal(n, 1);
  assert.ok(m.find('狗头'));
  m.close();
});

test('autoLearn 关掉就不收', async () => {
  const m = make({ autoLearn: false });
  const prepared = await m.prepareIncoming([{ url: `data:image/png;base64,${PNG.toString('base64')}`, subType: 1, summary: '狗头' }]);
  assert.equal(m.learnFromIncoming(prepared), 0);
  m.close();
});

test('toImageSegment 产出 base64:// 图片段（表情和网络图都走这里）', async () => {
  const m = make();
  m.storeImage(PNG, 'image/png', { tags: ['笑'] });
  const sticker = await m.toImageSegment({ kind: 'sticker', value: '笑' });
  assert.equal(sticker.segment.type, 'image');
  assert.ok(sticker.segment.data.file.startsWith('base64://'));
  assert.equal(m.find('笑').uses, 1, '发过之后计数会加');

  const url = await m.toImageSegment({ kind: 'image', value: `data:image/png;base64,${PNG.toString('base64')}` });
  assert.ok(url.segment.data.file.startsWith('base64://'));

  assert.equal(await m.toImageSegment({ kind: 'sticker', value: '根本没有' }), null);
  m.close();
});

test('从 stickers/ 目录导入，文件名即标签', () => {
  const dir = tmpDir();
  const stickers = path.join(dir, 'stickers');
  fs.mkdirSync(stickers, { recursive: true });
  fs.writeFileSync(path.join(stickers, '笑-狗头.png'), PNG);
  const m = createMedia({ dir, stickerDir: stickers }, { log: silentLog() });
  const all = m.list();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].tags, ['笑', '狗头']);
  assert.ok(m.find('狗头'));
  m.close();
});

test('图库索引能落盘再读回来', () => {
  const dir = tmpDir();
  const a = createMedia({ dir, stickerDir: path.join(dir, 'none') }, { log: silentLog() });
  a.storeImage(PNG, 'image/png', { tags: ['笑'] });
  a.close();
  const b = createMedia({ dir, stickerDir: path.join(dir, 'none') }, { log: silentLog() });
  assert.equal(b.list().length, 1);
  assert.ok(b.find('笑'));
  b.close();
});

test('prepareIncoming 用真的 HTTP 服务取图', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const m = make();
  try {
    const ok = await m.prepareIncoming([{ url: `http://127.0.0.1:${port}/ok.png` }]);
    assert.ok(ok[0].dataUrl.startsWith('data:image/png'));

    const bad = await m.prepareIncoming([{ url: `http://127.0.0.1:${port}/page.html` }]);
    assert.match(bad[0].error, /不是图片/);
  } finally {
    m.close();
    await new Promise((r) => server.close(r));
  }
});
