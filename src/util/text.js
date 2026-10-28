/** 文本工具：按长度切分消息、清理空白、截断。全部纯函数，方便测试。 */

/**
 * 把一段长文本切成若干条 QQ 消息。
 * - 优先在换行处切（避免把一句话劈成两半）
 * - 单行超长时硬切
 * - 超过 maxParts 时最后一条追加省略提示
 */
export function splitMessage(text, { limit = 1500, maxParts = 4 } = {}) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!src) return [];
  if (src.length <= limit) return [src];

  const parts = [];
  let buf = '';

  const flush = () => {
    if (buf) {
      parts.push(buf);
      buf = '';
    }
  };

  for (const rawLine of src.split('\n')) {
    let line = rawLine;
    while (line.length > limit) {
      flush();
      parts.push(line.slice(0, limit));
      line = line.slice(limit);
      if (parts.length >= maxParts) break;
    }
    if (parts.length >= maxParts) break;
    if (!line) {
      // 保留空行，但不要让它单独撑满一条
      if (buf) buf += '\n';
      continue;
    }
    if (!buf) {
      buf = line;
    } else if (buf.length + 1 + line.length <= limit) {
      buf += `\n${line}`;
    } else {
      flush();
      buf = line;
    }
  }
  flush();

  if (parts.length > maxParts) parts.length = maxParts;
  const joined = parts.join('\n');
  if (joined.length < src.trim().length) {
    const rest = src.replace(/\s+/g, '').length - joined.replace(/\s+/g, '').length;
    parts[parts.length - 1] += `\n…（内容过长，已省略约 ${Math.max(rest, 0)} 字）`;
  }
  return parts;
}

/**
 * 把一条回复拆成几个"气泡"——像真人聊天那样连发几条，而不是塞进一个框里。
 *
 * 切法优先级：
 *   1. 空行分段（模型自己的段落）
 *   2. 单换行分行（我们提示模型"一行一句"）
 *   3. 都没有、但很长 → 按句号/问号/感叹号切，再贪心打包成 ≤ maxChars 的块
 * 太短的碎片会和后一句粘在一起；超过 max 条时，多余的并进最后一条。
 *
 * @returns {string[]} 每条要单独发送的文本
 */
export function splitBubbles(text, { max = 3, minTotal = 60, maxChars = 70 } = {}) {
  const src = tidy(text);
  if (!src) return [];
  const limit = Math.max(1, Math.min(6, Number(max) || 3));
  if (limit === 1) return [src];
  // 带代码块的别拆，拆了就断在半截
  if (/```/.test(src)) return [src];

  let chunks = [];

  const paragraphs = src
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lines = src
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    // 模型自己分段了 —— 尊重它，哪怕每段很短
    chunks = paragraphs;
  } else if (lines.length > 1) {
    // 一行一句（我们在 system prompt 里就这么要求的）
    chunks = lines;
  } else {
    // 一整段：太短就不动；够长才按句末标点切，再打包
    if (src.length < Math.max(1, Number(minTotal) || 0)) return [src];
    const sentences = src.match(/[^。！？!?…~]+[。！？!?…~]+[”"』」）)]*|[^。！？!?…~]+$/g) ?? [src];
    let buf = '';
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      if (!buf) buf = s;
      else if (buf.length + s.length <= maxChars) buf += s;
      else {
        chunks.push(buf);
        buf = s;
      }
    }
    if (buf) chunks.push(buf);
  }

  // 只有「嗯。」这种两三个字的碎片才粘到前一条，别吞掉一整句
  const merged = [];
  for (const c of chunks) {
    if (merged.length && merged[merged.length - 1].length < 3) merged[merged.length - 1] += c;
    else merged.push(c);
  }

  if (merged.length <= limit) return merged;

  // 超过条数上限：均分成 limit 组，别把剩下的全堆到最后一条
  const per = Math.ceil(merged.length / limit);
  const out = [];
  for (let i = 0; i < merged.length; i += per) out.push(merged.slice(i, i + per).join('\n'));
  return out.slice(0, limit);
}

/** 去掉 CQ 码，只留纯文本（用于兜底解析字符串形式的消息）。 */
export function stripCQ(text) {
  return String(text ?? '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/\r\n/g, '\n');
}

/** 把文本压成单行摘要，用于日志。 */
export function preview(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 去掉行尾空白、连续空行压成一行空行。 */
export function tidy(text) {
  return String(text ?? '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 安全 JSON 解析。 */
export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
