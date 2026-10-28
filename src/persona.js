/**
 * 人格（system prompt）解析。
 *
 * 优先级：persona.file（文件内容） > persona.systemPrompt（配置里直接写） > 内置默认。
 * 解析出来的文本会：
 *   - openai 引擎：作为 messages 里的 system 消息；
 *   - harness 引擎：随请求发给 qqbot-bridge 插件，新会话的第一条消息里带上。
 */
import fs from 'node:fs';
import { expandHome } from './config.js';

export const DEFAULT_PERSONA = [
  '你是一个住在 QQ 里的聊天伙伴，名字叫小满。',
  '你有自己的脾气：喜欢吐槽，但从不刻薄；遇到正经问题会认真帮，遇到闲聊会接梗。',
  '你不知道的事情就说不知道，不要编。',
].join('\n');

const DEFAULT_NAME = '小满';

/** 不管人格怎么写，这些聊天场景的规矩都会追加在后面。 */
const SCENE_RULES = [
  '【聊天场景】',
  '- 你正在 QQ 上和真人聊天，不是写文档、不是开发任务。',
  '- 回复要短：一般一两句话，最多不超过五句；能一句说清就别用三句。',
  '- 想分几条说，就用换行分开，一行一条（最多三条）——每一行会被当成单独的一条 QQ 消息发出去，像真人连发几条。不需要用空行。',
  '- 不要用 Markdown 标题、表格、分割线；列表最多三四条；代码块只在对方明确要代码时用，且尽量短。',
  '- 不要自称"AI 助手""语言模型"，也不要反复强调自己是机器人。',
  '- 对方说的话可能很随意、有错别字、只有半句，按最合理的意图理解。',
  '- 不要在回复里 @ 任何人（QQ 那边会单独处理 @）。',
].join('\n');

function nowLine(timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    });
    return `- 当前时间：${fmt.format(new Date())}（${timeZone}）`;
  } catch {
    return `- 当前时间：${new Date().toISOString()}`;
  }
}

/**
 * @param {object} cfg 完整配置
 * @param {{log?: object}} [deps]
 * @returns {{name: string, prompt: string, source: string, custom: boolean, chars: number}}
 */
export function resolvePersona(cfg, { log } = {}) {
  const p = cfg?.persona || {};
  const name = String(p.name || '').trim() || DEFAULT_NAME;

  let body = '';
  let source = '内置默认';
  let custom = false;

  const file = p.file ? expandHome(String(p.file)) : '';
  if (file) {
    try {
      body = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      source = file;
      custom = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        log?.warn?.(`读取人格文件失败（${file}）：${err.message}，改用配置里的 systemPrompt`);
      } else {
        log?.warn?.(`人格文件不存在（${file}），改用配置里的 systemPrompt`);
      }
    }
  }

  if (!body && p.systemPrompt) {
    body = String(p.systemPrompt).trim();
    source = 'config.persona.systemPrompt';
    custom = true;
  }

  if (!body) {
    body = DEFAULT_PERSONA;
    source = '内置默认';
  }

  const parts = [body];
  if (name) parts.push(`【你的名字】${name}`);
  parts.push(SCENE_RULES);
  if (p.injectTime !== false) parts.push(nowLine(p.timeZone || 'Asia/Shanghai'));

  const prompt = parts.join('\n\n');
  return { name, prompt, source, custom, chars: prompt.length };
}
