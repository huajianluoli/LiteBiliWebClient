# LiteBili Web Client

> 基于 Node.js + Express 的自制 B 站网页客户端。

## 运行

```bash
npm install
npm start
```

默认端口 `3001`，访问：

| 页面 | 地址 |
|---|---|
| 搜索 / 首页 | `http://localhost:3001/search` |
| 播放器 | `http://localhost:3001/player?bv=BVxxxx` |
| 直播 | `http://localhost:3001/live` |
| 消息 | `http://localhost:3001/message` |
| 我的 | `http://localhost:3001/account` |
| 诊断 | `http://localhost:3001/diag` |

## 功能一览

### 视频
- 搜索、首页推荐（登录态走 WBI 个性化，未登录走热门）
- 1080p Dash / 720p Durl 自动降级
- Artplayer 播放器，支持画中画、截图、倍速、全屏
- 播放器内直接发弹幕（颜色 / 位置可选，WBI 签名）
- 弹幕列表加载、弹幕设置（透明度 / 字号 / 速度）持久化
- 评论区：表情面板（含已购买表情）、图片评论渲染、删除自己的评论、回复、点赞
- UP 主卡片（头像 + 粉丝数 + 关注按钮）
- 播放量 / 弹幕数显示
- "听视频"模式：Dash 音频流，支持循环 / 随机 / 顺序播放
- 历史记录、收藏夹、点赞投币收藏

### 直播
- 直播推荐列表、搜索
- WebSocket 实时弹幕（自动重连）
- 直播间发弹幕
- 清晰度切换
- 横屏分栏：左侧播放器缩小，右侧评论区

### 消息
- 私信会话列表、未读数
- 聊天页：发送文字 / 表情 / 图片
- 表情面板（私信专用 business）
- 图片消息直接渲染
- 回复我的 / @我 / 收到的赞 等通知列表，可点击跳回原视频

### 登录
- B 站扫码登录
- 登录 cookie 全部存在前端 `localStorage`（key: `bili_creds`），后端无状态、不落盘
- 换设备 / 重启服务器不丢登录态
- WBI 签名、CSRF 校验、buvid3 设备指纹自动处理

## 技术栈
- 后端：Express + ws（直播弹幕 WebSocket 直连 B 站）
- 前端：原生 HTML/CSS/JS + Artplayer
- 依赖：`express`、`qrcode`、`ws`、`bilibili-live-ws`

## 作者
- 第一作者：awa-obli
- 第二作者：huajianluoli
