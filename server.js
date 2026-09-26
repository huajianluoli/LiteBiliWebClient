// B站搜索 + 播放 + 登录 + 历史 + 收藏夹 + 个性化推荐
// Node.js >= 18
const express = require("express");
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

const COMMON_HEADERS = {
  "User-Agent":
    process.env.BILI_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
};

let cachedCookie = "";
let cookieFetchedAt = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000;

// 登录态说明：
// 凭证（SESSDATA / bili_jct / DedeUserID 等）完全由前端保存在 localStorage，
// 不落在服务端、不写 data/ 文件。前端每次请求通过 X-Bili-Cookie 请求头把整串
// B 站 cookies 带上来；服务端临时拼成 session 对象去请求 B 站，用完即弃。
// 这样在不同电脑上开同一个服务器、用同一个浏览器客户端，登录态都不会丢。
//
// 匿名侧的设备指纹 cookie（buvid3 等）仍由服务端 ensureCookie() 缓存合并。
const sessions = new Map(); // 兼容旧逻辑引用已废弃，保留为空 Map 不再持久化
const qrSessions = new Map();   // 二维码是临时的，不需要持久化

function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function parseCookieString(str) {
  const out = {};
  for (const part of String(str || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function extractSetCookies(res) {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

function extractCookiesFromUrl(url) {
  try {
    const u = new URL(url);
    const names = ["DedeUserID", "DedeUserID__ckMd5", "SESSDATA", "bili_jct"];
    const result = {};
    for (const n of names) {
      const v = u.searchParams.get(n);
      if (v) result[n] = v;
    }
    return result;
  } catch {
    return {};
  }
}

async function followLoginTicket(url) {
  if (!url) return {};
  const r = await fetch(url, {
    redirect: "manual",
    headers: {
      ...COMMON_HEADERS,
      Referer: "https://passport.bilibili.com/",
    },
  });
  const cookies = {};
  for (const c of extractSetCookies(r)) {
    const first = c.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) cookies[first.slice(0, i)] = first.slice(i + 1);
  }
  return cookies;
}

// 会话识别：登录凭证完全由前端通过 X-Bili-Cookie 请求头携带（整串 B 站 cookies），
// 服务端不落盘。这里临时解析成 session 对象，供后续 biliFetch 合并使用。
function getSession(req) {
  const raw = String(req.headers["x-bili-cookie"] || "");
  if (!raw) return null;
  const cookies = parseCookieString(raw);
  if (!cookies.SESSDATA) return null;
  return { cookies, user: null, createdAt: 0, lastSeen: 0 };
}

// 轻量 CSRF 防护：对改变状态的写接口校验 Origin/Referer 必须来自本站。
app.use((req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return next(); // 非浏览器客户端（curl/脚本）不强制校验
  try {
    const u = new URL(origin);
    if (u.host === (req.headers.host || "")) return next();
  } catch {}
  res.status(403).json({ error: "拒绝跨站请求（Origin 不匹配）" });
});

function requireSession(req, res) {
  const session = getSession(req);
  if (!session || !session.cookies.SESSDATA) {
    res.status(401).json({ code: -101, error: "请先登录 B 站账号" });
    return null;
  }
  return session;
}

async function biliFetch(url, options = {}, session = null) {
  const headers = {
    ...COMMON_HEADERS,
    ...(options.headers || {}),
  };

  let cookieStr = "";
  if (session?.cookies) {
    // 关键：登录会话里只有 SESSDATA/bili_jct/DedeUserID，没有 buvid3。
    // 2026 起 B 站对点赞/投币/收藏写接口做概率性风控，缺 buvid3 会随机 -352，
    // 表现为"有时候能点，有时候不行"。这里把匿名侧基础 cookie 与登录凭据合并。
    if (!cachedCookie) {
      try { await ensureCookie(); } catch {}
    }
    const base = parseCookieString(cachedCookie || "");
    const merged = { ...base, ...session.cookies };
    cookieStr = cookieHeader(merged);
  } else {
    // 匿名请求也需要 buvid3，否则直播/搜索等接口会 -352。ensureCookie 内部有缓存。
    if (!cachedCookie) {
      try { await ensureCookie(); } catch {}
    }
    cookieStr = cachedCookie;
  }

  if (cookieStr) headers.Cookie = cookieStr;
  // 关键：手机后端网络抖动时 fetch 默认永不超时，前端会干等几十秒。
  // 统一 15s 超时，挂了就快速失败让前端降级/重试，而不是死等。
  const started = Date.now();
  try {
    return await fetch(url, { ...options, headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw e;
  }
}

let ensureCookiePromise = null;
async function ensureCookie() {
  if (cachedCookie && Date.now() - cookieFetchedAt < COOKIE_TTL_MS) return cachedCookie;
  if (ensureCookiePromise) return ensureCookiePromise; // 并发去重：页面一打开同时发多个请求，只取一次指纹

  ensureCookiePromise = (async () => {
    const cookies = {};

    // 显式取设备指纹 buvid3/buvid4（2026 起 popular/series/one 等接口裸调会 -352）
    try {
      const r = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
        headers: COMMON_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      if (j.code === 0 && j.data) {
        if (j.data.b_3) cookies.buvid3 = j.data.b_3;
        if (j.data.b_4) cookies.buvid4 = j.data.b_4;
      }
    } catch {}

    // 再访问首页补齐其它基础 cookie（b_nut 等），已有的不覆盖。
    // 首页 HTML 很大，单独 8s 超时，拖慢不超过这个数。
    try {
      const res = await fetch("https://www.bilibili.com/", {
        headers: COMMON_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      for (const c of extractSetCookies(res)) {
        const first = c.split(";")[0];
        const i = first.indexOf("=");
        if (i > 0) {
          const k = first.slice(0, i);
          if (!cookies[k]) cookies[k] = first.slice(i + 1);
        }
      }
    } catch {}

    cachedCookie = cookieHeader(cookies);
    cookieFetchedAt = Date.now();
    return cachedCookie;
  })().finally(() => { ensureCookiePromise = null; });

  return ensureCookiePromise;
}

// ----------------------------- WBI -----------------------------
const MIXIN_KEY_ENC_TAB = [
  46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,
  27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,
  37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,
  22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52
];

let wbiKeyCache = { mixin: "", expires: 0 };

function getKeyFromUrl(url) {
  const m = String(url || "").match(/\/([^/]+?)(?:\.png|\.jpg|\.webp)?$/);
  return m ? m[1] : "";
}

async function getWbiMixinKey(session) {
  if (wbiKeyCache.mixin && Date.now() < wbiKeyCache.expires) {
    return wbiKeyCache.mixin;
  }
  const r = await biliFetch("https://api.bilibili.com/x/web-interface/nav", {}, session);
  const j = await r.json();
  const img = j.data?.wbi_img?.img_url || "";
  const sub = j.data?.wbi_img?.sub_url || "";
  const raw = getKeyFromUrl(img) + getKeyFromUrl(sub);
  let mixin = "";
  for (const i of MIXIN_KEY_ENC_TAB) mixin += raw[i] || "";
  wbiKeyCache = { mixin: mixin.slice(0, 32), expires: Date.now() + 24 * 3600 * 1000 };
  return wbiKeyCache.mixin;
}

async function signWbi(params, session) {
  const mixin = await getWbiMixinKey(session);
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(p)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  p.w_rid = crypto.createHash("md5").update(query + mixin).digest("hex");
  return p;
}

// ----------------------------- 通用数据转换 -----------------------------
function sanitizeTitle(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/<em class="keyword">/g, "@@EM_OPEN@@")
    .replace(/<\/em>/g, "@@EM_CLOSE@@")
    .replace(/<[^>]+>/g, "")
    .replace(/@@EM_OPEN@@/g, '<em class="keyword">')
    .replace(/@@EM_CLOSE@@/g, "</em>");
}

function normalizeVideo(item) {
  return {
    bvid: item.bvid || item.bv_id || "",
    aid: item.aid || item.id || item.arc?.aid || null,
    title: sanitizeTitle(item.title || item.arc?.title || ""),
    author: item.owner?.name || item.upper?.name || item.author || "",
    pic: (item.pic || item.cover || item.arc?.pic || "").startsWith("//")
      ? `https:${item.pic || item.cover || item.arc?.pic}`
      : (item.pic || item.cover || item.arc?.pic || ""),
    play: item.stat?.view ?? item.cnt_info?.play ?? item.play ?? null,
    danmaku: item.stat?.danmaku ?? item.cnt_info?.danmaku ?? item.danmaku ?? null,
    duration: item.duration || item.arc?.duration || 0,
    pubdate: item.pubdate || item.ctime || item.arc?.pubdate || 0,
    description: item.desc || item.description || item.arc?.desc || "",
  };
}

// 历史记录 cursor 版条目转换。business 可能是 archive / live / article / pgc，
// 只有 archive 才有完整的 bvid/aid/cid；其它类型用 oid 兜底（只供展示，不可直接播放）。
function normalizeHistoryItem(item) {
  const h = item.history || {};
  const business = h.business || "archive";
  const pic = item.cover || "";
  return {
    bvid: h.bvid || "",
    aid: h.aid || h.oid || null,
    cid: h.cid || 0,
    title: sanitizeTitle(item.title || ""),
    author: item.author_name || item.author || "",
    pic: pic.startsWith("//") ? `https:${pic}` : pic,
    play: null,          // cursor 版不返回播放量
    danmaku: null,
    duration: item.duration || 0,
    pubdate: item.view_at || 0,
    description: item.show_title || item.new_desc || "",
    business,
    progress: h.progress ?? -1,
    viewAt: item.view_at || 0,
  };
}

// ----------------------------- 登录：Web QR -----------------------------
app.get("/api/auth/qr", async (req, res) => {
  try {
    const r = await fetch("https://passport.bilibili.com/x/passport-login/web/qrcode/generate", {
      headers: COMMON_HEADERS,
    });
    const j = await r.json();
    if (j.code !== 0 || !j.data?.qrcode_key) {
      return res.status(502).json({ error: j.message || "二维码生成失败" });
    }
    const loginId = randomId(16);
    qrSessions.set(loginId, {
      qrcodeKey: j.data.qrcode_key,
      createdAt: Date.now(),
    });
    const qr = await QRCode.toDataURL(j.data.url, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: "M",
    });
    res.json({ login_id: loginId, url: j.data.url, qr, expires_in: 180 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "登录二维码获取失败" });
  }
});

app.get("/api/auth/poll", async (req, res) => {
  const loginId = String(req.query.login_id || "");
  const qr = qrSessions.get(loginId);
  if (!qr) return res.status(400).json({ error: "登录二维码不存在或已过期" });
  if (Date.now() - qr.createdAt > 180000) {
    qrSessions.delete(loginId);
    return res.json({ status: "expired", message: "二维码已过期" });
  }

  try {
    const r = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qr.qrcodeKey)}`,
      { headers: COMMON_HEADERS }
    );
    const j = await r.json();
    const state = j.data?.code;

    if (state === 86101) return res.json({ status: "waiting", message: "等待扫码" });
    if (state === 86090) return res.json({ status: "scanned", message: "已扫码，请在手机上确认" });
    if (state === 86038) {
      qrSessions.delete(loginId);
      return res.json({ status: "expired", message: "二维码已过期" });
    }
    if (state !== 0) return res.json({ status: "waiting", message: j.data?.message || "等待登录" });

// 关键修复：凭据随本次 poll 响应的 Set-Cookie 下发，不是从 data.url 解析。
const cookies = {};
for (const raw of extractSetCookies(r)) {
  const first = raw.split(";")[0];
  const i = first.indexOf("=");
  if (i <= 0) continue;
  const k = first.slice(0, i).trim();
  let v = first.slice(i + 1).trim();
  // B 站下发的 SESSDATA 等值经过 URL 编码（含 %2C 等），必须解码后再用。
  if (/%[0-9A-Fa-f]{2}/.test(v)) {
    try { v = decodeURIComponent(v); } catch {}
  }
  cookies[k] = v;
}

// 兜底（个别反代会剥掉 Set-Cookie）：从 data.url / crossDomain ticket 补齐。
if (!cookies.SESSDATA) {
  const fromUrl = extractCookiesFromUrl(j.data?.url || "");
  for (const [k, v] of Object.entries(fromUrl)) if (!cookies[k]) cookies[k] = v;
}
if (!cookies.SESSDATA && j.data?.url) {
  const followed = await followLoginTicket(j.data.url);
  for (const [k, v] of Object.entries(followed)) if (!cookies[k]) cookies[k] = v;
}

if (!cookies.SESSDATA) {
      qrSessions.delete(loginId);
      return res.status(502).json({
        status: "error",
        message: "登录成功但没有取得 SESSDATA，请重新扫码",
      });
    }
    // buvid3 一并交给前端存 localStorage，之后随 X-Bili-Cookie 整串带回。
    // 登录票里没带就用匿名侧抓到的设备指纹补上，保证写接口不被 -352 风控。
    if (!cookies.buvid3) {
      try {
        if (!cachedCookie) await ensureCookie();
        const base = parseCookieString(cachedCookie || "");
        if (base.buvid3) cookies.buvid3 = base.buvid3;
      } catch {}
    }
    qrSessions.delete(loginId);

    // 登录后立即验证并拿到用户信息（用刚拿到的 cookies 临时拼一个 session）。
    const userRes = await biliFetch("https://api.bilibili.com/x/web-interface/nav", {}, { cookies });
    const userJson = await userRes.json();

    // 关键：把完整 cookies 原样返回给前端，由前端存 localStorage。
    // 服务端不再保存任何登录态、不写 data/ 文件。
    res.json({
      status: "success",
      cookies, // 前端存 localStorage，之后每个请求用 X-Bili-Cookie 头带回
      user: {
        mid: userJson.data?.mid,
        uname: userJson.data?.uname,
        face: userJson.data?.face,
        vipStatus: userJson.data?.vipStatus,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", message: "登录轮询失败" });
  }
});

// 粉丝数/关注数：参考 WristBilibili 的 UP 主关系统计接口。
async function fetchRelationStat(mid, session) {
  if (!mid) return { follower: null, following: null };
  try {
    const u = new URL("https://api.bilibili.com/x/relation/stat");
    u.searchParams.set("vmid", String(mid));
    const r = await biliFetch(u.toString(), {}, session);
    const j = await r.json();
    if (j.code !== 0 || !j.data) return { follower: null, following: null };
    return { follower: j.data.follower ?? null, following: j.data.following ?? null };
  } catch {
    return { follower: null, following: null };
  }
}

app.get("/api/me", async (req, res) => {
  const session = getSession(req);
  if (!session) return res.json({ loggedIn: false });
  try {
    const r = await biliFetch("https://api.bilibili.com/x/web-interface/nav", {}, session);
    const j = await r.json();
    if (j.code === -101) {
      return res.json({ loggedIn: false });
    }
    session.user = j.data || null;
    const relation = await fetchRelationStat(j.data?.mid, session);
    res.json({
      loggedIn: true,
      user: {
        mid: j.data?.mid,
        uname: j.data?.uname,
        face: j.data?.face,
        coin: j.data?.money,
        level: j.data?.level_info?.current_level,
        vipStatus: j.data?.vipStatus,
        follower: relation.follower,
        following: relation.following,
      },
    });
  } catch {
    res.json({ loggedIn: false });
  }
});

app.post("/api/logout", async (req, res) => {
  // 凭证来自前端 X-Bili-Cookie 头，服务端无状态；调 B 站登出后前端清掉 localStorage 即可。
  const session = getSession(req);
  if (session?.cookies?.bili_jct) {
    try {
      await biliFetch("https://passport.bilibili.com/x/passport-login/web/logout", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `biliCSRF=${encodeURIComponent(session.cookies.bili_jct || "")}`,
      }, session);
    } catch {}
  }
  res.json({ ok: true });
});

// ----------------------------- 搜索 -----------------------------
const VALID_ORDERS = new Set(["", "totalrank", "click", "pubdate", "dm", "stow", "scores"]);

app.get("/api/search", async (req, res) => {
  const keyword = String(req.query.keyword || "").trim();
  const page = parseInt(req.query.page, 10) || 1;
  let order = String(req.query.order || "").trim();
  if (!VALID_ORDERS.has(order)) order = "";
  if (!keyword) return res.status(400).json({ error: "缺少 keyword 参数" });

  try {
    const cookie = await ensureCookie();
    const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("search_type", "video");
    url.searchParams.set("page", String(page));
    if (order) url.searchParams.set("order", order);

    const r = await fetch(url, { headers: { ...COMMON_HEADERS, Cookie: cookie } });
    const data = await r.json();
    if (data.code !== 0) return res.status(502).json({ error: `B站接口返回错误: ${data.message || data.code}` });

    res.json({
      total: data.data?.numResults || 0,
      totalPages: data.data?.numPages || 1,
      page,
      list: (data.data?.result || []).map(normalizeVideo),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "代理请求失败，请稍后重试" });
  }
});

// UP 主搜索：search_type=bili_user。字段名沿用 B 站原始返回（upic/usign）。
app.get("/api/search/users", async (req, res) => {
  const keyword = String(req.query.keyword || "").trim();
  const page = parseInt(req.query.page, 10) || 1;
  if (!keyword) return res.status(400).json({ error: "缺少 keyword 参数" });

  try {
    const session = getSession(req);
    const cookie = await ensureCookie();
    const url = new URL("https://api.bilibili.com/x/web-interface/search/type");
    url.searchParams.set("keyword", keyword);
    url.searchParams.set("search_type", "bili_user");
    url.searchParams.set("page", String(page));

    const r = await biliFetch(url.toString(), { headers: { Cookie: cookie } }, session);
    const data = await r.json();
    if (data.code !== 0) return res.status(502).json({ error: `B站接口返回错误: ${data.message || data.code}` });

    const list = (data.data?.result || []).map((u) => ({
      mid: u.mid ?? null,
      uname: sanitizeTitle(u.uname || ""),
      face: (u.upic || "").startsWith("//") ? `https:${u.upic}` : (u.upic || ""),
      sign: sanitizeTitle(u.usign || ""),
      fans: u.fans ?? null,
      videos: u.videos ?? null,
      level: u.level ?? null,
    }));

    // 批量补直播状态，供 UP 卡片显示"直播中"角标
    const liveMap = await fetchLiveStatusByUids(list.map((u) => u.mid), session);
    for (const u of list) {
      const live = liveMap[String(u.mid)];
      u.liveStatus = live?.liveStatus ?? 0;
      u.roomId = live?.roomId ?? null;
    }

    res.json({ total: data.data?.numResults || 0, page, list });
  } catch (e) {
    res.status(500).json({ error: "代理请求失败，请稍后重试" });
  }
});

// 番剧搜索：search_type=media_bangumi
app.get("/api/search/anime", async (req, res) => {
  const keyword = String(req.query.keyword || "").trim();
  if (!keyword) return res.status(400).json({ error: "缺少 keyword" });
  try {
    const session = getSession(req);
    const cookie = await ensureCookie();
    const signed = await signWbi({
      keyword,
      search_type: "media_bangumi",
      page: "1",
    }, session);
    const qs = new URLSearchParams(signed).toString();
    const r = await biliFetch(`https://api.bilibili.com/x/web-interface/search/type?${qs}`, { headers: { Cookie: cookie } }, session);
    const data = await r.json();
    if (data.code !== 0) return res.json({ list: [] });
    const list = (data.data?.result || []).slice(0, 10).map((a) => {
      const eps = Array.isArray(a.eps) ? a.eps : [];
      const firstEp = eps[0] || {};
      return {
        title: sanitizeTitle(a.title || ""),
        cover: (a.cover || "").startsWith("//") ? `https:${a.cover}` : (a.cover || ""),
        mediaId: a.media_id ?? a.season_id ?? null,
        indexShow: a.index_show || "",
        styles: Array.isArray(a.styles) ? a.styles.join(" / ") : (a.styles || ""),
        score: a.media_score?.score || "",
        epId: firstEp.id || null,
      };
    });
    res.json({ list });
  } catch (e) {
    res.json({ list: [] });
  }
});

// ep_id 转 bvid（番剧播放用），同时返回全部分集
app.get("/api/ep2bv", async (req, res) => {
  const epId = parseInt(req.query.ep, 10);
  if (!epId) return res.status(400).json({ error: "缺少 ep" });
  try {
    const session = getSession(req);
    const cookie = await ensureCookie();
    const r = await biliFetch(`https://api.bilibili.com/pgc/view/web/season?ep_id=${epId}`, { headers: { Cookie: cookie } }, session);
    const data = await r.json();
    if (data.code !== 0 || !data.result) return res.status(502).json({ error: "解析失败" });
    const eps = (data.result.episodes || []).map(e => ({
      epId: e.id,
      bvid: e.bvid || "",
      title: e.title || "",
      longTitle: e.long_title || "",
      cover: (e.cover || "").startsWith("//") ? `https:${e.cover}` : (e.cover || ""),
    }));
    const current = eps.find(e => e.epId === epId) || eps[0] || {};
    res.json({ bvid: current.bvid || "", aid: current.aid || 0, episodes: eps, seasonTitle: data.result.title || "" });
  } catch (e) {
    res.status(500).json({ error: "解析失败" });
  }
});

// ----------------------------- 首页 Banner -----------------------------
// 数据来源（2026-09 实测）：
//   - 季节头图：x/web-show/page/header/v2（可能含 split_layer 分层素材，图层里可能出现 webm/mp4）
//   - 轮播图：x/web-show/res/locs?pf=0&ids=4694（推荐位 ID 4694 = RecommendedSwipe）
// 两者都匿名可用，不需要 WBI 签名。
let bannerCache = { data: null, at: 0 };
const BANNER_TTL_MS = 30 * 60 * 1000;

function normalizeImgUrl(u) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http://")) return "https://" + u.slice(7);
  return u;
}

app.get("/api/banner", async (req, res) => {
  if (bannerCache.data && Date.now() - bannerCache.at < BANNER_TTL_MS) {
    return res.json(bannerCache.data);
  }

  const result = { header: null, carousel: [] };

  // 1. 顶部季节头图
  try {
    const r = await fetch("https://api.bilibili.com/x/web-show/page/header/v2", {
      headers: COMMON_HEADERS,
    });
    const j = await r.json();
    if (j.code === 0 && j.data) {
      const d = j.data;
      const layers = [];
      if (d.split_layer) {
        try {
          const sl = typeof d.split_layer === "string" ? JSON.parse(d.split_layer) : d.split_layer;
          for (const layer of sl.layers || []) {
            for (const resItem of layer.resources || []) {
              if (!resItem.src) continue;
              const src = normalizeImgUrl(resItem.src);
              layers.push({
                src,
                type: /\.(webm|mp4|mov)(\?|$)/i.test(src) ? "video" : "image",
              });
            }
          }
        } catch (e) {
          console.warn("split_layer 解析失败:", e && e.message);
        }
      }
      result.header = {
        pic: normalizeImgUrl(d.pic || ""),
        litpic: normalizeImgUrl(d.litpic || ""),
        is_split_layer: !!d.is_split_layer,
        layers,
      };
    }
  } catch (e) {
    console.error("头图获取失败:", e && e.message);
  }

  // 2. 首页轮播 banner（资源位 4694）
  try {
    const r = await fetch("https://api.bilibili.com/x/web-show/res/locs?pf=0&ids=4694", {
      headers: COMMON_HEADERS,
    });
    const j = await r.json();
    const items = j.data?.["4694"] || [];
    result.carousel = items
      .filter(x => x.pic)
      .sort((a, b) => (a.pos_num || 0) - (b.pos_num || 0))
      .map(x => ({
        id: x.id,
        name: x.name || "",
        pic: normalizeImgUrl(x.pic),
        url: x.url || "",
        pos_num: x.pos_num || 0,
        color: x.pic_main_color || "",
      }));
  } catch (e) {
    console.error("轮播获取失败:", e && e.message);
  }

  bannerCache = { data: result, at: Date.now() };
  res.json(result);
});

// ----------------------------- 个性化推荐 -----------------------------
app.get("/api/recommend", async (req, res) => {
  const session = getSession(req);
  try {
    if (session?.cookies?.SESSDATA) {
      const params = await signWbi({
        web_location: 1430650,
        y_num: 8,
        fresh_type: 4,
        feed_version: "V8",
        fresh_idx_1h: 1,
        fetch_row: 1,
        fresh_idx: 1,
        brush: 1,
        homepage_ver: 1,
        ps: Math.min(parseInt(req.query.ps, 10) || 20, 30),
        last_y_num: 8,
        screen: "1920-1080",
        seo_info: "",
        last_showlist: "",
        uniq_id: String(Math.floor(Math.random() * 9e13) + 1e13),
      }, session);

      const u = new URL("https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd");
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
      const r = await biliFetch(u.toString(), {}, session);
      const j = await r.json();
      if (j.code === 0 && Array.isArray(j.data?.item) && j.data.item.length) {
        return res.json({
          personalized: true,
          list: j.data.item.filter(x => x.goto === "av" || x.bvid).map(normalizeVideo),
        });
      }
    }

    // 未登录或个性化接口失败时回退到全站热门。
    await ensureCookie();
    const pn = Math.max(1, parseInt(req.query.pn, 10) || Math.floor(Math.random() * 20) + 1);
    const u = new URL("https://api.bilibili.com/x/web-interface/popular");
    u.searchParams.set("pn", String(pn));
    u.searchParams.set("ps", "20");
    const r = await biliFetch(u.toString());
    const j = await r.json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "推荐加载失败" });
    res.json({ personalized: false, list: (j.data?.list || []).map(normalizeVideo) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "推荐加载失败，请稍后重试" });
  }
});

