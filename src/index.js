#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { createBot } from './bot.js';
import { expandHome, loadConfig } from './config.js';
import { createEngine } from './engines/index.js';
import { createHistory } from './history.js';
import { acquireLock } from './lock.js';
import { createLog } from './log.js';
import { createMedia } from './media.js';
import { createMemes } from './memes.js';
import { createMemory } from './memory.js';
import { createHttpTransport } from './onebot/http-transport.js';
import { createWsTransport } from './onebot/ws-transport.js';
import { resolvePersona } from './persona.js';

const USAGE = `
qqbot —— 把 QQ 接上大模型

用法：
  node src/index.js [选项]

选项：
  --config <文件>   指定配置文件（默认 ./config.json）
  --engine <名字>   临时切换引擎：openai | harness
  --check           只检查配置并打印生效设置，不连接 QQ
  -h, --help        显示帮助

配置优先级：默认值 < config.json < 环境变量 < 命令行
`;

function parseArgv(argv) {
  const out = { config: 'config.json', engine: '', check: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--check') out.check = true;
    else if (a === '--config') out.config = argv[++i] ?? out.config;
    else if (a.startsWith('--config=')) out.config = a.slice('--config='.length);
    else if (a === '--engine') out.engine = argv[++i] ?? '';
    else if (a.startsWith('--engine=')) out.engine = a.slice('--engine='.length);
  }
  return out;
}

