# Bilibili Web Client 4.9
## 第一作者：awa-obli
## 第二作者：huajianluoli

在原项目基础上增加：

**基础功能**
- B站扫码登录
- `/api/me` 登录状态与用户信息
- `/api/history` 历史记录
- `/api/history/delete` 删除历史
- `/api/history/heartbeat` 播放历史心跳
- `/api/favorites` 收藏夹列表
- `/api/favorites/:mediaId` 收藏夹视频
- `/api/favorites/deal` 收藏/取消收藏
- 登录后的 WBI 个性化首页推荐
- 未登录时自动回退到全站热门
- `/account` 我的页面
- 1080p Dash与720p Durl自动选择

**UI / 首页**
- 首页 banner：季节头图（`page/header/v2`）优先，含视频素材时播视频，缺失时回退到轮播 banner（`res/locs?ids=4694`，11 张 5 秒自动切换）
- 顶栏随滚动切换状态：叠在 banner 上时为透明 + 白字，滚过 banner 后变白底 + 深字
- 顶部导航、右上角图标群（登录/头像、动态、消息、收藏、历史、播放器、设置）

**播放器**
- 顶栏统一配色：logo 为 B 站粉 `#FB7299`，其余图标跟随深色主题为白
- 视频标题下方显示发布时间（`YYYY-MM-DD HH:mm`，颜色 `#888888`，比简介略灰）
- UP 主关注组件（头像 + 名字 + 关注按钮）
- 关注成功后按钮变灰并显示"已关注"
- 点击 UP 主头像跳到 `/space/:mid`
- 弹幕设置（透明度、开关等）持久化到 `localStorage`

**评论区**
- 未登录：最多加载 3 条评论，翻到底显示"登录后查看更多评论"（颜色 `#FB7299`）
- 已登录：去掉"加载更多评论"按钮，滚动到底部自动加载

**个人主页 `/space/:mid`（含 `/account` 自身）**
- 默认显示该用户发布的视频（类似 `space.bilibili.com`）
- 视频区上方提供切换按钮：投稿 / 历史记录 / 收藏夹
- 查看他人主页时先尝试访问历史/收藏，拿不到数据就隐藏对应按钮
- 顶栏 UI 与 `/search` 一致（不保留透明效果）
- **作者注：Claude这段写的。。。竟然把我提示词写进去了（唉）**

## 运行

```bash
npm install
npm start
```

然后访问：

- `http://localhost:3001/search`
- `http://localhost:3001/player`
- `http://localhost:3001/account`
- `http://localhost:3001/space/:mid`（他人主页）

## 登录说明

登录采用 B站 Web QR 登录流程。登录成功后，SESSDATA / bili_jct / DedeUserID / buvid3
等**完整 B 站 cookies 由服务端随登录响应原样返回，前端保存在浏览器 `localStorage`
（key：`bili_creds`）中**，服务端不再保存任何登录态、不再写 `data/` 文件。

之后每个 API 请求前端自动通过 `X-Bili-Cookie` 请求头把整串 cookies 带给服务端，
服务端临时拼起来去请求 B 站、用完即弃。这样换一台电脑开同一个服务器、用同一个
浏览器客户端（或导出 `bili_creds`），登录信息都不会丢失；服务重启也不影响。

`/account` 页面显示二维码并轮询登录状态。退出登录时前端会清掉 `bili_creds`。

### 嵌套（iframe）场景登录说明

如果把本服务的页面（如 `/account`）用 `<iframe>` 嵌进**别的站点**，浏览器会把
iframe 里的请求视为"第三方上下文"，此时：

- 登录会话 Cookie `bili_session` 此前是 `SameSite=Lax`（浏览器默认值），
  在跨站 iframe 中**会被浏览器直接拒绝写入**——表现为"扫码成功但页面仍是未登录"。
- B 站自己的 `SESSDATA` 是 `SameSite=None`，所以 `m.bilibili.com` 在嵌套状态下可以正常登录。

本项目已修复：在 HTTPS 或 localhost 下，`bili_session` 改为
`SameSite=None; Secure; Partitioned`：

- `None` 允许跨站 iframe 写入并携带 Cookie；
- `Secure` 是 None 的强制配套；
- `Partitioned`（CHIPS）在 Chrome 全面拦截第三方 Cookie 后仍可用，
  代价是登录态按"顶层站点"分区，每个嵌入站点需要各自扫码一次。

部署注意：

1. 需要 **HTTPS**（`https://你的域名`）。`http://localhost` / `127.0.0.1` 也被
   Chrome 视为安全上下文，可本地调试；但局域网 IP（如 `192.168.x.x`）的裸 HTTP
   无法使用 Secure Cookie，会自动退回 `SameSite=Lax`，此时嵌套登录仍会失败，
   请改用 HTTPS 反向代理（如 Nginx / Caddy），并设置
   `X-Forwarded-Proto: https` 请求头。
2. 宿主页面如果是 HTTPS，本服务也必须是 HTTPS，否则 iframe 会被浏览器以
   "混合内容"整体拦截。
3. 宿主 `<iframe>` 不要加 `sandbox` 属性（或必须包含 `allow-same-origin`），
   否则 Cookie / localStorage 会被整体禁用。
4. 由于 `SameSite=None` 会放开跨站携带 Cookie，本项目已对写接口（POST/PUT/
   DELETE）增加 Origin 同源校验，防止跨站请求伪造；脚本类客户端不带 Origin
   不受影响。

### 安卓 WebView / 平板（Cookie 不可靠环境）

