# Lite Bili Web Client

> 基于 Node.js + Express 的自制 B 站网页客户端。兼容WebView。

## 运行

```bash
npm install
npm start
```

默认端口 `3002`，可通过环境变量 `PORT` 覆盖。访问：

| 页面 | 地址 |
|---|---|
| 搜索 / 首页 | `http://localhost:3002/search` |
| 播放器 | `http://localhost:3002/player?bv=BVxxxx` |
| 直播列表 | `http://localhost:3002/live` |
| 直播间 | `http://localhost:3002/stream?room_id=xxxx` |
| 消息 | `http://localhost:3002/message` |
| 我的 | `http://localhost:3002/account` |
| 动态 | `http://localhost:3002/dynamic` |
| 图文详情 | `http://localhost:3002/opus?id=xxxx` |
| 设置 | `http://localhost:3002/settings` |
| 诊断 | `http://localhost:3002/diag` |

## 登录机制

- 登录二维码扫码登录，完整 B 站 cookie 保存在前端 `localStorage`（key: `bili_creds`），请求时通过 `X-Bili-Cookie` 头带给服务端。
- 后端在 `data/cookies.json` 持久化 cookie：匿名 buvid3 + 按设备区分（每台设备随机生成 `bili_device_id` 存在前端），**重启服务后登录态不丢**，换设备/换电脑登录信息不丢失、互不干扰。
- 页面打开时会自动带上登录态；首页推荐等接口等登录信息返回后再加载，避免先展示未登录的热门内容。
- 服务端登录接口统一处理 WBI 签名、CSRF 校验、buvid3 设备指纹。

## 功能一览

### 首页 / 搜索
- 首页推荐（登录态走 WBI 个性化，未登录走热门）
- Banner 降级规则：季节头图有视频 → 播视频；没有则用轮播图；都没有则用静态头图；也可在设置页固定图源或自定义图片链接
- 视频搜索、图文（专栏）搜索（搜索栏右侧可切换「视频 / 图文」，图文结果可在站内图文页阅读）、番剧搜索（番剧结果显示在 UP 主栏下方，点击直达播放器对应分集）

### 播放器
- Artplayer 播放器：1080p Dash / 720p Durl 自动降级，画中画、截图、倍速、全屏
- 播放器脚本多源降级加载：国内 CDN（staticfile → bootcdn）→ 本地 `public/vendor/` 兜底，每个源 8 秒超时，网络差也能稳定进入播放器
- 播放量、弹幕数显示（与官方同款图标）
- 进度条 B 站蓝配色，加载进度条（art-progress-loaded）可见
- 弹幕：播放器内直接发弹幕（颜色 / 位置 / 样式可选，WBI 签名）、弹幕列表加载、弹幕设置持久化
- 评论区：发表 / 回复 / 删除自己的评论（垃圾桶图标）、表情面板（悬浮框，含已购买表情）、图片评论渲染、点赞；点头像 / 名字进入 UP 主主页
- 收藏夹联动：从"我的"收藏夹点入的视频，播放器自动把该收藏夹渲染进选集框（分页 + 下滑加载更多 + 多 P 展开），点击任意视频 / 分 P 切换播放
- 收藏弹窗：播放器内收藏可自选收藏夹（居中弹窗、主题自适应、粉色确认按钮）
- "听视频"模式：原生 audio 播放器，循环 / 随机 / 顺序播放；收藏夹来源播到已加载列表最底部时**自动加载下一页并续播**，无需手动操作
- 听视频歌词：登录后自动读取 UP 主字幕（优先）或 AI 字幕；AI 字幕优先选 `ai_type=0` 的原声轨（英文歌默认英文原声，中文视频默认中文原声），翻译轨可手动切换；逐行滚动高亮、点击跳转；没有字幕时显示「无歌词 请欣赏」，未登录或登录失效时提示先登录
- 字幕内容不对时，可用播放组件栏的「ASR」本地重新识别；旁边可选「粗略（fast，base 模型）/ 精准（accurate，large-v3-turbo，可能几分钟）」，模型放在 `E:\ASR-Models`，结果按 cid + 精度缓存
- 历史记录、点赞投币

### 直播
- 直播推荐列表、直播搜索（关键词 / 相关内容）
- WebSocket 实时弹幕（自动重连，断线自动恢复，支持登录态 token）
- 直播间发送弹幕
- 清晰度切换
- 横屏分栏布局：左侧播放器，右侧评论区（可收可发）+ 发送框；竖屏保持全屏播放

### 消息
- 关注人消息 / 未关注人消息：两个入口都支持收发消息、显示对方头像、表情与图片
- 聊天页：显示我的头像、表情面板（发表情 / 发图片）、图片与表情渲染、对话时间显示
- 回复我的 / @我 / 收到的赞 通知列表：点头像 / 名字跳 UP 主主页，点内容跳回对应视频并定位高亮那条评论
- 消息页背景图：在设置页配置链接，对整个消息页生效

