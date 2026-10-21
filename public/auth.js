/* 公网访问口令前端：
 * 1. 包装 fetch：所有请求自动带 X-Access-Token（取 localStorage.access_token）
 * 2. URL 带 ?k=口令 时自动保存（方便分享一次性链接）
 * 3. 服务端开启口令（/api/config 返回 authRequired）且本地无口令时，
 *    全屏弹窗要求输入口令，输入正确后刷新进入。
 * 必须在页面其它脚本之前执行（放 <head> 同步加载），
 * 否则页面早期发起的 API 请求会赶不上带 token。
 */
(function () {
  'use strict';
  var TOKEN_KEY = 'access_token';

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  // URL 带 ?k= 时保存口令并清掉地址栏参数
  try {
    var k = new URLSearchParams(location.search).get('k');
    if (k) {
      localStorage.setItem(TOKEN_KEY, k);
      history.replaceState({}, '', location.pathname + location.hash);
    }
  } catch (e) {}

  var origFetch = window.fetch;
  window.fetch = function (url, opts) {
    opts = opts || {};
    var headers = new Headers(opts.headers || {});
    var t = getToken();
    if (t) headers.set('X-Access-Token', t);
    opts.headers = headers;
    return origFetch.call(this, url, opts);
  };

  function showGate() {
    if (document.getElementById('accessGate')) return;
    var mask = document.createElement('div');
    mask.id = 'accessGate';
    mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;';
    mask.innerHTML =
      '<div style="background:var(--card,#ffffff);color:var(--text,#18191c);padding:28px 32px;border-radius:14px;text-align:center;max-width:300px;width:86%;box-sizing:border-box;box-shadow:0 8px 40px rgba(0,0,0,.25)">' +
      '<div style="font-size:16px;font-weight:700;margin-bottom:6px">访问需要口令</div>' +
      '<div style="font-size:12px;color:var(--text-3,#9499a0);margin-bottom:16px">本服务已开启公网保护，请输入访问口令</div>' +
      '<input id="accessGateInput" type="password" placeholder="请输入访问口令" autocomplete="off" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--border,#dcdee2);border-radius:8px;font-size:14px;outline:none;background:var(--bg,#ffffff);color:var(--text,#18191c);margin-bottom:14px">' +
      '<button id="accessGateBtn" style="width:100%;padding:10px 0;border:none;border-radius:8px;background:#FB7299;color:#fff;font-size:14px;font-weight:600;cursor:pointer">进入</button>' +
      '</div>';
    document.body.appendChild(mask);
    var input = document.getElementById('accessGateInput');
    function submit() {
      var v = input.value.trim();
      if (!v) return;
      try { localStorage.setItem(TOKEN_KEY, v); } catch (e) {}
      location.reload();
    }
    document.getElementById('accessGateBtn').onclick = submit;
    input.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    setTimeout(function () { input.focus(); }, 50);
  }

  function checkAuth() {
    origFetch('/api/config').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.authRequired && !getToken()) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', showGate);
        } else {
          showGate();
        }
      }
    }).catch(function () {});
  }

  checkAuth();
})();