Android WebView（如平板上的 "awa's browser" 这类套壳浏览器）有额外限制：

- WebView 默认**不允许第三方 Cookie**，跨站 iframe 里返回的 `Set-Cookie`
  会被直接丢弃；
- 若部署在 `http://局域网IP`（如 `10.145.82.170`）且没有 HTTPS，
  `Secure` Cookie 也无法使用。

因此在这种设备上**不能依赖 Cookie 保持登录**。本项目已增加**令牌会话**方案，
与 Cookie 完全解耦：

1. 扫码登录成功后，`/api/auth/poll` 会额外返回 `sid` 与 `buvid3`；
2. 前端把 `sid` / `buvid3` 存入 sessionStorage / localStorage（两者都不可用时
   退化为当前页面内存变量），之后所有请求自动携带 `X-Bili-Session` 与
   `X-Bili-Buvid3` 请求头；
3. 服务端 `getSession` 优先读请求头、其次读 Cookie，普通浏览器与 WebView
   两条通道同时可用，互不影响。

**风控与设备指纹**：2026 起 B 站对点赞 / 投币 / 收藏等写接口做概率性风控，
缺 `buvid3` 时会随机返回 `-352`（表现为"有时候能点，有时候不行"）。
本项目在 `ensureCookie` 里显式调 `/x/frontend/finger/spi` 获取 `buvid3`，
并在 `biliFetch` 里把匿名侧基础 cookie 与登录凭据合并，保证登录态请求也带
设备指纹。

排查手段：在出问题的设备上打开 `/diag` 页面，点"运行测试"，把"测试结果"
区域的内容发回来，即可判断该设备上 Cookie / 存储 / 请求头各自是否可用。

验证脚本（无需真机扫码，打桩 B 站接口）：

```bash
node test/stub-server.js   # 起一个打桩登录的服务 :3199
# 浏览器打开 http://localhost:3199/account，点"生成二维码"即可看到登录成功
PORT=3199 node test/auth-token-test.js  # 无头全链路断言
```

## API 一览

### 登录与用户

| 端点 | 说明 |
|---|---|
| `/api/auth/qr` + `/api/auth/poll` | 扫码登录（返回 `sid` + `buvid3`） |
| `/api/me` | 登录状态与当前用户信息 |
| `/api/logout` | 退出登录 |
| `/api/user/info?mid=` | 用户信息（WBI + Cookie） |
| `/api/user/videos?mid=` | 用户投稿视频（WBI + Cookie） |
| `/api/user/follow?mid=` | 关注 / 取关（POST，Cookie + CSRF） |
| `/api/user/relation?mid=` | 查询与目标用户的关注关系 |
| `/api/user/followings?mid=` | 关注列表 |
| `/api/user/followers?mid=` | 粉丝列表（WBI + Cookie） |
| `/api/user/stat?mid=` | 关注 / 粉丝数（匿名可用） |

### 视频

| 端点 | 说明 |
|---|---|
| `/api/search` | 搜索 |
| `/api/recommend` | 首页推荐（登录态走 WBI 个性化，未登录走热门） |
| `/api/banner` | 首页 banner（季节头图 + 轮播图） |
| `/api/play` | 解析播放地址 |
| `/api/info` | 视频信息（含 `pubdate` / `mid` / `face`） |
| `/api/related` | 相关推荐 |
| `/api/danmaku` | 弹幕列表 |
| `/api/video/relation` | 当前用户对视频的点赞 / 投币 / 收藏状态 |
| `/api/video/like` | 点赞 / 取消点赞 |
| `/api/video/coin` | 投币（单次 1 个，最多 2 个） |
| `/api/video/favorite` | 收藏 / 取消收藏 |

### 评论

| 端点 | 说明 |
|---|---|
| `/api/comments` | 主评论列表 |
| `/api/comments/replies` | 展开楼中楼 |
| `/api/comments/like` | 评论点赞 |
| `/api/comments/send` | 发表评论 / 回复（root+parent） |
| `/api/comments/delete` | 删除自己的评论 / 回复 |
| `/api/emotes` | 表情面板（默认表情 + 已购买表情） |

### 历史 / 收藏

| 端点 | 说明 |
|---|---|
| `/api/history` | 历史记录（游标翻页） |
| `/api/history/delete` | 删除单条历史 |
| `/api/history/heartbeat` | 播放心跳 |
| `/api/favorites` | 收藏夹列表 |
| `/api/favorites/:mediaId` | 收藏夹视频 |
| `/api/favorites/deal` | 收藏 / 取消收藏（WBI 签名） |

## API 对照 WristBilibili

| WristBilibili | 本项目 |
|---|---|
| `UserInfoApi` | `/api/me`、`/api/user/info` |
| `UserLoginApi` | `/api/auth/qr` + `/api/auth/poll` |
| `HistoryApi` | `/api/history` + `/api/history/delete` |
| `OnlineVideoApi.playHistory()` | `/api/history/heartbeat` |
| `FavorBoxApi` / `FavorVideoApi` | `/api/favorites` + `/api/favorites/:mediaId` |
| `RecommendApi` | `/api/recommend`（WBI Web 推荐） |
| `UserApi.getUserVideo` | `/api/user/videos` |
| `UserApi.getUserFollow` | `/api/user/followings` |
| `UserApi.getUserFans` | `/api/user/followers` |
| `UserApi.follow / unfollow` | `/api/user/follow` |
| `UserApi.getUserInfo` | `/api/user/info` |
