# QQ 聊天机器人（OneBot 11 / NapCat）

一个**零 npm 依赖**的 QQ 聊天机器人，自带控制面板、记忆库、表情库，**整个文件夹拷走就能跑**（NapCat 和数据都在里面）。

两种大脑可选：

| 引擎 | 是谁在回话 | 适合 |
| --- | --- | --- |
| `harness`（默认） | 当前正在运行的 **DeepSeek Harness** 里的 agent（能用工具、能看你的工作目录） | 想让 QQ 变成 Harness 的遥控器 |
| `openai` | 任意 **OpenAI 兼容 API**（DeepSeek / OpenAI / 本地 Ollama / one-api 都行） | 想独立跑一个纯聊天机器人 |

QQ 侧通过 **NapCat**（OneBot 11 协议）接入：NapCat 负责登录 QQ、收发消息，本项目负责决定"要不要回、回什么"。

```
QQ 用户 ──> NapCat ──WebSocket──> 本项目 src/ ──┬─> OpenAI 兼容 API
                                               └─> DeepSeek Harness（dsh-plugin 暴露的本地 HTTP 路由）

浏览器 ──> 控制面板 panel/  ──> 启停机器人 / 扫二维码 / 管表情 / 管记忆 / 看日志 / 改设置
```

文件夹里都有什么：

```
QQbot\
├─ 启动面板.bat      双击 → 打开控制面板（推荐入口）
├─ 菜单.bat          双击 → 数字菜单（启动机器人 / 启动 NapCat / 迁移数据 …）
├─ napcat\           已经装好的 NapCat（不用另外下载）
├─ data\             ← 你的全部数据：记忆、表情、日志、会话历史、网搜索引
├─ persona.md        它的人设，随便改
└─ src\ panel\ tools\ test\ ...
```

> 换电脑 / 备份：整个 `QQbot` 文件夹拷走，`data\` 就是全部家当。旧的、散在 `~/.dsh` 里的数据可以在面板「设置」里一键搬进来。

---

## 1. 快速开始

### 1.0 最省事的路：双击 `启动面板.bat`

面板起来后浏览器会自己打开 <http://127.0.0.1:8899>，里面有：

| 页面 | 能干什么 |
| --- | --- |
| 总览 | 机器人在不在跑、QQ 在不在线、一键启停、消息/记忆/表情计数、**关闭面板** |
| 登录·二维码 | 实时刷新的 QQ 登录二维码（扫码就在这里）；启动/停止 NapCat |
| 表情包库 | 看全部表情、上传、改标签、删除；「去网上找一张」按关键词联网找 |
| 记忆库 | 长期记忆的增删改查；翻最近聊过的原话（可删） |
| 日志 | 机器人日志 / 控制台日志，自动刷新，错误高亮 |
| 设置 | 引擎、**模型 API（地址 / Key / 模型 / 温度，可一键测试连接）**、人格、白名单（可增删、可从「最近跟它说过话的」里一键加）、NapCat 路径与 QQ 号、OneBot 地址、数据目录、迁移旧数据 |

点面板上的「启动 NapCat」→ 如果弹 UAC 点「是」→ 到「登录·二维码」页扫码 → 再「启动机器人」，就能聊了。

面板只监听 `127.0.0.1:8899`，别人连不上。想在手机上用，见下面 1.0.1。

### 1.0.1 手机上用：一个能随时停掉它的「遥控器」

手机和电脑连同一个 Wi-Fi，然后用手机浏览器打开 `http://<这台电脑的IP>:8899/m`，可以「添加到主屏幕」，之后就像个 App：看一眼机器人还在不在、QQ 掉线没有，一键停止 / 重启。

- 开这个功能：面板 → 设置 → **手机遥控** → 「允许手机访问」改成开着 → 保存 → 重开面板。页面上会列出手机该输入的地址。
- 第一次开的时候会自动生成一个 6 位 PIN，面板控制台会打印出来（**手机打开时会要你输这个**）。PIN 也能在设置里自己改；不设 PIN 而开着局域网的话，同 Wi-Fi 的人都能把机器人关掉。
- 它是个网页（PWA），不用装 APK；Android Chrome / iOS Safari 都能「添加到主屏幕」。
- 页面底部有「面板本身 → 关闭控制面板」：点两次就把电脑上的面板关掉（机器人不受影响）。之后想再打开，在电脑上双击 `启动面板.bat`。
- 端口没通的话，通常是 Windows 防火墙拦了——在「允许应用通过防火墙」里给 node 放行，或者直接关掉这一层。

下面的 1.1–1.4 是手动路线，想自己控制的时候用。

### 1.1 NapCat 已经装好了（`napcat\`）

第一次用需要登录一次 QQ（扫码）。最方便就是在面板「登录·二维码」页扫码，或者：

