/* 控制面板前端 —— 原生 JS，不依赖任何库 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TOKEN = new URLSearchParams(location.search).get('token') || '';

const state = {
  page: 'overview',
  status: null,
  stickers: [],
  stickersQuery: '',
  memKind: 'long',
  memItems: [],
  config: null,
  logAuto: true,
  timers: {},
};

// ---------- 工具 ----------

async function api(method, path, body) {
  const p = path.startsWith('/') ? path : `/${path}`;
  const r = await fetch(p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text.slice(0, 300) };
  }
  if (!r.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.payload = data;
    throw err;
  }
  return data;
}

const get = (p) => api('GET', p);
const post = (p, b = {}) => api('POST', p, b);
const patch = (p, b = {}) => api('PATCH', p, b);
const del = (p) => api('DELETE', p);

function toast(message, kind = '') {
  const box = $('#toast');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 300);
  }, kind === 'err' ? 6000 : 3200);
}

async function guard(fn, okMessage) {
  try {
    const r = await fn();
    if (okMessage) toast(okMessage, 'ok');
    return r;
  } catch (err) {
    toast(err.message || String(err), 'err');
    return null;
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtAgo(sec) {
  if (sec < 0) return '';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
  return `${Math.round(sec / 3600)} 小时前`;
}

function pill(text, kind = '') {
  return `<span class="pill ${kind}"><span class="dot ${kind}"></span>${esc(text)}</span>`;
}

// ---------- 导航 ----------

function showPage(name) {
  const known = ['overview', 'napcat', 'stickers', 'memory', 'logs', 'settings'];
  if (!known.includes(name)) name = 'overview';
  state.page = name;
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === name));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
  if (name === 'stickers') loadStickers().catch(() => {});
  if (name === 'memory') loadMemory().catch(() => {});
  if (name === 'logs') refreshLogs().catch(() => {});
  if (name === 'settings') loadConfig().catch(() => {});
  if (name === 'napcat') refreshQr(0);
}

$$('.nav-item').forEach((n) => n.addEventListener('click', () => showPage(n.dataset.page)));
window.addEventListener('hashchange', () => showPage(location.hash.replace(/^#/, '')));

// ---------- 总览 ----------

function renderStatus(st) {
  state.status = st;

  const bot = st.bot;
  $('#stBot').innerHTML = bot.running ? `<span class="pill ok">运行中 ${bot.pid}</span>` : `<span class="pill">没在跑</span>`;
  $('#stBotHint').textContent = bot.running
    ? bot.startedAt
      ? `由面板启动 · ${fmtTime(bot.startedAt)}`
      : '进程存在（可能是在别处启动的）'
    : '点下面的按钮启动';

  const ob = st.onebot;
  $('#stOnebot').innerHTML = ob.ok ? `<span class="pill ok">已连接</span>` : `<span class="pill bad">未连接</span>`;
  $('#stOnebotHint').textContent = ob.ok ? `${ob.nickname} (${ob.userId})` : ob.error || '';

  const n = st.napcat;
  // 二维码文件只是 NapCat 写过一次就会一直留着，所以"在线"以 OneBot 能连上为准
  const waitingQr = !ob.ok && n.qrExists && n.qrAgeSec >= 0 && n.qrAgeSec < 300;
  $('#stNapcat').innerHTML = ob.ok
    ? `<span class="pill ok">已登录</span>`
    : waitingQr
      ? `<span class="pill warn">等你扫码</span>`
      : n.exists
        ? `<span class="pill">未启动</span>`
        : `<span class="pill bad">找不到目录</span>`;
  $('#stNapcatHint').textContent = ob.ok
    ? 'OneBot 3001 已连上'
    : waitingQr
      ? `二维码 ${fmtAgo(n.qrAgeSec)}`
      : n.exists
        ? 'NapCat 目录就绪'
        : '找不到 NapCat 目录';

  $('#stEngine').textContent = st.engine === 'openai' ? 'openai（直连模型）' : st.engine === 'harness' ? 'harness（接 DSH）' : st.engine;
  $('#stPersona').textContent = st.persona?.name ? `人格：${st.persona.name}` : '';

  $('#cMsg').textContent = st.counts.messages;
  $('#cLong').textContent = st.counts.longItems;
  $('#cSticker').textContent = st.counts.stickers;
  $('#cMemes').textContent = st.counts.memes;

  $('#ovPaths').textContent = `数据：${st.storage.root}\n记忆：${st.storage.memory}\n图片：${st.storage.media}\n索引：${st.storage.memes}\n日志：${st.storage.log}`;
  $('#footInfo').innerHTML = `${esc(st.engine)} · ${st.counts.messages} 条记忆${st.onebot.ok ? ' · 在线' : ''}`;
  $('#ovSub').textContent = `${st.project}　|　${st.configFile}`;

  $('#napQQ').textContent = n.qq || '—';
  $('#napState').innerHTML = ob.ok
    ? `已登录：${esc(ob.nickname)} (${esc(ob.userId)})`
    : waitingQr
      ? `正在等扫码（二维码 ${fmtAgo(n.qrAgeSec)}）`
      : 'NapCat 没在跑，或者还没登录';
  $('#napMeta').innerHTML = [
    `<span>目录 ${esc(n.dir)}</span>`,
    n.webui ? `<span><a href="${esc(n.webui)}${n.webuiToken ? `?token=${esc(n.webuiToken)}` : ''}" target="_blank">NapCat 网页</a></span>` : '',
  ]
    .filter(Boolean)
    .join('');

  // 机器人按钮状态
  $('#btnBotStart').disabled = bot.running;
  $('#btnBotStop').disabled = !bot.running;
  $('#btnBotRestart').disabled = !bot.running;
}

async function refreshStatus() {
  try {
    const st = await get('/api/status');
    renderStatus(st);
  } catch (err) {
    $('#footInfo').textContent = '连不上面板服务';
  }
}

$('#btnBotStart').onclick = () => guard(async () => (await post('/api/bot/start'), refreshStatus()), '机器人已启动');
$('#btnBotStop').onclick = () => guard(async () => (await post('/api/bot/stop'), setTimeout(refreshStatus, 900)), '已发送停止信号');
$('#btnBotRestart').onclick = () => guard(async () => (await post('/api/bot/restart'), setTimeout(refreshStatus, 1600)), '正在重启');
$('#btnNapStart').onclick = () => guard(async () => {
  const r = await post('/api/napcat/start');
  toast(r.note || '已拉起 NapCat（可能要等 UAC）');
  setTimeout(() => refreshQr(1500), 2500);
});
$('#btnNapStop').onclick = () => guard(async () => {
  const r = await post('/api/napcat/stop');
  toast(r.note || '已在关 QQ');
});
$('#btnPanelStop').onclick = async () => {
  if (!confirm('关掉面板（这个网页服务）？\n机器人是独立进程，关了面板它照常回消息。\n\n下次要用再双击「启动面板.bat」。')) return;
  const btn = $('#btnPanelStop');
  btn.disabled = true;
  btn.textContent = '正在关闭…';
  try {
    await post('/api/panel/stop');
    document.body.innerHTML = '<div style="padding:48px 24px;font:16px/1.9 system-ui;color:#c9d3df;text-align:center">'
      + '<div style="font-size:22px;margin-bottom:12px">面板已关闭</div>'
      + '<div>这个页面可以关掉了。<br />机器人还在后台回消息，想再打开面板就双击文件夹里的「启动面板.bat」。</div>'
      + '</div>';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '关闭面板';
    toast('关不掉：' + err.message);
  }
};

// ---------- NapCat / 二维码 ----------

function refreshQr(delay = 0) {
  clearTimeout(state.timers.qr);
  const run = () => {
    const img = $('#qrBox img');
    const src = `/api/napcat/qr?t=${Date.now()}`;
    const probe = new Image();
    probe.onload = () => {
      if (img) img.src = src;
      else $('#qrBox').innerHTML = `<img src="${src}" alt="二维码" />`;
    };
    probe.onerror = () => {
      const n = state.status?.napcat;
      const onebot = state.status?.onebot;
      if (onebot?.ok) {
        $('#qrBox').innerHTML = `<div class="empty">已经登录啦<br />${esc(onebot.nickname || '')}</div>`;
      } else {
        $('#qrBox').innerHTML = `<div class="empty">${n && !n.exists ? '找不到 NapCat 目录' : '还没有二维码<br />点「启动 NapCat」'}</div>`;
      }
    };
    probe.src = src;
    state.timers.qr = setTimeout(() => (state.page === 'napcat' ? run() : null), 3000);
  };
  state.timers.qr = setTimeout(run, delay);
}

$('#btnNapStart2').onclick = $('#btnNapStart').onclick;
$('#btnNapStop2').onclick = $('#btnNapStop').onclick;
$('#btnNapWeb').onclick = () => {
  const n = state.status?.napcat;
  if (!n?.webui) return toast('配置里没有 NapCat 网页地址', 'err');
  window.open(n.webui + (n.webuiToken ? `?token=${encodeURIComponent(n.webuiToken)}` : ''), '_blank');
};

// ---------- 表情库 ----------

function stickerCard(it) {
  const img = it.hasFile ? `<img loading="lazy" src="/api/stickers/image?id=${encodeURIComponent(it.id)}" alt="${esc(it.note || it.tags.join(' '))}" />` : `<span class="hint">文件丢了</span>`;
  const tags = (it.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  return `<div class="sticker" data-id="${esc(it.id)}">
    <div class="thumb">${img}</div>
    <div class="ops">
      <button class="btn" data-act="edit">改标签</button>
      <button class="btn danger" data-act="del">删</button>
    </div>
    <div class="meta">
      <div class="tags">${tags || '<span class="tag">（无标签）</span>'}</div>
      <div class="from">${esc(it.from || '')}${it.note ? ` · ${esc(it.note.slice(0, 40))}` : ''}</div>
    </div>
  </div>`;
}

async function loadStickers() {
  const q = state.stickersQuery;
  const r = await get(`/api/stickers?q=${encodeURIComponent(q)}`);
  state.stickers = r.items;
  $('#stickerGrid').innerHTML = r.items.length
    ? r.items.map(stickerCard).join('')
    : `<div class="empty-state">${q ? '没搜到' : '库里还没有表情。上传几张，或者用右边「去网上找一张」。'}</div>`;
  $('#stickerCount').textContent = `共 ${r.items.length} 张${q ? `（筛选：${q}）` : ''}`;
}

$('#stickerGrid').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.sticker').dataset.id;
  const item = state.stickers.find((s) => s.id === id);
  if (btn.dataset.act === 'del') {
    if (!confirm(`删掉这条？\n${id}`)) return;
    guard(async () => (await del(`/api/stickers?id=${encodeURIComponent(id)}`), loadStickers()), '已删除');
  } else if (btn.dataset.act === 'edit') {
    const tags = prompt('新的标签（逗号分隔）', (item?.tags || []).join(','));
    if (tags === null) return;
    const note = prompt('备注（可留空）', item?.note || '');
    guard(async () => (await patch(`/api/stickers?id=${encodeURIComponent(id)}`, { tags, note }), loadStickers()), '改好了');
  }
});

$('#stickerSearch').addEventListener('input', () => {
  clearTimeout(state.timers.sticker);
  state.timers.sticker = setTimeout(() => {
    state.stickersQuery = $('#stickerSearch').value.trim();
    loadStickers().catch(() => {});
  }, 260);
});
$('#btnStickerReload').onclick = () => guard(loadStickers);

$('#btnOnlineSearch').onclick = async () => {
  const q = $('#onlineQuery').value.trim();
  if (!q) return toast('先填个关键词');
  const btn = $('#btnOnlineSearch');
  btn.disabled = true;
  btn.textContent = '在找…';
  try {
    const r = await post('/api/stickers/search', { q });
    toast(`找到并入库：${r.hit?.title || r.item?.id}`, 'ok');
    await loadStickers();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '去网上找一张';
  }
};

$('#fileInput').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  if (!files.length) return;
  let ok = 0;
  for (const f of files) {
    const dataUrl = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.readAsDataURL(f);
    });
    const guess = f.name.replace(/\.[^.]+$/, '').split(/[-_\s、,，]+/).filter(Boolean);
    try {
      await post('/api/stickers', { dataUrl, tags: guess, note: f.name, from: 'upload' });
      ok += 1;
    } catch (err) {
      toast(`${f.name}：${err.message}`, 'err');
    }
  }
  if (ok) toast(`上传了 ${ok} 张`, 'ok');
  await loadStickers();
});

// ---------- 记忆库 ----------

function longCard(it) {
  const tags = (it.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  return `<div class="item" data-id="${esc(it.id)}">
    <div class="body">
      <div class="text">${esc(it.text)}</div>
      <div class="meta">
        <span>#${esc(it.id)}</span>
        <span>${esc(it.kind || 'note')}</span>
        <span>${fmtTime(it.t)}</span>
        ${it.cid ? `<span>${esc(it.cid)}</span>` : ''}
        ${tags}
      </div>
    </div>
    <div class="ops">
      <button class="btn sm" data-act="edit">改</button>
      <button class="btn sm danger" data-act="del">删</button>
    </div>
  </div>`;
}

function msgCard(m) {
  const who = m.role === 'user' ? '他' : '我';
  return `<div class="item" data-t="${m.t}" data-cid="${esc(m.cid)}" data-role="${esc(m.role)}">
    <div class="body">
      <div class="text">${esc(m.text).slice(0, 800)}</div>
      <div class="meta"><span>${who}</span><span>${fmtTime(m.t)}</span><span>${esc(m.cid)}</span></div>
    </div>
    <div class="ops"><button class="btn sm danger" data-act="delmsg">删</button></div>
  </div>`;
}

async function loadMemory() {
  const q = $('#memSearch').value.trim();
  const cid = $('#memCid').value;
  const r = await get(`/api/memory?kind=${state.memKind}&q=${encodeURIComponent(q)}&cid=${encodeURIComponent(cid)}&limit=300`);
  state.memItems = state.memKind === 'long' ? r.items : r.messages;

  if (r.conversations?.length) {
    const cur = $('#memCid').value;
    $('#memCid').innerHTML =
      `<option value="">全部会话</option>` + r.conversations.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('#memCid').value = cur;
  }

  const box = $('#memList');
  if (!state.memItems.length) {
    box.innerHTML = `<div class="empty-state">${q ? '没搜到' : '还是空的'}</div>`;
  } else {
    box.innerHTML = state.memKind === 'long' ? state.memItems.map(longCard).join('') : state.memItems.map(msgCard).join('');
  }
  $('#memTabLong').className = `btn${state.memKind === 'long' ? ' primary' : ' ghost'}`;
  $('#memTabRecent').className = `btn${state.memKind === 'recent' ? ' primary' : ' ghost'}`;
  $('#memAddCard').style.display = state.memKind === 'long' ? '' : 'none';
  $('#memReload').textContent = `刷新（${state.memItems.length}）`;
}

$('#memTabLong').onclick = () => {
  state.memKind = 'long';
  loadMemory().catch(() => {});
};
$('#memTabRecent').onclick = () => {
  state.memKind = 'recent';
  loadMemory().catch(() => {});
};
$('#memReload').onclick = () => guard(loadMemory);
$('#memCid').onchange = () => loadMemory().catch(() => {});
$('#memSearch').addEventListener('input', () => {
  clearTimeout(state.timers.mem);
  state.timers.mem = setTimeout(() => loadMemory().catch(() => {}), 280);
});

$('#memAddBtn').onclick = () => {
  const text = $('#memNewText').value.trim();
  if (!text) return toast('写点内容', 'err');
  const tags = $('#memNewTags').value.trim();
  guard(async () => {
    await post('/api/memory', { text, tags });
    $('#memNewText').value = '';
    $('#memNewTags').value = '';
    await loadMemory();
    await refreshStatus();
  }, '记住了');
};

$('#memList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.item');
  if (btn.dataset.act === 'del') {
    const id = row.dataset.id;
    if (!confirm('删掉这条长期记忆？')) return;
    guard(async () => (await del(`/api/memory?id=${encodeURIComponent(id)}`), loadMemory(), refreshStatus()), '已删除');
  } else if (btn.dataset.act === 'edit') {
    const item = state.memItems.find((m) => m.id === row.dataset.id);
    const text = prompt('内容', item?.text || '');
    if (text === null) return;
    const tags = prompt('标签（逗号分隔）', (item?.tags || []).join(','));
    if (tags === null) return;
    guard(async () => (await patch(`/api/memory?id=${encodeURIComponent(row.dataset.id)}`, { text, tags }), loadMemory()), '改好了');
  } else if (btn.dataset.act === 'delmsg') {
    if (!confirm('删掉这条原始对话？')) return;
    const qs = new URLSearchParams({
      kind: 'message',
      t: row.dataset.t,
      cid: row.dataset.cid,
      role: row.dataset.role,
      text: row.querySelector('.text').textContent,
    });
    guard(async () => (await del(`/api/memory?${qs}`), loadMemory(), refreshStatus()), '已删除');
  }
});

// ---------- 日志 ----------

async function refreshLogs() {
  const consoleMode = $('#logConsole').checked;
  const r = await get(`/api/logs?lines=400${consoleMode ? '&file=console' : ''}`);
  const box = $('#logBox');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  box.innerHTML = r.lines
    .map((line) => {
      const cls = /\[error\]|\bERROR\b/.test(line) ? 'lvl-err' : /\[warn\]|\bWARN\b/.test(line) ? 'lvl-warn' : '';
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    })
    .join('\n');
  $('#logFile').textContent = r.file;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

$('#btnLogRefresh').onclick = () => guard(refreshLogs);
$('#logConsole').onchange = () => guard(refreshLogs);
$('#logAuto').onchange = () => {
  state.logAuto = $('#logAuto').checked;
  clearInterval(state.timers.log);
  if (state.logAuto) state.timers.log = setInterval(() => state.page === 'logs' && refreshLogs().catch(() => {}), 2500);
};

// ---------- 设置 ----------

state.wl = { users: [], groups: [] };

function renderChips(boxId, list, onRemove, labelOf = (v) => v) {
  const box = $(boxId);
  box.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'chip empty';
    empty.textContent = '（空）';
    box.appendChild(empty);
    return;
  }
  for (const v of list) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const text = document.createElement('span');
    text.textContent = labelOf(v);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.title = '移除';
    x.textContent = '×';
    x.onclick = () => {
      onRemove(v);
      renderWhitelist();
    };
    chip.append(text, x);
    box.appendChild(chip);
  }
}

function renderWhitelist() {
  renderChips('#userChips', state.wl.users, (v) => {
    state.wl.users = state.wl.users.filter((x) => x !== v);
  });
  renderChips('#groupChips', state.wl.groups, (v) => {
    state.wl.groups = state.wl.groups.filter((x) => x !== v);
  });
}

function addTo(kind, value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (!/^\d{4,15}$/.test(v)) {
    toast('得是纯数字号（QQ 号 / 群号）', 'err');
    return false;
  }
  const list = state.wl[kind];
  if (list.includes(v)) {
    toast('已经在里面了');
    return false;
  }
  list.push(v);
  renderWhitelist();
  return true;
}

async function loadSenders() {
  const r = await get('/api/senders').catch(() => null);
  const box = $('#senderChips');
  if (!r) {
    $('#senderHint').textContent = '读不到最近的会话';
    return;
  }
  box.innerHTML = '';
  const known = new Set([...state.wl.users, ...state.wl.groups]);
  const items = [
    ...(r.private || []).map((p) => ({ kind: 'users', id: p.qq, text: `私聊 ${p.qq}（${p.count} 条）` })),
    ...(r.groups || []).map((g) => ({ kind: 'groups', id: g.gid, text: `群 ${g.gid}（${g.count} 条）` })),
  ].slice(0, 30);
  if (!items.length) {
    box.innerHTML = '<span class="chip empty">还没人跟它说过话</span>';
  }
  for (const it of items) {
    const chip = document.createElement('span');
    chip.className = `chip clickable${known.has(it.id) ? ' on' : ''}`;
    chip.textContent = it.text;
    chip.onclick = () => {
      if (known.has(it.id)) return toast('已经在白名单里了');
      if (addTo(it.kind, it.id)) toast(`加进白名单：${it.id}（记得点保存）`, 'ok');
    };
    box.appendChild(chip);
  }
  $('#senderHint').textContent = items.length ? '点一下加到上面的白名单，最后记得点「保存设置」' : '';
}

async function loadConfig() {
  const r = await get('/api/config');
  state.config = r.config;
  const c = r.config;
  $('#setEngine').value = c.engine || 'openai';
  $('#setPersonaName').value = c.persona?.name || '';
  $('#setPersonaFile').value = c.persona?.file || '';

  const o = c.engines?.openai || {};
  $('#setApiBase').value = o.baseUrl || '';
  $('#setApiModel').value = o.model || '';
  $('#setApiTemp').value = o.temperature ?? '';
  $('#setApiMaxTokens').value = o.maxTokens ?? '';
  $('#setApiHistory').value = o.historyTurns ?? '';
  $('#setApiTimeout').value = o.timeoutMs ?? '';
  $('#setApiKeyEnv').value = o.apiKeyEnv || '';
  const keyBox = $('#setApiKey');
  keyBox.value = '';
  keyBox.readOnly = true;
  keyBox.placeholder = o.apiKeySet ? `已配置：${o.apiKey}（点【改 Key】换一个）` : '还没填 → 点【改 Key】粘贴';

  const h = c.engines?.harness || {};
  $('#setHarnessBase').value = h.baseUrl || '';
  $('#setHarnessPath').value = h.path || '';

  $('#setPrivateAllow').value = c.policy?.private?.allow || 'whitelist';
  $('#setGroupAllow').value = c.policy?.group?.allow || 'whitelist';
  state.wl.users = (c.policy?.private?.users || []).map(String);
  state.wl.groups = (c.policy?.group?.groups || []).map(String);
  renderWhitelist();

  $('#setRequireAt').value = String(c.policy?.group?.requireAt !== false);
  $('#setNapQQ').value = c.napcat?.qq || '';
  $('#setNapDir').value = c.napcat?.dir || '';
  $('#setOnebotWs').value = c.onebot?.ws?.url || '';
  $('#setDataRoot').value = c.__paths?.root || r.paths?.root || c.storage?.root || '';
  $('#setDataHint').textContent = r.paths
    ? `现在实际用：${r.paths.root}（改完要重启机器人才生效）${r.config.__legacy ? '｜旧数据在 ~/.dsh' : ''}`
    : '';
  const lanOn = !['', '127.0.0.1', 'localhost', '::1'].includes(String(c.panel?.host || '127.0.0.1'));
  $('#setLan').value = lanOn ? 'on' : 'off';
  $('#setPanelPin').value = c.panel?.pin || '';
  loadMobileInfo().catch(() => {});
  $('#setSaveHint').textContent = r.file;
  $('#apiModeTag').textContent = c.engine === 'harness' ? '现在用的是 harness，这页配置不生效' : 'openai 引擎用这个';
  loadSenders().catch(() => {});
}

function numOr(id, fallback) {
  const v = $(id).value.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

$('#btnUserAdd').onclick = () => {
  if (addTo('users', $('#userInput').value)) $('#userInput').value = '';
};
$('#userInput').onkeydown = (e) => {
  if (e.key === 'Enter') $('#btnUserAdd').click();
};
$('#btnGroupAdd').onclick = () => {
  if (addTo('groups', $('#groupInput').value)) $('#groupInput').value = '';
};
$('#groupInput').onkeydown = (e) => {
  if (e.key === 'Enter') $('#btnGroupAdd').click();
};

// 表单 → 配置补丁（保存和"测试连接"共用，这样没保存的改动也能测）
function formPatch() {
  const p = {
    engine: $('#setEngine').value,
    persona: { name: $('#setPersonaName').value.trim(), file: $('#setPersonaFile').value.trim() },
    engines: {
      openai: {
        baseUrl: $('#setApiBase').value.trim(),
        model: $('#setApiModel').value.trim(),
        temperature: numOr('#setApiTemp', 1),
        maxTokens: numOr('#setApiMaxTokens', 1200),
        historyTurns: numOr('#setApiHistory', 12),
        timeoutMs: numOr('#setApiTimeout', 120000),
        apiKeyEnv: $('#setApiKeyEnv').value.trim(),
      },
      harness: {
        baseUrl: $('#setHarnessBase').value.trim(),
        path: $('#setHarnessPath').value.trim(),
      },
    },
    policy: {
      private: { allow: $('#setPrivateAllow').value, users: state.wl.users },
      group: { allow: $('#setGroupAllow').value, groups: state.wl.groups, requireAt: $('#setRequireAt').value === 'true' },
    },
    napcat: { qq: $('#setNapQQ').value.trim(), dir: $('#setNapDir').value.trim() },
    onebot: { ws: { url: $('#setOnebotWs').value.trim() } },
    panel: { host: $('#setLan').value === 'on' ? '0.0.0.0' : '127.0.0.1', pin: $('#setPanelPin').value.trim() },
  };
  const newKey = $('#setApiKey').value.trim();
  if (newKey) p.engines.openai.apiKey = newKey; // 没动这个框就不改原来的
  return p;
}

// ---- 手机遥控 ----
async function loadMobileInfo() {
  const r = await get('/api/mobile').catch(() => null);
  const box = $('#mobileUrls');
  const hint = $('#mobileHint');
  if (!r) {
    box.textContent = '读不到（面板版本旧了？）';
    return;
  }
  const pinLine = r.pinSet ? '要输 PIN（设置页填的那个）' : '现在没设 PIN —— 建议填一个';
  if (!r.lanEnabled) {
    box.textContent = '现在只允许本机访问，手机连不上。把上面「允许手机访问」改成开着，保存后重启面板。';
    hint.textContent = pinLine;
    return;
  }
  const urls = r.urls || [];
  box.innerHTML = urls.length
    ? urls.map((u) => `${u.name}  <b>${u.url}</b>`).join('<br />')
    : '没找到局域网地址（这台电脑没连 Wi-Fi / 网线？）';
  hint.textContent = `${pinLine}。改完地址或 PIN 要重开面板才生效；手机打开后点「添加到主屏幕」就像个 App。`;
}

$('#btnMobileInfo').onclick = () => guard(loadMobileInfo(), '地址刷新了');
$('#btnMobileOpen').onclick = () => window.open('/m', '_blank');

$('#btnEditKey').onclick = () => {
  const box = $('#setApiKey');
  box.readOnly = false;
  box.value = '';
  box.placeholder = '粘贴新的 API Key，然后点【测试连接】或【保存设置】';
  box.focus();
};

$('#btnApiTest').onclick = () => {
  const hint = $('#apiTestHint');
  hint.textContent = '测试中…（最多等 90 秒）';
  return guard(async () => {
    const r = await post('/api/engine/test', { patch: formPatch() });
    hint.textContent = `通了：${r.model || r.engine}，${r.ms}ms`;
    toast(`它说：${r.reply || '（空回复）'}`.slice(0, 160), 'ok');
  }).then((r) => {
    if (r === null) hint.textContent = '没通，看上面的提示';
  });
};

$('#btnApiClearKey').onclick = () => {
  if (!confirm('清掉 config.json 里存的 API Key？（之后要靠环境变量或重新填）')) return;
  guard(async () => {
    await patch('/api/config', { patch: { engines: { openai: { apiKey: '__clear__' } } } });
    await loadConfig();
  }, 'key 清掉了');
};

$('#btnSaveSettings').onclick = () => {
  const p = formPatch();
  const hadKey = Boolean($('#setApiKey').value.trim());
  guard(async () => {
    await patch('/api/config', { patch: p });
    await loadConfig();
    await refreshStatus();
  }, hadKey ? '已保存（新 Key 已写入，重启机器人后生效）' : '已保存（模型 API 要重启机器人才生效）');
};

$('#btnDataRoot').onclick = () => {
  const root = $('#setDataRoot').value.trim();
  if (!root) return toast('填个目录', 'err');
  guard(async () => {
    const r = await post('/api/storage', { root });
    toast(`数据目录改成：${r.root}`, 'ok');
    await loadConfig();
    await refreshStatus();
  });
};

$('#btnMigrateDry').onclick = () =>
  guard(async () => {
    const r = await post('/api/migrate', { from: null, force: false, dryRun: true });
    const rep = r.report || {};
    toast(`会搬：归档 ${rep.archiveLines ?? 0} 条、长期 ${rep.longItems ?? 0} 条、表情 ${rep.stickerItems ?? 0} 张、索引 ${rep.memesCount ?? 0} 条`);
  });

$('#btnMigrate').onclick = () => {
  if (!confirm('把 ~/.dsh 里的旧数据复制到现在的数据目录？已有的不会覆盖。')) return;
  guard(async () => {
    const r = await post('/api/migrate', { force: false });
    const rep = r.report || {};
    toast(`搬完了：归档 ${rep.archiveLines ?? 0} 条、长期 ${rep.longItems ?? 0} 条、表情 ${rep.stickerItems ?? 0} 张`, 'ok');
    await refreshStatus();
    if (state.page === 'stickers') loadStickers().catch(() => {});
  });
};

// ---------- 启动 ----------

refreshStatus().catch(() => {});
state.timers.status = setInterval(() => refreshStatus().catch(() => {}), 3000);
state.timers.log = setInterval(() => state.page === 'logs' && state.logAuto && refreshLogs().catch(() => {}), 2500);
showPage(location.hash.replace(/^#/, '') || 'overview');