// ----------------------------- 视频信息 / 播放 -----------------------------
// 打开一个视频时，/api/info、/api/play(resolveCid)、/api/comments(resolveAid)
// 会各调一次 /x/web-interface/view。手机后端每次往返都慢，这里短缓存（60s）消除重复请求。
const viewCache = new Map();
const VIEW_TTL_MS = 60 * 1000;

async function fetchView({ aid, bvid }, session) {
  const key = bvid ? `bv:${bvid}` : `av:${aid}`;
  const hit = viewCache.get(key);
  if (hit && Date.now() - hit.at < VIEW_TTL_MS) return hit.data;

  const u = new URL("https://api.bilibili.com/x/web-interface/view");
  if (bvid) u.searchParams.set("bvid", bvid);
  else u.searchParams.set("aid", String(aid));
  const j = await (await biliFetch(u.toString(), {}, session)).json();
  if (j.code === 0 && j.data) {
    viewCache.set(key, { data: j.data, at: Date.now() });
    if (viewCache.size > 200) viewCache.delete(viewCache.keys().next().value); // 简单上限防膨胀
  }
  return j.data;
}

async function resolveCid({ aid, bvid, page = 1 }, session = null) {
  const data = await fetchView({ aid, bvid }, session);
  if (!data) throw new Error("获取视频信息失败");
  const pages = data.pages || [];
  const target = pages[(parseInt(page, 10) || 1) - 1];
  if (!target) throw new Error("该视频不存在对应分P");
  return { cid: target.cid, aid: data.aid, bvid: data.bvid };
}

