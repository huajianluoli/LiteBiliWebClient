/* 顶栏消息角标：轮询 /api/message/unread 渲染未读总数。
 * 所有页面共用，引入方式：导航消息按钮内加 <span class="nav-badge" id="navMsgBadge" style="display:none"></span>
 * 并在 </body> 前 <script src="/msg-badge.js" defer></script>。
 * 未登录时接口 401，直接隐藏角标；打开会话后 message 页调 MsgBadge.refresh() 即时刷新。 */
(function () {
  'use strict';
  var badge = document.getElementById('navMsgBadge');
  if (!badge) return;

  // 顶栏角标样式统一在这里注入，各页面不用各自维护
  (function injectStyle() {
    var s = document.createElement('style');
    s.textContent = '.user-icon{position:relative}.nav-badge#navMsgBadge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--pink,#FB7299);color:#fff;font-size:11px;font-weight:700;position:absolute;top:-6px;right:-8px;z-index:5;box-sizing:border-box;line-height:1}';
    document.head.appendChild(s);
  })();

  function render(n) {
    n = Number(n) || 0;
    if (n <= 0) {
      badge.style.display = 'none';
      badge.textContent = '';
      return;
    }
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.style.display = '';
  }

  var seq = 0;
  async function refresh() {
    var s = ++seq;
    try {
      var r = await fetch('/api/message/unread');
      var d = await r.json().catch(function () { return null; });
      if (s !== seq) return;
      if (!r.ok || !d) { render(0); return; }
      render((Number(d.chat) || 0) + (Number(d.reply) || 0) + (Number(d.at) || 0) + (Number(d.like) || 0) + (Number(d.sysMsg) || 0));
    } catch (e) {
      if (s === seq) render(0);
    }
  }

  window.MsgBadge = {
    refresh: refresh,
    clear: function () { render(0); },
  };

  refresh();
  setInterval(refresh, 60000);
  // 切回前台时立即刷一次，别等下一轮定时器
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });
})();
