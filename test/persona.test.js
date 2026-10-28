import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_CONFIG, deepMerge } from '../src/config.js';
import { DEFAULT_PERSONA, resolvePersona } from '../src/persona.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-persona-'));

function cfgWith(persona) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona = { ...cfg.persona, ...persona };
  return cfg;
}

const silentLog = { warn() {}, info() {}, debug() {}, error() {} };

test('没有自定义时用内置人格，并追加聊天场景和时间', () => {
  const p = resolvePersona(cfgWith({ systemPrompt: '', file: '' }), { log: silentLog });
  assert.equal(p.custom, false);
  assert.equal(p.source, '内置默认');
  assert.ok(p.prompt.includes(DEFAULT_PERSONA));
  assert.match(p.prompt, /【聊天场景】/);
  assert.match(p.prompt, /当前时间：/);
  assert.ok(p.chars > 100);
});

test('配置里直接写 systemPrompt 生效', () => {
  const p = resolvePersona(cfgWith({ systemPrompt: '你是一只猫，只会喵。', file: '' }), { log: silentLog });
  assert.equal(p.custom, true);
  assert.equal(p.source, 'config.persona.systemPrompt');
  assert.match(p.prompt, /你是一只猫，只会喵。/);
  assert.match(p.prompt, /【你的名字】小满/);
});

test('人格文件优先于配置文本', () => {
  const file = path.join(tmpDir, 'p1.md');
  fs.writeFileSync(file, '你是一个话很少的人。\n', 'utf8');
  const p = resolvePersona(cfgWith({ systemPrompt: '不该出现', file }), { log: silentLog });
  assert.equal(p.custom, true);
  assert.equal(p.source, file);
  assert.match(p.prompt, /你是一个话很少的人。/);
  assert.doesNotMatch(p.prompt, /不该出现/);
});

test('人格文件有 BOM 也能读', () => {
  const file = path.join(tmpDir, 'bom.md');
  fs.writeFileSync(file, '\uFEFF你是测试人格。', 'utf8');
  const p = resolvePersona(cfgWith({ systemPrompt: '', file }), { log: silentLog });
  assert.ok(p.prompt.startsWith('你是测试人格。'), 'BOM 应被去掉');
});

test('文件不存在时退回配置文本并警告', () => {
  const warnings = [];
  const log = { warn: (m) => warnings.push(m), info() {}, debug() {}, error() {} };
  const p = resolvePersona(cfgWith({ systemPrompt: '兜底人格', file: path.join(tmpDir, 'nope.md') }), { log });
  assert.equal(p.custom, true);
  assert.equal(p.source, 'config.persona.systemPrompt');
  assert.match(p.prompt, /兜底人格/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /人格文件不存在/);
});

test('injectTime=false 时不注入时间', () => {
  const p = resolvePersona(cfgWith({ systemPrompt: 'x', injectTime: false }), { log: silentLog });
  assert.doesNotMatch(p.prompt, /当前时间：/);
});

test('name 会写进提示词', () => {
  const p = resolvePersona(cfgWith({ name: '阿白', systemPrompt: 'x' }), { log: silentLog });
  assert.equal(p.name, '阿白');
  assert.match(p.prompt, /【你的名字】阿白/);
});

test('deepMerge 不会把 persona 弄丢', () => {
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), { persona: { systemPrompt: 'hi' } });
  assert.equal(merged.persona.systemPrompt, 'hi');
  assert.equal(merged.persona.name, DEFAULT_CONFIG.persona.name);
  assert.equal(merged.persona.injectTime, true);
});