```powershell
start-napcat-log.bat      # 会关掉已开的 QQ，再由 NapCat 拉起 QQ
```

登录过之后 QQ 会记住登录记录，之后 `start-napcat-log.bat`（以及 `restart-napcat.bat`、菜单第 3 项、面板的「启动 NapCat」）都会带 `-q <QQ号>` 尝试快速登录；哪天失效就再扫一次。

> 建议用小号：第三方客户端有被风控的可能，别拿主号冒险。

### 1.2 OneBot 的 WebSocket 服务端（已配好，不用动）

`napcat\config\onebot11_<QQ号>.json` 里已经是：

- 主机 `127.0.0.1`、端口 `3001`、消息格式 `array`、Token 留空

只想核对的话：NapCat 配置 → 网络配置 → WebSocket 服务器。

### 1.3 配置

`config.json` 已经在文件夹里，面板「设置」页能改大部分；直接编辑也行：

```powershell
notepad config.json
```

数据（记忆 / 表情 / 日志 / 历史 / 网搜索引）默认全在 `data\` 下，**不用写绝对路径**——`storage.root` 改成别的相对目录，整个数据就搬过去；面板「设置 → 数据目录」也能改。

白名单里填的是**这台机器上的真实 QQ 号**（私聊 `3580323035`），群聊先关着。换人的时候改这一处就行。也可以用假 NapCat 做无 QQ 联调（第 2 节），那时把白名单改成假 NapCat 的测试号 `10001`。

真的要用 QQ 聊天，把这两处换成你自己的：

```json
"policy": {
  "private": { "allow": "whitelist", "users": [你的QQ号] },
  "group":   { "allow": "whitelist", "groups": [允许的群号] }
}
```

- 只想先私聊、不玩群？`groups` 留空即可——群聊就是不工作，不报错。
- 只想在群里用？把 `private.allow` 设成 `"none"`。
- 私聊白名单留空会**启动失败**并直接告诉你改哪里（故意的：免得陌生人把你的额度聊光）。
- 被白名单挡掉的消息会在日志里写 `忽略（private-not-in-whitelist）…`，所以"它为什么不理我"有据可查。

### 1.4 启动

```powershell
npm start
```

看到这些就通了：

```
INFO  就绪：引擎 harness，传输 ws
INFO  OneBot WebSocket 已连接
INFO  登录账号：你的昵称 (你的QQ号)
```

然后在 QQ 上给这个号发一条消息。

---

## 2. 不登录 QQ 也能先试

仓库自带一个**假 NapCat**（自己实现的 OneBot 11 WebSocket 服务端，纯 Node，无需安装）：

```powershell
# 终端 A：假装是 QQ 那边
npm run fake-napcat
# 终端 B：启动机器人
npm start
```

终端 A 里直接打字就当作用户发言，机器人回复会打印出来：

```
↑ 测试用户(10001)：你好
↓ 机器人 → 私聊10001：你好呀
```

快捷指令：`#user 10001` 换身份、`#group 55555` 之后发到群里、`#group 0` 回私聊、`#at` 切换要不要 @ 机器人、`#quit` 退出。

一行式自测（发一条，收到回复就退出）：

```powershell
node tools/fake-napcat.js --user 10001 --say "你好" --delay 4000 --exit-on-reply
```

> 这个工具只用本机端口 3001，和真 NapCat 二选一，别同时开。

---

## 3. 群里怎么叫它

群消息默认**必须 @ 机器人**（`policy.group.requireAt`）。除此之外，`policy.group` 还能配：

| 配置 | 作用 |
| --- | --- |
| `groups` | 只在这些群里工作 |
| `requireAt: true` | 必须 @ 它 |
| `prefix: "小助"` | 或者以 `小助` 开头（会被剥掉再交给模型） |
| `replyToMe: true` | 回复它自己的消息也算叫它 |
| `allow: "all"` | 不限制群号（谨慎） |

私聊同理：`private.allow` 取 `"whitelist"` 或 `"all"`，`denyUsers` 永远拉黑。

同一个人私聊、以及每个群里每个人，各自对应 Harness 里**独立的一个会话**，互不串台：

- 私聊 → `private:<QQ号>`
- 群聊 → `group:<群号>:<QQ号>`

---

## 4. 内置命令

在聊天里直接发（前缀可配 `commands.prefixes`，默认 `/`、`!`、`！`）：

| 命令 | 作用 |
| --- | --- |
| `/help` | 用法 |
| `/reset` | 忘掉上下文（Harness 引擎会取消旧会话，下次开新的） |
| `/status` | 当前引擎、会话号、历史条数 |
| `/ping` | 活着的证明 |
| `/记忆` | 记忆库存了多少东西 |
| `/记 <内容>` | 让它在长期记忆里存一条 |
| `/忆 <关键词>` | 翻以前的聊天记录 |
| `/回忆 [天数]` | 按天看最近聊了什么（默认 7 天） |
| `/忘 <编号或词>` | 删掉一条长期记忆 |
| `/表情 [关键词]` | 从表情库发一张图（`/表情 生气`、`/表情 #3`） |
| `/搜图 <关键词>` | 去网上的表情包库（梗鲸）找一张贴题的发给你 |
| `/图库 [关键词]` | 看看表情库里都有什么 |
| `/存表情 [标签]` | 把你刚发的那张图存进表情库 |
| `/看图` | 让它单独描述一下你刚发的图 |

