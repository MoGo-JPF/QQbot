#!/usr/bin/env node
// 直接用 OneBot 接口发一张图，验证「机器人 → 你」这条图片链路（不经过 bot 逻辑）。
//
//   node tools/send-image.js --to 3580323035 --image ./stickers/笑.png
//   node tools/send-image.js --to 3580323035 --image https://x/y.png --text 看这个
//   node tools/send-image.js --group 55555 --image ./stickers/生气.png
//
// 图片会被转成 base64:// 发出去 —— 和机器人内部发表情包用的是同一种段格式。

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { url: 'ws://127.0.0.1:3001', token: '', to: 0, group: 0, image: '', text: '', timeout: 15000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--token') out.token = next();
    else if (a === '--to') out.to = Number(next());
    else if (a === '--group') out.group = Number(next());
    else if (a === '--image') out.image = next();
    else if (a === '--text') out.text = next();
    else if (a === '-h' || a === '--help') {
      console.log('用法: node tools/send-image.js --to <QQ号> --image <本地路径|http(s)://> [--text 说明文字]');
      process.exit(0);
    }
  }
  return out;
}

function imageRefOf(ref) {
  const r = String(ref || '').trim();
  if (!r) throw new Error('缺少 --image');
  if (/^(https?:|base64:\/\/)/i.test(r)) return r;
  const p = path.resolve(r);
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.to && !args.group) {
  console.error('要给谁发？--to <QQ号> 或 --group <群号>');
  process.exit(1);
}
if (!args.image) {
  console.error('发哪张？--image <路径或URL>');
  process.exit(1);
}

const url = args.token ? `${args.url}?access_token=${encodeURIComponent(args.token)}` : args.url;
const ws = new WebSocket(url);

const done = (code) => {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
};

const timer = setTimeout(() => {
  console.error('超时：NapCat 没回应');
  done(1);
}, args.timeout);

ws.addEventListener('open', async () => {
  const raw = imageRefOf(args.image);
  // http(s) 交给 NapCat 自己下；本地文件转 data URL，NapCat 会存成 base64://
  const message = args.text ? [{ type: 'text', data: { text: args.text } }] : [];
  message.push({ type: 'image', data: { file: raw } });

  const echo = `send-${Date.now()}`;
  ws.send(
    JSON.stringify({
      action: args.group ? 'send_group_msg' : 'send_private_msg',
      params: args.group ? { group_id: args.group, message } : { user_id: args.to, message },
      echo,
    }),
  );

  ws.addEventListener('message', (ev) => {
    let payload;
    try {
      payload = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (payload.echo !== echo) return;
    clearTimeout(timer);
    if (payload.retcode === 0 || payload.status === 'ok') {
      console.log(`发出去了：message_id=${payload.data?.message_id ?? '?'}`);
      done(0);
    } else {
      console.error(`发送失败：retcode=${payload.retcode} ${payload.wording || payload.message || ''}`);
      done(1);
    }
  });
});

ws.addEventListener('error', () => {
  clearTimeout(timer);
  console.error(`连不上 NapCat（${args.url}）：确认 QQ 已登录、3001 端口在跑`);
  done(1);
});
