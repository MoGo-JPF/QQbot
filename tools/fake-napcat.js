#!/usr/bin/env node
// 假 NapCat：一个零依赖的 OneBot 11 WebSocket 服务端（RFC 6455 手写）。
//
// 作用：不用真的 QQ、不用装 NapCat，就能把整个链路跑通。
//   node tools/fake-napcat.js            # 起服务，然后在终端里一行行打字当"用户发言"
//   node tools/fake-napcat.js --say 你好  # 连上后自动发一条，收到回复就退出
//
// 另一端这样连：config.json 里 onebot.ws.url = ws://127.0.0.1:3001
// 终端里的快捷指令：
//   #user 10001     切换"我是谁"
//   #group 55555    之后的消息发到群里（#group 0 回到私聊）
//   #say 你好        发一条（普通输入默认就是这个）
//   #quit           退出

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseArgs(argv) {
  const out = {
    port: 3001,
    user: 10001,
    nickname: '测试用户',
    self: 20002,
    group: 0,
    say: '',
    image: '',
    at: false,
    delay: 600,
    exitOnReply: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--port') out.port = Number(next());
    else if (arg === '--user') out.user = Number(next());
    else if (arg === '--nickname') out.nickname = next();
    else if (arg === '--self') out.self = Number(next());
    else if (arg === '--group') out.group = Number(next());
    else if (arg === '--say') out.say = next();
    else if (arg === '--image') out.image = next();
    else if (arg === '--at') out.at = true;
    else if (arg === '--delay') out.delay = Number(next());
    else if (arg === '--exit-on-reply') out.exitOnReply = true;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(
        '用法: node tools/fake-napcat.js [--port 3001] [--user 10001] [--group 55555] [--say 你好] [--image 路径或URL] [--exit-on-reply]',
      );
      process.exit(0);
    }
  }
  if (out.say) out.exitOnReply = out.exitOnReply || argv.includes('--exit-on-reply');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...parts) => console.log(`\x1b[90m[${stamp()}]\x1b[0m`, ...parts);