async function fetchPlayUrl({ aid, bvid, cid, qn }, session = null) {
  const buildBase = (pgc) => {
    const u = new URL(pgc
      ? "https://api.bilibili.com/pgc/player/web/playurl"
      : "https://api.bilibili.com/x/player/playurl");
    u.searchParams.set("avid", String(aid || ""));
    u.searchParams.set("bvid", bvid || "");
    u.searchParams.set("cid", String(cid));
    u.searchParams.set("qn", String(qn || 80));
    u.searchParams.set("type", "mp4");
    u.searchParams.set("otype", "json");
    u.searchParams.set("fnver", "0");
    u.searchParams.set("fourk", "1");
    u.searchParams.set("platform", "html5");
    u.searchParams.set("high_quality", "1");
    return u;
  };

  async function tryOne(pgc) {
    const base = buildBase(pgc);
    const headers = pgc ? { Referer: "https://www.bilibili.com/bangumi/play/" } : {};
    const dashUrl = new URL(base.toString());
    dashUrl.searchParams.set("fnval", pgc ? "4048" : "16");
    const dashRes = await biliFetch(dashUrl.toString(), { headers }, session).then(r => r.json()).catch(() => null);
    let dashData = (dashRes && dashRes.code === 0) ? (dashRes.result || dashRes.data) : null;

    let dash = null;
    if (dashData?.dash?.video?.length) {
      const wanted = qn ? dashData.dash.video.find((v) => Number(v.id) === Number(qn)) : null;
      const video = wanted || dashData.dash.video[0];
      const audio = dashData.dash.audio?.[0];
      dash = {
        video: video.baseUrl || video.base_url,
        audio: audio ? (audio.baseUrl || audio.base_url) : null,
        videoId: video.id,
        audioId: audio ? audio.id : null,
      };
    }

    let fallbackUrl = "";
    // DASH 响应里如果直接带了 durl（PGC 常见），先用它
    if (!dash && dashData?.durl?.length) {
      fallbackUrl = dashData.durl[0].url;
    }
    if (!dash && !fallbackUrl) {
      const durlUrl = new URL(base.toString());
      durlUrl.searchParams.set("fnval", "0");
      const durlRes = await biliFetch(durlUrl.toString(), { headers }, session).then(r => r.json()).catch(() => null);
      const durlData = (durlRes && durlRes.code === 0) ? (durlRes.result || durlRes.data) : null;
      if (durlData?.durl?.length) fallbackUrl = durlData.durl[0].url;
    }

    if (!dash && !fallbackUrl) return null;
    const qualitySource = dashData || { accept_quality: [], accept_description: [] };
    return {
      quality: dash ? dash.videoId : qualitySource.quality,
      accept_quality: qualitySource.accept_quality,
      accept_description: qualitySource.accept_description,
      dash,
      fallbackUrl,
    };
  }

  let result = await tryOne(false);
  if (!result) result = await tryOne(true); // PGC 番剧兜底

  if (!result) {
    throw new Error("未获取到可播放的直链");
  }
  return result;
}

app.get("/api/play", async (req, res) => {
  const bvid = String(req.query.bv || "").trim();
  const aid = parseInt(req.query.av || "", 10) || 0;
  const page = parseInt(req.query.p, 10) || 1;
  const qn = parseInt(req.query.qn, 10) || 0;
  if (!bvid && !aid) return res.status(400).json({ code: 1, message: "缺少 bv 或 av 参数" });

  try {
    const session = getSession(req);
    const resolved = await resolveCid({ aid, bvid, page }, session);
    const play = await fetchPlayUrl({ ...resolved, qn }, session);
    res.json({ code: 0, ...resolved, page, ...play });
  } catch (e) {
    console.error(e);
    res.status(502).json({ code: 1, message: e.message || "解析失败" });
  }
});

app.get("/api/info", async (req, res) => {
  const bvid = String(req.query.bv || "").trim();
  const aid = parseInt(req.query.av || "", 10) || 0;
  if (!bvid && !aid) return res.status(400).json({ code: 1, message: "缺少 bv 或 av 参数" });
  try {
    const session = getSession(req);
    const j = await fetchView({ aid, bvid }, session);
    if (!j) throw new Error("获取视频信息失败");
    res.json({
      code: 0,
      aid: j.aid,
      bvid: j.bvid,
      title: j.title || "",
      pubdate: j.pubdate || 0,
      desc: j.desc || "",
      pages: (j.pages || []).map((p, i) => ({ page: i + 1, cid: p.cid, part: p.part || `第 ${i + 1} P` })),
      pic: j.pic?.startsWith("//") ? `https:${j.pic}` : j.pic,
      author: j.owner?.name || "",
      mid: j.owner?.mid ?? 0,
      face: j.owner?.face || "",
      duration: j.duration || 0,
      play: j.stat?.view ?? null,
      stat: {
        like: j.stat?.like ?? null,
        coin: j.stat?.coin ?? null,
        favorite: j.stat?.favorite ?? null,
        reply: j.stat?.reply ?? null,
        danmaku: j.stat?.danmaku ?? null,
        share: j.stat?.share ?? null,
      },
    });
  } catch (e) {
    res.status(502).json({ code: 1, message: e.message || "获取视频信息失败" });
  }
});

// ----------------------------- 听视频（音频模式） -----------------------------
// 取音频直链：优先 DASH（fnval=16）取码率最高的一路，失败回退 fnval=0 的 durl。
// 未登录也能拿到（匿名可取音频，音质受限）。
app.get("/api/audio", async (req, res) => {
  const bvid = String(req.query.bvid || req.query.bv || "").trim();
  const aid = parseInt(req.query.aid || req.query.av || "", 10) || 0;
  const cidParam = parseInt(req.query.cid || "", 10) || 0;
  const page = parseInt(req.query.p, 10) || 1;
  if (!bvid && !aid) return res.status(400).json({ code: 1, message: "缺少 bvid/aid 参数" });

  try {
    const session = getSession(req);

    let cid = cidParam;
    let resolvedAid = aid;
    let resolvedBvid = bvid;
    if (!cid) {
      const resolved = await resolveCid({ aid, bvid, page }, session);
      cid = resolved.cid;
      resolvedAid = resolved.aid;
      resolvedBvid = resolved.bvid;
    }

    const base = new URL("https://api.bilibili.com/x/player/playurl");
    base.searchParams.set("avid", String(resolvedAid || aid || ""));
    base.searchParams.set("bvid", resolvedBvid || bvid || "");
    base.searchParams.set("cid", String(cid));
    base.searchParams.set("otype", "json");
    base.searchParams.set("platform", "html5");
    base.searchParams.set("high_quality", "1");

    // 先试 DASH，拿码率最高的音频轨
    const dashUrl = new URL(base.toString());
    dashUrl.searchParams.set("fnval", "16");
    const dashRes = await biliFetch(dashUrl.toString(), {}, session).then((r) => r.json()).catch(() => null);
    const dashData = dashRes && dashRes.code === 0 ? dashRes.data : null;

    if (dashData?.dash?.audio?.length) {
      const bestAudio = [...dashData.dash.audio].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
      return res.json({
        code: 0,
        audioUrl: bestAudio.baseUrl || bestAudio.base_url,
        quality: bestAudio.id,
        isDash: true,
      });
    }

    // 回退：fnval=0 拿 durl（视频+音频混流，只取地址当音频播）
    const durlUrl = new URL(base.toString());
    durlUrl.searchParams.set("fnval", "0");
    durlUrl.searchParams.set("qn", "32");
    const durlRes = await biliFetch(durlUrl.toString(), {}, session).then((r) => r.json()).catch(() => null);
    const durlData = durlRes && durlRes.code === 0 ? durlRes.data : null;

    if (durlData?.durl?.length) {
      return res.json({
        code: 0,
        audioUrl: durlData.durl[0].url,
        quality: durlData.quality ?? null,
        isDash: false,
      });
    }

    throw new Error("未获取到可播放的音频直链");
  } catch (e) {
    console.error(e);
    res.status(502).json({ code: 1, message: e.message || "获取音频失败" });
  }
});

// 音频直链走服务端代理：B 站直链有 Referer 防盗链限制，浏览器直接播放会被拒绝。
// 白名单只放行 B 站 CDN 域名，防止被当作任意地址的转发代理（SSRF）。
const AUDIO_PROXY_ALLOWED_HOST_RE = /^([a-z0-9-]+\.)*(bilivideo\.com|hdslb\.com)$/i;

app.get("/api/audio/proxy", async (req, res) => {
  const src = String(req.query.src || "");
  let target;
  try {
    target = new URL(src);
  } catch {
    return res.status(400).json({ error: "非法地址" });
  }
  if (target.protocol !== "https:" || !AUDIO_PROXY_ALLOWED_HOST_RE.test(target.hostname)) {
    return res.status(403).json({ error: "不允许的地址" });
  }

  try {
    // 关键：把浏览器的 Range 请求头转发给 B 站，并透传 206 / Content-Range /
    // Accept-Ranges，否则浏览器认为音频流不可 seek，进度条拖不动、拖了也会弹回 0。
    const upHeaders = {
      "User-Agent": COMMON_HEADERS["User-Agent"],
      Referer: "https://www.bilibili.com/",
    };
    const range = req.headers.range;
    if (range) upHeaders["Range"] = range;

    const upstream = await fetch(target.toString(), { headers: upHeaders });
    if (!upstream.body) {
      return res.status(502).json({ error: "音频拉取失败" });
    }

    res.status(upstream.status);
    const passthrough = ["content-type", "content-length", "content-range", "accept-ranges"];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=3600");

    const upstreamStream = Readable.fromWeb(upstream.body);
    upstreamStream.on("error", (e) => {
      // 上游 HTTP2 中途断流（NGHTTP2_PROTOCOL_ERROR 等）会在这里冒泡成 unhandled error 直接崩进程。
      console.warn("[音频代理] 上游流中断:", e.message);
      try { res.destroy(); } catch {}
    });
    upstreamStream.pipe(res);
    res.on("error", () => { try { upstreamStream.destroy(); } catch {} });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(502).json({ error: "音频代理失败" });
  }
});

app.get("/api/video/proxy", async (req, res) => {
  const src = String(req.query.src || "");
  let target;
  try { target = new URL(src); } catch { return res.status(400).json({ error: "非法地址" }); }
  if (target.protocol !== "https:" || !AUDIO_PROXY_ALLOWED_HOST_RE.test(target.hostname)) {
    return res.status(403).json({ error: "不允许的地址" });
  }
  try {
    const upHeaders = {
      "User-Agent": COMMON_HEADERS["User-Agent"],
      Referer: "https://www.bilibili.com/",
    };
    if (req.headers.range) upHeaders["Range"] = req.headers.range;
    const upstream = await fetch(target.toString(), { headers: upHeaders });
    if (!upstream.body) return res.status(502).json({ error: "视频拉取失败" });
    res.status(upstream.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=3600");
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", () => { try { res.destroy(); } catch {} });
    stream.pipe(res);
    res.on("error", () => { try { stream.destroy(); } catch {} });
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: "视频代理失败" });
  }
});

app.get("/api/related", async (req, res) => {
  const bvid = String(req.query.bv || "").trim();
  const aid = parseInt(req.query.av || "", 10) || 0;
  if (!bvid && !aid) return res.status(400).json({ error: "缺少 bv 或 av 参数" });
  try {
    const session = getSession(req);
    const u = new URL("https://api.bilibili.com/x/web-interface/archive/related");
    if (bvid) u.searchParams.set("bvid", bvid);
    else u.searchParams.set("aid", String(aid));
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "获取相关推荐失败" });
    res.json({ list: (j.data || []).map(normalizeVideo) });
  } catch (e) {
    res.status(500).json({ error: "获取相关推荐失败" });
  }
});

