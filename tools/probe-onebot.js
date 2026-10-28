// 连上 OneBot 的 WebSocket，问一句登录信息，方便确认 QQ 号是否接对了。
// 用法: node tools/probe-onebot.js [ws://127.0.0.1:3001]
const url = process.argv[2] || 'ws://127.0.0.1:3001';
const echo = String(Date.now());

const ws = new WebSocket(url);
const timer = setTimeout(() => {
  console.error('超时：8 秒内没收到 get_login_info 的响应。');
  console.error('可能是 NapCat 没启动、端口不对，或 WebSocket 服务端没开。');
  process.exit(1);
}, 8000);

ws.addEventListener('open', () => {
  console.log(`已连上 ${url}`);
  ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo }));
});

ws.addEventListener('message', (ev) => {
  let data;
  try {
    data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
  } catch {
    return;
  }
  if (data.echo !== echo) return;
  clearTimeout(timer);
  if (data.status === 'ok' && data.data) {
    console.log(`登录状态: ok`);
    console.log(`QQ 号   : ${data.data.user_id}`);
    console.log(`昵称    : ${data.data.nickname}`);
    ws.close();
    process.exit(0);
  }
  console.error(`NapCat 回了失败: ${JSON.stringify(data)}`);
  ws.close();
  process.exit(1);
});

ws.addEventListener('error', (err) => {
  clearTimeout(timer);
  console.error('连接失败:', err.message || err);
  process.exit(1);
});
