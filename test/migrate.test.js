// 旧数据搬家：~/.dsh 里散着的东西 → 单文件夹的 data/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { migrateData, legacyAvailable } from '../src/migrate.js';

const tmp = (prefix = 'qqbot-mig-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function setup() {
  const base = tmp();
  const projectDir = path.join(base, 'project');
  const legacyDir = path.join(base, 'legacy');
  fs.mkdirSync(projectDir, { recursive: true });

  const configFile = path.join(projectDir, 'config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      engine: 'openai',
      policy: { private: { users: [10001] }, group: { groups: [] } },
      engines: { openai: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat' } },
    }),
    'utf8',
  );

  // 旧数据
  const memDir = path.join(legacyDir, 'qqbot-memory');
  fs.mkdirSync(path.join(memDir, 'media'), { recursive: true });
  fs.writeFileSync(
    path.join(memDir, 'archive.jsonl'),
    [
      JSON.stringify({ t: Date.now() - 1000, cid: 'private:10001', role: 'user', text: '在吗' }),
      JSON.stringify({ t: Date.now(), cid: 'private:10001', role: 'assistant', text: '在。' }),
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(memDir, 'long.json'),
    JSON.stringify({ version: 1, items: [{ id: 'abc', t: Date.now(), cid: '', kind: 'note', text: '他喜欢美式', tags: ['饮料'], weight: 1 }] }),
    'utf8',
  );
  fs.writeFileSync(path.join(memDir, 'memes.json'), JSON.stringify({ version: 1, source: 'aigengtu', items: Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: `t${i}`, cat: 'DeepSeek娘', quote: '', emotion: '' })) }), 'utf8');
  fs.writeFileSync(path.join(legacyDir, 'qqbot-history.json'), JSON.stringify({ 'private:10001': { messages: [{ role: 'user', content: '在吗' }] } }), 'utf8');

  // 两张图 + 索引（file 指向旧目录）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const f1 = path.join(memDir, 'media', 'aaaa1111.png');
  const f2 = path.join(memDir, 'media', 'bbbb2222.png');
  fs.writeFileSync(f1, png);
  fs.writeFileSync(f2, png);
  fs.writeFileSync(
    path.join(memDir, 'media', 'stickers.json'),
    JSON.stringify({
      version: 1,
      items: [
        { id: 'dir:笑.png', file: f1, tags: ['笑'], note: '', from: 'folder', addedAt: 1, uses: 0 },
        { id: 'dir:哭.png', file: f2, tags: ['哭'], note: '', from: 'folder', addedAt: 2, uses: 0 },
      ],
    }),
    'utf8',
  );

  const cfg = loadConfig({ file: configFile, env: {} });
  return { base, projectDir, legacyDir, configFile, cfg };
}

test('legacyAvailable 判断旧数据在不在', () => {
  const s = setup();
  assert.equal(legacyAvailable(s.legacyDir), true);
  assert.equal(legacyAvailable(path.join(s.base, 'nowhere')), false);
  assert.equal(legacyAvailable(path.join(s.base, 'legacy', 'qqbot-memory', 'media')), false);
});

test('迁移：文件都到位，计数正确', () => {
  const s = setup();
  const report = migrateData(s.cfg, { from: s.legacyDir });

  const root = path.join(s.projectDir, 'data');
  assert.equal(report.root, root);
  assert.equal(report.dryRun, false);
  assert.equal(report.archiveLines, 2);
  assert.equal(report.longItems, 1);
  assert.equal(report.memesCount, 5);
  assert.equal(report.stickerItems, 2);
  assert.equal(report.stickersRewritten, 2);

  for (const f of ['memory/archive.jsonl', 'memory/long.json', 'memes.json', 'history.json', 'media/aaaa1111.png', 'media/bbbb2222.png']) {
    assert.equal(fs.existsSync(path.join(root, f)), true, `${f} 应该被搬过来`);
  }
});

test('迁移：表情索引里的绝对路径改成新目录', () => {
  const s = setup();
  migrateData(s.cfg, { from: s.legacyDir });
  const root = path.join(s.projectDir, 'data');
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'media', 'stickers.json'), 'utf8'));
  assert.equal(idx.items.length, 2);
  for (const item of idx.items) {
    assert.equal(fs.existsSync(item.file), true, `${item.file} 应该存在`);
    assert.ok(item.file.toLowerCase().startsWith(root.toLowerCase()), `${item.file} 应该在新目录里`);
  }
  assert.deepEqual(idx.items.map((i) => i.tags[0]).sort(), ['哭', '笑']);
});

test('迁移：数据已经在了就不覆盖（除非 force）', () => {
  const s = setup();
  migrateData(s.cfg, { from: s.legacyDir });

  const archivePath = path.join(s.projectDir, 'data', 'memory', 'archive.jsonl');
  fs.writeFileSync(archivePath, '{"t":1,"cid":"c","role":"user","text":"新数据"}\n', 'utf8');

  const again = migrateData(s.cfg, { from: s.legacyDir });
  assert.equal(again.archiveLines, 1, '不该被旧数据覆盖回去');

  const forced = migrateData(s.cfg, { from: s.legacyDir, force: true });
  assert.equal(forced.archiveLines, 2, 'force 时应该覆盖');
});

test('迁移：dry-run 只报告不写盘', () => {
  const s = setup();
  const dry = migrateData(s.cfg, { from: s.legacyDir, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(fs.existsSync(path.join(s.projectDir, 'data')), false, 'dry-run 不该创建目录');
  const missing = dry.items.find((i) => i.name === '记忆归档');
  assert.equal(missing.exists, true);
  assert.equal(missing.targetExists, false);
});

test('迁移：没有旧数据也不炸', () => {
  const s = setup();
  const report = migrateData(s.cfg, { from: path.join(s.base, 'nothing') });
  assert.equal(report.archiveLines, 0);
  assert.equal(report.stickerItems, 0);
});
