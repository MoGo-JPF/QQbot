import { describeMessage, normalizeEvent } from './onebot/events.js';
import { clockLabel, oneLine } from './memory.js';
import { decide, stripPrefix } from './policy.js';
import { preview, splitBubbles, splitMessage, tidy } from './util/text.js';

/** OneBot 的 id 既接受数字也接受字符串；能用安全整数就用数字，兼容性最好。 */
function num(id) {
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : String(id);
}

const HELP_TEXT = [
  '我是接在 QQ 上的 AI 助手，直接跟我说话就行。',
  '',
  '可用指令：',
  '/help   显示这份帮助',
  '/reset  清空当前会话的上下文，重新开始',
  '/status 看我在不在线、用什么模型',
  '/ping   测一下延迟',
  '',
  '记忆相关：',
  '/记忆           看看我记住了多少东西',
  '/记 <内容>      让我长期记住一件事',
  '/忆 <关键词>    翻以前的聊天记录',
  '/回忆 [天数]    按天看最近聊了什么（默认 7 天）',
  '/忘 <编号或词>  删掉一条长期记忆',
  '',
  '平时直接说“记住：…”我也会自己存下来；问“你还记得…吗”我会去翻旧账。',
  '',
  '图片相关：',
  '  直接发图片/表情包，我能看懂（需要模型支持看图）',
  '/表情 [关键词]   让我发一张表情包（不带词就随便挑一张）',
  '/搜图 <关键词>   去网上的表情包库找一张发给你',
  '/图库            看看我的表情包库存',
  '/存表情 [标签]   把上一条图片/表情存进图库，标签用逗号隔开',
  '/看图            再仔细描述一下上一条图片',
  '',
  '我回复里可以用 [表情:笑] 这种标记发表情包，也可以用 [搜图:摆烂] 去网上找，[图:网址] 发指定图片。',
  '群里需要 @我 才会回复。',
].join('\n');

