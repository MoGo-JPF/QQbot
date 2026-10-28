// 路径解析：所有数据都落在 storage.root 下面，整个文件夹可以整体搬走。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, applyPaths, dataPaths } from '../src/config.js';

function writeConfig(dir, extra = {}) {
  const file = path.join(dir, 'config.json');
  const cfg = {
    engine: 'openai',
    policy: { private: { users: [10001] }, group: { groups: [] } },
    engines: { openai: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat' } },
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  return file;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-paths-'));

test('默认全落在 storage.root 下面', () => {
  const dir = tmp();
  const cfg = loadConfig({ file: writeConfig(dir), env: {} });
  const p = dataPaths(cfg);

  assert.equal(p.root, path.join(dir, 'data'));
  assert.equal(p.memory, path.join(dir, 'data', 'memory'));
  assert.equal(p.archive, path.join(dir, 'data', 'memory', 'archive.jsonl'));
  assert.equal(p.media, path.join(dir, 'data', 'media'));
  assert.equal(p.memes, path.join(dir, 'data', 'memes.json'));
  assert.equal(p.history, path.join(dir, 'data', 'history.json'));
  assert.equal(p.log, path.join(dir, 'data', 'logs', 'qqbot.log'));
  assert.equal(p.lock, path.join(dir, '.qqbot.lock'));
});

test('storage.root 改成相对路径时相对 config.json 所在目录', () => {
  const dir = tmp();
  const cfg = loadConfig({ file: writeConfig(dir, { storage: { root: './mydata' } }), env: {} });
  assert.equal(dataPaths(cfg).root, path.join(dir, 'mydata'));
  assert.equal(dataPaths(cfg).memes, path.join(dir, 'mydata', 'memes.json'));
});

test('绝对路径 = 用户自己指定，原样使用', () => {
  const dir = tmp();
  const custom = path.join(dir, 'somewhere', 'mem.json');
  const cfg = loadConfig({
    file: writeConfig(dir, { storage: { root: path.join(dir, 'd') }, media: { webSearch: { indexFile: custom } } }),
    env: {},
  });
  assert.equal(dataPaths(cfg).memes, custom);
});

test('~ 会展开成主目录', () => {
  const dir = tmp();
  const cfg = loadConfig({ file: writeConfig(dir, { history: { file: '~/x/history.json' } }), env: {} });
  const p = dataPaths(cfg);
  assert.equal(p.history, path.join(os.homedir(), 'x', 'history.json'));
});

test('QQBOT_DATA 环境变量能覆盖数据根目录', () => {
  const dir = tmp();
  const other = path.join(dir, 'elsewhere');
  const cfg = loadConfig({ file: writeConfig(dir), env: { QQBOT_DATA: other } });
  assert.equal(dataPaths(cfg).root, other);
  assert.equal(dataPaths(cfg).memory, path.join(other, 'memory'));
});

test('applyPaths 可以反复调用，结果稳定', () => {
  const dir = tmp();
  const cfg = loadConfig({ file: writeConfig(dir), env: {} });
  const first = dataPaths(cfg).memes;
  applyPaths(cfg);
  applyPaths(cfg);
  assert.equal(dataPaths(cfg).memes, first);
  assert.equal(cfg.memory.dir, path.join(dir, 'data', 'memory'));
  assert.equal(cfg.media.dir, path.join(dir, 'data', 'media'));
  assert.equal(cfg.log.file, path.join(dir, 'data', 'logs', 'qqbot.log'));
});

test('配置里的面板 / NapCat 也一起解析', () => {
  const dir = tmp();
  const cfg = loadConfig({
    file: writeConfig(dir, { napcat: { dir: './napcat', qq: '3991745047' }, panel: { host: '127.0.0.1', port: 8899 } }),
    env: {},
  });
  assert.equal(cfg.napcat.dir, path.join(dir, 'napcat'));
  assert.equal(cfg.napcat.qq, '3991745047');
  assert.equal(cfg.panel.port, 8899);
});