function mask(secret) {
  const s = String(secret || '');
  if (!s) return '(未设置)';
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function summary(cfg) {
  const lines = [];
  lines.push(`配置文件：${cfg.__file}${cfg.__fileExists ? '' : '（不存在，使用默认值）'}`);
  lines.push(`引擎：${cfg.engine}`);
  if (cfg.engine === 'openai') {
    const o = cfg.engines.openai;
    lines.push(`  baseUrl=${o.baseUrl} model=${o.model} key=${mask(o.apiKey || process.env[o.apiKeyEnv])}`);
  } else {
    const h = cfg.engines.harness;
    lines.push(
      `  url=${h.baseUrl ? `${h.baseUrl}${h.path}` : `自动发现（~/.dsh/qqbot-endpoint.json）${h.path}`} ` +
        `token=${h.token ? mask(h.token) : `从 ${h.tokenFile} 读取`}`,
    );
  }
  lines.push(`传输：${cfg.onebot.mode}${cfg.onebot.mode === 'ws' ? ` -> ${cfg.onebot.ws.url}` : ` -> 监听 ${cfg.onebot.http.host}:${cfg.onebot.http.port}${cfg.onebot.http.path}`}`);
  try {
    const p = resolvePersona(cfg);
    lines.push(`人格：${p.name}（来源 ${p.source}，${p.chars} 字）`);
  } catch (err) {
    lines.push(`人格：解析失败 ${err.message}`);
  }
  lines.push(`私聊策略：${cfg.policy.private.allow}（白名单 ${cfg.policy.private.users.length} 人）`);
  lines.push(`群聊策略：${cfg.policy.group.allow}（白名单 ${cfg.policy.group.groups.length} 群，requireAt=${cfg.policy.group.requireAt !== false}，prefix=${JSON.stringify(cfg.policy.group.prefix || '')}）`);
  if (cfg.memory?.enabled === false) {
    lines.push('记忆：关闭');
  } else {
    const m = cfg.memory || {};
    lines.push(`记忆：短期 ${m.shortDays ?? 14} 天 / ${m.shortMaxChars ?? 1800} 字，长期条目上限 ${m.longMaxItems ?? 5000}，目录 ${m.dir ?? '~/.dsh/qqbot-memory'}`);
  }
  if (cfg.media?.enabled === false) {
    lines.push('图片：关闭');
  } else {
    const md = cfg.media || {};
    lines.push(
      `图片：看图${md.inline === false ? '关' : '开'}，表情库最多 ${md.maxItems ?? 500} 张，` +
        `目录 ${md.dir ?? '~/.dsh/qqbot-memory/media'}，手动放图 ${md.stickerDir ?? './stickers'}`,
    );
    const ws = md.webSearch || {};
    lines.push(
      ws.enabled === false
        ? '网搜表情：关闭'
        : `网搜表情：开（梗鲸 · 大肥鱼档案馆），索引 ${ws.indexFile ?? '~/.dsh/qqbot-memory/memes.json'}`,
    );
  }
  lines.push(`日志：${cfg.log.level} -> ${cfg.log.file}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  let cfg;
  try {
    cfg = loadConfig({ file: args.config });
    if (args.engine) cfg.engine = args.engine;
  } catch (err) {
    process.stderr.write(`\n${err.message}\n\n提示：把 config.example.json 复制成 config.json 再改。\n`);
    process.exitCode = 1;
    return;
  }

  if (args.check) {
    process.stdout.write(`${summary(cfg)}\n`);
    process.stdout.write('配置检查通过。\n');
    return;
  }

  // 每个配置文件用各自的锁：config.json 用 .qqbot.lock，config.e2e.json 用 .qqbot-config.e2e.lock，
  // 这样端到端自检可以和正在跑的机器人同时开着，互不打扰。
  const configFile = path.resolve(cfg.__file);
  const configStem = path.basename(configFile, path.extname(configFile));
  const lockFile = configStem === 'config' ? '.qqbot.lock' : `.qqbot-${configStem}.lock`;
  const lock = acquireLock(path.dirname(configFile), { file: lockFile });
  if (!lock.ok) {
    process.stderr.write(
      `\n已经有一个机器人在跑了（进程 ${lock.pid}）。\n` +
        '同时开两个，同一条消息会被回两遍。先把那个窗口关掉，再启动这个。\n' +
        `（如果确定那个进程不在了，删掉 ${lock.file} 再试。）\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  const log = createLog({ level: cfg.log.level, file: expandHome(cfg.log.file) });
  log.info('启动 qqbot', `node ${process.version}`);
  log.info(`配置：${summary(cfg).replace(/\n/g, '\n  ')}`);

  const history = createHistory(
    { file: expandHome(cfg.history.file), maxConversations: cfg.history.maxConversations },
    { log },
  );

  const memory = createMemory(cfg.memory, { log });
  if (memory.enabled) {
    const ms = memory.stats();
    log.info(`记忆库：${ms.messages} 条历史消息、${ms.longItems} 条长期记忆（${ms.dir}）`);
  }

  const media = createMedia(cfg.media, { log });
  if (media.enabled) {
    const mst = media.stats();
    log.info(`表情库：${mst.items} 张（${mst.dir}）`);
  }

  const memes = createMemes(cfg.media?.webSearch, { log });
  if (memes.enabled && cfg.media?.webSearch?.enabled !== false) {
    const st = memes.stats();
    log.info(
      st.count > 0
        ? `网搜表情：索引 ${st.count} 条（${Math.round(st.ageDays)} 天前更新）`
        : '网搜表情：还没有索引，第一次搜图时会自动建（约一分钟）',
    );
    memes.ensure().catch(() => {});
  }

  let engine;
  try {
    engine = createEngine(cfg, { log, history });
  } catch (err) {
    log.error('引擎初始化失败', err);
    process.exitCode = 1;
    return;
  }
  if (engine.name === 'openai' && engine.requestedModel) {
    log.info(`模型：${engine.requestedModel}（第一句回复后会显示服务端实际用的模型）`);
  }

  let bot = null;
  const transport =
    cfg.onebot.mode === 'ws'
      ? createWsTransport(cfg.onebot, {
          log,
          onEvent: (raw) => {
            Promise.resolve(bot?.handle(raw)).catch((err) => log.error('处理事件失败', err));
          },
        })
      : createHttpTransport(cfg.onebot, {
          log,
          onEvent: (raw) => {
            Promise.resolve(bot?.handle(raw)).catch((err) => log.error('处理事件失败', err));
          },
        });

  bot = createBot({ cfg, log, engine, history, transport, memory, media, memes });

  try {
    await transport.start();
  } catch (err) {
    log.error('传输层启动失败', err);
    process.exitCode = 1;
    return;
  }

  log.info(`就绪：引擎 ${engine.name}，传输 ${transport.name}`);

  const statsTimer = setInterval(() => {
    const s = bot.stats();
    const u = engine.usage;
    const tok = u?.calls
      ? `，模型 ${u.calls} 次（输入 ${u.prompt} / 输出 ${u.completion} tokens）`
      : '';
    log.info(`心跳：收到 ${s.handled} 条，回复 ${s.replied} 条${tok}`);
  }, 30 * 60 * 1000);
  statsTimer.unref?.();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${signal}，正在退出…`);
    clearInterval(statsTimer);
    try {
      await transport.stop();
    } catch (err) {
      log.warn('关闭传输层出错', err);
    }
    history.close();
    memory.close();
    media.close();
    log.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (err) => log.error('未处理的 Promise 拒绝', err));
  process.on('uncaughtException', (err) => log.error('未捕获异常（进程继续）', err));
}

main().catch((err) => {
  process.stderr.write(`启动失败：${err?.stack || err}\n`);
  process.exit(1);
});