// ----------------------------- 点赞 / 投币 / 收藏 -----------------------------
// 参考 WristBilibili 的 likeVideo / coinVideo / favVideo。
async function resolveAid({ aid, bvid }, session) {
  if (aid) return parseInt(aid, 10);
  const data = await fetchView({ bvid }, session);
  if (!data) throw new Error("视频不存在");
  return data.aid;
}

// 获取当前登录用户对该视频的点赞/投币/收藏状态。未登录时返回全部为空状态。
app.get("/api/video/relation", async (req, res) => {
  const bvid = String(req.query.bv || "").trim();
  const aid = parseInt(req.query.av || "", 10) || 0;
  if (!bvid && !aid) return res.status(400).json({ error: "缺少 bv 或 av 参数" });

  const session = getSession(req);
  if (!session || !session.cookies.SESSDATA) {
    return res.json({ liked: false, coin: 0, favorite: false });
  }
  try {
    const u = new URL("https://api.bilibili.com/x/web-interface/archive/relation");
    if (bvid) u.searchParams.set("bvid", bvid);
    else u.searchParams.set("aid", String(aid));
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0 || !j.data) return res.json({ liked: false, coin: 0, favorite: false });
    res.json({
      liked: !!j.data.like,
      coin: typeof j.data.coin === "number" ? j.data.coin : (j.data.coin ? 1 : 0),
      favorite: !!j.data.favorite,
    });
  } catch {
    res.json({ liked: false, coin: 0, favorite: false });
  }
});

function likeErrorText(code, fallback) {
  switch (code) {
    case -101: return "登录已失效，请重新扫码登录";
    case -111: return "CSRF 校验失败，请重新登录";
    case -403: return "账号异常，操作被风控拦截";
    case -352: return "操作过于频繁或设备指纹缺失，请稍后再试";
    case 65004: return "取消点赞失败（可能并未点赞）";
    case 65006: return "你已经赞过这个视频啦";
    default: return fallback || "点赞操作失败";
  }
}

function coinErrorText(code, fallback) {
  switch (code) {
    case -101: return "登录已失效，请重新扫码登录";
    case -111: return "CSRF 校验失败，请重新登录";
    case -400: return "请求参数错误（aid/bvid 不匹配）";
    case -403: return "账号异常，操作被风控拦截";
    case -352: return "操作过于频繁或设备指纹缺失，请稍后再试";
    case -104: return "硬币不足";
    case 34005: return "今日投币已达上限，明天再来吧";
    case 34006: return "不能给自己的稿件投币";
    case 65004: return "未点赞（select_like 只能配合已点赞的视频）";
    default: return fallback || "投币操作失败";
  }
}

app.post("/api/video/like", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const bvid = String(req.body.bvid || "").trim();
  const aid = parseInt(req.body.aid, 10) || 0;
  const like = req.body.like ? 1 : 2; // 1:点赞 2:取消赞
  if (!bvid && !aid) return res.status(400).json({ error: "缺少 bvid 或 aid" });

  if (!session.cookies.bili_jct) {
    return res.status(401).json({ code: -111, error: "缺少 CSRF 凭据，请重新登录" });
  }

  try {
    const body = new URLSearchParams({
      like: String(like),
      csrf: session.cookies.bili_jct,
    });
    if (bvid) body.set("bvid", bvid); else body.set("aid", String(aid));
    const j = await (await biliFetch("https://api.bilibili.com/x/web-interface/archive/like", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: bvid
          ? `https://www.bilibili.com/video/${bvid}`
          : `https://www.bilibili.com/video/av${aid}`,
      },
      body,
    }, session)).json();
    if (j.code !== 0) {
      return res.status(502).json({ code: j.code, error: likeErrorText(j.code, j.message) });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("点赞异常:", e);
    res.status(500).json({ error: "点赞操作失败（网络异常）" });
  }
});

app.post("/api/video/coin", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const bvid = String(req.body.bvid || "").trim();
  const aid = parseInt(req.body.aid, 10) || 0;
  const multiply = Math.min(2, Math.max(1, parseInt(req.body.multiply, 10) || 1));
  const selectLike = req.body.select_like ? "1" : "0";
  if (!bvid && !aid) return res.status(400).json({ error: "缺少 bvid 或 aid" });

  if (!session.cookies.bili_jct) {
    return res.status(401).json({ code: -111, error: "缺少 CSRF 凭据，请重新登录" });
  }

  try {
    const body = new URLSearchParams({
      multiply: String(multiply),
      select_like: selectLike,
      csrf: session.cookies.bili_jct,
      cross_domain: "true",
    });
    if (bvid) body.set("bvid", bvid); else body.set("aid", String(aid));
    const j = await (await biliFetch("https://api.bilibili.com/x/web-interface/coin/add", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: bvid
          ? `https://www.bilibili.com/video/${bvid}`
          : `https://www.bilibili.com/video/av${aid}`,
      },
      body,
    }, session)).json();
    if (j.code !== 0) {
      return res.status(502).json({ code: j.code, error: coinErrorText(j.code, j.message) });
    }
    res.json({ ok: true, data: j.data });
  } catch (e) {
    console.error("投币异常:", e);
    res.status(500).json({ error: "投币操作失败（网络异常）" });
  }
});



// 收藏/取消收藏：统一收进登录用户的默认收藏夹(收藏夹列表中的第一个)。
app.post("/api/video/favorite", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const aid = parseInt(req.body.aid, 10) || 0;
  const action = req.body.action === "remove" ? "remove" : "add";
  if (!aid) return res.status(400).json({ error: "缺少 aid" });
  try {
    const listUrl = new URL("https://api.bilibili.com/x/v3/fav/folder/created/list-all");
    listUrl.searchParams.set("up_mid", String(session.user?.mid || session.cookies.DedeUserID || ""));
    listUrl.searchParams.set("type", "2");
    const listJson = await (await biliFetch(listUrl.toString(), {}, session)).json();
    const defaultFolder = listJson.data?.list?.[0];
    if (listJson.code !== 0 || !defaultFolder) {
      return res.status(502).json({ error: "未找到可用的收藏夹" });
    }

    // 2026 起 x/v3/fav/resource/deal 强制要求 WBI 签名（见接口清单“2026 年新增鉴权要点”）。
    const signedParams = await signWbi({
      rid: String(aid),
      type: "2",
      add_media_ids: action === "add" ? String(defaultFolder.id) : "",
      del_media_ids: action === "remove" ? String(defaultFolder.id) : "",
      csrf: session.cookies.bili_jct || "",
      platform: "web",
    }, session);
    const body = new URLSearchParams(signedParams);
    const j = await (await biliFetch("https://api.bilibili.com/x/v3/fav/resource/deal", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "收藏操作失败" });
    res.json({ ok: true, folder: defaultFolder.title });
  } catch {
    res.status(500).json({ error: "收藏操作失败" });
  }
});

// ----------------------------- 评论区 -----------------------------
// 参考 WristBilibili 的 getReply/getReply(sub)，接口不强制要求 WBI 签名。
app.get("/api/comments", async (req, res) => {
  const bvid = String(req.query.bv || "").trim();
  const aid = parseInt(req.query.av || "", 10) || 0;
  const next = parseInt(req.query.next, 10) || 0;
  if (!bvid && !aid) return res.status(400).json({ error: "缺少 bv 或 av 参数" });

  try {
    const session = getSession(req);
    const resolvedAid = await resolveAid({ aid, bvid }, session);
    await ensureCookie();

    const u = new URL("https://api.bilibili.com/x/v2/reply/main");
    u.searchParams.set("oid", String(resolvedAid));
    u.searchParams.set("type", "1");
    u.searchParams.set("mode", "3");
    u.searchParams.set("next", String(next));
    u.searchParams.set("plat", "1");

    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "评论加载失败" });

    res.json({
      aid: resolvedAid,
      count: j.data?.cursor?.all_count ?? 0,
      isEnd: !!j.data?.cursor?.is_end,
      next: j.data?.cursor?.next ?? next + 1,
      list: (j.data?.replies || []).map(normalizeReply),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "评论加载失败" });
  }
});

// 展开某条评论的完整子回复列表。
app.get("/api/comments/replies", async (req, res) => {
  const aid = parseInt(req.query.av, 10) || 0;
  const root = String(req.query.root || "").trim();
  const pn = Math.max(1, parseInt(req.query.pn, 10) || 1);
  if (!aid || !root) return res.status(400).json({ error: "缺少 av 或 root 参数" });

  try {
    const session = getSession(req);
    const u = new URL("https://api.bilibili.com/x/v2/reply/reply");
    u.searchParams.set("oid", String(aid));
    u.searchParams.set("type", "1");
    u.searchParams.set("root", root);
    u.searchParams.set("ps", "10");
    u.searchParams.set("pn", String(pn));

    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "回复加载失败" });

    res.json({ list: (j.data?.replies || []).map(normalizeReply) });
  } catch (e) {
    res.status(500).json({ error: e.message || "回复加载失败" });
  }
});

// 点赞 / 取消点赞 一条评论（含楼中楼子回复）。
// 参考 WristBilibili 的 likeReply：x/v2/reply/action。
app.post("/api/comments/like", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const aid = parseInt(req.body.aid, 10) || 0;
  const rpid = String(req.body.rpid || "").trim();
  const like = req.body.like ? 1 : 0; // 1:点赞 0:取消
  if (!aid || !rpid) return res.status(400).json({ error: "缺少 aid 或 rpid" });
  try {
    const body = new URLSearchParams({
      oid: String(aid),
      type: "1",
      rpid,
      action: String(like),
      jsonp: "jsonp",
      csrf: session.cookies.bili_jct || "",
    });
    const j = await (await biliFetch("https://api.bilibili.com/x/v2/reply/action", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "评论点赞失败" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "评论点赞失败" });
  }
});

// 发表评论 / 回复评论。
// 参考 WristBilibili 的 sendReply：x/v2/reply/add。root/parent 都传 rpid 表示回复某条主评论。
app.post("/api/comments/send", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const aid = parseInt(req.body.aid, 10) || 0;
  const message = String(req.body.message || "").trim();
  const root = String(req.body.root || "").trim();
  const parent = String(req.body.parent || "").trim();
  if (!aid || !message) return res.status(400).json({ error: "缺少 aid 或评论内容" });
  try {
    const body = new URLSearchParams({
      oid: String(aid),
      type: "1",
      message,
      plat: "1",
      csrf: session.cookies.bili_jct || "",
    });
    if (root) {
      body.set("root", root);
      body.set("parent", parent || root);
    }
    const j = await (await biliFetch("https://api.bilibili.com/x/v2/reply/add", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session)).json();
    if (j.code !== 0) {
      return res.status(502).json({ error: (j.message || "发送评论失败") + "（code=" + j.code + "）" });
    }
    res.json({ ok: true, reply: j.data?.reply ? normalizeReply(j.data.reply) : null });
  } catch {
    res.status(500).json({ error: "发送评论失败" });
  }
});

// 删除自己的评论 / 回复。x/v2/reply/del，仅能删自己发的。
app.post("/api/comments/delete", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const aid = parseInt(req.body.aid, 10) || 0;
  const rpid = String(req.body.rpid || "").trim();
  if (!aid || !rpid) return res.status(400).json({ error: "缺少 aid 或 rpid" });
  try {
    const body = new URLSearchParams({
      oid: String(aid),
      type: "1",
      rpid,
      csrf: session.cookies.bili_jct || "",
    });
    const j = await (await biliFetch("https://api.bilibili.com/x/v2/reply/del", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "删除评论失败" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "删除评论失败" });
  }
});

// 表情面板：x/emote/user/panel/web?business=reply。
// 登录后返回默认表情 + 用户已购买 / 大会员专属表情。匿名也能拿到默认表情。
app.get("/api/emotes", async (req, res) => {
  const session = getSession(req);
  const business = req.query.business || "reply";
  try {
    const j = await (await biliFetch(
      `https://api.bilibili.com/x/emote/user/panel/web?business=${encodeURIComponent(business)}`,
      {},
      session
    )).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "表情加载失败" });

    const pkgs = j.data?.packages || [];
    const emoteMap = j.data?.emote || {};
    const list = pkgs
      .map((p) => {
        const id = p.package_id ?? p.id;
        const arr = emoteMap[String(id)] || p.emote || [];
        return {
          id,
          name: p.package_name || p.text || "",
          icon: normalizeImgUrl(p.package_url || ""),
          emojis: arr
            .map((e) => ({
              text: e.text || e.emoji_name || "",
              url: normalizeImgUrl(e.url || ""),
              size: e.meta?.size || 1,
            }))
            .filter((e) => e.text && e.url),
        };
      })
      .filter((p) => p.emojis.length);
    res.json({ list });
  } catch (e) {
    console.error("表情面板异常:", e && e.message);
    res.status(500).json({ error: "表情加载失败" });
  }
});

