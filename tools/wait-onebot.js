// 等 NapCat 的 OneBot WebSocket 就绪，最多等 --timeout 秒（默认 180）。
//
// 开机自启时用：NapCat 和 QQ 起来要十几秒到一分钟，机器人不能一到点就硬连。
//   node tools/wait-onebot.js --timeout 180
// 就绪 exit 0，超时 exit 1。

import process from 'node:process';

function parseArgs(argv) {
  const out = { url: 'ws://127.0.0.1:3001', timeout: 180, token: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--token') out.token = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const deadline = Date.now() + args.timeout * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tryOnce() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
      resolve({ ok, info });
    };

    const url = args.token ? `${args.url}?access_token=${encodeURIComponent(args.token)}` : args.url;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve({ ok: false, info: '连不上' });
      return;
    }

    const timer = setTimeout(() => done(false, '超时'), 5000);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'wait' }));
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.echo !== 'wait') return;
        if (msg.status === 'ok' || msg.status === 'async') {
          const d = msg.data || {};
          done(true, `${d.nickname ?? '?'} (${d.user_id ?? '?'})`);
        } else {
          done(false, `NapCat 回了 ${msg.status} ${msg.retcode ?? ''}`);
        }
      } catch {
        /* 忽略非 JSON */
      }
    });
    ws.addEventListener('error', () => done(false, '连接出错'));
    ws.addEventListener('close', () => done(false, '连接被关闭'));
  });
}

const started = Date.now();
let attempt = 0;
process.stdout.write(`等 NapCat 就绪（${args.url}，最多 ${args.timeout} 秒）`);

while (Date.now() < deadline) {
  attempt += 1;
  const r = await tryOnce();
  if (r.ok) {
    const sec = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`\n就绪：${r.info}（第 ${attempt} 次尝试，${sec} 秒）\n`);
    process.exit(0);
  }
  process.stdout.write('.');
  await sleep(2000);
}

process.stdout.write(`\n超时：${args.timeout} 秒内 NapCat 没就绪。检查 QQ 是否需要扫码登录。\n`);
process.exit(1);
