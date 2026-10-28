// 直接跟「引擎」说一句话，不经过 QQ。
//
// 用途：确认模型接口通不通、人格有没有生效、key 对不对、记忆有没有塞进去。
// 用法：
//   node tools/try-engine.js                # 默认说一句"在吗"
//   node tools/try-engine.js "讲个冷笑话"    # 自己指定内容
//   node tools/try-engine.js --reset        # 清掉自检会话的历史
//   node tools/try-engine.js --remember "我喜欢喝美式"   # 先往长期记忆里存一条
//   node tools/try-engine.js "你还记得我喜欢喝什么吗"
//
// 注意：用的是一个独立的假会话（private:selftest），不会污染你在 QQ 上的聊天记录；
// 但记忆库是真实的那一个（方便验证"它到底记不记得"）。

import { expandHome, loadConfig } from '../src/config.js';
import { createLog } from '../src/log.js';
import { createHistory } from '../src/history.js';
import { createMemory } from '../src/memory.js';
import { createEngine } from '../src/engines/index.js';
import { resolvePersona } from '../src/persona.js';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const rememberAt = args.indexOf('--remember');
const rememberText = rememberAt >= 0 ? args[rememberAt + 1] : '';
const text =
  args
    .filter((a, i) => !a.startsWith('--') && !(rememberAt >= 0 && i === rememberAt + 1))
    .join(' ')
    .trim() || '在吗？一句话打个招呼。';
const conversationId = 'private:selftest';

const cfg = loadConfig();
const log = createLog({ level: 'warn', file: '', toStderr: true });
const persona = resolvePersona(cfg, { log });
console.log(`人格：${persona.name}（来源 ${persona.source}，${persona.chars} 字）`);

const history = createHistory({ file: expandHome(cfg.history.file) }, { log });
const memory = createMemory(cfg.memory, { log });
const engine = createEngine(cfg, { log, history });
console.log(`引擎：${engine.name}｜记忆：${memory.enabled ? memory.stats().messages + ' 条消息 / ' + memory.stats().longItems + ' 条长期记忆' : '关闭'}`);

if (reset) {
  await engine.reset?.(conversationId);
  history.clear(conversationId);
  console.log('已清空自检会话的历史。');
}

if (rememberText) {
  const item = memory.remember({ cid: conversationId, text: rememberText, weight: 2, tags: ['自检'] });
  console.log(`已记住 #${item?.id}：${rememberText}`);
}

memory.record(conversationId, 'user', text, { t: Date.now() });
const memCtx = memory.context({
  cid: conversationId,
  text,
  skip: engine.managesHistory ? (cfg.engines?.openai?.historyTurns ?? 12) * 2 : 0,
});
if (memCtx.block) {
  console.log(`记忆注入：短期 ${memCtx.shortCount} 行，旧记忆 ${memCtx.longHits} 条，翻旧账 ${memCtx.recallHits} 条`);
}

const t0 = Date.now();
try {
  const out = await engine.chat({ conversationId, text, images: [], memory: memCtx.block });
  const ms = Date.now() - t0;
  memory.record(conversationId, 'assistant', out.text);
  console.log(`\n我说：${text}`);
  console.log(`它说：${out.text}`);
  console.log(`\n（${ms}ms${out.sessionId ? '，会话 ' + out.sessionId : ''}）`);
} catch (err) {
  console.error(`\n失败：${err.message}`);
  process.exitCode = 1;
} finally {
  memory.close();
  history.close();
  log.close();
}