不用加斜杠也能用：说「记住：我不吃香菜」它会直接存；问「你还记得…吗」它会去翻旧账。

---

## 4.5 记忆：它怎么"记得"你

默认开启，存档在 `~/.dsh/qqbot-memory/`：

| 文件 | 内容 |
| --- | --- |
| `archive.jsonl` | **全部**原始对话，一行一条，永不自动删除 —— 这就是可以随时遍历的历史 |
| `long.json` | 长期记忆条目（手动记的 + 每天自动小结的日记） |

工作方式分两层：

**短期记忆（近 14 天）** —— 每次回你之前，先把最近两周你们聊过的原话整理成一段，塞进模型的上下文里。
所以哪怕会话被 `/reset`、或者隔了三天没说话、或者重启过机器人，它也知道你们聊到哪儿了。
上限 `memory.shortMaxChars`（默认 1800 字），超了从最旧的开始丢；`memory.shortDays` 改覆盖天数。

**长期记忆（永久）** —— 两种来源：

1. 你明确让它记：`/记 我不吃香菜`，或者说「记住：我妈生日是 3 月 8 号」；
2. 每天自动小结：第二天它会把前一天聊的内容压缩成一条「X 月 X 日这天聊了…」的日记存进去。

被问到「你还记得…吗」这类话（触发词：记得 / 之前 / 上次 / 以前 / 回忆 / 聊过…），
除了短期记忆，它还会拿你这句话去**全文检索 archive.jsonl**，把最相关的几句原话一起翻出来 ——
所以一年前的对话也翻得到，只要存档还在。

想自己翻：`/忆 火锅`（关键词检索）、`/回忆 30`（按天列最近 30 天）。想让它彻底忘掉：`/忘 <编号>`。

存档是纯文本，可以直接用记事本打开、用 `grep` 搜、备份就复制整个目录。关掉：`"memory": { "enabled": false }`。

从旧版本升级上来的话，先把 `history.json` 里的旧对话导进去：

```powershell
node tools/import-history.js --dry-run   # 先看会导多少条
node tools/import-history.js             # 真导入
```

---

## 4.6 图片与表情包：能看图，也会发表情

### 4.6.1 它能"看见"你发的图

你直接发图（照片、截图、表情包都行），它会把图下载下来、转成模型能读的格式一起送过去。
默认模型 `deepseek-flash` 本身支持读图，不用另外配视觉模型。

> 模型名别用 `deepseek-chat` 这种别名（它现在指向 `deepseek-flash`，但以后指向哪说不准），直接写死 `deepseek-flash`。
> 想确认"到底在跑哪个模型"：`node tools/check-model.js`（会打印「配置里写的」和「服务端实际」，别名会标出来）。
> 另外 `deepseek-v4-pro` **不能看图**，别拿它当聊天模型。机器人日志里第一句回复之后也会打一行 `模型：deepseek-flash`。

它会顺手把这张图存到 `~/.dsh/qqbot-memory/media/` 一份，所以：

- 你接着问「这图里那个人在干嘛」，它不用重新下载；
- 你发的是**表情包**（`sub_type=1`，或带名字的商城表情），它会自动收进表情库，以后自己会用。

`/看图` —— 让它再单独描述一次上一张图（不带上聊天上下文）。

### 4.6.2 它会自己发表情

回应里它可以写三种标记，机器人会真的把图发出去：

| 标记 | 效果 |
| --- | --- |
| `[表情:狗头]` | 从**表情库**里找最像的图发出去（找不到就不发） |
| `[搜图:摆烂]` | 去**网上的表情包库**搜一张贴题的，下下来发出去（见 4.6.6） |
| `[图:https://…]` | 下载这个地址的图发出去（也接受本地路径） |

标记本身不会出现在聊天里。一轮最多发 `media.maxSendPerTurn` 张（默认 2）。

### 4.6.3 表情库怎么攒

目录 `stickers/`，**文件名就是标签**，用 `-`、`_`、空格、逗号分隔，可以写多个：

```
stickers/
  笑-狗头.png     → /表情 笑   /表情 狗头  都能找到
  无语.png
```

放进去重启机器人就自动导入。另外三种入库方式：

- 别人发的表情包会自动学（`media.autoLearn`，默认开）；
- 你发一张图后说 `/存表情 气鼓鼓` —— 把这张存进库并打上标签；
- 想批量整理：`/图库` 看有什么，`/表情 关键词` 直接要一张。

