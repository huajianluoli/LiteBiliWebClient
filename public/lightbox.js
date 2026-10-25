/*
 * 通用图片大图查看器（动态 / 图文 / 视频评论区 / 私信 共用）
 *
 * 用法：
 *   BiliLightbox.open(['https://…/a.jpg', {url:'…'}], 0)      // 直接打开
 *   BiliLightbox.bind(rootEl, '.some-img', (el) => ({ list: [...], index: 0 }))
 *       // 在 rootEl 上做事件委托：点到 .some-img 就按返回的图片组打开；
 *       // 返回 null/空数组表示这次点击不处理（比如是表情图）。
 *
 * 操作：左右键/点左右按钮/手机左右滑切图；滚轮或双击放大，放大后可拖动；Esc/点空白处/点 × 关闭。
 */
(function () {
  if (window.BiliLightbox) return;

  var css = '' +
    '.bl-mask{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none}' +
    '.bl-mask.show{display:flex}' +
    '.bl-img{max-width:94vw;max-height:90vh;object-fit:contain;cursor:zoom-in;transition:transform .12s ease;-webkit-user-drag:none;will-change:transform}' +
    '.bl-img.zoomed{cursor:grab;transition:none}' +
    '.bl-img.dragging{cursor:grabbing}' +
    '.bl-btn{position:absolute;width:44px;height:44px;padding:0;border:none;border-radius:50%;background:rgba(255,255,255,.14);color:#fff;font-size:26px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
    '.bl-btn:hover{background:rgba(255,255,255,.3)}' +
    '.bl-prev{left:16px;top:50%;transform:translateY(-50%)}' +
    '.bl-next{right:16px;top:50%;transform:translateY(-50%)}' +
    '.bl-close{right:16px;top:16px}' +
    '.bl-count{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);padding:3px 12px;border-radius:12px;background:rgba(0,0,0,.55);color:#fff;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}' +
    '.bl-mask.single .bl-prev,.bl-mask.single .bl-next,.bl-mask.single .bl-count{display:none}';

  var mask, img, countEl, list = [], idx = 0, scale = 1, tx = 0, ty = 0, drag = null, swipeX = null;

  function build() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    mask = document.createElement('div');
    mask.className = 'bl-mask';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.innerHTML =
      '<button type="button" class="bl-btn bl-close" aria-label="关闭">&times;</button>' +
      '<button type="button" class="bl-btn bl-prev" aria-label="上一张">&#8249;</button>' +
      '<img class="bl-img" alt="" referrerpolicy="no-referrer" draggable="false">' +
      '<button type="button" class="bl-btn bl-next" aria-label="下一张">&#8250;</button>' +
      '<div class="bl-count"></div>';
    document.body.appendChild(mask);
    img = mask.querySelector('.bl-img');
    countEl = mask.querySelector('.bl-count');

    mask.querySelector('.bl-close').onclick = close;
    mask.querySelector('.bl-prev').onclick = function (e) { e.stopPropagation(); step(-1); };
    mask.querySelector('.bl-next').onclick = function (e) { e.stopPropagation(); step(1); };
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

    // 缩放：滚轮 / 双击
    mask.addEventListener('wheel', function (e) {
      e.preventDefault();
      setScale(scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18));
    }, { passive: false });
    img.addEventListener('dblclick', function (e) { e.preventDefault(); setScale(scale > 1 ? 1 : 2.5); });

    // 放大后拖动
    img.addEventListener('mousedown', function (e) {
      if (scale <= 1) return;
      e.preventDefault();
      drag = { x: e.clientX - tx, y: e.clientY - ty };
      img.classList.add('dragging');
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply();
    });
    window.addEventListener('mouseup', function () { drag = null; if (img) img.classList.remove('dragging'); });

    // 手机：未放大时左右滑切图
    mask.addEventListener('touchstart', function (e) {
      swipeX = (e.touches.length === 1 && scale <= 1) ? e.touches[0].clientX : null;
    }, { passive: true });
    mask.addEventListener('touchend', function (e) {
      if (swipeX == null) return;
      var dx = e.changedTouches[0].clientX - swipeX;
      swipeX = null;
      if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    });

    document.addEventListener('keydown', function (e) {
      if (!mask.classList.contains('show')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
  }

  function apply() {
    img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    img.classList.toggle('zoomed', scale > 1);
  }
  function setScale(s) {
    scale = Math.min(5, Math.max(1, s));
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  }
  function show() {
    scale = 1; tx = 0; ty = 0; apply();
    img.src = list[idx].url;
    countEl.textContent = (idx + 1) + ' / ' + list.length;
  }
  function step(d) {
    if (list.length < 2) return;
    idx = (idx + d + list.length) % list.length;
    show();
  }
  function open(items, index) {
    var arr = (items || []).map(function (it) { return typeof it === 'string' ? { url: it } : it; })
      .filter(function (it) { return it && it.url; });
    if (!arr.length) return;
    build();
    list = arr;
    idx = Math.min(Math.max(index || 0, 0), arr.length - 1);
    mask.classList.toggle('single', arr.length < 2);
    mask.classList.add('show');
    document.body.style.overflow = 'hidden';
    show();
  }
  function close() {
    if (!mask) return;
    mask.classList.remove('show');
    img.removeAttribute('src');
    document.body.style.overflow = '';
  }

  function bind(root, selector, getGroup) {
    if (!root) return;
    root.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest(selector) : null;
      if (!el || !root.contains(el)) return;
      var g = getGroup(el);
      if (!g || !g.list || !g.list.length) return;
      e.preventDefault();
      e.stopPropagation();
      open(g.list, g.index || 0);
    }, true);   // 捕获阶段：先于页面里其它点击处理（比如评论整条点击=回复）
  }

  window.BiliLightbox = { open: open, close: close, bind: bind };
})();
