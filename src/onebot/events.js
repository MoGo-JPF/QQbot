import { stripCQ } from '../util/text.js';

/** 解析 CQ 码里的 key=value 对（value 里的 &amp; , ] 会被转义，这里只取常用的几个）。 */
function cqParams(body) {
  const out = {};
  for (const part of String(body).split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i);
    if (out[k] != null) continue;
    out[k] = part
      .slice(i + 1)
      .replace(/&#44;/g, ',')
      .replace(/&#91;/g, '[')
      .replace(/&#93;/g, ']')
      .replace(/&amp;/g, '&');
  }
  return out;
}

/** OneBot 11 消息段 -> 纯文本 + 元信息。 */
function convertSegments(message, selfId) {
  const out = { text: '', atSelf: false, atAll: false, replyId: null, images: [], hasMedia: false };

  if (typeof message === 'string') {
    out.atSelf = new RegExp(`\\[CQ:at,qq=${selfId}[,\\]]`).test(message);
    out.atAll = /\[CQ:at,qq=all[,\]]/.test(message);
    const m = message.match(/\[CQ:reply,id=(-?\d+)/);
    if (m) out.replyId = m[1];
    for (const mm of message.matchAll(/\[CQ:image,([^\]]*)\]/g)) {
      const p = cqParams(mm[1]);
      out.images.push({
        url: p.url || '',
        file: p.file || '',
        subType: Number(p.sub_type ?? p.subType ?? 0) || 0,
        summary: p.summary || '',
        source: 'text',
      });
    }
    out.hasMedia = /\[CQ:(image|record|video|file),/.test(message);
    out.text = stripCQ(message).trim();
    return out;
  }

  if (!Array.isArray(message)) {
    out.text = String(message ?? '').trim();
    return out;
  }

  const chunks = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    const data = seg.data || {};
    switch (seg.type) {
      case 'text':
        chunks.push(String(data.text ?? ''));
        break;
      case 'at':
        if (String(data.qq) === String(selfId)) out.atSelf = true;
        else if (String(data.qq) === 'all') {
          out.atAll = true;
          chunks.push('@全体成员 ');
        } else chunks.push(`@${data.qq ?? ''} `);
        break;
      case 'reply':
        out.replyId = data.id != null ? String(data.id) : null;
        break;
      case 'image':
        out.hasMedia = true;
        out.images.push({
          url: data.url ? String(data.url) : '',
          file: data.file ? String(data.file) : '',
          subType: Number(data.sub_type ?? data.subType ?? 0) || 0,
          summary: data.summary ? String(data.summary) : '',
          source: 'array',
        });
        chunks.push('[图片]');
        break;
      case 'mface':
        out.hasMedia = true;
        // 商城表情（表情包）：url 是图片地址，summary 是它的名字
        if (data.url) {
          out.images.push({ url: String(data.url), file: '', subType: 1, summary: String(data.summary || ''), source: 'mface' });
        }
        chunks.push(data.summary ? `[表情:${data.summary}]` : '[表情]');
        break;
      case 'record':
        out.hasMedia = true;
        chunks.push('[语音]');
        break;
      case 'video':
        out.hasMedia = true;
        chunks.push('[视频]');
        break;
      case 'file':
        out.hasMedia = true;
        chunks.push(`[文件 ${data.name ?? ''}]`.trim());
        break;
      case 'face':
        chunks.push('[表情]');
        break;
      case 'forward':
        chunks.push('[合并转发]');
        break;
      case 'json':
      case 'xml':
        chunks.push('[卡片消息]');
        break;
      case 'poke':
        chunks.push('[戳一戳]');
        break;
      default:
        break;
    }
  }

  out.text = chunks.join('').replace(/[ \t]+\n/g, '\n').trim();
  return out;
}

/**
 * 把 OneBot 事件规整成内部消息对象。
 * 不是聊天消息（心跳、通知、自己发的消息）返回 null。
 */
export function normalizeEvent(raw, { selfId = 0, rawMessage = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.post_type === 'meta_event') return null;
  if (raw.post_type === 'notice' || raw.post_type === 'request') return null;
  if (raw.post_type !== 'message' && !raw.message_type) return null;

  const userId = raw.user_id != null ? String(raw.user_id) : '';
  const effectiveSelf = String(raw.self_id ?? selfId ?? '');
  if (!userId) return null;
  if (effectiveSelf && userId === effectiveSelf) return null;

  const isGroup = raw.message_type === 'group';
  const groupId = isGroup && raw.group_id != null ? String(raw.group_id) : '';
  const sender = raw.sender || {};
  const nickname = String(sender.card || sender.nickname || sender.name || userId);

  const seg = convertSegments(raw.message, effectiveSelf);
  const text = seg.text || '';

  return {
    kind: isGroup ? 'group' : 'private',
    conversationId: isGroup ? `group:${groupId}:${userId}` : `private:${userId}`,
    selfId: effectiveSelf,
    userId,
    groupId,
    nickname,
    messageId: raw.message_id != null ? String(raw.message_id) : '',
    rawMessage: rawMessage || (typeof raw.message === 'string' ? raw.message : ''),
    text,
    atSelf: seg.atSelf,
    atAll: seg.atAll,
    replyId: seg.replyId,
    images: seg.images,
    hasMedia: seg.hasMedia,
    time: Number(raw.time) || Math.floor(Date.now() / 1000),
  };
}

/** 给日志用的简短描述。 */
export function describeMessage(msg) {
  if (!msg) return '<null>';
  const where = msg.kind === 'group' ? `群${msg.groupId}` : '私聊';
  return `${where} ${msg.nickname}(${msg.userId})`;
}