### 我的（个人页）
- 关注的人 / 粉丝列表：胶囊按钮切换，两列网格卡片，数字分页
- 收藏夹列表 + 收藏内容分页（"加载更多"按钮逐页加载）
- 他人主页：关注按钮、发消息按钮（点击跳转到对应聊天框）
- 历史记录（滚动加载）

### 设置
- 主题双开关：**全站深色模式**（首页、直播、消息、我的、设置页，默认浅色）与**播放器深色模式**（播放器 / 直播间，默认深色）互相独立，互不干扰
- 首页 Banner 图源（自动降级 / 季节头图 / 轮播 / 自定义链接）
- 消息页背景图

## 技术栈

- 后端：Express + ws（直播弹幕 WebSocket 直连 B 站）
- 前端：原生 HTML/CSS/JS + Artplayer + Artplayer 弹幕插件
- 依赖：`express`、`qrcode`、`ws`、`bilibili-live-ws`
- 可选本地 ASR：Python + `faster-whisper` + `av` + `numpy`（用于 B 站 AI 字幕内容错误时的歌词兜底）

## 目录结构

```
├── server.js                 # 后端主服务（接口代理 / 登录 / 弹幕 / 直播 / 字幕 / ASR）
├── public/                   # 前端页面（search / player / stream / live / message / account / dynamic / opus / settings）
│   ├── vendor/               # Artplayer 本地兜底脚本（部署时必需，勿删）
│   └── ...
├── scripts/
│   └── asr_transcribe.py     # 本地 ASR：faster-whisper 转时间轴字幕
├── data/                     # 运行时数据（cookies.json、server*.log、asr/），已 gitignore
├── .gitignore
├── package.json
└── README.md
```

> `data/` 整个目录都不进仓库；ASR 结果按 `data/asr/<cid>.<quality>.json` 缓存，也在忽略范围内。

## 字幕与听视频歌词

- 字幕列表来自 `x/player/v2`，需要登录态（SESSDATA）；匿名请求 `subtitles` 恒为空。
- 优先级：**UP 主字幕（type=0） > AI 原声（type=1, ai_type=0） > AI 翻译（type=1, ai_type=1）**。
- 英文歌默认选 `ai-en` 原声而不是 `ai-zh` 翻译；中文视频默认 `ai-zh` 原声。
- B 站有时会分多次返回 AI 轨道，服务端会在只有翻译/空列表时补拉并合并。
- 字幕正文由服务端代理下载，避免跨域并隐藏临时 `auth_key`。
- 没字幕时显示「无歌词 请欣赏」；登录失效时提示重新登录。

## 本地 ASR 部署（可选）

B 站 AI 字幕有时内容完全错误（网页版也一样）。这时可以用视频音频在本地跑 ASR，生成自己的时间轴歌词。ASR 完全可选，不装不影响其它功能。

### 1. Python 依赖

```bash
python -m pip install faster-whisper av numpy
```

需要 Python 3.10+，且 `python` 在 PATH 中。也可以用项目外的便携 Python 环境，通过 `PYTHON` 环境变量指定解释器。

### 2. 下载 faster-whisper CT2 模型

默认代码读取 E 盘：

```text
E:\ASR-Models\faster-whisper-base                  # 粗略（快），约 138 MB
E:\ASR-Models\faster-whisper-large-v3-turbo        # 精准（慢），约 1.54 GB
```

推荐模型仓库：

- 粗略：`Systran/faster-whisper-base`
- 精准：`deepdml/faster-whisper-large-v3-turbo-ct2`

每个目录需要包含：

```text
config.json
model.bin
tokenizer.json
vocabulary.txt        # turbo 模型是 vocabulary.json
preprocessor_config.json（可选）
```

国内网络可以用 `hf-mirror.com`，例如：

```bash
mkdir -p /path/to/models/faster-whisper-base
curl -L "https://hf-mirror.com/Systran/faster-whisper-base/resolve/main/model.bin" \
  -o /path/to/models/faster-whisper-base/model.bin
```

把 `config.json`、`tokenizer.json`、`vocabulary.txt` 一并下载。

### 3. 配置模型路径