// 评论正文里的表情映射：把 [微笑] 这类占位符映射到表情图 URL。
// B 站 reply 返回里表情实际是 content.emote 对象（key 形如 "[doge]"）；
// 个别新结构可能是 content.emoji 数组，两种都兼容。
function normalizeReplyEmoji(content) {
  const out = {};
  for (const e of content?.emoji || []) {
    const rawName = e.emoji_name || e.text || "";
    const name = String(rawName).replace(/^\[|\]$/g, "");
    if (name && e.url) out[name] = normalizeImgUrl(e.url);
  }
  const emoteObj = content?.emote;
  if (emoteObj && typeof emoteObj === "object") {
    for (const [key, e] of Object.entries(emoteObj)) {
      const rawName = (e && (e.text || e.emoji_name)) || key;
      const name = String(rawName).replace(/^\[|\]$/g, "");
      const url = e && e.url;
      if (name && url && !out[name]) out[name] = normalizeImgUrl(url);
    }
  }
  return out;
}

// 评论附图：content.pictures 数组里的图片。
function normalizeReplyPictures(content) {
  return (content?.pictures || [])
    .map((p) => ({
      src: normalizeImgUrl(p.img_src || ""),
      width: p.img_width || 0,
      height: p.img_height || 0,
    }))
    .filter((p) => p.src);
}

function normalizeReply(item) {
  return {
    rpid: item.rpid,
    mid: item.member?.mid ?? 0,
    uname: item.member?.uname || "",
    avatar: normalizeImgUrl(item.member?.avatar || ""),
    message: item.content?.message || "",
    emoji: normalizeReplyEmoji(item.content),
    pictures: normalizeReplyPictures(item.content),
    like: item.like ?? 0,
    liked: item.action === 1, // action: 0=未操作 1=已点赞 2=已点踩
    rcount: item.rcount ?? (item.replies ? item.replies.length : 0),
    ctime: item.ctime || 0,
    replies: (item.replies || []).slice(0, 3).map((sub) => ({
      rpid: sub.rpid,
      mid: sub.member?.mid ?? 0,
      uname: sub.member?.uname || "",
      avatar: normalizeImgUrl(sub.member?.avatar || ""),
      message: sub.content?.message || "",
      emoji: normalizeReplyEmoji(sub.content),
      pictures: normalizeReplyPictures(sub.content),
      like: sub.like ?? 0,
      liked: sub.action === 1,
      ctime: sub.ctime || 0,
    })),
  };
}

// ----------------------------- 弹幕 -----------------------------
const DANMAKU_MODE_MAP = { 1: 0, 2: 0, 3: 0, 4: 2, 5: 1, 6: 0, 7: 0, 8: 0 };

function decodeXmlEntities(str) {
  return str.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function parseDanmakuXml(xml) {
  const list = [];
  const re = /<d p="([^"]+)">([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1].split(",");
    const text = decodeXmlEntities(m[2]).trim();
    if (!text) continue;
    const time = parseFloat(a[0]) || 0;
    const biliMode = parseInt(a[1], 10) || 1;
    const colorDec = parseInt(a[3], 10);
    list.push({
      text, time,
      color: "#" + (Number.isFinite(colorDec) ? colorDec : 0xffffff).toString(16).padStart(6, "0"),
      mode: DANMAKU_MODE_MAP[biliMode] ?? 0
    });
  }
  list.sort((a,b) => a.time - b.time);
  return list.length > 6000 ? list.filter((_, i) => i % Math.ceil(list.length / 6000) === 0) : list;
}

app.get("/api/danmaku", async (req, res) => {
  const cid = String(req.query.cid || "").trim();
  if (!cid) return res.status(400).json({ error: "缺少 cid 参数" });
  try {
    const session = getSession(req);
    const r = await biliFetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${encodeURIComponent(cid)}`, {}, session);
    const xml = await r.text();
    const list = parseDanmakuXml(xml);
    res.json({ total: list.length, list });
  } catch {
    res.status(500).json({ error: "获取弹幕失败" });
  }
});

// 发送视频弹幕。POST https://api.bilibili.com/x/v2/dm/post，需登录 cookie + csrf。
app.post("/api/danmaku/send", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const cid = parseInt(req.body.cid, 10) || 0;
  const msg = String(req.body.msg || "").trim().slice(0, 30);
  const progress = Number(req.body.progress) || 0; // 秒
  if (!cid || !msg) return res.status(400).json({ error: "缺少 cid 或弹幕内容" });
  try {
    const bodyParams = {
      type: "1",
      oid: String(cid),
      msg,
      bvid: String(req.body.bvid || ""),
      progress: String(Math.round(progress * 1000)),
      color: String(req.body.color || "16777215"),
      fontsize: "25",
      pool: "0",
      mode: String(req.body.mode || "1"),
      rnd: String(Math.floor(Date.now() / 1000)),
      csrf: session.cookies.bili_jct || "",
    };
    const signed = await signWbi(bodyParams, session);
    const upstream = await biliFetch("https://api.bilibili.com/x/v2/dm/post", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": `https://www.bilibili.com/video/${req.body.bvid || ""}`,
      },
      body: new URLSearchParams(signed).toString(),
    }, session);
    const j = await upstream.json();
    if (j.code !== 0) {
      return res.status(502).json({ error: (j.message || "弹幕发送失败") + "（code=" + j.code + "）" });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "弹幕发送失败" });
  }
});

// ----------------------------- 历史记录 -----------------------------
app.get("/api/history", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const ownMid = String(session.user?.mid || session.cookies.DedeUserID || "");
  const qMid = String(parseInt(req.query.mid, 10) || "");
  // 历史记录是私密数据，B 站没有查看他人历史的接口：明确拒绝，前端据此隐藏"历史记录"按钮。
  if (qMid && qMid !== ownMid) {
    return res.status(403).json({ error: "无法查看他人的历史记录" });
  }
  try {
    const ps = Math.min(Math.max(parseInt(req.query.ps, 10) || 30, 1), 30);

    // 新版游标接口（推荐）：支持视频 / 直播 / 专栏 / 番剧混合，翻页参数由上一页
    // 的 data.cursor 原样回传。旧版 x/v2/history 走 pn/ps 仍可用，但只能拿纯视频。
    // 见接口清单 HistoryApi.getHistory。
    const u = new URL("https://api.bilibili.com/x/web-interface/history/cursor");
    u.searchParams.set("ps", String(ps));
    const max = String(req.query.max || "").trim();
    const viewAt = String(req.query.view_at || "").trim();
    const business = String(req.query.business || "").trim();
    if (max) u.searchParams.set("max", max);
    if (viewAt) u.searchParams.set("view_at", viewAt);
    if (business) u.searchParams.set("business", business);

    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "历史记录获取失败" });

    const data = j.data || {};
    const cursor = data.cursor || {};
    res.json({
      mid: ownMid,
      list: (data.list || []).map(normalizeHistoryItem),
      cursor: {
        max: cursor.max ?? 0,
        view_at: cursor.view_at ?? 0,
        business: cursor.business ?? "",
      },
      hasMore: !!(cursor.max || cursor.view_at),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "历史记录获取失败" });
  }
});

app.post("/api/history/delete", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const aid = String(req.body.aid || "").trim();
  if (!aid) return res.status(400).json({ error: "缺少 aid" });
  try {
    const body = new URLSearchParams({
      kid: `archive_${aid}`,
      csrf: session.cookies.bili_jct || "",
    });
    const j = await (await biliFetch("https://api.bilibili.com/x/v2/history/delete", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "删除失败" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "删除历史记录失败" });
  }
});

// 播放心跳：参考 WristBilibili 的 /x/report/web/heartbeat。
app.post("/api/history/heartbeat", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const aid = parseInt(req.body.aid, 10) || 0;
  const cid = parseInt(req.body.cid, 10) || 0;
  const playTime = Math.max(0, parseInt(req.body.played_time, 10) || 0);
  const isFin = !!req.body.finished;
  if (!aid || !cid) return res.status(400).json({ error: "缺少 aid/cid" });
  try {
    const body = new URLSearchParams({
      aid: String(aid),
      cid: String(cid),
      mid: String(session.user?.mid || session.cookies.DedeUserID || ""),
      csrf: session.cookies.bili_jct || "",
      played_time: isFin ? "-1" : String(playTime),
      realtime: String(playTime),
      start_ts: String(Math.floor(Date.now() / 1000) - playTime),
      type: "3",
      dt: "2",
      play_type: isFin ? "4" : "1",
    });
    const j = await (await biliFetch("https://api.bilibili.com/x/report/web/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session)).json();
    res.json({ code: j.code, message: j.message });
  } catch (e) {
    res.status(500).json({ error: "历史心跳提交失败" });
  }
});

// ----------------------------- 收藏夹 -----------------------------
app.get("/api/favorites", async (req, res) => {
  let session = getSession(req);
  const ownMid = String(session?.user?.mid || session?.cookies?.DedeUserID || "");
  const qMid = String(parseInt(req.query.mid, 10) || "");
  const viewingOther = !!qMid && qMid !== ownMid;
  // 看自己的收藏夹必须登录；看别人的只能拿到对方公开的收藏夹，登录与否都可以尝试。
  if (!viewingOther) {
    session = requireSession(req, res);
    if (!session) return;
  }
  const upMid = viewingOther ? qMid : ownMid;
  try {
    const u = new URL("https://api.bilibili.com/x/v3/fav/folder/created/list-all");
    u.searchParams.set("up_mid", upMid);
    u.searchParams.set("type", "2");
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "收藏夹获取失败" });
    res.json({ mid: upMid, list: j.data?.list || [] });
  } catch {
    res.status(500).json({ error: "收藏夹获取失败" });
  }
});

app.get("/api/favorites/:mediaId", async (req, res) => {
  // 公开收藏夹无需登录即可读取；私密收藏夹由 B 站按登录态返回权限错误。
  const session = getSession(req);
  try {
    const u = new URL("https://api.bilibili.com/x/v3/fav/resource/list");
    u.searchParams.set("media_id", String(req.params.mediaId));
    u.searchParams.set("platform", "web");
    u.searchParams.set("ps", String(Math.min(parseInt(req.query.ps, 10) || 20, 20)));
    u.searchParams.set("pn", String(Math.max(1, parseInt(req.query.pn, 10) || 1)));
    u.searchParams.set("order", "mtime");
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "收藏内容获取失败" });
    res.json({
      info: j.data?.info || null,
      list: (j.data?.medias || []).map(normalizeVideo),
    });
  } catch {
    res.status(500).json({ error: "收藏内容获取失败" });
  }
});

app.post("/api/favorites/deal", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const aid = parseInt(req.body.aid, 10) || 0;
  const add = String(req.body.add_media_ids || "").trim();
  const del = String(req.body.del_media_ids || "").trim();
  if (!aid) return res.status(400).json({ error: "缺少 aid" });
  try {
    // 2026 起 x/v3/fav/resource/deal 强制要求 WBI 签名（见接口清单 FavorVideoApi /
    // VideoApi.favVideo：新库实测还需 WBI 签名）。不签名会被风控挡下并返回 -101/-403，
    // 容易误判成"未登录"。
    const signedParams = await signWbi({
      rid: String(aid),
      type: "2",
      add_media_ids: add,
      del_media_ids: del,
      csrf: session.cookies.bili_jct || "",
      platform: "web",
    }, session);
    const body = new URLSearchParams(signedParams);
    const j = await (await biliFetch("https://api.bilibili.com/x/v3/fav/resource/deal", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "收藏操作失败" });
    res.json({ ok: true, data: j.data });
  } catch {
    res.status(500).json({ error: "收藏操作失败" });
  }
});

// ----------------------------- 关注 / 用户空间 -----------------------------
// space 系列接口风控较严（-352），除 WBI 签名外再补一组 dm_img_* 参数。
const SPACE_DM_PARAMS = {
  dm_img_list: "[]",
  dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
  dm_cover_img_str: "QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKEludGVsKQ",
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
};

async function biliSignedGet(url, params, session) {
  const signed = await signWbi(params, session);
  const u = new URL(url);
  for (const [k, v] of Object.entries(signed)) u.searchParams.set(k, String(v));
  const r = await biliFetch(u.toString(), {
    headers: { Referer: `https://space.bilibili.com/${params.mid || ""}/` },
  }, session);
  return r.json();
}

function spaceErrorText(code, fallback) {
  switch (code) {
    case -101: return "请先登录 B 站账号";
    case -352:
    case -799: return "B 站风控拦截了本次请求，请稍后重试";
    case -404: return "该用户不存在";
    default: return fallback || "获取用户信息失败";
  }
}