// ---------------------------------------------------------------- WS 编解码
function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControl(opcode, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

// 解析客户端发来的帧（客户端必须加 mask）。返回 { frames, rest }。
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (cursor + 2 > buffer.length) break;
      len = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + len > buffer.length) break;
    const data = Buffer.from(buffer.subarray(cursor, cursor + len));
    if (mask) for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
    frames.push({ fin, opcode, data });
    offset = cursor + len;
  }
  return { frames, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------- 会话状态
let messageSeq = 1000;
const clients = new Set();
let pendingReplyWaiter = null;

/** 把命令行给的东西变成 OneBot 认的图片地址：http(s)/data: 原样，本地文件转 data URL。 */
function imageRefOf(ref) {
  const r = String(ref || '').trim();
  if (!r) return '';
  if (/^(https?:|data:|base64:\/\/)/i.test(r)) return r;
  const p = path.resolve(r);
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function sendEvent(client, text, imageRef = '') {
  messageSeq += 1;
  const isGroup = args.group > 0;
  const image = imageRefOf(imageRef);
  const event = {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: 'normal',
    time: Math.floor(Date.now() / 1000),
    self_id: args.self,
    message_id: messageSeq,
    message_seq: messageSeq,
    raw_message: text,
    font: 0,
    user_id: args.user,
    message: [{ type: 'text', data: { text } }],
    sender: {
      user_id: args.user,
      nickname: args.nickname,
      card: args.nickname,
      role: 'member',
    },
  };
  if (isGroup) {
    event.group_id = args.group;
    event.sender.role = 'member';
    event.sender.card = args.nickname;
  }
  const message = [{ type: 'text', data: { text } }];
  if (args.at) message.unshift({ type: 'at', data: { qq: String(args.self) } });
  if (image) message.push({ type: 'image', data: { url: image, file: 'fake.png', sub_type: 0, summary: '' } });
  event.message = message;
  event.raw_message = `${args.at ? `[CQ:at,qq=${args.self}] ` : ''}${text}${image ? '[CQ:image,file=fake.png]' : ''}`;
  const payload = JSON.stringify(event);
  client.write(encodeFrame(payload));
  log(
    `\x1b[36m↑ ${args.nickname}(${args.user})${isGroup ? ` @群${args.group}` : ''}${args.at ? ' [@了你]' : ''}：\x1b[0m${text}${image ? ' [图片]' : ''}`,
  );
}

function replyToEcho(client, echo, data) {
  client.write(encodeFrame(JSON.stringify({ status: 'ok', retcode: 0, data, echo })));
}

function textOfSegments(segments) {
  if (typeof segments === 'string') return segments;
  if (!Array.isArray(segments)) return String(segments ?? '');
  return segments
    .map((seg) => {
      if (typeof seg === 'string') return seg;
      if (seg?.type === 'text') return seg.data?.text ?? '';
      if (seg?.type === 'at') return `@${seg.data?.qq === 'all' ? '全体成员' : seg.data?.qq} `;
      if (seg?.type === 'image') return '[图片]';
      if (seg?.type === 'face') return '[表情]';
      return `[${seg?.type ?? '未知'}]`;
    })
    .join('');
}

// ---------------------------------------------------------------- 服务
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('fake-napcat: 这是一个 OneBot 11 WebSocket 服务，请用 ws:// 连接。\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'),
  );
  socket.setNoDelay(true);
  clients.add(socket);
  log('\x1b[32m✓ 机器人已连上来\x1b[0m');

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        socket.end(encodeControl(0x8));
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeControl(0xa, frame.data));
        continue;
      }
      if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue;
      let msg;
      try {
        msg = JSON.parse(frame.data.toString('utf8'));
      } catch {
        continue;
      }
      handleAction(socket, msg);
    }
  });

  const drop = () => {
    clients.delete(socket);
    log('\x1b[90m✗ 机器人断开了\x1b[0m');
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

function handleAction(client, msg) {
  const { action, params = {}, echo } = msg;
  if (action === 'send_private_msg' || action === 'send_group_msg') {
    const text = textOfSegments(params.message);
    messageSeq += 1;
    const where = action === 'send_group_msg' ? `群${params.group_id}` : `私聊${params.user_id}`;
    console.log(`\x1b[35m↓ 机器人 → ${where}：\x1b[0m${text}`);
    replyToEcho(client, echo, { message_id: messageSeq });
    if (pendingReplyWaiter) pendingReplyWaiter(text);
    return;
  }
  if (action === 'get_login_info') {
    replyToEcho(client, echo, { user_id: args.self, nickname: '假机器人' });
    return;
  }
  if (action === 'get_status') {
    replyToEcho(client, echo, { online: true, good: true });
    return;
  }
  replyToEcho(client, echo, {});
}

server.listen(args.port, '127.0.0.1', () => {
  log(`\x1b[32m假 NapCat 已启动\x1b[0m ws://127.0.0.1:${args.port}`);
  log(`我是 QQ ${args.user}（${args.nickname}），机器人是 ${args.self}${args.group ? `，群 ${args.group}` : '，私聊'}`);
  log('\x1b[90m把 config.json 的 onebot.ws.url 指向上面的地址，然后 npm start。\x1b[0m');
  if (args.say) {
    log(`\x1b[90m${args.delay}ms 后自动发送：${args.say}\x1b[0m`);
    setTimeout(() => {
      const client = [...clients][0];
      if (!client) {
        log('还没有客户端连上来，先启动机器人再试。');
        process.exit(1);
      }
      if (args.exitOnReply) {
        const timer = setTimeout(() => {
          log('\x1b[31m等回复超时\x1b[0m');
          process.exit(1);
        }, 120000);
        pendingReplyWaiter = () => {
          clearTimeout(timer);
          setTimeout(() => process.exit(0), 300);
        };
      }
      sendEvent(client, args.say, args.image);
    }, args.delay);
    return;
  }
  startRepl();
});

function startRepl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  log('\x1b[90m直接打字就是发一条消息（Ctrl+C 退出）\x1b[0m');
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    const [cmd, ...restParts] = text.split(/\s+/);
    const rest = text.slice(cmd.length).trim();
    if (cmd === '#quit' || cmd === '#exit') process.exit(0);
    if (cmd === '#user') {
      args.user = Number(rest);
      log(`现在我是 QQ ${args.user}`);
      return;
    }
    if (cmd === '#group') {
      args.group = Number(rest) || 0;
      log(args.group ? `之后的消息发到群 ${args.group}` : '之后的消息走私聊');
      return;
    }
    if (cmd === '#at') {
      args.at = !args.at;
      log(args.at ? '之后的消息会 @ 一下机器人' : '之后的消息不 @ 机器人');
      return;
    }
    if (cmd === '#say') {
      sendToFirstClient(rest);
      return;
    }
    if (cmd === '#image') {
      const [p, ...cap] = rest.split(/\s+/);
      sendToFirstClient(cap.join(' '), p);
      return;
    }
    sendToFirstClient(text);
  });
  rl.on('close', () => process.exit(0));
}

function sendToFirstClient(text, imageRef = '') {
  const client = [...clients][0];
  if (!client) {
    log('\x1b[31m机器人还没连上来\x1b[0m');
    return;
  }
  sendEvent(client, text, imageRef);
}

process.on('SIGINT', () => {
  for (const client of clients) {
    try {
      client.end(encodeControl(0x8));
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
});