export function createBot({ cfg, log, engine, history, transport, memory, media, memes }) {
  const startedAt = Date.now();
  /** 我发出去的消息 id，用来识别“别人回复我” */
  const sentIds = new Set();
  const sentOrder = [];
  /** conversationId -> epoch ms */
  const lastActive = new Map();
  /** conversationId -> 最近一条图片（给 /存表情、/看图 用） */
  const lastImage = new Map();
  /** conversationId -> Promise，保证同一会话串行处理 */
  const chains = new Map();
  let handled = 0;
  let replied = 0;

  function rememberSent(id) {
    if (id == null) return;
    const key = String(id);
    sentIds.add(key);
    sentOrder.push(key);
    if (sentOrder.length > 300) {
      const drop = sentOrder.shift();
      sentIds.delete(drop);
    }
  }

  function parseCommand(text) {
    const commands = cfg.commands || {};
    if (commands.enabled === false) return null;
    const prefixes = Array.isArray(commands.prefixes) ? commands.prefixes : ['/'];
    for (const p of prefixes) {
      if (!p) continue;
      if (!text.startsWith(p)) continue;
      const body = text.slice(p.length).trim();
      const name = body.split(/\s+/)[0]?.toLowerCase() || '';
      if (!name) return null;
      return { name, rest: body.slice(name.length).trim() };
    }
    return null;
  }

  /** 这个会话本身有没有说话资格（群里忽略“是否 @ 我”）。 */
  function conversationAllowed(msg) {
    const probe = { ...msg, atSelf: true, text: '' };
    return decide(probe, cfg.policy).respond;
  }

  async function sendSegments(msg, segments) {
    const action = msg.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params =
      msg.kind === 'group'
        ? { group_id: num(msg.groupId), message: segments }
        : { user_id: num(msg.userId), message: segments };
    const data = await transport.call(action, params, 30000);
    rememberSent(data?.message_id);
    return data;
  }

  /** 去网上（梗鲸）找一张贴题的表情包，顺手存进图库，下次 [表情:…] 也能命中。 */
  async function findOnlineSticker(query) {
    const wcfg = cfg.media?.webSearch ?? {};
    if (!memes?.enabled || wcfg.enabled === false) return null;
    const stat = memes.stats();
    if (!stat.count) {
      // 索引还没建：先让她别干等，后台同步，这一轮就不发图了
      memes.ensure().catch(() => {});
      log.info('表情索引是空的，正在后台同步，这一轮先不发图');
      return { pending: true };
    }
    memes.ensure().catch(() => {});
    const hits = memes.search(query, {
      limit: Math.max(3, Number(wcfg.maxResults ?? 2)),
      min: Number(wcfg.minScore ?? 0.34),
    });
    if (hits.length === 0) {
      log.info(`网上没找到和「${query}」贴的表情包`);
      return { none: true };
    }
    // 站点偶尔抽风，一个下不下来就换下一个，别一句话都不发
    let lastErr = null;
    for (const hit of hits.slice(0, 3)) {
      try {
        const { buffer, mime } = await media.fetchImage(memes.imageUrl(hit));
        const stored = media.storeImage(buffer, mime, {
          id: `net:${hit.id}`,
          tags: memes.tagsOf(hit),
          note: hit.title,
          from: 'aigengtu',
        });
        log.info(`网上找图「${query}」→ #${hit.id} ${hit.title}（${Math.round(hit.score * 100)}%）`);
        return {
          hit,
          buffer,
          mime,
          item: stored,
          segment: { type: 'image', data: { file: `base64://${buffer.toString('base64')}` } },
        };
      } catch (err) {
        lastErr = err;
        log.warn(`下载 #${hit.id} 失败：${err.message}`);
      }
    }
    log.warn(`网上找图「${query}」全失败了：${lastErr?.message}`);
    return { failed: true, error: lastErr };
  }

  /** 把一串 [表情:…]/[搜图:…]/[图:…] 请求变成真正发出去的图片，最多 maxSendPerTurn 张。 */
  async function sendRequests(msg, requests) {
    if (!media?.enabled || requests.length === 0) return 0;
    const cap = Math.max(0, Number(cfg.media?.maxSendPerTurn ?? 2));
    let sent = 0;
    for (const req of requests.slice(0, cap)) {
      try {
        if (req.kind === 'search') {
          const got = await findOnlineSticker(req.value);
          if (!got || got.pending) continue;
          if (got.none) {
            if (sent === 0) await sendText(msg, `没找到「${req.value}」的表情包，换个词试试？`);
            continue;
          }
          if (got.failed) {
            if (sent === 0) await sendText(msg, '图找到了，但下载不下来（网络抽风），等会儿再试？');
            continue;
          }
          await sendSegments(msg, [got.segment]);
          sent += 1;
          log.info(`发图 ${describeMessage(msg)}：网上「${req.value}」→ #${got.hit.id} ${got.mime}`);
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        const out = await media.toImageSegment(req);
        if (!out) {
          log.debug(`图库里没找到「${req.value}」，跳过`);
          continue;
        }
        await sendSegments(msg, [out.segment]);
        sent += 1;
        log.info(`发图 ${describeMessage(msg)}：${req.kind}「${req.value}」${out.mime || ''}`);
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        log.warn(`发图失败（${req.kind}:${req.value}）：${err.message}`);
      }
    }
    return sent;
  }

  /**
   * 发一段文字。
   * @param {{at?: boolean, bubbles?: boolean}} [opts]
   *   bubbles=true 时先把回复拆成几条再逐条发（聊天回复用）；
   *   指令输出（帮助、列表）保持整段，别被拆散。
   */
  async function sendText(msg, text, { at = false, bubbles = false } = {}) {
    const content = tidy(text);
    if (!content) return;
    const limit = cfg.reply?.limit ?? 1500;
    const maxParts = cfg.reply?.maxParts ?? 4;
    const useBubbles = bubbles && cfg.reply?.split !== false;

    let parts;
    if (useBubbles) {
      const bubblesOut = splitBubbles(content, {
        max: cfg.reply?.splitMax ?? 3,
        minTotal: cfg.reply?.splitMinChars ?? 60,
      });
      parts = [];
      for (const b of bubblesOut) parts.push(...splitMessage(b, { limit, maxParts }));
    } else {
      parts = splitMessage(content, { limit, maxParts });
    }

    const gap = useBubbles ? (cfg.reply?.splitDelayMs ?? 450) : 250;
    for (let i = 0; i < parts.length; i += 1) {
      const segments = [];
      if (at && i === 0 && msg.kind === 'group') segments.push({ type: 'at', data: { qq: String(msg.userId) } });
      segments.push({ type: 'text', data: { text: parts[i] } });
      await sendSegments(msg, segments);
      if (i < parts.length - 1) await new Promise((r) => setTimeout(r, gap));
    }
  }

  function enqueue(conversationId, task) {
    const prev = chains.get(conversationId) ?? Promise.resolve();
    const run = prev.then(task, task);
    const settled = run.catch(() => {});
    chains.set(conversationId, settled);
    settled.then(() => {
      if (chains.get(conversationId) === settled) chains.delete(conversationId);
    });
    return run;
  }

  const MEMORY_COMMANDS = new Set([
    '记忆', 'mem', 'memory',
    '记', '记住', 'remember',
    '忆', 'recall', '搜',
    '回忆', 'timeline',
    '忘', '忘记', 'forget',
  ]);

  async function runMemoryCommand(msg, cmd) {
    if (!MEMORY_COMMANDS.has(cmd.name)) return false;
    if (!memory || memory.enabled === false) {
      await sendText(msg, '记忆库没开（config.json 里 memory.enabled = false），我现在只能记住当前这段对话。');
      return true;
    }

    if (cmd.name === '记忆' || cmd.name === 'mem' || cmd.name === 'memory') {
      const s = memory.stats();
      const lines = [
        `短期记忆：最近 ${s.shortDays} 天，共 ${s.messages} 条消息、${s.conversations} 个会话`,
        `长期记忆：${s.longItems} 条`,
        s.newest ? `最早一条 ${clockLabel(s.oldest)}，最新一条 ${clockLabel(s.newest)}` : '还一条都没记。',
        `存档目录：${s.dir}`,
      ];
      await sendText(msg, lines.join('\n'));
      return true;
    }

    if (cmd.name === '记' || cmd.name === '记住' || cmd.name === 'remember') {
      const body = cmd.rest.trim();
      if (!body) {
        await sendText(msg, '要记什么？格式：/记 我不吃香菜');
        return true;
      }
      const item = memory.remember({
        cid: msg.conversationId,
        text: body,
        kind: 'note',
        weight: 2,
        tags: ['手动'],
      });
      await sendText(msg, `记住了（#${item?.id ?? '?'}）：${body.slice(0, 200)}`);
      return true;
    }

    if (cmd.name === '忆' || cmd.name === 'recall' || cmd.name === '搜') {
      const q = cmd.rest.trim();
      if (!q) {
        await sendText(msg, '想翻什么？格式：/忆 火锅');
        return true;
      }
      const hits = memory.searchMessages(q, { cid: msg.conversationId, limit: 6 });
      const longs = memory.searchLong(q, { cid: msg.conversationId, limit: 4 });
      if (hits.length === 0 && longs.length === 0) {
        await sendText(msg, `没找到跟「${q}」有关的记录。`);
        return true;
      }
      const lines = [];
      if (longs.length > 0) {
        lines.push('长期记忆：');
        longs.forEach((h) => lines.push(`· #${h.id} [${clockLabel(h.t)}] ${oneLine(h.text, 120)}`));
      }
      if (hits.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('以前的原话：');
        hits.forEach((h) => {
          const who = h.role === 'assistant' ? '我' : '对方';
          lines.push(`· [${clockLabel(h.t)}] ${who}：${oneLine(h.text, 120)}`);
        });
      }
      await sendText(msg, lines.join('\n'));
      return true;
    }

    if (cmd.name === '回忆' || cmd.name === 'timeline') {
      const days = Number(String(cmd.rest).replace(/[^0-9]/g, '')) || 7;
      const span = Math.min(Math.max(days, 1), 90);
      const rows = memory.timeline(msg.conversationId, { days: span });
      const days30 = memory
        .searchLong('日记', { cid: msg.conversationId, limit: 8 })
        .filter((h) => h.kind === 'day');
      const lines = [];
      if (rows.length > 0) {
        lines.push(`最近 ${span} 天：`, ...rows);
      } else {
        lines.push(`最近 ${span} 天没聊过什么。`);
      }
      if (days30.length > 0) {
        lines.push('', '自动小结：', ...days30.map((h) => `· ${oneLine(h.text, 160)}`));
      }
      await sendText(msg, lines.join('\n'));
      return true;
    }

    if (cmd.name === '忘' || cmd.name === '忘记' || cmd.name === 'forget') {
      const key = cmd.rest.trim();
      if (!key) {
        await sendText(msg, '要忘掉什么？用 /忆 关键词 找到编号，然后 /忘 <编号>，或者直接 /忘 关键词');
        return true;
      }
      const ok = memory.forget(key);
      await sendText(msg, ok ? `忘了：${key}` : `没找到「${key}」，用 /忆 关键词 先翻一下？`);
      return true;
    }

    return false;
  }

  const MEDIA_COMMANDS = new Set(['表情', '表情包', 'sticker', '图库', 'stickers', '存表情', '看图', '搜图', '找图', '来张']);

  function mediaOff() {
    return !media || media.enabled === false;
  }

  async function runMediaCommand(msg, cmd) {
    if (!MEDIA_COMMANDS.has(cmd.name)) return false;
    if (mediaOff()) {
      await sendText(msg, '图片功能没开（config.json 里 media.enabled = false）。');
      return true;
    }

    // /表情 [关键词]：直接发一张
    if (cmd.name === '表情' || cmd.name === '表情包' || cmd.name === 'sticker') {
      const q = cmd.rest.trim();
      const item = media.find(q);
      if (!item) {
        const total = media.stats().items;
        await sendText(
          msg,
          total === 0
            ? '图库还是空的。把我发的表情存进来（/存表情 笑），或者把图片丢进项目的 stickers/ 文件夹。'
            : `图库里没有跟「${q}」对得上的（共 ${total} 张），换个说法试试？`,
        );
        return true;
      }
      const sent = await sendRequests(msg, [{ kind: 'sticker', value: q || item.id }]);
      if (sent === 0) await sendText(msg, '这张图我发不出去，可能文件不见了。');
      return true;
    }

    // /搜图 关键词：去网上找一张
    if (cmd.name === '搜图' || cmd.name === '找图' || cmd.name === '来张') {
      const q = cmd.rest.trim();
      if (!q) {
        await sendText(msg, '想找什么表情？比如 /搜图 摆烂、/搜图 晚安。');
        return true;
      }
      const got = await findOnlineSticker(q);
      if (!got) {
        await sendText(msg, '网上找图没开（config.json 里 media.webSearch.enabled = false）。');
        return true;
      }
      if (got.pending) {
        await sendText(msg, '表情库我还在同步，等一分钟再来要一次。');
        return true;
      }
      if (got.none) {
        const near = memes.search(q, { limit: 5, min: 0.15 });
        const hint = near.length > 0 ? `\n相近的还有：${near.map((h) => h.emotion || h.title.slice(0, 12)).join('、')}` : '';
        await sendText(msg, `没找到「${q}」的表情包。${hint}`);
        return true;
      }
      if (got.failed) {
        await sendText(msg, `图是找到了（#${got.hit?.id ?? '?'}），可它这会儿下载不下来，网络在抽风，等会儿再让我发。`);
        return true;
      }
      await sendSegments(msg, [got.segment]);
      log.info(`发图 ${describeMessage(msg)}：/搜图「${q}」→ #${got.hit.id}`);
      return true;
    }

    // /图库 [关键词]
    if (cmd.name === '图库' || cmd.name === 'stickers') {
      const q = cmd.rest.trim();
      const rows = q ? media.findMany(q, 10) : media.list().slice(-10).reverse();
      if (rows.length === 0) {
        await sendText(msg, q ? `没找到「${q}」相关的表情。` : '图库还是空的。');
        return true;
      }
      const s = media.stats();
      const lines = [`表情包库存 ${s.items} 张${q ? `（匹配「${q}」）` : '（最近 10 张）'}：`];
      rows.forEach((it) => {
        const tags = it.tags.filter((t) => t !== '表情').join('/') || '没标签';
        lines.push(`· #${media.list().indexOf(it)} ${tags}${it.note ? ` ${oneLine(it.note, 30)}` : ''}（用过 ${it.uses ?? 0} 次）`);
      });
      lines.push('', '发一张：/表情 关键词　塞新图：发图 + /存表情 标签');
      await sendText(msg, lines.join('\n'));
      return true;
    }

    // /存表情 [标签]
    if (cmd.name === '存表情') {
      const last = lastImage.get(msg.conversationId);
      if (!last) {
        await sendText(msg, '这个会话里我还没收到过图片。先发一张，再说 /存表情 笑,狗头');
        return true;
      }
      const tags = cmd.rest
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const item = media.storeImage(last.buffer, last.mime, {
        tags: tags.length > 0 ? tags : ['表情'],
        note: last.summary || '',
        from: 'saved',
        id: last.sha,
      });
      await sendText(msg, `收好了（#${item.id}）：标签 ${item.tags.join('、')}。以后 /表情 ${item.tags[0]} 就能发它。`);
      return true;
    }

    // /看图：让模型再说一遍图里有什么
    if (cmd.name === '看图') {
      const last = lastImage.get(msg.conversationId);
      if (!last) {
        await sendText(msg, '这个会话里我还没收到过图片。');
        return true;
      }
      if (typeof engine.summarize !== 'function') {
        await sendText(msg, '当前引擎（' + engine.name + '）不支持单独看图。');
        return true;
      }
      try {
        const dataUrl = media.toDataUrl(last.buffer, last.mime);
        const desc = await engine.summarize('用两三句中文说这张图里有什么，有没有文字。', {
          system: '你是一个只描述图片内容、不加评价的助手。',
          image: dataUrl,
        });
        await sendText(msg, desc || '这张图我看不出什么。');
      } catch (err) {
        await sendText(msg, `看图失败：${String(err.message).slice(0, 200)}`);
      }
      return true;
    }

    return false;
  }

  async function runCommand(msg, cmd) {
    const commands = cfg.commands || {};
    if (await runMemoryCommand(msg, cmd)) return true;
    if (await runMediaCommand(msg, cmd)) return true;
    if (cmd.name === 'help' && commands.help !== false) {
      await sendText(msg, HELP_TEXT);
      return true;
    }
    if (cmd.name === 'reset' && commands.reset !== false) {
      if (typeof engine.reset === 'function') await engine.reset(msg.conversationId);
      history?.clear(msg.conversationId);
      await sendText(msg, '好，之前的上下文我忘了，重新开始吧。');
      return true;
    }
    if (cmd.name === 'ping') {
      await sendText(msg, 'pong');
      return true;
    }
    if (cmd.name === 'status' && commands.status !== false) {
      const uptime = Math.round((Date.now() - startedAt) / 1000);
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = uptime % 60;
      const lines = [
        `引擎：${engine.name}${engine.managesHistory ? '（上下文保存在本地）' : '（上下文由 Harness 保存）'}`,
        `模型：${engine.model || engine.requestedModel || '—'}`,
        `在线：${h > 0 ? `${h}小时` : ''}${m}分${s}秒`,
        `已收到 ${handled} 条消息，回复 ${replied} 条`,
        `本地保存的会话数：${engine.managesHistory ? history.size() : '—'}`,
      ];
      const u = engine.usage;
      if (u?.calls) {
        lines.push(`这个进程跑过 ${u.calls} 次模型，输入 ${u.prompt} tokens、输出 ${u.completion} tokens`);
      }
      await sendText(msg, lines.join('\n'));
      return true;
    }
    return false;
  }

  function messageTime(msg) {
    const t = Number(msg?.time);
    if (!t) return Date.now();
    return t < 1e12 ? t * 1000 : t;
  }

  async function talk(msg, userText) {
    const t0 = Date.now();

    // 先把图片抓下来：能看懂的模型直接看图，看不懂的会收到一句文字提示
    let pics = [];
    if (media?.enabled && Array.isArray(msg.images) && msg.images.length > 0) {
      try {
        pics = await media.prepareIncoming(msg.images, { inline: cfg.media?.inline !== false });
        const usable = pics.filter((p) => p && !p.error);
        if (usable.length > 0) {
          const last = usable[usable.length - 1];
          lastImage.set(msg.conversationId, { buffer: last.buffer, mime: last.mime, sha: last.sha, summary: last.summary });
          media.learnFromIncoming(usable);
        }
        if (!userText.trim()) userText = usable.length > 0 ? '[发来一张图片]' : '[图片没取到]';
      } catch (err) {
        log.warn(`处理图片失败：${err.message}`);
      }
    }

    memory?.record(msg.conversationId, 'user', userText, { t: messageTime(msg) });

    // 每次对话之前先"过一遍"短期记忆：最近两周聊过什么 + 命中的旧记忆
    const memCtx = memory?.context({
      cid: msg.conversationId,
      text: userText,
      now: Date.now(),
      // openai 引擎本来就会带最近 N 轮原文，记忆里就跳过这部分免得重复
      skip: engine.managesHistory ? (cfg.engines?.openai?.historyTurns ?? 12) * 2 : 0,
    });
    if (memCtx?.block) {
      log.debug(
        `记忆注入 ${msg.conversationId}：短期 ${memCtx.shortCount} 行，旧记忆 ${memCtx.longHits} 条，翻旧账 ${memCtx.recallHits} 条`,
      );
    }

    const result = await engine.chat({
      conversationId: msg.conversationId,
      text: userText,
      images: pics,
      memory: memCtx?.block || '',
      meta: {
        kind: msg.kind,
        userId: msg.userId,
        groupId: msg.groupId,
        nickname: msg.nickname,
        messageId: msg.messageId,
      },
    });
    const raw = String(result?.text ?? '').trim();
    const elapsed = Date.now() - t0;
    if (!raw) {
      log.warn(`模型返回空内容，耗时 ${elapsed}ms`);
      await sendText(msg, '（我这边没有得到有效回复，稍后再试一次？）', { at: cfg.reply?.atInGroup });
      return;
    }

    // 回复里的 [表情:笑] / [图:https://…] 换成真图片发出去
    const parsed = media?.enabled ? media.parseReplyMarkers(raw) : { text: raw, requests: [] };
    const text = parsed.text;
    const sentPics = await sendRequests(msg, parsed.requests);
    if (text) {
      await sendText(msg, text, { at: cfg.reply?.atInGroup, bubbles: true });
      memory?.record(msg.conversationId, 'assistant', text);
    }
    if (!text && sentPics === 0) {
      await sendText(msg, '（我这儿憋了半天没说出话…）', { at: cfg.reply?.atInGroup });
      return;
    }
    log.info(`回复 ${describeMessage(msg)} 用时 ${elapsed}ms，${text.length} 字${sentPics > 0 ? `，${sentPics} 张图` : ''}`);
    replied += 1;
  }

  /** 不打指令也能记：说"记住：…"就直接存下来。 */
  async function handleNaturalMemory(msg, userText) {
    if (!memory || memory.enabled === false) return false;
    const t = userText.trim();
    const remember = /^(?:请|帮我)?(?:记住|记下|记一下)[，,：:\s]*([\s\S]+)$/.exec(t);
    if (remember && remember[1].trim()) {
      const body = remember[1].trim();
      const item = memory.remember({
        cid: msg.conversationId,
        text: body,
        kind: 'note',
        weight: 2,
        tags: ['口头'],
      });
      const reply = `好，记住了（#${item?.id ?? '?'}）：${oneLine(body, 120)}`;
      memory.record(msg.conversationId, 'user', userText, { t: messageTime(msg) });
      memory.record(msg.conversationId, 'assistant', reply);
      replied += 1;
      log.info(`口头记忆 ${describeMessage(msg)}：${preview(body)}`);
      await sendText(msg, reply, { at: cfg.reply?.atInGroup });
      return true;
    }
    const forget = /^(?:请|帮我)?(?:忘掉|忘记|别再记着)[，,：:\s]*([\s\S]+)$/.exec(t);
    if (forget && forget[1].trim()) {
      const key = forget[1].trim();
      const ok = memory.forget(key);
      log.info(`口头遗忘 ${describeMessage(msg)}：${preview(key)} -> ${ok}`);
      await sendText(msg, ok ? `好，忘掉了：${key}` : `我这儿没找到跟「${key}」有关的记忆。`, {
        at: cfg.reply?.atInGroup,
      });
      return true;
    }
    return false;
  }

  async function handle(raw) {
    let msg;
    try {
      msg = normalizeEvent(raw, { selfId: raw?.self_id });
    } catch (err) {
      log.error('事件解析失败', err);
      return;
    }
    if (!msg) return;

    handled += 1;
    const cmd = parseCommand(msg.text || '');

    if (cmd && conversationAllowed(msg)) {
      try {
        const ok = await runCommand(msg, cmd);
        if (ok) {
          log.info(`指令 /${cmd.name} <- ${describeMessage(msg)}`);
          return;
        }
      } catch (err) {
        log.error('指令执行失败', err);
        return;
      }
      // 不认识的指令交给模型自己处理
    }

    const decision = decide(msg, cfg.policy, { isReplyToMe: msg.replyId ? sentIds.has(String(msg.replyId)) : false });
    if (!decision.respond) {
      // 白名单挡下来的消息用 info 记，免得"为什么不理我"要靠猜
      if (decision.reason === 'private-not-in-whitelist' || decision.reason === 'group-not-in-whitelist' || decision.reason === 'user-denied') {
        log.info(`忽略（${decision.reason}）${describeMessage(msg)}: ${preview(msg.text)}`);
      } else {
        log.debug(`忽略（${decision.reason}）${describeMessage(msg)}: ${preview(msg.text)}`);
      }
      return;
    }

    let userText = msg.text || '';
    if (decision.reason === 'group-prefix') userText = stripPrefix(userText, cfg.policy.group.prefix);

    if (!userText.trim()) {
      // 只有图片/表情：交给 talk() 抓图之后补一句说明
      if (msg.hasMedia) userText = '';
      else {
        if (msg.kind === 'group' && msg.atSelf) await sendText(msg, '在的，你想说什么？');
        return;
      }
    }

    const cooldown = cfg.policy.cooldownMs ?? 0;
    if (cooldown > 0) {
      const last = lastActive.get(msg.conversationId) ?? 0;
      if (Date.now() - last < cooldown) {
        log.debug(`冷却中，跳过 ${describeMessage(msg)}`);
        return;
      }
    }
    lastActive.set(msg.conversationId, Date.now());

    log.info(`收到 ${describeMessage(msg)}: ${preview(userText || '[图片]')}`);

    await enqueue(msg.conversationId, async () => {
      try {
        if (await handleNaturalMemory(msg, userText)) return;
        await talk(msg, userText);
      } catch (err) {
        log.error(`回复失败 ${describeMessage(msg)}`, err);
        if (cfg.reply?.replyOnError !== false) {
          const short = String(err?.message || err).slice(0, 300);
          await sendText(msg, `抱歉，出错了：${short}`, { at: false }).catch((e) => log.error('错误提示也发不出去', e));
        }
      }
    });
  }

  return {
    handle,
    sendText,
    stats: () => ({ handled, replied, uptimeMs: Date.now() - startedAt }),
  };
}