function followErrorText(code, fallback) {
  switch (code) {
    case -101: return "登录已失效，请重新扫码登录";
    case -111: return "CSRF 校验失败，请重新登录";
    case -352: return "操作过于频繁或设备指纹缺失，请稍后再试";
    case -403: return "账号异常，操作被风控拦截";
    case 22001: return "不能关注自己";
    case 22002: return "因对方隐私设置，你还不能关注 ta";
    case 22003: return "你已将对方拉黑，请先解除拉黑";
    case 22009: return "关注数量已达上限";
    case 22013: return "对方账号已注销";
    case 22015: return "账号异常，请稍后再试";
    default: return fallback || "关注操作失败";
  }
}

// 当前登录用户是否已关注 mid。未登录 / 查询失败时按"未关注"返回，不报错。
app.get("/api/relation", async (req, res) => {
  const mid = parseInt(req.query.mid, 10) || 0;
  if (!mid) return res.status(400).json({ error: "缺少 mid 参数" });
  const session = getSession(req);
  if (!session || !session.cookies.SESSDATA) return res.json({ loggedIn: false, following: false });
  try {
    const u = new URL("https://api.bilibili.com/x/relation");
    u.searchParams.set("fid", String(mid));
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0 || !j.data) return res.json({ loggedIn: true, following: false, known: false });
    // attribute: 0 未关注 / 1 悄悄关注 / 2 已关注 / 6 已互粉 / 128 已拉黑
    const attr = j.data.attribute;
    res.json({ loggedIn: true, following: attr === 1 || attr === 2 || attr === 6, known: true });
  } catch {
    res.json({ loggedIn: true, following: false, known: false });
  }
});

// 关注 / 取消关注：POST { fid, act }，act=1 关注，act=2 取消关注。
app.post("/api/follow", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const fid = parseInt(req.body.fid, 10) || 0;
  const act = parseInt(req.body.act, 10) === 2 ? 2 : 1;
  if (!fid) return res.status(400).json({ error: "缺少 fid" });
  if (!session.cookies.bili_jct) {
    return res.status(401).json({ code: -111, error: "缺少 CSRF 凭据，请重新登录" });
  }
  try {
    const body = new URLSearchParams({
      fid: String(fid),
      act: String(act),
      re_src: "11",
      csrf: session.cookies.bili_jct,
    });
    const j = await (await biliFetch("https://api.bilibili.com/x/relation/modify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `https://space.bilibili.com/${fid}/`,
      },
      body,
    }, session)).json();
    // 22014：已经关注过了 —— 对前端来说目标状态已达成，按成功处理。
    if (j.code === 0 || (act === 1 && j.code === 22014)) return res.json({ ok: true, following: act === 1 });
    res.status(502).json({ code: j.code, error: followErrorText(j.code, j.message) });
  } catch (e) {
    console.error("关注异常:", e);
    res.status(500).json({ error: "关注操作失败（网络异常）" });
  }
});

// 用户资料：优先走 space/wbi/acc/info，被风控时回退到 web-interface/card。
async function fetchUserProfile(mid, session) {
  try {
    const j = await biliSignedGet("https://api.bilibili.com/x/space/wbi/acc/info", {
      mid: String(mid), platform: "web", web_location: "1550101", ...SPACE_DM_PARAMS,
    }, session);
    if (j.code === 0 && j.data) {
      const d = j.data;
      return {
        mid: d.mid || mid,
        uname: d.name || "",
        face: d.face || "",
        sign: d.sign || "",
        level: d.level ?? null,
        vipStatus: d.vip?.status === 1 ? 1 : 0,
        isFollowed: !!d.is_followed,
      };
    }
    if (j.code === -404) throw Object.assign(new Error(spaceErrorText(-404)), { code: -404 });
  } catch (e) {
    if (e.code === -404) throw e;
  }
  const u = new URL("https://api.bilibili.com/x/web-interface/card");
  u.searchParams.set("mid", String(mid));
  u.searchParams.set("photo", "false");
  const j = await (await biliFetch(u.toString(), {}, session)).json();
  if (j.code !== 0 || !j.data?.card) {
    throw Object.assign(new Error(spaceErrorText(j.code, j.message)), { code: j.code });
  }
  const c = j.data.card;
  return {
    mid: Number(c.mid) || mid,
    uname: c.name || "",
    face: c.face || "",
    sign: c.sign || "",
    level: c.level_info?.current_level ?? null,
    vipStatus: c.vip?.vipStatus === 1 || c.vip?.status === 1 ? 1 : 0,
    isFollowed: !!j.data.following,
  };
}

app.get("/api/user/:mid", async (req, res) => {
  const mid = parseInt(req.params.mid, 10) || 0;
  if (!mid) return res.status(400).json({ error: "无效的 mid" });
  const session = getSession(req);
  try {
    const [profile, rel] = await Promise.all([
      fetchUserProfile(mid, session),
      fetchRelationStat(mid, session),
    ]);
    res.json({ ...profile, follower: rel.follower, following: rel.following });
  } catch (e) {
    res.status(502).json({ code: e.code, error: e.message || "获取用户信息失败" });
  }
});

function parseDurationText(v) {
  if (typeof v === "number") return v;
  return String(v || "")
    .split(":")
    .map((n) => parseInt(n, 10) || 0)
    .reduce((acc, n) => acc * 60 + n, 0);
}

function normalizeSpaceVideo(v) {
  const pic = v.pic || v.cover || "";
  return {
    bvid: v.bvid || "",
    aid: v.aid || null,
    title: sanitizeTitle(v.title || ""),
    author: v.author || "",
    pic: pic.startsWith("//") ? `https:${pic}` : pic,
    play: typeof v.play === "number" ? v.play : (v.stat?.view ?? null), // 部分稿件 play 为 "--"
    danmaku: v.video_review ?? v.stat?.danmaku ?? null,
    duration: parseDurationText(v.length ?? v.duration),
    pubdate: v.created || v.pubdate || v.ctime || 0,
    description: v.description || v.desc || "",
  };
}

// 某个用户的投稿视频。order: pubdate(最新发布) / click(最多播放) / stow(最多收藏)。
app.get("/api/user/:mid/videos", async (req, res) => {
  const mid = parseInt(req.params.mid, 10) || 0;
  if (!mid) return res.status(400).json({ error: "无效的 mid" });
  const pn = Math.max(1, parseInt(req.query.pn, 10) || 1);
  const ps = Math.min(Math.max(parseInt(req.query.ps, 10) || 30, 1), 40);
  const order = ["pubdate", "click", "stow"].includes(req.query.order) ? req.query.order : "pubdate";
  const session = getSession(req);

  let failed = null;
  try {
    const j = await biliSignedGet("https://api.bilibili.com/x/space/wbi/arc/search", {
      mid: String(mid), ps: String(ps), pn: String(pn), order, tid: "0", keyword: "",
      platform: "web", web_location: "1550101", order_avoided: "true", ...SPACE_DM_PARAMS,
    }, session);
    if (j.code === 0 && j.data?.list) {
      const list = (j.data.list.vlist || []).map(normalizeSpaceVideo);
      const count = j.data.page?.count ?? list.length;
      return res.json({ list, page: { pn, ps, count }, hasMore: pn * ps < count });
    }
    failed = { code: j.code, message: j.message };
  } catch (e) {
    failed = { code: -1, message: e.message };
  }

  // 回退：arc/search 被风控时，用 series/recArchivesByKeywords 拿最近一批投稿（不支持排序和翻页）。
  if (pn === 1) {
    try {
      const u = new URL("https://api.bilibili.com/x/series/recArchivesByKeywords");
      u.searchParams.set("mid", String(mid));
      u.searchParams.set("keywords", "");
      u.searchParams.set("ps", "50");
      const j = await (await biliFetch(u.toString(), {
        headers: { Referer: `https://space.bilibili.com/${mid}/` },
      }, session)).json();
      if (j.code === 0 && Array.isArray(j.data?.archives)) {
        const list = j.data.archives.map(normalizeSpaceVideo);
        return res.json({ list, page: { pn: 1, ps: list.length, count: list.length }, hasMore: false, fallback: true });
      }
    } catch {}
  }
  res.status(502).json({ code: failed?.code, error: spaceErrorText(failed?.code, failed?.message || "投稿视频获取失败") });
});

// ============================= 直播 =============================
// 数据来源（2026-09）：
//   - 房间信息：api.live.bilibili.com/room/v1/Room/get_info（匿名可用）
//   - 主播信息：api.live.bilibili.com/live_user/v1/Master/info（匿名可用）
//   - 批量直播状态：api.live.bilibili.com/room/v1/Room/get_status_info_by_uids（按 uid 批量查，匿名可用）
//   - 关注的正在直播的 UP：api.live.bilibili.com/relation/v1/feed/getList（需登录）
//   - 首页/分区推荐直播：api.live.bilibili.com/xlive/web-interface/v1/second/getList（匿名可用）
//   - 取流（HLS）：api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo（匿名可用，登录可获取更高清晰度）
// 这些接口不在原始接口清单里，是本次按 2026-09 实测/开源客户端资料补的，字段可能随官方调整变化。

function normalizeLiveRoom(r) {
  return {
    roomId: r.roomid ?? r.room_id ?? r.roomId ?? null,
    uid: r.uid ?? null,
    uname: sanitizeTitle(r.uname || r.owner_name || ""),
    face: normalizeImgUrl(r.face || r.uface || ""),
    title: sanitizeTitle(r.title || ""),
    cover: normalizeImgUrl(r.cover || r.system_cover || r.user_cover || ""),
    online: r.online ?? null,
    area: r.area_name || r.area_name_v2 || r.area_v2_name || "",
    parentArea: r.parent_name || r.parent_area_name || r.area_v2_parent_name || "",
  };
}

// 按 uid 批量查直播状态：{ [uid]: { liveStatus, roomId, title, cover, online, uname, face } }
async function fetchLiveStatusByUids(uids, session) {
  const list = Array.from(new Set((uids || []).map((n) => parseInt(n, 10)).filter(Boolean))).slice(0, 50);
  if (!list.length) return {};
  try {
    const body = new URLSearchParams();
    list.forEach((uid) => body.append("uids[]", String(uid)));
    const r = await biliFetch("https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session);
    const j = await r.json();
    if (j.code !== 0 || !j.data) return {};
    const out = {};
    for (const [uid, d] of Object.entries(j.data)) {
      out[uid] = {
        liveStatus: d.live_status ?? 0,
        roomId: d.room_id ?? null,
        title: sanitizeTitle(d.title || ""),
        cover: normalizeImgUrl(d.cover_from_user || d.cover || ""),
        online: d.online ?? null,
        uname: sanitizeTitle(d.uname || ""),
        face: normalizeImgUrl(d.face || ""),
      };
    }
    return out;
  } catch {
    return {};
  }
}

// 批量查直播状态：GET ?uids=1,2,3（供 search.html 的 UP 卡片、account.html 头像角标使用）
app.get("/api/live/status", async (req, res) => {
  const uids = String(req.query.uids || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!uids.length) return res.json({});
  const session = getSession(req);
  res.json(await fetchLiveStatusByUids(uids, session));
});

// 关注的、正在直播的 UP 主（左栏）
// 原来用的 relation/v1/feed/getList 已失效（控制器里没这个方法）。
// 改用：关注列表 x/relation/followings 拿 mid，再批量查 get_status_info_by_uids 过滤开播的。
app.get("/api/live/followed", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const selfMid = session.cookies && (session.cookies.DedeUserID || session.cookies.DedeUserID__ckMd5);
    if (!selfMid) return res.status(401).json({ error: "无法获取当前用户" });

    // 取关注列表前 50 个（按关注时间倒序，侧边栏够用）
    const fu = new URL("https://api.bilibili.com/x/relation/followings");
    fu.searchParams.set("vmid", String(selfMid));
    fu.searchParams.set("pn", "1");
    fu.searchParams.set("ps", "50");
    fu.searchParams.set("order", "desc");
    const fj = await (await biliFetch(fu.toString(), {}, session)).json();
    if (fj.code !== 0 || !fj.data) return res.status(502).json({ error: `获取关注列表失败: ${fj.message || fj.code}` });
    const mids = (fj.data.list || []).map((u) => u.mid).filter(Boolean);

    const status = await fetchLiveStatusByUids(mids, session);
    const list = Object.entries(status)
      .filter(([, s]) => s.liveStatus === 1 && s.roomId)
      .map(([uid, s]) => ({
        roomId: s.roomId,
        uid: Number(uid),
        uname: s.uname,
        face: s.face,
        title: s.title,
        cover: s.cover,
        online: s.online,
        area: "",
        parentArea: "",
      }));
    res.json({ list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "获取关注直播失败" });
  }
});

// 推荐直播（右栏 / 未登录兜底）
app.get("/api/live/recommend", async (req, res) => {
  const session = getSession(req);
  try {
    // second/getList 现在对匿名请求一律 -352；改用直播首页 index/getList（匿名可用），
    // 它返回多个模块，其中"推荐直播"模块的 list 就是要展示的房间列表。
    const u = new URL("https://api.live.bilibili.com/xlive/web-interface/v1/index/getList");
    u.searchParams.set("platform", "web");
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: `获取推荐直播失败: ${j.message || j.code}` });
    const modules = j.data?.room_list || [];
    let rooms = [];
    for (const m of modules) {
      if (m.module_info?.title === "推荐直播" && Array.isArray(m.list)) { rooms = m.list; break; }
    }
    if (!rooms.length) rooms = modules.flatMap((m) => m.list || []);
    const list = rooms.map(normalizeLiveRoom).filter((r) => r.roomId);
    res.json({ list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "获取推荐直播失败" });
  }
});

