/**
 * 谁能让机器人说话。纯函数，方便单测。
 * 返回 { respond, reason }，reason 用来说明为什么回/不回，日志里很好用。
 */
export function decide(msg, policy = {}, { isReplyToMe = false } = {}) {
  if (!msg) return { respond: false, reason: 'empty' };

  const deny = new Set((policy.denyUsers || []).map(String));
  if (deny.has(String(msg.userId))) return { respond: false, reason: 'user-denied' };

  if (msg.kind === 'private') {
    const p = policy.private || {};
    const mode = p.allow || 'whitelist';
    if (mode === 'none') return { respond: false, reason: 'private-disabled' };
    if (mode === 'all') return { respond: true, reason: 'private-all' };
    const users = new Set((p.users || []).map(String));
    if (users.has(String(msg.userId))) return { respond: true, reason: 'private-whitelist' };
    return { respond: false, reason: 'private-not-in-whitelist' };
  }

  const g = policy.group || {};
  const mode = g.allow || 'whitelist';
  if (mode === 'none') return { respond: false, reason: 'group-disabled' };
  if (mode !== 'all') {
    const groups = new Set((g.groups || []).map(String));
    if (!groups.has(String(msg.groupId))) return { respond: false, reason: 'group-not-in-whitelist' };
  }

  // 关键：群里不能对每条消息都搭话，必须被点名
  const prefix = String(g.prefix ?? '');
  const hasPrefix = Boolean(prefix) && msg.text.startsWith(prefix);
  if (hasPrefix) return { respond: true, reason: 'group-prefix' };

  if (msg.atSelf) return { respond: true, reason: 'group-at' };

  if (g.replyToMe !== false && isReplyToMe) return { respond: true, reason: 'group-reply' };

  // prefix 配了但这条消息没带，就当作没叫它
  if (Boolean(prefix) && !msg.atSelf) return { respond: false, reason: 'group-not-addressed' };
  if (g.requireAt === false) return { respond: true, reason: 'group-open' };

  return { respond: false, reason: 'group-not-addressed' };
}

/** 触发前缀命中时，把前缀从文本里剥掉再交给模型。 */
export function stripPrefix(text, prefix) {
  const p = String(prefix ?? '');
  if (!p) return text;
  if (!String(text).startsWith(p)) return text;
  return String(text).slice(p.length).replace(/^[\s,，:：]+/, '');
}
