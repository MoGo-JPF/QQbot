import fs from 'node:fs';
import path from 'node:path';

/**
 * 会话上下文存储（仅 openai 引擎用；harness 引擎的上下文在 Harness 那侧）。
 * 结构：{ [conversationId]: { messages: [{role, content}], updatedAt } }
 */
export function createHistory({ file, maxConversations = 500 } = {}, { log } = {}) {
  const abs = file ? path.resolve(file) : '';
  /** @type {Map<string, {messages: Array<{role:string,content:string}>, updatedAt:number}>} */
  let store = new Map();
  let loaded = false;
  let writeTimer = null;
  let dirty = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!abs) return;
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (v && Array.isArray(v.messages)) {
            store.set(k, {
              messages: v.messages.filter((m) => m && typeof m.content === 'string'),
              updatedAt: Number(v.updatedAt) || 0,
            });
          }
        }
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') log?.warn(`读取历史失败（忽略）: ${err.message}`);
    }
  }

  function flush() {
    writeTimer = null;
    if (!dirty || !abs) return;
    dirty = false;
    const obj = Object.fromEntries(store);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
      fs.renameSync(tmp, abs);
    } catch (err) {
      log?.warn(`保存历史失败: ${err.message}`);
    }
  }

  function schedule() {
    dirty = true;
    if (!writeTimer) {
      writeTimer = setTimeout(flush, 500);
      writeTimer.unref?.();
    }
  }

  function prune() {
    if (store.size <= maxConversations) return;
    const entries = [...store.entries()].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    const drop = store.size - maxConversations;
    for (let i = 0; i < drop; i += 1) store.delete(entries[i][0]);
  }

  return {
    get(conversationId) {
      load();
      return store.get(conversationId)?.messages ?? [];
    },

    append(conversationId, role, content, { maxTurns = 12 } = {}) {
      load();
      const entry = store.get(conversationId) || { messages: [], updatedAt: 0 };
      entry.messages.push({ role, content });
      // 只保留最近 maxTurns 轮（一轮 ≈ 用户 + 助手）
      const maxMessages = Math.max(2, maxTurns * 2);
      if (entry.messages.length > maxMessages) {
        entry.messages = entry.messages.slice(entry.messages.length - maxMessages);
      }
      entry.updatedAt = Date.now();
      store.set(conversationId, entry);
      prune();
      schedule();
      return entry.messages;
    },

    clear(conversationId) {
      load();
      store.delete(conversationId);
      schedule();
    },

    size() {
      load();
      return store.size;
    },

    flush,
    close() {
      if (writeTimer) clearTimeout(writeTimer);
      flush();
    },
  };
}