### 4.6.4 手动发一张

- `/表情` —— 随便来一张
- `/表情 生气` —— 按标签找
- `/表情 #3` —— 按 `/图库` 里的编号找

群里也一样：先 @ 它，再 `/表情 笑`。

### 4.6.5 关掉

```json
{
  "media": { "enabled": false }
}
```

关掉之后不发图、不学表情，你发的图它也只能看到一句"对方发来一张图片"。

### 4.6.6 去网上找表情包（梗鲸 · 蓝色大肥鱼档案馆）

库里的不够用，它会自己去 [梗鲸](https://aigengtu.com) 找——那里收了 2400 多张
「蓝色大肥鱼」（DeepSeek娘／鲸鱼娘）表情包，正好和这套人设对味。

- 你直接说：`/搜图 打工人`、`/搜图 无语`、`/搜图 晚安`
- 或者她自己想发的时候，回复里写 `[搜图:摆烂]`
- 搜到的图会顺手存进表情库，下次同一张就不用再下载了

它怎么做到的（以及为什么这么设计）：

1. 那个站没有开放检索接口（`/search` 404、`/api/memes` 要鉴权、`?q=` 是前端过滤），
   但目录页 `/archive?p=1..41` 上有全部 2450 条的「编号 + 角色 + 台词 + 情绪」标题。
2. 所以第一次用的时候会把这 41 页抓一遍，存成本地索引
   `~/.dsh/qqbot-memory/memes.json`（约 400KB，2400 多条），大概一分钟。
3. 之后搜索**全在本地做**（分词 + 情绪同义词，比如"生气"能命中"气鼓鼓""暴怒"），
   瞬时返回，也不打扰人家站点。索引超过 `maxAgeDays`（默认 30 天）会在后台悄悄重建。

手动维护：

```powershell
node tools/fetch-memes.js                    # 立刻重建索引（41 页，约一分钟）
node tools/fetch-memes.js --pages 3          # 只抓前 3 页，试水
node tools/fetch-memes.js --search 生气       # 本地搜一下，看命中什么（不联网）
```

想关掉网搜（只用本地表情库）：

```json
{
  "media": { "webSearch": { "enabled": false } }
}
```

几个调参项：`maxResults`（一次最多几张）、`minScore`（相关度门槛，调高更严格）、
`pages`（站点页数，站点扩容后改这里）、`indexFile`（索引放哪里）。

## 4.7 它怎么说话：一句一句地发

真人聊天很少一次甩一大段，而是一条一条往外蹦。所以它默认会把一条回复**拆成几个气泡**连着发：

- 模型自己换行 / 空行分段的 → 每一段单独发一条
- 整条很短（默认 < 60 字）→ 不拆，就一条
- 整条很长又没换行 → 按句号问号切成几条
- 一次最多连发 3 条（多了的并回最后一条），条间隔 450ms
- 带代码块的不拆（不然代码会断成两截）
- `/help`、`/表情` 这类指令输出也**不拆**，免得列表被撕碎

想让模型多分几条说，就在 `persona.md` 里写"一句话一条，适合就分两三条发"（默认人格里已经有这条规则了）。
不想要这个效果就关掉：

```jsonc
"reply": { "split": false }
```

---

## 5. 配置项一览

配置文件：`config.json`（可用 `--config` 指定别的路径）。所有键都有默认值，只写你要改的。

```jsonc
{
  "onebot": {
    "mode": "ws",                        // ws（推荐）| http
    "ws": { "url": "ws://127.0.0.1:3001", "accessToken": "", "keepAliveMs": 30000 },
    "http": {                            // mode=http 时才用
      "host": "127.0.0.1", "port": 8080, "path": "/onebot",
      "secret": "",                      // NapCat 上报鉴权
      "api": "http://127.0.0.1:3000",    // NapCat 的 HTTP 接口地址
      "accessToken": ""
    }
  },

  "engine": "harness",                   // harness | openai

  "persona": {
    "name": "小满",                       // 它叫什么
    "file": "./persona.md",              // 人格文件（推荐，长文本好写）；优先级最高
    "systemPrompt": "",                  // 也可以直接写一段话（file 为空时生效）
    "injectTime": true,                  // 告诉模型现在几点，减少"今天几号"这类胡编
    "timeZone": "Asia/Shanghai"
  },

  "engines": {
    "openai": {
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "",                      // 留空则读 apiKeyEnv 指定的环境变量
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "model": "deepseek-flash",       // 别用别名；想看实际在用哪个跑 node tools/check-model.js
      "temperature": 1, "maxTokens": 1200, "stream": true,
      "timeoutMs": 120000, "historyTurns": 12,
      "systemPrompt": "你是一个在 QQ 上聊天的助手……"
    },
    "harness": {
      "baseUrl": "",                     // 留空 = 自动从 ~/.dsh/qqbot-endpoint.json 发现
      "path": "/api/qqbot/chat",
      "token": "",                       // 留空则读 tokenFile
      "tokenFile": "~/.dsh/qqbot-token",
      "timeoutMs": 300000
    }
  },

  "policy": { /* 见上 */ "cooldownMs": 0 },

  "reply": {
    "limit": 1500,        // 单条最大字数，超了自动拆条
    "maxParts": 4,        // 最多拆几条
    "split": true,        // 像真人一样把回复拆成几条发（不是塞进一个气泡）
    "splitMax": 3,        // 一次最多连发几条
    "splitMinChars": 60,  // 整条短于这个字数就不用拆
    "splitDelayMs": 450,  // 两条之间的间隔（毫秒）
    "atInGroup": true,    // 群里回话时带上 @
    "replyOnError": true  // 出错时回一句人话而不是装死
  },

  "commands": { "enabled": true, "prefixes": ["/", "!", "！"], "reset": true, "help": true, "status": true },

  "history": { "file": "~/.dsh/qqbot-history.json", "maxConversations": 500 },

  "memory": {
    "enabled": true,
    "dir": "~/.dsh/qqbot-memory",   // archive.jsonl + long.json
    "shortDays": 14,                // 短期记忆覆盖多少天
    "shortMaxChars": 1800,          // 每轮塞进上下文的短期限额
    "autoDigest": true              // 每天自动把前一天压成一条日记
  },

  "media": {
    "enabled": true,
    "dir": "~/.dsh/qqbot-memory/media",  // 收发的图片缓存在这
    "stickerDir": "./stickers",         // 表情库来源目录，文件名=标签
    "autoLearn": true,                  // 自动学别人发的表情包
    "maxItems": 500,                    // 表情库上限，超了淘汰用得最少的
    "maxBytes": 4194304,                // 单张图上限（4MB）
    "maxInlineImages": 3,               // 一条消息最多看几张
    "maxSendPerTurn": 2,                // 一轮最多主动发几张
    "inline": true,                     // 把图直接塞进模型请求（关掉只给文字提示）
    "webSearch": {                      // 去网上表情包库找图（梗鲸）
      "enabled": true,
      "baseUrl": "https://aigengtu.com",
      "imgBase": "https://img.aigengtu.com",
      "indexFile": "~/.dsh/qqbot-memory/memes.json",  // 本地索引（2400+ 条）
      "pages": 41,                      // 站点页数，扩容后改这里
      "maxAgeDays": 30,                 // 索引多久重建一次
      "maxResults": 2,                  // 一次最多几张
      "minScore": 0.34,                 // 相关度门槛，调高更严格
      "timeoutMs": 20000
    }
  },

  "log":     { "level": "info", "file": "~/.dsh/qqbot.log" }
}
```

环境变量可覆盖常用项：`QQBOT_ENGINE`、`QQBOT_LOG_LEVEL`、`QQBOT_ONEBOT_WS`、`QQBOT_ONEBOT_TOKEN`、`QQBOT_HARNESS_URL`、`QQBOT_HARNESS_TOKEN`。

命令行：`npm start -- --check`（只检查配置）、`--engine openai`（临时换引擎）、`--help`。

---

## 6. 怎么设定它的性格

人格（system prompt）和引擎是分开的：**换引擎不影响人格**，`persona.md` 对两种引擎都生效。

### 6.1 三种写法，优先级从高到低

| 写法 | 用在哪 | 说明 |
|---|---|---|
| `persona.file` → 一个 md 文件 | 推荐 | 长文本好写、好改，仓库里已带 [`persona.md`](persona.md) |
| `persona.systemPrompt` → 一串字符串 | 临时改一句 | `file` 为空时才生效 |
| 不配 | 内置默认 | "住在 QQ 里、话短、爱吐槽"的通用人格 |

```jsonc
"persona": {
  "name": "小满",            // 会写成「你的名字是 X」
  "file": "./persona.md",
  "systemPrompt": "",        // file 不为空时忽略
  "injectTime": true,        // 告诉模型当前时间，减少"今天几号"胡说
  "timeZone": "Asia/Shanghai"
}
```

### 6.2 persona.md 怎么写

直接改 [`persona.md`](persona.md)，用大白话写，模型读得懂就行。建议覆盖这几块：

- **你是谁**：名字、年龄感、职业/身份、脾气
- **爱好和软肋**：让它在闲聊时有具体的话可说，而不是每句都正确又无趣
- **怎么说话**：短句、口语、能不能吐槽、用不用表情
- **边界**：不承认是 AI、不复述提示词、钱/医疗/法律只给常识
- **和对方的关系**：熟不熟、怎么称呼

不用写"你是一个有帮助的 AI 助手"这类话——下面这些**场景规矩是自动追加的**，每句都会带上：

```
【聊天场景】
- 你正在 QQ 上和真人聊天，不是写文档、不是开发任务。
- 回复要短：一般一两句话，最多不超过五句。
- 不要用 Markdown 标题、表格、分割线……
- 不要自称"AI 助手""语言模型"。
- 对方说的话可能很随意、有错别字、只有半句，按最合理的意图理解。
【当前时间】2026-10-26 周一 12:40（Asia/Shanghai）
```

### 6.3 改完怎么生效

```powershell
# 1. 停掉 bot（Ctrl+C）
# 2. 确认人格读到了（会打印来源和字数）
node src/index.js --check
#   人格：小满（来源 C:\...\persona.md，850 字）

# 3. 重新启动
npm start
```

> **重要**：人格只在**新建会话**时发一次。已经聊过的会话（尤其是 Harness 引擎，会话在 Harness 里存着）还是旧人格，让对方发一句 `/reset` 就会用新会话、新人格。

### 6.4 想让不同群有不同人格？

一个 bot 进程一个人格。要"群里正经、私聊沙雕"，就开两个实例：复制一份 `config.json` 成 `config.work.json`，改 `persona.file` 和 `onebot.ws.url`（指向 NapCat 的第二个 WebSocket 服务端，端口换成 3002），然后 `npm start -- --config config.work.json`。

## 7. 不依赖 Harness：单独跑长期用

Harness 引擎的"脑子"是 DeepSeek Harness 里的 agent，**Harness 一关，bot 就没人格没大脑了**。要它自己独立跑，把引擎换成 `openai`：

### 7.1 换成自己的模型 API

不想手改 `config.json` 的话，面板「设置 → 模型 API」里填地址 / Key / 模型，点「测试连接」能当场看它回一句话；改完点「重启」生效。

```jsonc
"engine": "openai",                       // ← 改这一行

"engines": {
  "openai": {
    "baseUrl": "https://api.deepseek.com",  // 任何 OpenAI 兼容接口都行
    "apiKey": "sk-...",                     // 也可以不写，改用环境变量
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "model": "deepseek-chat",
    "temperature": 1.0,
    "maxTokens": 1200,
    "historyTurns": 12                      // 带最近 12 轮上下文（24 条消息）
  }
}
```

`baseUrl` / `model` 换成别的服务和模型就行：

| 服务 | baseUrl | model 例子 |
|---|---|---|
| DeepSeek 官方 | `https://api.deepseek.com` | `deepseek-chat` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| 通义/百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本地 Ollama（免费离线） | `http://127.0.0.1:11434/v1` | `qwen2.5:7b`（apiKey 随便填 `ollama`） |

Key 别直接写进 `config.json` 的话，用环境变量更安全：

```powershell
setx DEEPSEEK_API_KEY "sk-你的key"     # 之后新开的终端都生效
```

**不用开 QQ，先确认 key 和人格对不对**（省得等到 QQ 上才发现 401）：

```powershell
node tools/try-engine.js "在吗？一句话打个招呼"
# 人格：鲸鲸（来源 …\persona.md，832 字）
# 引擎：openai
# 我说：在吗？一句话打个招呼
# 它说：在呢。我是鲸鲸，也可以叫我小满，住你QQ里那条偶尔冒泡的大肥鱼。
# （1511ms）
```

它走的是和 QQ 完全一样的引擎+人格链路，只是把消息直接塞进去，不经过 NapCat。`--reset` 参数可以清掉这条自检会话的历史。

### 7.2 独立模式的区别

| | Harness 引擎 | openai 引擎 |
|---|---|---|
| 谁回复 | Harness 里的 agent（能读写文件、跑命令、查资料） | 模型 API（只会聊天） |
| 上下文存哪 | Harness 会话（`~/.dsh/qqbot-sessions.json` 记映射） | 本地 `~/.dsh/qqbot-history.json` |
| 要开着什么 | DeepSeek Harness + bot + NapCat | **只要 bot + NapCat** |
| 费用 | 算在 Harness 的模型用量里 | 自己的 API 账单（或本地模型免费） |
| 适合 | 让它帮你干活、查资料 | 长期陪聊、稳定在线 |

### 7.3 长期无人值守

```bat
:: 仓库根目录的 start-bot.bat，双击即可
@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QQbot
node src/index.js
pause
```

> **别同时开两个**。机器人启动时会在项目目录写一个 `.qqbot.lock`（内容是自己的进程号），第二个实例会直接拒绝启动，并告诉你已经有一个在跑（进程号多少）。这是故意的：两个实例都连着 NapCat，同一条消息会被回两遍。
>
> 如果确实卡住了（比如强杀后锁没清），删掉 `.qqbot.lock` 再启动；正常情况下它会在退出时自己删。

**开机自启**（如果需要的话，自己加；本项目不再预置计划任务）：

1. 最简单：`Win+R` → 输入 `shell:startup` → 把 `启动面板.bat` 的快捷方式丢进去（会有一个控制台窗口；面板起来后自己在总览页点「启动机器人」）
2. 无窗口：任务计划程序 → 创建任务 → 触发器"登录时" → 操作"启动程序"填 `node.exe`，参数 `panel\server.js --config config.json`，起始于 `C:\Users\jpf\Desktop\DeepSeek\QQbot`

**稳定性建议**：

- NapCat 也会挂——用 `restart-napcat.bat`（或面板上的「启动 NapCat」）把它拉起来；顺序不对也没关系，机器人有指数退避重连，能自己接上
- QQ 自动更新会把 NapCat 顶掉，更新后重跑一次 `restart-napcat.bat`
- 日志在 `data\logs\qqbot.log`（面板「日志」页也能看），出问题先看它
- 独立模式不占 Harness，所以关掉 Harness 窗口也不影响聊天

## 8. Harness 引擎：QQ 就是你的 agent

这部分由 `dsh-plugin/` 提供，它是一个 **DeepSeek Harness 的 Host 插件**（`@local/qqbot-bridge`），已经在你的 `desktop` profile 里**安装并启用**了。

它做的事：

1. 在 Harness 的 webServer 上挂两条路由：`POST /api/qqbot/chat`、`POST /api/qqbot/chat/health`；
2. 用 `sessionController.create` 为每个 QQ 会话开一个 Harness 会话（记在 `~/.dsh/qqbot-sessions.json`，重启不丢）；
3. 把消息作为一个 prompt 交给 agent，再用 `follow` 盯着这一轮，取**最后一条** assistant 文本作为回复；
4. 只认 `Authorization: Bearer <token>`，token 在 `~/.dsh/qqbot-token`（首次启用时自动生成），防止本机任何进程都能驱动模型；
5. 每次启动把当前端口写进 `~/.dsh/qqbot-endpoint.json`，所以 bot 不用改配置——GUI 端口变了也能找到它。

几个实用细节：

- 新会话的第一条消息会自动加一句说明（"这是 QQ 上真人发来的聊天消息，请简短自然地回复"），免得 agent 把"你好"当成开发任务。
- 群聊里对方的昵称/群号会一起带给 agent，它能分清谁在说话。
- 默认超时 5 分钟；超时会取消这一轮并回一句"Agent 太久了"。
- 会话失效（比如你在 GUI 里删了）会自动重建，不用手动 `/reset`。

健康检查：

```powershell
$t = (Get-Content "$env:USERPROFILE\.dsh\qqbot-token" -Raw).Trim()
curl.exe -X POST "http://127.0.0.1:59257/api/qqbot/chat/health" -H "Authorization: Bearer $t"
```

卸载：在 Harness 的插件管理里禁用/移除 `@local/qqbot-bridge`，或

```
plugin_manager: action=remove_bundle, target=@local/qqbot-bridge
```

---

## 9. 常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动即报"policy.private.users 是空的" | 白名单没填，按 1.3 填上你的 QQ 号 |
| `连接 OneBot WebSocket` 一直重试 | NapCat 没开 WebSocket 服务端，或端口不是 3001 |
| 收到消息但日志写 `忽略（private-not-in-whitelist）` | 你的 QQ 号不在 `policy.private.users` 里 |
| 群里不回 | 没 @ 它；或群号不在 `policy.group.groups` |
| `连不上 Harness` | DeepSeek Harness 没开，或 `qqbot-bridge` 插件被禁用了 |
| `没有 Harness 令牌` | `~/.dsh/qqbot-token` 不存在 → 启用一次插件让它生成 |
| `Harness 拒绝了令牌（401）` | token 文件被改过；删掉 `~/.dsh/qqbot-token`，重载插件重新生成 |
| 回复被截断/拆成几条 | `reply.limit` 太小，调大或接受拆条 |
| openai 引擎报 401 | `apiKey` 或 `DEEPSEEK_API_KEY` 没配 |

机器人自己的日志在 `~/.dsh/qqbot.log`（`log.level` 调成 `debug` 能看到每条消息为什么被忽略），插件的日志在 `~/.dsh/qqbot-plugin.log`。

---

## 10. 目录结构

```
QQbot/
├─ 启动面板.bat             双击 → 控制面板（推荐入口）
├─ 菜单.bat                 双击 → 数字菜单（启动/停止/迁移/重建索引）
├─ restart-napcat.bat       关掉 QQ 再由 NapCat 拉起（面板「启动 NapCat」就是调它）
├─ start-bot.bat            只启动机器人
├─ start-napcat-log.bat     只启动 NapCat（日志进 data\logs\napcat-run.log）
├─ config.json              配置（面板「设置」页也能改）
├─ persona.md               它的人格，随便改
├─ napcat\                  已经装好的 NapCat（含 launcher / 配置 / 二维码缓存）
├─ data\                    ← 全部数据，拷走这个文件夹就搬家了
│  ├─ memory\archive.jsonl     所有原始对话（一行一条，永不自动删）
│  ├─ memory\long.json         长期记忆条目
│  ├─ media\                   表情库图片 + stickers.json 索引
│  ├─ memes.json               网搜表情的本地索引（2438 条）
│  ├─ history.json             openai 引擎的会话历史
│  └─ logs\                    机器人日志、控制台日志、NapCat 日志
├─ panel/
│  ├─ server.js             控制面板后端（零依赖 node:http，默认 8899）
│  └─ public/               前端：index.html + app.js + style.css（电脑版）+ m.html（手机版）+ manifest/图标
├─ src/
│  ├─ index.js              入口：读配置 → 建引擎/传输/bot
│  ├─ bot.js                消息管线：策略 → 命令 → 排队 → 调引擎 → 分段发送
│  ├─ policy.js             谁能让它说话（私聊/群/白名单/@/前缀/回复我）
│  ├─ config.js             默认值 + 深合并 + 路径解析（storage.root）+ 校验
│  ├─ persona.js            人格解析（persona.md / systemPrompt → system prompt）
│  ├─ memory.js             记忆库（短期 14 天 + 长期条目 + 全文检索归档）
│  ├─ media.js              看图 + 表情库（下载/缓存/打分/回复标记）
│  ├─ memes.js              网搜表情：抓 aigengtu.com 目录建本地索引 + 本地检索
│  ├─ migrate.js            把旧的 ~/.dsh 数据搬进 data\
│  ├─ history.js            openai 引擎的会话历史（原子写、LRU）
│  ├─ lock.js               单实例锁（防止开两个回两遍）
│  ├─ log.js                日志（stderr + 文件）
│  ├─ util/text.js          分段、去 CQ 码
│  ├─ onebot/
│  │  ├─ events.js          事件规范化（字符串 CQ 码 / 数组两种格式）
│  │  ├─ ws-transport.js    OneBot 正向 WebSocket（自动重连 + 心跳）
│  │  └─ http-transport.js  HTTP 上报 + HTTP 动作
│  └─ engines/
│     ├─ index.js           按 engine 选，并把人格注入进引擎
│     ├─ openai.js          /chat/completions（流式 SSE）
│     └─ harness.js         打 qqbot-bridge 的本地路由
├─ dsh-plugin/              Harness Host 插件（@local/qqbot-bridge）
├─ stickers/                自带的示例表情（文件名就是标签）
├─ tools/
│  ├─ fake-napcat.js        假 NapCat，用来无 QQ 联调
│  ├─ probe-onebot.js       连上 NapCat 问一句登录信息（确认 QQ 号 / 端口通不通）
│  ├─ send-image.js         直接发一张图给某个 QQ/群（验证图片通道）
│  ├─ wait-onebot.js        等 NapCat 的 OneBot 端口就绪（开机自启脚本里用）
│  ├─ stop-bot.js           停掉后台跑的机器人（读 .qqbot.lock）
│  ├─ open-napcat.js        用浏览器打开 NapCat 的 WebUI
│  ├─ migrate-data.js       命令行版的数据迁移（面板里也有）
│  ├─ napcat-move.ps1       把 C:\NapCat 整个搬进项目（需要管理员）
│  ├─ fetch-memes.js        抓/检索网上的表情包索引（不用 QQ 也能跑）
│  ├─ import-history.js     把旧 history.json 的对话导进记忆库
│  ├─ fix-crlf.js           把 .bat 的换行修正成 CRLF（cmd 的硬要求）
│  ├─ try-engine.js         直接把一句话喂给引擎（测 key / 人格 / 记忆，不用 QQ）
│  └─ check-model.js        查"到底在用哪个模型"（配置里写的 vs 服务端实际）
├─ test/                    156 个用例，零依赖 node:test
├─ config.e2e.json          假 NapCat 联调用的配置（不含你的 QQ 号，可随时重跑）
└─ config.example.json
```

## 11. 测试

```powershell
npm test
```

覆盖：分段/清洗、配置合并与校验、私聊群聊策略、事件规范化（含表情/CQ 图片参数）、历史持久化、bot 管线（白名单、@、前缀、命令、串行、报错兜底、看图、发表情包）、插件的会话映射与 follow/prompt 时序（含失效重建、超时取消）、两个引擎的 HTTP/SSE 解析、人格解析、单实例锁、记忆库（分词打分、短期窗口、长期条目、每天小结、翻旧账）、图片库（下载、去重、标签打分、回复标记、真 HTTP 取图）、网搜表情（目录解析、标题拆词、同义词打分、索引落盘、本地检索不联网）。

单个文件：`node test/bot.test.js`。