模型路径的代码位置在 [server.js:1968](server.js#L1968)：

```js
const ASR_MODELS = {
  fast: process.env.ASR_MODEL_FAST || "E:\\ASR-Models\\faster-whisper-base",
  accurate: process.env.ASR_MODEL_ACCURATE || "E:\\ASR-Models\\faster-whisper-large-v3-turbo",
};
```

也就是直接改这两个默认字符串，或者不改代码、用环境变量覆盖：

```powershell
$env:ASR_MODEL_FAST     = "E:\ASR-Models\faster-whisper-base"
$env:ASR_MODEL_ACCURATE = "E:\ASR-Models\faster-whisper-large-v3-turbo"
$env:PYTHON             = "python"
npm start
```

路径解析与回退逻辑在 [server.js:1972](server.js#L1972) 的 `ASR_FALLBACK_MODEL` 和 [server.js:1976](server.js#L1976) 的 `resolveAsrModel`：  
如果 E 盘模型不存在，会回退到项目外的 `servers/.asr/models/small`（如果存在）。

### 4. 接口与缓存

```http
GET /api/subtitle/asr?bvid=&aid=&cid=&quality=fast|accurate
```

- `quality=fast`：base 模型，4 分钟音频约 20–30 秒
- `quality=accurate`：large-v3-turbo，4 分钟音频约 3–4 分钟
- 返回：`{ language, list: [{from,to,text}], quality, model }`
- 缓存：`data/asr/<cid>.fast.json`、`data/asr/<cid>.accurate.json`
- 同一视频同一精度第二次调用直接读缓存

### 5. 播放器接入

听视频模式播放组件栏：

```text
[字幕语言] [ASR 精度：粗略/精准] [ASR]
```

- 点「ASR」按当前精度重新识别
- 识别中会显示预计耗时
- 完成后歌词区替换为 ASR 结果
- 精准/粗略选择会保存在 `localStorage`

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3002` | 服务端口 |
| `ACCESS_TOKEN` | 空 | 设置后所有 `/api/` 需带 `X-Access-Token`，用于公网 |
| `PERSIST_COOKIES` | `1` | 设为 `0` 时不把 B 站 cookie 写入 `data/cookies.json` |
| `ASR_MODEL_FAST` | `E:\ASR-Models\faster-whisper-base` | 粗略 ASR 模型目录 |
| `ASR_MODEL_ACCURATE` | `E:\ASR-Models\faster-whisper-large-v3-turbo` | 精准 ASR 模型目录 |
| `PYTHON` | `python` | ASR 使用的 Python 解释器 |

## 安全提醒

- `data/cookies.json` 含 B 站登录凭据，已被 `.gitignore` 忽略，**不要提交**。
- 公网部署请设置 `ACCESS_TOKEN`；不需要重启保留登录态时设 `PERSIST_COOKIES=0`。
- `data/asr/**` 是按视频缓存出来的歌词/识别结果，也已忽略，避免把观看内容带进仓库。
- 本机测试/调试脚本、开机自启/守护脚本、截图以及 ASR 缓存都已列入 `.gitignore`；推送前请检查 `git status`。

## 作者

- 第一作者：awa-obli
- 第二作者：huajianluoli

## 免责声明

> **请在使用、分发或二次开发本项目前完整阅读以下内容。**

1. **非官方项目**  
   本项目是一个独立的个人开源项目，与哔哩哔哩（Bilibili）官方及其关联公司**没有任何隶属、合作、授权或背书关系**，也不是官方客户端。项目中出现的“B站”“哔哩哔哩”“Bilibili”等名称、商标、图标及相关内容的权利归其各自权利人所有。

2. **仅用于学习与技术交流**  
   本项目仅用于个人学习、技术研究、前端/后端实践和交流分享，不得用于任何商业用途，也不得用于批量抓取、数据贩卖、流量作弊、绕过平台付费/权限限制、侵犯他人隐私或其他违反法律法规、平台协议及公序良俗的行为。

3. **内容版权归原作者所有**  
   本项目本身不生产、不拥有视频、音频、字幕、弹幕、图片、评论等内容。通过本项目访问或处理的内容，其版权归原 UP 主、权利人及平台所有。请勿将相关内容用于未经授权的转载、传播或商业使用。

4. **账号与使用风险自负**  
   使用本项目可能需要登录 B 站账号。请自行评估账号安全、平台风控及服务条款风险。因使用本项目导致的账号受限、数据丢失、服务中断、法律纠纷或其他损失，作者及贡献者不承担任何责任。

5. **接口与功能不保证稳定**  
   项目依赖的第三方接口、页面结构、风控策略和播放地址可能随时变化；ASR、字幕、直播、登录等功能不保证持续可用、准确或完整。ASR 识别结果可能存在明显错误，仅供辅助参考。

6. **不要高频请求或滥用**  
   请控制请求频率，遵守目标平台的服务条款与合理使用边界。因滥用、爬取、攻击或其它不当使用造成的后果，由使用者自行承担。

7. **权利人通知**  
   如本项目中的代码、文档或示例侵犯了您的合法权益，请通过仓库 Issue 联系作者，作者会在核实后尽快处理或删除相关内容。

8. **最终解释**  
   本免责声明不构成任何形式的法律意见或授权承诺；本项目以仓库 [LICENSE](LICENSE) 为准。使用本项目即视为您已阅读、理解并同意上述内容。
