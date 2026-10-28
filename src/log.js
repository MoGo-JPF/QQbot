import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function fmt(v) {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 极简日志：同时写 stderr 和文件（文件可选）。
 * 之所以写文件，是因为桌面端从 GUI 启动时看不到 stdout。
 */
export function createLog({ level = 'info', file = '', toStderr = true } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => {
        stream = null;
      });
    } catch {
      stream = null;
    }
  }

  function write(lvl, args) {
    if ((LEVELS[lvl] ?? 9) > threshold) return;
    const line = `[${new Date().toISOString()}] ${lvl.toUpperCase().padEnd(5)} ${args.map(fmt).join(' ')}`;
    if (toStderr) process.stderr.write(`${line}\n`);
    if (stream) stream.write(`${line}\n`);
  }

  const log = {
    error: (...a) => write('error', a),
    warn: (...a) => write('warn', a),
    info: (...a) => write('info', a),
    debug: (...a) => write('debug', a),
    trace: (...a) => write('trace', a),
    child(prefix) {
      return {
        error: (...a) => write('error', [prefix, ...a]),
        warn: (...a) => write('warn', [prefix, ...a]),
        info: (...a) => write('info', [prefix, ...a]),
        debug: (...a) => write('debug', [prefix, ...a]),
        trace: (...a) => write('trace', [prefix, ...a]),
      };
    },
    close() {
      stream?.end();
      stream = null;
    },
  };

  return log;
}
