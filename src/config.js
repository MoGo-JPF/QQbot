import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 把 ~ 展开成用户主目录，并转成绝对路径。 */
export function expandHome(p) {
  const s = String(p ?? '');
  if (!s) return '';
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

export const DEFAULT_CONFIG = {
  // 数据总目录：记忆库、表情库、索引、日志、会话历史、NapCat 都在这里，整个文件夹拷走就能跑
  storage: {
    root: './data',
  },

  // 控制面板（panel/server.js）
  panel: {
    enabled: true,
    host: '127.0.0.1', // 想用手机开就改成 0.0.0.0，并设置 token
    port: 8899,
    token: '', // 非空时访问需要 ?token= 或 Authorization: Bearer（手机登录成功后也会记在 cookie 里）
    pin: '', // 手机端用 4~8 位数字登录，比在手机上敲一长串 token 省事
  },

  // NapCat 本体（面板里启动/看二维码用）
  napcat: {
    dir: './napcat',
    launcher: 'launcher-win10.bat',
    qq: '',
    webui: 'http://127.0.0.1:6099/webui',
    webuiToken: '',
    waitSeconds: 180,
  },

  onebot: {
    // "ws" = 主动连 NapCat 的 WebSocket 服务；"http" = 收 webhook 上报 + 调 HTTP API
    mode: 'ws',
    ws: {
      url: 'ws://127.0.0.1:3001',
      accessToken: '',
      reconnectMs: 3000,
      maxReconnectMs: 60000,
      keepAliveMs: 30000,
    },
    http: {
      host: '127.0.0.1',
      port: 8080,
      path: '/onebot',
      secret: '',
      api: 'http://127.0.0.1:3000',
      accessToken: '',
    },
  },

  policy: {
    private: {
      // whitelist: 只回名单里的人；all: 谁都回；none: 私聊全不回
      allow: 'whitelist',
      users: [],
    },
    group: {
      // whitelist: 只回名单里的群；all: 所有群；none: 群聊全不回
      allow: 'whitelist',
      groups: [],
      // 群里必须 @ 我才回（prefix 命中时不受此限制）
      requireAt: true,
      // 群里除了 @，也可以用固定前缀触发（空字符串 = 不启用）
      prefix: '',
      // 别人回复我的消息时也算找我
      replyToMe: true,
    },
    // 这些 QQ 号永远不回（自己和机器人号会被自动忽略）
    denyUsers: [],
    // 同一会话两条消息之间的最小间隔（毫秒），防止刷屏把我刷爆
    cooldownMs: 0,
  },

  // 人格设定：决定"它是谁、怎么说话"。两种引擎通用。
  persona: {
    // 名字，会告诉模型"你的名字是 X"
    name: '小满',
    // 直接写一段话当人格；长文本建议用下面的 file
    systemPrompt: '',
    // 指向一个人格文件（markdown/txt 都行），优先级高于 systemPrompt
    file: '',
    // 让模型知道现在几点（很多"答非所问"是因为模型不知道当前时间）
    injectTime: true,
    timeZone: 'Asia/Shanghai',
  },

  engine: 'harness',

  engines: {
    openai: {
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      model: 'deepseek-chat',
      temperature: 1.0,
      maxTokens: 1200,
      stream: true,
      timeoutMs: 120000,
      historyTurns: 12,
      systemPrompt: '你是一个在 QQ 上聊天的助手。回答简洁自然，像人一样说话，不要用 Markdown 表格和标题，代码块保持简短。',
    },
    harness: {
      // 留空 = 自动从 ~/.dsh/qqbot-endpoint.json 发现（Harness 每次启动端口可能变）
      baseUrl: '',
      path: '/api/qqbot/chat',
      // 留空则自动读 tokenFile
      token: '',
      tokenFile: '~/.dsh/qqbot-token',
      // Harness 地址自动发现文件（由 qqbot-bridge 插件写入）
      endpointFile: '~/.dsh/qqbot-endpoint.json',
      timeoutMs: 300000,
    },
  },

  reply: {
    limit: 1500,
    maxParts: 4,
    // 把回复拆成几条发（像真人连发），而不是塞进一个气泡
    split: true,
    splitMax: 3,
    // 整条回复短于这么多字就不拆
    splitMinChars: 60,
    // 气泡之间的间隔（毫秒）
    splitDelayMs: 450,
    // 群里回复时带上 @
    atInGroup: true,
    // 出错时给用户一句人话提示
    replyOnError: true,
  },

  commands: {
    enabled: true,
    prefixes: ['/', '!', '！', '。'],
    reset: true,
    help: true,
    status: true,
  },

  history: {
    // openai 引擎的上下文存这里（留空 = <storage.root>/history.json）
    file: '',
    maxConversations: 500,
  },

  // 记忆库：短期记忆（最近聊过什么）+ 长期记忆（可检索的条目，按天自动小结）
  memory: {
    enabled: true,
    // 存档目录：archive.jsonl 是全部原始对话（永不删），long.json 是长期记忆条目（留空 = <storage.root>/memory）
    dir: '',
    // 短期记忆覆盖多少天
    shortDays: 14,
    // 每次注入给模型的短期记忆最多多少字（超了就从最旧的开始丢）
    shortMaxChars: 1800,
    // 短期记忆最多取多少条消息
    shortLimit: 600,
    // 长期记忆条目上限（超了按重要度+时间淘汰）
    longMaxItems: 5000,
    // 被问"还记得吗"时，最多翻几条旧账
    recallLimit: 6,
    // 每天自动把前一天聊的内容做成一条长期记忆
    autoDigest: true,
  },

  // 图片与表情包
  media: {
    enabled: true,
    // 收到的图、表情库存这里（stickers.json 是索引）；留空 = <storage.root>/media
    dir: '',
    // 手动放表情包的目录：文件名就是标签，如 笑-狗头.png
    stickerDir: './stickers',
    // 对方发表情时自动收进图库
    autoLearn: true,
    // 图库最多存多少张
    maxItems: 500,
    // 单张图上限（字节）
    maxBytes: 4194304,
    // 一条消息里最多看几张图
    maxInlineImages: 3,
    // 一条回复里最多发几张图
    maxSendPerTurn: 2,
    // 把图片直接作为 image_url 喂给模型（需要模型支持视觉；失败会自动退回纯文字）
    inline: true,
    timeoutMs: 20000,

    // 需要时去网上找表情包（梗鲸 · 蓝色大肥鱼档案馆）
    webSearch: {
      enabled: true,
      // 站点地址（目录页 /archive?p=N；原图在 imgBase）
      baseUrl: 'https://aigengtu.com',
      imgBase: 'https://img.aigengtu.com',
      // 本地索引：2400 多条标题，几百 KB，建一次能用很久；留空 = <storage.root>/memes.json
      indexFile: '',
      // 目录一共多少页（站点现在是 41 页 ≈ 2450 张）
      pages: 41,
      // 索引超过这么多天就后台悄悄重建
      maxAgeDays: 30,
      // 一次最多发几张
      maxResults: 2,
      // 相关度门槛，低于这个宁可说"没找到"
      minScore: 0.34,
      timeoutMs: 20000,
    },
  },

  log: {
    level: 'info',
    // 留空 = <storage.root>/logs/qqbot.log
    file: '',
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 递归合并：数组整体替换，对象逐层合并。 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 读取 JSON 文件，不存在就返回 undefined。（容忍 Windows 编辑器加的 BOM） */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    throw new Error(`配置文件解析失败 ${file}: ${err.message}`);
  }
}

/**
 * 加载配置：默认值 <- config.json <- 环境变量。
 * 环境变量：QQBOT_ENGINE / DEEPSEEK_API_KEY / QQBOT_HARNESS_TOKEN / QQBOT_LOG_LEVEL
 */
export function loadConfig({ file = 'config.json', env = process.env } = {}) {
  const abs = expandHome(file);
  const fromFile = readJsonFile(abs);
  let cfg = deepMerge(structuredClone(DEFAULT_CONFIG), fromFile || {});

  if (env.QQBOT_ENGINE) cfg.engine = env.QQBOT_ENGINE;
  if (env.QQBOT_LOG_LEVEL) cfg.log.level = env.QQBOT_LOG_LEVEL;
  if (env.QQBOT_HARNESS_TOKEN) cfg.engines.harness.token = env.QQBOT_HARNESS_TOKEN;
  if (env.QQBOT_HARNESS_URL) cfg.engines.harness.baseUrl = env.QQBOT_HARNESS_URL;
  if (env.QQBOT_ONEBOT_WS) cfg.onebot.ws.url = env.QQBOT_ONEBOT_WS;
  if (env.QQBOT_ONEBOT_TOKEN) {
    cfg.onebot.ws.accessToken = env.QQBOT_ONEBOT_TOKEN;
    cfg.onebot.http.accessToken = env.QQBOT_ONEBOT_TOKEN;
  }
  if (env.QQBOT_PERSONA_FILE) {
    cfg.persona.file = env.QQBOT_PERSONA_FILE;
    cfg.persona.systemPrompt = '';
  }
  if (env.QQBOT_PERSONA_NAME) cfg.persona.name = env.QQBOT_PERSONA_NAME;
  if (env.QQBOT_DATA) cfg.storage.root = env.QQBOT_DATA;

  cfg.__file = abs;
  cfg.__fileExists = Boolean(fromFile);
  applyPaths(cfg);
  validateConfig(cfg);
  return cfg;
}

/**
 * 把所有路径项解析成绝对路径。
 * - 空字符串 = 用默认位置（<storage.root>/xxx）
 * - 以 ~ 开头 = 主目录
 * - 相对路径 = 相对 config.json 所在目录（所以整个文件夹可以搬走）
 */
export function applyPaths(cfg) {
  const baseDir = cfg.__file ? path.dirname(path.resolve(String(cfg.__file))) : process.cwd();
  const rootRaw = String(cfg.storage?.root || './data').trim();
  // 注意：不要直接 expandHome(root)，它会把相对路径解析成"相对当前工作目录"，
  // 这里要的语义是"相对 config.json 所在目录"，这样整个文件夹才能搬走。
  const root =
    rootRaw === '~' || rootRaw.startsWith('~/') || rootRaw.startsWith('~\\')
      ? expandHome(rootRaw)
      : path.resolve(baseDir, rootRaw);
  cfg.storage = { ...(cfg.storage || {}), root };

  const pick = (value, fallback) => {
    const s = String(value ?? '').trim();
    if (!s) return fallback == null ? '' : path.join(root, fallback);
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return expandHome(s);
    return path.resolve(baseDir, s);
  };

  cfg.history.file = pick(cfg.history.file, 'history.json');
  cfg.memory.dir = pick(cfg.memory.dir, 'memory');
  cfg.media.dir = pick(cfg.media.dir, 'media');
  cfg.media.stickerDir = pick(cfg.media.stickerDir, 'stickers');
  cfg.media.webSearch.indexFile = pick(cfg.media.webSearch.indexFile, 'memes.json');
  cfg.log.file = pick(cfg.log.file, path.join('logs', 'qqbot.log'));
  cfg.napcat.dir = pick(cfg.napcat?.dir, 'napcat');
  cfg.__baseDir = baseDir;
  return cfg;
}

/** 数据目录汇总（面板 / 迁移工具 / 文档都用这个，避免各处拼路径）。 */
export function dataPaths(cfg) {
  return {
    root: cfg.storage.root,
    memory: cfg.memory.dir,
    archive: path.join(cfg.memory.dir, 'archive.jsonl'),
    long: path.join(cfg.memory.dir, 'long.json'),
    media: cfg.media.dir,
    stickers: path.join(cfg.media.dir, 'stickers.json'),
    memes: cfg.media.webSearch.indexFile,
    history: cfg.history.file,
    log: cfg.log.file,
    logsDir: path.dirname(cfg.log.file),
    stickerDir: cfg.media.stickerDir,
    napcat: cfg.napcat?.dir || '',
    lock: path.join(cfg.__baseDir || process.cwd(), '.qqbot.lock'),
  };
}

/** 配置校验：把明显的错误在启动时就抛出来，而不是等第一条消息。 */
export function validateConfig(cfg) {
  const errors = [];

  if (!['ws', 'http'].includes(cfg.onebot.mode)) {
    errors.push(`onebot.mode 只能是 "ws" 或 "http"，当前是 ${JSON.stringify(cfg.onebot.mode)}`);
  }
  if (cfg.onebot.mode === 'ws' && !/^wss?:\/\//.test(String(cfg.onebot.ws.url || ''))) {
    errors.push(`onebot.ws.url 必须是 ws:// 或 wss:// 开头，当前是 ${JSON.stringify(cfg.onebot.ws.url)}`);
  }
  if (cfg.onebot.mode === 'http') {
    if (!Number.isInteger(cfg.onebot.http.port) || cfg.onebot.http.port <= 0) {
      errors.push(`onebot.http.port 必须是正整数，当前是 ${JSON.stringify(cfg.onebot.http.port)}`);
    }
    if (!/^https?:\/\//.test(String(cfg.onebot.http.api || ''))) {
      errors.push(`onebot.http.api 必须是 http:// 或 https:// 开头`);
    }
  }

  if (!['openai', 'harness'].includes(cfg.engine)) {
    errors.push(`engine 只能是 "openai" 或 "harness"，当前是 ${JSON.stringify(cfg.engine)}`);
  }

  const priv = cfg.policy.private;
  if (!['whitelist', 'all', 'none'].includes(priv.allow)) {
    errors.push(`policy.private.allow 只能是 whitelist/all/none`);
  }
  if (!Array.isArray(priv.users)) errors.push('policy.private.users 必须是数组');
  if (priv.allow === 'whitelist' && priv.users.length === 0) {
    errors.push('policy.private.allow = whitelist 但 policy.private.users 是空的：没有谁能私聊成功。请填入你的 QQ 号，或改成 "all"');
  }

  const grp = cfg.policy.group;
  if (!['whitelist', 'all', 'none'].includes(grp.allow)) {
    errors.push(`policy.group.allow 只能是 whitelist/all/none`);
  }
  if (!Array.isArray(grp.groups)) errors.push('policy.group.groups 必须是数组');
  // 群里一个群都没配不是错误：那就是"先只用私聊"，启动摘要里会写明群聊是关的。

  if (cfg.engine === 'openai') {
    const o = cfg.engines.openai;
    if (!/^https?:\/\//.test(String(o.baseUrl || ''))) errors.push('engines.openai.baseUrl 必须是 http(s):// 开头');
    if (!o.model) errors.push('engines.openai.model 不能为空');
    if (!o.apiKey && !(o.apiKeyEnv && process.env[o.apiKeyEnv])) {
      errors.push(`engines.openai.apiKey 为空，也没有环境变量 ${o.apiKeyEnv || '(未配置 apiKeyEnv)'}`);
    }
  }

  if (cfg.reply.limit < 100) errors.push('reply.limit 太小（至少 100）');
  if (cfg.reply.maxParts < 1) errors.push('reply.maxParts 至少为 1');

  const mem = cfg.memory || {};
  if (mem.enabled !== false) {
    if (!Number.isFinite(Number(mem.shortDays)) || Number(mem.shortDays) < 1) {
      errors.push('memory.shortDays 至少为 1（短期记忆覆盖的天数）');
    }
    if (!Number.isFinite(Number(mem.shortMaxChars)) || Number(mem.shortMaxChars) < 200) {
      errors.push('memory.shortMaxChars 太小（至少 200）');
    }
  }

  if (errors.length) {
    const err = new Error(`配置有问题：\n- ${errors.join('\n- ')}`);
    err.code = 'E_CONFIG';
    throw err;
  }
  return cfg;
}