// 直播间信息（stream.html 顶部信息 / 关注按钮）
app.get("/api/live/room", async (req, res) => {
  const roomId = parseInt(req.query.room_id, 10) || 0;
  if (!roomId) return res.status(400).json({ error: "缺少 room_id" });
  const session = getSession(req);
  try {
    const u = new URL("https://api.live.bilibili.com/room/v1/Room/get_info");
    u.searchParams.set("room_id", String(roomId));
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0 || !j.data) return res.status(502).json({ error: `直播间信息获取失败: ${j.message || j.code}` });
    const d = j.data;
    let master = {};
    try {
      const mu = new URL("https://api.live.bilibili.com/live_user/v1/Master/info");
      mu.searchParams.set("uid", String(d.uid));
      const mj = await (await biliFetch(mu.toString(), {}, session)).json();
      if (mj.code === 0 && mj.data) master = mj.data;
    } catch {}
    res.json({
      roomId: d.room_id,
      uid: d.uid,
      title: sanitizeTitle(d.title || ""),
      cover: normalizeImgUrl(d.user_cover || d.cover || ""),
      liveStatus: d.live_status ?? 0, // 0 未开播 1 直播中 2 轮播
      online: d.online ?? null,
      areaName: d.area_name || "",
      parentAreaName: d.parent_area_name || "",
      uname: sanitizeTitle(master.info?.uname || ""),
      face: normalizeImgUrl(master.info?.face || ""),
      follower: master.follower_num ?? null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "获取直播间信息失败" });
  }
});

// 取流：优先 HLS（供 artplayer + hls.js 播放），带 flv 兜底地址
app.get("/api/live/play", async (req, res) => {
  const roomId = parseInt(req.query.room_id, 10) || 0;
  if (!roomId) return res.status(400).json({ error: "缺少 room_id" });
  const qn = parseInt(req.query.qn, 10) || 10000;
  const session = getSession(req);
  try {
    const u = new URL("https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo");
    u.searchParams.set("room_id", String(roomId));
    u.searchParams.set("protocol", "0,1");
    u.searchParams.set("format", "0,1,2");
    u.searchParams.set("codec", "0,1");
    u.searchParams.set("qn", String(qn));
    u.searchParams.set("platform", "web");
    u.searchParams.set("ptype", "8");
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0 || !j.data) return res.status(502).json({ error: `取流失败: ${j.message || j.code}` });
    const d = j.data;
    if (d.live_status !== 1) return res.status(409).json({ error: "主播未开播", liveStatus: d.live_status ?? 0 });

    const playurl = d.playurl_info?.playurl || {};
    // 可用清晰度列表：优先用接口的 g_qn_desc，否则用 B 站标准 qn 映射表
    const QN_NAME = { 30000: "杜比", 20000: "4K", 10000: "原画", 400: "蓝光", 250: "超清", 150: "高清", 80: "流畅" };
    const acceptQn = playurl.accept_qn || [];
    let qnDesc = playurl.g_qn_desc || [];
    // 兜底：若接口没给 g_qn_desc，用映射表按 accept_qn 生成
    if ((!qnDesc || !qnDesc.length) && acceptQn.length) {
      qnDesc = acceptQn.map((qn) => ({ qn, desc: QN_NAME[qn] || String(qn) }));
    }
    const qualities = qnDesc
      .filter((q) => acceptQn.length === 0 || acceptQn.includes(q.qn))
      .map((q) => ({ qn: q.qn, desc: q.desc || QN_NAME[q.qn] || String(q.qn) }))
      .sort((a, b) => b.qn - a.qn);

    const streams = playurl.stream || [];
    let hlsUrl = "", flvUrl = "";
    for (const s of streams) {
      const isHls = s.protocol_name === "http_hls";
      for (const f of (s.format || [])) {
        for (const c of (f.codec || [])) {
          const info = (c.url_info || [])[0];
          if (!info) continue;
          const full = `${info.host}${c.base_url}${info.extra}`;
          if (isHls && !hlsUrl) hlsUrl = full;
          if (!isHls && !flvUrl) flvUrl = full;
        }
      }
    }
    if (!hlsUrl && !flvUrl) return res.status(502).json({ error: "未获取到可用的直播流地址" });
    res.json({ hlsUrl, flvUrl, liveStatus: d.live_status ?? 1, qualities, currentQn: qn });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "获取直播流失败" });
  }
});

// ============================= 消息中心 =============================
// 数据来源（bilibili-API-collect，message/ 目录，2026-09 复核仍可用）：
//   - 未读汇总：api.bilibili.com/x/msgfeed/unread
//   - 回复我的：api.bilibili.com/x/msgfeed/reply
//   - @我的：   api.bilibili.com/x/msgfeed/at
//   - 收到的赞：api.bilibili.com/x/msgfeed/like
//   - 私信会话列表 / 系统通知会话：api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions
//     （session_type: 1 私聊 2 系统通知 3 应援团）
//   - 私信未读数：api.vc.bilibili.com/session_svr/v1/session_svr/single_unread
//   - 会话消息记录：api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs
//   - 发送私信：   api.vc.bilibili.com/web_im/v1/web_im/send_msg
// 这些接口字段在社区文档里也标注"部分不明确"，前端做了容错渲染，取不到的字段直接跳过。

// 发送直播弹幕。POST https://api.live.bilibili.com/msg/send，需登录 cookie + csrf。
app.post("/api/live/send", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const roomid = parseInt(req.body.roomid, 10) || 0;
  const message = String(req.body.message || "").trim().slice(0, 30);
  if (!roomid || !message) return res.status(400).json({ error: "缺少房间号或弹幕内容" });
  try {
    const body = new URLSearchParams({
      color: "16777215",
      fontsize: "25",
      mode: "1",
      bubble: "0",
      msg: message,
      rnd: String(Math.floor(Date.now() / 1000)),
      roomid: String(roomid),
      csrf: session.cookies.bili_jct || "",
      csrf_token: session.cookies.bili_jct || "",
    });
    const j = await (await biliFetch("https://api.live.bilibili.com/msg/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `https://live.bilibili.com/${roomid}`,
      },
      body,
    }, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: j.message || "弹幕发送失败" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "弹幕发送失败" });
  }
});

app.get("/api/message/unread", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const [feedJ, sessJ] = await Promise.all([
      (await biliFetch("https://api.bilibili.com/x/msgfeed/unread", {}, session)).json(),
      (await biliFetch("https://api.vc.bilibili.com/session_svr/v1/session_svr/single_unread", {}, session)).json(),
    ]);
    const feed = feedJ.code === 0 ? feedJ.data : {};
    const sess = sessJ.code === 0 ? sessJ.data : {};
    res.json({
      chat: (sess.follow_unread || 0) + (sess.unfollow_unread || 0),
      reply: feed.reply || 0,
      at: feed.at || 0,
      like: feed.like || 0,
      sysMsg: feed.sys_msg || 0,
    });
  } catch (e) {
    res.status(500).json({ error: "获取未读消息数失败" });
  }
});

function pickText(...vals) {
  for (const v of vals) { if (typeof v === "string" && v) return v; }
  return "";
}

// 回复我的 / @我的 / 收到的赞 —— 三个 feed 结构接近，统一归一化
function normalizeFeedItem(x) {
  const user = x.user || x.up_action_text_user || (x.users?.[0]) || {};
  const item = x.item || {};
  const pic = item.pictures?.[0]?.img_src || item.image || item.item_pic || item.cover || "";
  const userCount = x.users?.length || (user.nickname ? 1 : 0);
  return {
    id: x.id ?? null,
    actorName: sanitizeTitle(pickText(user.nickname, user.uname, x.nickname)),
    actorFace: normalizeImgUrl(user.avatar || user.face || ""),
    actorMid: Number(user.mid || user.uid || x.uid || 0),
    actionText: sanitizeTitle(pickText(item.title_prefix, x.reply_type_desc)) || (userCount > 1 ? `${userCount} 人赞了` : ""),
    content: sanitizeTitle(pickText(item.source_content, item.target_reply_content, item.content, item.item_name, item.title, x.item?.reply?.content?.message)),
    thumb: normalizeImgUrl(pic),
    time: x.reply_time || x.at_time || x.like_time || x.time || x.like_time || 0,
    uri: item.uri || "",
    bvid: item.bvid || item.uri?.match(/BV[0-9a-zA-Z]+/)?.[0] || "",
    aid: item.oid || item.business_id || 0,
    rpid: item.target_reply_id || x.id || 0,
  };
}

async function fetchFeedList(url, cursorId, session) {
  const params = { id: String(cursorId || 0), build: "0", mobi_app: "web" };
  const signed = await signWbi(params, session);
  const u = new URL(url);
  Object.entries(signed).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  const j = await (await biliFetch(u.toString(), {}, session)).json();
  if (j.code !== 0) throw Object.assign(new Error(j.message || String(j.code)), { code: j.code });
  const items = (j.data?.items || j.data?.total?.items || j.data?.latest?.items || []).map(normalizeFeedItem);
  const cursor = j.data?.cursor || j.data?.total?.cursor || {};
  return { items, hasMore: !cursor.is_end, nextId: cursor.id || 0 };
}

app.get("/api/message/reply", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    res.json(await fetchFeedList("https://api.bilibili.com/x/msgfeed/reply", req.query.cursor, session));
  } catch (e) { res.status(502).json({ error: "获取回复消息失败: " + e.message }); }
});
app.get("/api/message/at", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    res.json(await fetchFeedList("https://api.bilibili.com/x/msgfeed/at", req.query.cursor, session));
  } catch (e) { res.status(502).json({ error: "获取 @ 消息失败: " + e.message }); }
});
app.get("/api/message/like", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    res.json(await fetchFeedList("https://api.bilibili.com/x/msgfeed/like", req.query.cursor, session));
  } catch (e) { res.status(502).json({ error: "获取点赞消息失败: " + e.message }); }
});

// 用户名片小缓存：私信会话列表按 talker_id 批量补头像/昵称，避免同一个人反复请求
const cardCache = new Map(); // mid -> { data, at }
const CARD_TTL_MS = 10 * 60 * 1000;
async function fetchCardCached(mid, session) {
  const hit = cardCache.get(mid);
  if (hit && Date.now() - hit.at < CARD_TTL_MS) return hit.data;
  try {
    const u = new URL("https://api.bilibili.com/x/web-interface/card");
    u.searchParams.set("mid", String(mid));
    u.searchParams.set("photo", "false");
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    const data = j.code === 0 && j.data?.card
      ? { uname: sanitizeTitle(j.data.card.name || ""), face: normalizeImgUrl(j.data.card.face || "") }
      : { uname: `用户${mid}`, face: "" };
    cardCache.set(mid, { data, at: Date.now() });
    return data;
  } catch {
    return { uname: `用户${mid}`, face: "" };
  }
}

// 有限并发的 map，避免几十个会话同时打满出站请求
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

function parseMsgContent(msgType, content) {
  try {
    const j = JSON.parse(content);
    if (msgType === 1) return { type: "text", text: j.content || "" };
    if (msgType === 2) return { type: "image", url: normalizeImgUrl(j.url || ""), width: j.width, height: j.height };
    if (msgType === 5) return { type: "revoke" };
    return { type: "other", raw: j };
  } catch {
    return { type: "text", text: String(content || "") };
  }
}

// 会话列表：session_type 1=私聊（我的消息） 2=系统通知
app.get("/api/message/sessions", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const sessionType = req.query.type === "2" ? 2 : 1;
  try {
    const u = new URL("https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions");
    u.searchParams.set("session_type", String(sessionType));
    u.searchParams.set("group_fold", "1");
    u.searchParams.set("unfollow_fold", "0");
    u.searchParams.set("sort_rule", "2");
    u.searchParams.set("build", "0");
    u.searchParams.set("mobi_app", "web");
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: `获取会话列表失败: ${j.message || j.code}` });
    const rawList = j.data?.session_list || [];
    const list = await mapLimit(rawList, 6, async (s) => {
      const card = await fetchCardCached(s.talker_id, session);
      const lastMsg = s.last_msg || {};
      const parsed = parseMsgContent(lastMsg.msg_type, lastMsg.content);
      return {
        talkerId: s.talker_id,
        uname: card.uname,
        face: card.face,
        unreadCount: s.unread_count || 0,
        lastMsgPreview: parsed.type === "text" ? parsed.text : parsed.type === "image" ? "[图片]" : parsed.type === "revoke" ? "[消息已撤回]" : "",
        lastMsgTime: lastMsg.timestamp || 0,
      };
    });
    res.json({ list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "获取会话列表失败" });
  }
});

