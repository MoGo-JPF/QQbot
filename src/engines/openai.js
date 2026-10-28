/**
 * OpenAI 兼容引擎：直接调用 /chat/completions（DeepSeek、OpenAI、Ollama、vLLM、OneAPI 都行）。
 * 上下文自己存，不依赖服务端。
 */
export function createOpenAiEngine(cfg, { log, history }) {
  const baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const model = cfg.model || 'deepseek-chat';
  const apiKey = cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : '') || '';
  const temperature = cfg.temperature ?? 1.0;
  const maxTokens = cfg.maxTokens ?? 1200;
  const stream = cfg.stream !== false;
  const timeoutMs = cfg.timeoutMs ?? 120000;
  const historyTurns = cfg.historyTurns ?? 12;
  const systemPrompt = cfg.systemPrompt || '你是一个 QQ 聊天助手。';
  /** 模型不支持图片时置 true，之后就不再传图，省得每轮都失败一次 */
  let visionBroken = false;
  /** 服务端实际用的模型（response 里的 model 字段，别名会被解析成真名） */
  let actualModel = '';
  let announcedModel = false;
  /** 累计 token 用量（服务端返回 usage 才有，便于跟平台账单对账） */
  const totals = { calls: 0, prompt: 0, completion: 0 };

  /**
   * 记下服务端回的 model。第一次发现"请求的和实际的不一样"时打一行日志，
   * 这样以后有人问「到底在用什么模型」看一眼日志就有答案。
   */
  function noteModel(actual) {
    if (!actual) return;
    actualModel = actual;
    if (announcedModel) return;
    announcedModel = true;
    if (actual !== model) log.info(`模型：请求 ${model}，服务端实际用 ${actual}`);
    else log.info(`模型：${actual}`);
  }

  function explainHttpError(status, body) {
    const snippet = String(body || '').slice(0, 300);
    if (status === 401 || status === 403) return `模型接口鉴权失败（${status}）：检查 apiKey。${snippet}`;
    if (status === 404) return `模型接口 404：检查 baseUrl 和 model 名字。${snippet}`;
    if (status === 429) return `模型接口限流（429），稍后再试。${snippet}`;
    if (status >= 500) return `模型服务出错（${status}）。${snippet}`;
    return `模型接口返回 ${status}：${snippet}`;
  }

  async function requestOnce(userText, messages, overrides = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), overrides.timeoutMs ?? timeoutMs);
    timer.unref?.();

    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: overrides.temperature ?? temperature,
          max_tokens: overrides.maxTokens ?? maxTokens,
          stream: overrides.stream ?? stream,
        }),
        signal: ac.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(explainHttpError(resp.status, body));
      }

      if (overrides.stream === false || !stream) {
        const payload = await resp.json();
        const text = payload?.choices?.[0]?.message?.content ?? '';
        noteModel(payload?.model);
        return { text, usage: payload?.usage, model: payload?.model };
      }

      const decoder = new TextDecoder();
      let buf = '';
      let text = '';
      let usage;

      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk?.choices?.[0]?.delta;
          if (delta?.content) text += delta.content;
          if (chunk?.usage) usage = chunk.usage;
          if (chunk?.model) noteModel(chunk.model, usage);
        }
      }
      return { text, usage, model: actualModel };
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`模型接口超时（${timeoutMs}ms）`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'openai',
    managesHistory: true,

    async chat({ conversationId, text, images = [], memory = '' }) {
      const pics = visionBroken ? [] : images.filter((i) => i?.dataUrl);
      const missed = images.filter((i) => i && !i.dataUrl);

      // 记忆档案放在 system 里：它是"背景"，不能冒充用户这句话
      const sys = memory ? `${systemPrompt}\n\n${memory}` : systemPrompt;
      const messages = [{ role: 'system', content: sys }];
      for (const m of history.get(conversationId)) messages.push(m);

      let userContent;
      if (pics.length > 0) {
        userContent = [];
        if (text) userContent.push({ type: 'text', text });
        for (const pic of pics) {
          userContent.push({ type: 'image_url', image_url: { url: pic.dataUrl, detail: 'auto' } });
        }
      } else {
        const notes = [];
        if (missed.length > 0) notes.push(`（对方发来 ${missed.length} 张图片，但没取到，别猜内容）`);
        if (visionBroken && images.length > 0) notes.push('（对方发了图片，但当前模型看不到图，只能请他描述一下）');
        userContent = [text, ...notes].filter(Boolean).join('\n');
      }
      messages.push({ role: 'user', content: userContent });

      const started = Date.now();
      let reply;
      let usage;
      try {
        ({ text: reply, usage } = await requestOnce(userContent, messages));
      } catch (err) {
        // 模型不认 image_url 时退化成纯文字，别让整轮对话挂掉
        const msg = String(err?.message || '');
        if (pics.length > 0 && /image|vision|modal|content|invalid|unsupported/i.test(msg)) {
          visionBroken = true;
          log.warn(`模型好像不支持图片（${msg.slice(0, 160)}），之后收到图只当文字提示。`);
          const plain = [text, '（对方发来一张图片，但你看不到）'].filter(Boolean).join('\n');
          ({ text: reply, usage } = await requestOnce(plain, [{ role: 'system', content: sys }, ...history.get(conversationId), { role: 'user', content: plain }]));
        } else {
          throw err;
        }
      }
      const clean = String(reply || '').trim();
      if (usage) {
        totals.calls += 1;
        totals.prompt += Number(usage.prompt_tokens || 0);
        totals.completion += Number(usage.completion_tokens || 0);
        log.debug(
          `tokens：本次 输入 ${usage.prompt_tokens ?? '?'} / 输出 ${usage.completion_tokens ?? '?'}；累计 ${totals.calls} 次、输入 ${totals.prompt}、输出 ${totals.completion}`,
        );
      }

      if (clean) {
        // 历史里只存文字占位，别把 base64 存进去
        const historyText = pics.length > 0 ? `${text || ''}${text ? ' ' : ''}[发来一张图片]`.trim() : String(text ?? '');
        history.append(conversationId, 'user', historyText, { maxTurns: historyTurns });
        history.append(conversationId, 'assistant', clean, { maxTurns: historyTurns });
      }

      log.debug(
        `openai 完成 ${conversationId} 用时 ${Date.now() - started}ms，覆盖 ${messages.length - 2} 条历史`,
        pics.length > 0 ? `（含 ${pics.length} 张图）` : '',
      );
      return { text: clean, engine: 'openai', usage, totals: { ...totals } };
    },

    /** 单独跑一次模型（不写入会话历史），给"整理记忆"之类的后台任务用。 */
    async summarize(prompt, { system = '你是一个只输出要点的助手。不要寒暄，不要解释你在做什么。', image } = {}) {
      const content = image
        ? [
            { type: 'text', text: String(prompt) },
            { type: 'image_url', image_url: { url: image, detail: 'auto' } },
          ]
        : String(prompt);
      const { text } = await requestOnce(String(prompt), [
        { role: 'system', content: system },
        { role: 'user', content },
      ], { stream: false, temperature: 0.3, maxTokens: 400 });
      return String(text || '').trim();
    },

    /** 配的模型名 / 服务端实际用的模型名（服务端会解析别名，比如 deepseek-chat → deepseek-flash） */
    get requestedModel() {
      return model;
    },
    get model() {
      return actualModel || model;
    },
    /** 累计 token（进程内），跟平台账单对账用 */
    get usage() {
      return { ...totals };
    },
  };
}
