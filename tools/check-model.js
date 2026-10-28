#!/usr/bin/env node
/**
 * 看一眼"到底在用哪个模型"。
 *
 * 为什么要这个工具：`deepseek-chat` 这类名字是别名，服务端会解析成真名
 * （可能解析到 deepseek-flash，也可能哪天改到别的）。模型自己说"我是谁"
 * 完全不可信——它看不到自己被哪个 id 调用。唯一可信的是 HTTP 响应里的
 * `model` 字段，这个脚本就是去读那个字段。
 *
 * 用法：
 *   node tools/check-model.js              # 用 config.json 里配的模型
 *   node tools/check-model.js deepseek-flash
 */
import { loadConfig } from '../src/config.js';

const configFile = process.env.QQBOT_CONFIG || undefined;
const cfg = loadConfig({ file: configFile });
const o = cfg.engines?.openai || {};
const key = o.apiKey || (o.apiKeyEnv ? process.env[o.apiKeyEnv] : '') || '';
if (!key) {
  console.error('[x] 没有 API Key：config.json 里 engines.openai.apiKey 是空的。');
  process.exit(1);
}
const baseUrl = String(o.baseUrl || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('[x] config.json 里 engines.openai.baseUrl 是空的。');
  process.exit(1);
}

const requested = process.argv[2] || o.model || 'deepseek-chat';

async function listModels() {
  const r = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return (j?.data || []).map((m) => ({
    id: m.id,
    modalities: m.input_modalities || m.modalities || null,
  }));
}

async function ask(model) {
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '说一个字' }],
      max_tokens: 8,
      stream: false,
    }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, model: j?.model || '', error: j?.error?.message || '' };
}

console.log(`接口：${baseUrl}`);
const models = await listModels();
if (models?.length) {
  console.log('这个 key 能用的模型：');
  for (const m of models) {
    const mods = m.modalities ? `（输入：${m.modalities.join(' + ')}）` : '';
    console.log(`  - ${m.id}${mods}`);
  }
} else {
  console.log('（/models 接口没给列表，跳过）');
}

const got = await ask(requested);
console.log('');
if (got.status !== 200) {
  console.log(`[x] 请求 ${requested} 失败（HTTP ${got.status}）：${got.error}`);
  process.exit(1);
}
console.log(`配置里写的：${requested}`);
console.log(`服务端实际：${got.model || '（响应里没带 model 字段）'}`);
if (got.model && got.model !== requested) {
  console.log('  → 这是个别名，实际跑的是上面那个。');
}
if (/v4-?pro/i.test(got.model || '')) {
  console.log('');
  console.log('[!] 现在用的是 v4-pro 系列：它【不支持图片输入】。');
  console.log('    想让它能看图，把 config.json 的 engines.openai.model 改成 deepseek-flash。');
}