// 某个会话的消息记录（默认取最近 30 条）
app.get("/api/message/history", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  const talkerId = parseInt(req.query.talker_id, 10) || 0;
  const sessionType = req.query.type === "2" ? 2 : 1;
  if (!talkerId) return res.status(400).json({ error: "缺少 talker_id" });
  try {
    const u = new URL("https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs");
    u.searchParams.set("talker_id", String(talkerId));
    u.searchParams.set("session_type", String(sessionType));
    u.searchParams.set("size", "30");
    if (req.query.begin_seqno) u.searchParams.set("begin_seqno", String(req.query.begin_seqno));
    const j = await (await biliFetch(u.toString(), {}, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: `获取消息记录失败: ${j.message || j.code}` });
    const myMid = Number(session.cookies.DedeUserID || 0);
    const list = (j.data?.messages || []).map((m) => ({
      senderUid: m.sender_uid,
      isMine: Number(m.sender_uid) === myMid,
      seqno: m.msg_seqno,
      timestamp: m.timestamp,
      ...parseMsgContent(m.msg_type, m.content),
    })).reverse();
    res.json({ list });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "获取消息记录失败" });
  }
});

function randomDevId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  }).toUpperCase();
}

// 表情面板：转发 B 站表情接口
app.get("/api/emote/panel", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const j = await (await biliFetch("https://api.bilibili.com/x/emote/user/panel?web_location=1315875&business=1", {}, session)).json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: "获取表情失败" });
  }
});

// 私信图片上传：转发到 B 站图片接口
app.post("/api/message/upload-image", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  try {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const buf = Buffer.concat(chunks);
      const fd = new FormData();
      fd.append("file_up", new Blob([buf], { type: "image/png" }), "image.png");
      fd.append("category", "daily");
      fd.append("csrf", session.cookies.bili_jct || "");
      const upstream = await fetch("https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs", {
        method: "POST",
        headers: {
          Cookie: cookieHeader({ ...parseCookieString(cachedCookie || ""), ...session.cookies }),
          "User-Agent": COMMON_HEADERS["User-Agent"],
          "Referer": "https://t.bilibili.com/",
          "Origin": "https://t.bilibili.com",
        },
        body: fd,
        signal: AbortSignal.timeout(15000),
      });
      const text = await upstream.text();
      let j;
      try { j = JSON.parse(text); } catch { return res.status(502).json({ error: "图片上传失败: 服务器返回异常" }); }
      if (j.code !== 0) {
        return res.status(502).json({ error: "图片上传失败: " + (j.message || j.msg || j.code) });
      }
      const url = j.data?.image_url || j.data?.url || j.data?.img_url || "";
      res.json({ url, width: j.data?.image_width || j.data?.width || 0, height: j.data?.image_height || j.data?.height || 0 });
    });
  } catch (e) {
    res.status(500).json({ error: "图片上传失败" });
  }
});

app.post("/api/message/send", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  if (!session.cookies.bili_jct) return res.status(401).json({ code: -111, error: "缺少 CSRF 凭据，请重新登录" });
  const receiverId = parseInt(req.body.talker_id, 10) || 0;
  const text = String(req.body.content || "").trim();
  const imgUrl = String(req.body.image_url || "").trim();
  if (!receiverId || (!text && !imgUrl)) return res.status(400).json({ error: "缺少 talker_id 或 content" });
  const myMid = Number(session.cookies.DedeUserID || 0);
  if (!myMid) return res.status(401).json({ error: "登录态缺少 DedeUserID" });
  try {
    const isImage = !!imgUrl;
    const msgType = isImage ? "2" : "1";
    const contentObj = isImage
      ? { url: imgUrl, width: Number(req.body.image_width) || 0, height: Number(req.body.image_height) || 0 }
      : { content: text };
    const body = new URLSearchParams({
      "msg[sender_uid]": String(myMid),
      "msg[receiver_id]": String(receiverId),
      "msg[receiver_type]": "1",
      "msg[msg_type]": msgType,
      "msg[msg_status]": "0",
      "msg[dev_id]": randomDevId(),
      "msg[timestamp]": String(Math.floor(Date.now() / 1000)),
      "msg[content]": JSON.stringify(contentObj),
      csrf: session.cookies.bili_jct,
    });
    const j = await (await biliFetch("https://api.vc.bilibili.com/web_im/v1/web_im/send_msg", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, session)).json();
    if (j.code !== 0) return res.status(502).json({ error: `发送失败: ${j.msg || j.message || j.code}` });
    res.json({ ok: true, msgKey: j.data?.msg_key || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "发送失败（网络异常）" });
  }
});

// ----------------------------- 环境诊断（排查平板/WebView 登录问题） -----------------------------
app.get("/api/diag/set-cookie", (req, res) => {
  res.cookie("diag_cookie", "ok", { httpOnly: true, path: "/", maxAge: 60000, sameSite: "lax" });
  res.json({ ok: true });
});
app.get("/api/diag/whoami", (req, res) => {
  const cookies = String(req.headers.cookie || "");
  res.json({
    cookie_received: cookies.split(";").some(p => p.trim().startsWith("diag_cookie=")),
    token_received: !!req.headers["x-bili-session"],
  });
});
app.get("/diag", (req, res) => res.sendFile(path.join(__dirname, "public", "diag.html")));

// ----------------------------- 静态页面 -----------------------------
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/search"));
app.get("/search", (req, res) => res.sendFile(path.join(__dirname, "public", "search.html")));
app.get("/player", (req, res) => res.sendFile(path.join(__dirname, "public", "player.html")));
app.get("/account", (req, res) => res.sendFile(path.join(__dirname, "public", "account.html")));
app.get("/live", (req, res) => res.sendFile(path.join(__dirname, "public", "live.html")));
app.get("/stream", (req, res) => res.sendFile(path.join(__dirname, "public", "stream.html")));
app.get("/message", (req, res) => res.sendFile(path.join(__dirname, "public", "message.html")));

// ----------------------------- 直播弹幕转发（WebSocket） -----------------------------
// 浏览器不方便直接连 B 站直播弹幕协议（二进制帧），所以由服务端先调 getDanmuInfo
// 拿到弹幕服务器地址 + token，再带 token 建立 WebSocket，解析后转发给前端。
// 老版 bilibili-live-ws 写死连 broadcastlv.chat.bilibili.com 且 join 不带 token，
// 现在一连上就被 B 站断开（OPEN→CLOSE），所以这里自己按官方流程连，只复用它的编解码。
const httpServer = require("http").createServer(app);
let LiveBuffer = null;
try {
  LiveBuffer = require("bilibili-live-ws/src/buffer");
} catch {
  console.warn("[直播弹幕] 未找到 bilibili-live-ws 依赖，请先 npm install 后重启");
}

async function fetchDanmuEndpoint(roomId, session) {
  if (!cachedCookie) { try { await ensureCookie(); } catch {} }
  const params = { id: String(roomId), type: "0" };
  const signed = await signWbi(params, session);
  const u = new URL("https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo");
  for (const [k, v] of Object.entries(signed)) u.searchParams.set(k, String(v));
  const headers = { Referer: `https://live.bilibili.com/${roomId}` };
  let j = await (await biliFetch(u.toString(), { headers }, session)).json();
  // 偶发 -352 风控：清掉旧 buvid3 重新取一次再试
  if (j.code === -352) {
    cachedCookie = ""; cookieFetchedAt = 0;
    try { await ensureCookie(); } catch {}
    j = await (await biliFetch(u.toString(), { headers }, session)).json();
  }
  if (j.code !== 0 || !j.data) throw new Error(j.message || "getDanmuInfo 失败");
  // join 包必须用真实 room_id（短号会被服务器立刻断开 1006），用 room_init 解析。
  let realRoomId = roomId;
  try {
    const ri = await (await biliFetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`, { headers }, session)).json();
    if (ri.code === 0 && ri.data && ri.data.room_id) realRoomId = ri.data.room_id;
  } catch {}
  return { ...j.data, realRoomId }; // { token, host_list, realRoomId }
}

try {
  const { WebSocketServer, WebSocket } = require("ws");
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/live" });
  wss.on("connection", async (ws, req) => {
    const urlp = new URL(req.url, "http://x");
    let roomId = 0;
    try { roomId = parseInt(urlp.searchParams.get("room_id"), 10) || 0; } catch {}
    if (!roomId || !LiveBuffer) {
      try { ws.send(JSON.stringify({ cmd: "__error", message: "弹幕转发服务不可用" })); } catch {}
      return ws.close();
    }
    // 浏览器把整串 B 站 cookie 放在 query 里带过来（WebSocket 不能自定义 header），
    // 登录态调 getDanmuInfo 能显著降低 -352 风控概率。
    let session = null;
    try {
      const rawCookie = urlp.searchParams.get("cookie") || "";
      if (rawCookie) {
        const cookies = parseCookieString(rawCookie);
        if (cookies.SESSDATA) session = { cookies, user: null, createdAt: 0, lastSeen: 0 };
      }
    } catch {}

    let info;
    try {
      info = await fetchDanmuEndpoint(roomId, session);
    } catch (e) {
      try { ws.send(JSON.stringify({ cmd: "__error", message: "获取弹幕服务器失败: " + (e.message || "") })); } catch {}
      return ws.close();
    }

    // WS 握手要带 cookie（浏览器会自动带，Node 不会），否则风控直接断 1006
    const wsCookie = [cachedCookie, session ? Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join("; ") : ""].filter(Boolean).join("; ");

    let sock = null;
    let heartbeatTimer = null;
    let closed = false;
    let reconnectTimer = null;
    const stopHeartbeat = () => { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } };

    async function connectUpstream() {
      if (closed) return;
      let tok;
      try { tok = await fetchDanmuEndpoint(roomId, session); }
      catch (e) { if (!closed) reconnectTimer = setTimeout(connectUpstream, 5000); return; }
      const host = (tok.host_list && tok.host_list[0] && tok.host_list[0].host) || "broadcastlv.chat.bilibili.com";
      const wssPort = (tok.host_list && tok.host_list[0] && tok.host_list[0].wss_port) || 443;
      try {
        sock = new WebSocket(`wss://${host}:${wssPort}/sub`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
            Origin: "https://live.bilibili.com",
            Cookie: wsCookie,
          },
        });
      } catch (e) { if (!closed) reconnectTimer = setTimeout(connectUpstream, 5000); return; }

      sock.on("open", () => {
        const ck = parseCookieString(cachedCookie);
        const buvid = ck.buvid3 || "";
        const uid = Number(session?.cookies?.DedeUserID) || 0;
        sock.send(LiveBuffer.encoder({
          type: "join",
          body: { uid, roomid: tok.realRoomId || roomId, protover: 2, buvid, platform: "web", type: 2, key: tok.token },
        }));
        stopHeartbeat();
        heartbeatTimer = setInterval(() => { try { sock.send(LiveBuffer.encoder({ type: "heartbeat" })); } catch {} }, 30000);
      });

      sock.on("message", async (buffer) => {
        let packs;
        try { packs = await LiveBuffer.decoder(buffer); } catch (e) { return; }
        for (const pack of packs) {
          if (pack.type !== "message" || !pack.data) continue;
          const data = pack.data;
          const cmd = data.cmd || (data.msg && data.msg.cmd);
          if (!cmd) continue;
          if (ws.readyState !== ws.OPEN) continue;
          try { ws.send(JSON.stringify({ cmd, data })); } catch {}
        }
      });

      sock.on("close", (code) => {
        stopHeartbeat();
        if (closed) return;
        reconnectTimer = setTimeout(connectUpstream, 5000);
      });
      sock.on("error", () => { stopHeartbeat(); try { sock.close(); } catch {} });
    }

    ws.on("close", () => { closed = true; stopHeartbeat(); clearTimeout(reconnectTimer); try { sock && sock.close(); } catch {} });
    ws.on("error", () => { closed = true; stopHeartbeat(); clearTimeout(reconnectTimer); try { sock && sock.close(); } catch {} });

    connectUpstream();
  });
} catch {
  console.warn("[直播弹幕] 未找到 ws 依赖，请先 npm install 后重启");
}

httpServer.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
  console.log(`  搜索页: http://localhost:${PORT}/search`);
  console.log(`  播放页: http://localhost:${PORT}/player`);
  console.log(`  我的:   http://localhost:${PORT}/account`);
  console.log(`  直播:   http://localhost:${PORT}/live`);
  console.log(`  消息:   http://localhost:${PORT}/message`);
});

// 凭证完全在前端 localStorage，服务端无状态，退出无需写盘。
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
// 任何未捕获的异步错误 / 未处理 Promise 拒绝都只记录、不崩进程（Termux 长跑必须）。
process.on("unhandledRejection", (e) => console.warn("[未处理 Promise]", e && e.message || e));
process.on("uncaughtException", (e) => console.warn("[未捕获异常]", e && e.message || e));
//（注：内容由AI生成）
