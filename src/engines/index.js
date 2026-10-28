import { resolvePersona } from '../persona.js';
import { createHarnessEngine } from './harness.js';
import { createOpenAiEngine } from './openai.js';

/**
 * 告诉模型"你有发图的能力"。不作为硬指令，只在她真想说的时候用。
 * 这段只在媒体功能开着的时候附加。
 */
const MEDIA_RULES = [
  '【发图能力】',
  '- 你有一个表情包图库，想发表情包时，在回复里写一个标记：[表情:关键词]（比如 [表情:无语]），系统会把它换成一张真的表情图片发出去。',
  '- 库里的都不合适，就去网上找：写 [搜图:关键词]（比如 [搜图:摆烂]、[搜图:晚安]），系统会从「蓝色大肥鱼档案馆」里挑一张最贴题的发出去——那里的图全是你这种蓝色大肥鱼，正好是你的风格。',
  '- 想发网上某张具体的图，写 [图:https://完整的图片地址]。',
  '- 每轮最多发两张。只在情绪到位时用，别每句话都配图；也不要解释这些标记，标记会被自动替换掉，也不要说"我去找找"然后什么都没发。',
  '- 对方发来的图片你是能看到的，直接说图里有什么就行，不要问对方"你能描述一下吗"。',
].join('\n');

/** 网搜表情包关掉时，别把 [搜图:…] 这条能力告诉她。 */
function mediaRules(cfg) {
  if (cfg?.media?.webSearch?.enabled === false) {
    return MEDIA_RULES.split('\n').filter((l) => !l.includes('[搜图:')).join('\n');
  }
  return MEDIA_RULES;
}

function withMediaRules(systemPrompt, cfg) {
  if (cfg?.media?.enabled === false) return systemPrompt;
  return `${systemPrompt}\n\n${mediaRules(cfg)}`;
}

/** 根据 config.engine 造出对话引擎。 */
export function createEngine(cfg, deps) {
  const persona = resolvePersona(cfg, deps);
  const systemPrompt = withMediaRules(persona.prompt, cfg);

  if (cfg.engine === 'harness') {
    const h = { ...(cfg.engines.harness || {}), persona: systemPrompt };
    return createHarnessEngine(h, deps);
  }

  if (cfg.engine === 'openai') {
    const o = { ...(cfg.engines.openai || {}) };
    // 人格优先用 persona 的；没自定义就退回 engines.openai.systemPrompt，再退回内置
    o.systemPrompt = systemPrompt;
    return createOpenAiEngine(o, deps);
  }

  throw new Error(`未知引擎 ${cfg.engine}`);
}
