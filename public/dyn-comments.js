/*
 * 动态 / 图文 通用评论面板（动态页内嵌展开、图文详情页底部都用它）
 *
 *   const h = DynComments.mount(slotEl, { oid, type, myMid, toast: fn, onCountDelta: (d) => {} });
 *   h.destroy();
 *
 * 依赖服务端接口：/api/comments  /api/comments/replies  /api/comments/like  /api/comments/send  /api/comments/delete
 * （评论区类型 type：11 图文 / 17 动态 / 1 视频；oid 是字符串，别转成数字，18 位整数会丢精度）
 */
(function () {
  if (window.DynComments) return;

  var css = '' +
    '.cm-panel{padding:12px 0 4px;border-top:1px dashed var(--border,#e3e5e7);color:var(--text,#18191c)}' +
    '.cm-compose{display:flex;gap:10px;align-items:flex-start}' +
    '.cm-compose textarea{flex:1;min-height:38px;max-height:120px;resize:vertical;padding:8px 12px;border:1px solid var(--border,#e3e5e7);border-radius:8px;background:var(--bg,#f1f2f3);color:var(--text,#18191c);font:inherit;font-size:14px;outline:none}' +
    '.cm-compose textarea:focus{border-color:#FB7299;background:var(--card,#fff)}' +
    '.cm-send{flex-shrink:0;height:38px;padding:0 20px;border:none;border-radius:8px;background:#FB7299;color:#fff;font-size:14px;font-weight:600;cursor:pointer}' +
    '.cm-send:disabled{opacity:.5;cursor:default}' +
    '.cm-tools{display:flex;align-items:center;gap:6px;margin-top:6px}' +
    '.cm-tools button{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:none;border-radius:6px;background:none;color:var(--text-2,#61666d);cursor:pointer}' +
    '.cm-tools button:hover{background:var(--bg,#f1f2f3);color:#FB7299}' +
    '.cm-tools button:disabled{opacity:.5;cursor:default}' +
    '.cm-tools-hint{font-size:12px;color:var(--text-3,#9499a0);margin-left:4px}' +
    '.cm-pending{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}' +
    '.cm-pending:empty{display:none}' +
    '.cm-thumb{position:relative;width:72px;height:72px;border-radius:6px;overflow:hidden;background:var(--bg,#f1f2f3);border:1px solid var(--border,#e3e5e7)}' +
    '.cm-thumb img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.cm-thumb-x{position:absolute;top:2px;right:2px;width:20px;height:20px;padding:0;border:none;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:14px;line-height:1;cursor:pointer}' +
    '.cm-emote-panel{display:none;max-height:200px;overflow-y:auto;margin-top:6px;padding:6px;border-radius:8px;background:var(--bg,#f1f2f3)}' +
    '.cm-emote-panel.show{display:block}' +
    '.cm-emote-pkg-name{padding:4px 2px;font-size:11px;color:var(--text-3,#9499a0)}' +
    '.cm-emote-grid{display:flex;flex-wrap:wrap;gap:2px}' +
    '.cm-emote-grid img{width:32px;height:32px;object-fit:contain;cursor:pointer}' +
    '.cm-target{display:none;margin:6px 0 0;font-size:12px;color:var(--text-3,#9499a0)}' +
    '.cm-target.show{display:block}' +
    '.cm-target button{margin-left:8px;padding:0;border:none;background:none;color:#00A1D6;font-size:12px;cursor:pointer}' +
    '.cm-list{margin-top:10px}' +
    '.cm-item{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid var(--border,#e3e5e7)}' +
    '.cm-item:last-child{border-bottom:none}' +
    '.cm-avatar{width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--bg,#f1f2f3)}' +
    '.cm-avatar.sub{width:24px;height:24px}' +
    '.cm-main{min-width:0;flex:1}' +
    '.cm-name{font-size:13px;font-weight:600;color:var(--text-2,#61666d);text-decoration:none}' +
    '.cm-name:hover{color:#FB7299}' +
    '.cm-text{margin-top:3px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}' +
    '.cm-emote{height:1.5em;width:auto;vertical-align:-.35em}' +
    '.cm-pics{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
    '.cm-pic{max-width:160px;max-height:140px;border-radius:6px;border:1px solid var(--border,#e3e5e7);cursor:zoom-in;background:var(--bg,#f1f2f3)}' +
    '.cm-meta{margin-top:5px;display:flex;align-items:center;gap:14px;font-size:12px;color:var(--text-3,#9499a0)}' +
    '.cm-meta button{padding:0;border:none;background:none;color:inherit;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:3px}' +
    '.cm-meta button:hover,.cm-meta button.on{color:#FB7299}' +
    '.cm-subs{margin-top:8px;padding:2px 0 2px 12px;border-left:2px solid var(--border,#e3e5e7)}' +
    '.cm-subs .cm-item{padding:8px 0}' +
    '.cm-more{margin-top:4px;padding:0;border:none;background:none;color:#00A1D6;font-size:12px;cursor:pointer}' +
    '.cm-state{padding:16px 0;text-align:center;color:var(--text-3,#9499a0);font-size:13px}' +
    '.cm-loadmore{display:block;margin:8px auto 0;padding:7px 24px;border:1px solid var(--border,#e3e5e7);border-radius:16px;background:var(--card,#fff);color:var(--text-2,#61666d);font-size:13px;cursor:pointer}' +
    '.cm-loadmore:hover{color:#FB7299;border-color:#FB7299}';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function faceUrl(f) { f = String(f || ''); return f.indexOf('//') === 0 ? 'https:' + f : f; }
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(n);
  }
  function agoText(ts) {
    if (!ts) return '';
    var s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + '分钟前';
    if (s < 86400) return Math.floor(s / 3600) + '小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + '天前';
    var d = new Date(ts * 1000), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  var LIKE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Zm0 0l4.5-8a2 2 0 0 1 3.5 1.5V9h4.2a2 2 0 0 1 1.97 2.3l-1.1 7A2 2 0 0 1 18.1 20H10a3 3 0 0 1-3-3v-6Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';

  var EMOJI_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1.1" fill="currentColor"/><circle cx="15" cy="10" r="1.1" fill="currentColor"/><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  var IMG_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M21 16l-5-5-9 9" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  var MAX_PICS = 9;
  var emoteCache = null;   // 表情包整页缓存：同一页面里多个评论框共用，只请求一次
  function loadEmotes() {
    if (emoteCache) return Promise.resolve(emoteCache);
    return fetch('/api/emotes?business=reply').then(function (r) { return r.json(); })
      .then(function (j) { emoteCache = j.list || []; return emoteCache; });
  }

  function jpost(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); });
  }

  function mount(slot, opts) {
    if (!document.getElementById('dyn-comments-css')) {
      var st = document.createElement('style');
      st.id = 'dyn-comments-css';
      st.textContent = css;
      document.head.appendChild(st);
    }
    var toast = opts.toast || function (t) { alert(t); };
    var st2 = { next: 0, isEnd: false, loading: false, replyTo: null, retryFirst: true };

    slot.innerHTML = '<div class="cm-panel">' +
      '<div class="cm-compose"><textarea rows="1" maxlength="1000" placeholder="发一条友善的评论" data-cm-input></textarea><button type="button" class="cm-send" data-cm-send>发送</button></div>' +
      '<div class="cm-tools"><button type="button" data-cm-emote-btn title="表情">' + EMOJI_ICON + '</button>' +
      '<button type="button" data-cm-img-btn title="图片">' + IMG_ICON + '</button>' +
      '<input type="file" accept="image/*" multiple hidden data-cm-file><span class="cm-tools-hint" data-cm-hint></span></div>' +
      '<div class="cm-pending" data-cm-pending></div>' +
      '<div class="cm-emote-panel" data-cm-emote-panel></div>' +
      '<div class="cm-target" data-cm-target></div>' +
      '<div class="cm-list" data-cm-list></div><div data-cm-foot></div></div>';
    var root = slot.firstElementChild;
    var listEl = root.querySelector('[data-cm-list]'), footEl = root.querySelector('[data-cm-foot]');
    var ta = root.querySelector('[data-cm-input]'), sendBtn = root.querySelector('[data-cm-send]');
    var tgt = root.querySelector('[data-cm-target]');
    var fileInput = root.querySelector('[data-cm-file]'), imgBtn = root.querySelector('[data-cm-img-btn]');
    var emoteBtn = root.querySelector('[data-cm-emote-btn]'), emotePanel = root.querySelector('[data-cm-emote-panel]');
    var pendingEl = root.querySelector('[data-cm-pending]'), hintEl = root.querySelector('[data-cm-hint]');
    var pics = [];          // 已上传、等待随评论发送的图片 [{url,width,height,size}]
    var uploading = 0;

    // 点工具栏按钮 / 表情面板时不要抢走输入框的焦点和光标位置
    function keepFocus(e) { e.preventDefault(); }
    emoteBtn.addEventListener('mousedown', keepFocus);
    emotePanel.addEventListener('mousedown', keepFocus);

    function insertAtCaret(text) {
      var start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
      var end = ta.selectionEnd == null ? start : ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
      var pos = start + text.length;
      ta.focus();
      try { ta.setSelectionRange(pos, pos); } catch (e) {}
    }
    function renderPending() {
      pendingEl.innerHTML = pics.map(function (p, i) {
        return '<div class="cm-thumb"><img src="' + esc(p.url) + '" alt="" referrerpolicy="no-referrer">' +
          '<button type="button" class="cm-thumb-x" data-cm-rm="' + i + '" aria-label="移除">&times;</button></div>';
      }).join('');
      hintEl.textContent = uploading ? '图片上传中…' : (pics.length ? pics.length + '/' + MAX_PICS : '');
      imgBtn.disabled = pics.length + uploading >= MAX_PICS;
    }
    async function uploadFiles(files) {
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        if (!/^image\//.test(f.type)) { toast('只能上传图片'); continue; }
        if (pics.length + uploading >= MAX_PICS) { toast('最多添加 ' + MAX_PICS + ' 张图片'); break; }
        uploading++; renderPending();
        try {
          var r = await fetch('/api/comments/upload-image', { method: 'POST', body: f });
          var d = await r.json().catch(function () { return {}; });
          if (!r.ok || !d.url) { toast(d.error || '图片上传失败'); if (r.status === 401) setTimeout(function () { location.href = '/account'; }, 1200); }
          else pics.push({ url: d.url, width: d.width, height: d.height, size: d.size });
        } catch (e) { toast('图片上传失败（网络异常）'); }
        uploading--; renderPending();
      }
    }
    imgBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var files = Array.prototype.slice.call(fileInput.files || []);
      fileInput.value = '';
      if (files.length) uploadFiles(files);
    });
    // 直接粘贴截图也能当附图
    ta.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.files) || [];
      var imgs = Array.prototype.filter.call(items, function (f) { return /^image\//.test(f.type); });
      if (imgs.length) { e.preventDefault(); uploadFiles(imgs); }
    });
    emoteBtn.addEventListener('click', function () {
      var show = !emotePanel.classList.contains('show');
      emotePanel.classList.toggle('show', show);
      if (!show || emotePanel.dataset.loaded) return;
      emotePanel.innerHTML = '<div class="cm-state">加载表情…</div>';
      loadEmotes().then(function (list) {
        emotePanel.innerHTML = list.map(function (pkg) {
          return '<div class="cm-emote-pkg-name">' + esc(pkg.name) + '</div><div class="cm-emote-grid">' + pkg.emojis.map(function (e) {
            return '<img src="' + esc(e.url) + '" alt="' + esc(e.text) + '" title="' + esc(e.text) + '" data-cm-emote="' + esc(e.text) + '" referrerpolicy="no-referrer">';
          }).join('') + '</div>';
        }).join('') || '<div class="cm-state">暂无表情</div>';
        emotePanel.dataset.loaded = '1';
      }).catch(function () { emotePanel.innerHTML = '<div class="cm-state">表情加载失败</div>'; });
    });

    function textHTML(c) {
      var html = esc(c.message || '');
      var names = Object.keys(c.emoji || {}).sort(function (a, b) { return b.length - a.length; });
      if (names.length) {
        var re = new RegExp('\\[(' + names.map(function (n) { return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')\\]', 'g');
        html = html.replace(re, function (m, name) {
          return '<img class="cm-emote" src="' + esc(c.emoji[name]) + '" alt="' + esc(name) + '" loading="lazy" referrerpolicy="no-referrer">';
        });
      }
      return html;
    }
    function picsHTML(c) {
      if (!c.pictures || !c.pictures.length) return '';
      return '<div class="cm-pics">' + c.pictures.map(function (p) {
        return '<img class="cm-pic" src="' + esc(p.src) + '" referrerpolicy="no-referrer" loading="lazy" alt="">';
      }).join('') + '</div>';
    }
    function moreBtn(rpid, text) { return '<button type="button" class="cm-more" data-more="' + esc(rpid) + '" data-pn="1">' + text + '</button>'; }
    function itemHTML(c, isSub, rootRpid) {
      var mine = opts.myMid && Number(c.mid) === Number(opts.myMid);
      var subs = '';
      if (!isSub && (c.rcount || (c.replies && c.replies.length))) {
        var inner = (c.replies || []).map(function (r) { return itemHTML(r, true, c.rpid); }).join('');
        var more = c.rcount > (c.replies || []).length ? moreBtn(c.rpid, '共 ' + c.rcount + ' 条回复，点击查看') : '';
        subs = '<div class="cm-subs" data-root="' + esc(c.rpid) + '">' + inner + more + '</div>';
      }
      return '<div class="cm-item" data-rpid="' + esc(c.rpid) + '" data-uname="' + esc(c.uname) + '" data-root="' + esc(rootRpid || c.rpid) + '">' +
        '<img class="cm-avatar' + (isSub ? ' sub' : '') + '" src="' + esc(faceUrl(c.avatar)) + '" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility=\'hidden\'">' +
        '<div class="cm-main"><a class="cm-name" href="/account?mid=' + esc(c.mid) + '">' + esc(c.uname) + '</a>' +
        '<div class="cm-text">' + textHTML(c) + '</div>' + picsHTML(c) +
        '<div class="cm-meta"><span>' + esc(agoText(c.ctime)) + '</span>' +
        '<button type="button" data-cm-like class="' + (c.liked ? 'on' : '') + '">' + LIKE_SVG + '<span data-n="' + (c.like || 0) + '">' + (c.like ? fmtCount(c.like) : '点赞') + '</span></button>' +
        '<button type="button" data-cm-reply>回复</button>' + (mine ? '<button type="button" data-cm-del>删除</button>' : '') +
        '</div>' + subs + '</div></div>';
    }

    function load(first) {
      if (st2.loading) return Promise.resolve();
      st2.loading = true;
      if (first) listEl.innerHTML = '<div class="cm-state">评论加载中…</div>'; else footEl.innerHTML = '<div class="cm-state">加载中…</div>';
      var q = new URLSearchParams({ oid: opts.oid, type: opts.type, next: st2.next });
      return fetch('/api/comments?' + q).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
        .then(function (x) {
          if (!x.r.ok) throw new Error(x.d.error || '评论加载失败');
          if (first) listEl.innerHTML = '';
          listEl.insertAdjacentHTML('beforeend', x.d.list.map(function (c) { return itemHTML(c, false); }).join(''));
          st2.next = x.d.next; st2.isEnd = !!x.d.isEnd;
          if (first && !x.d.list.length) listEl.innerHTML = '<div class="cm-state">还没有评论，来抢沙发吧</div>';
          footEl.innerHTML = st2.isEnd ? '' : '<button type="button" class="cm-loadmore" data-cm-loadmore>加载更多评论</button>';
        }).catch(function (e) {
          if (first) listEl.innerHTML = '';
          footEl.innerHTML = '<div class="cm-state">' + esc(e.message || '评论加载失败') + ' <button type="button" class="cm-more" data-cm-retry>重试</button></div>';
          st2.retryFirst = !!first;
        }).then(function () { st2.loading = false; });
    }

    function resetTarget() {
      st2.replyTo = null; tgt.classList.remove('show'); tgt.innerHTML = ''; ta.placeholder = '发一条友善的评论';
    }

    function send() {
      var text = ta.value.trim();
      if (uploading) { toast('图片还在上传，请稍等'); return; }
      if (!text && !pics.length) { toast('先写点什么吧'); return; }
      sendBtn.disabled = true;
      var body = { oid: opts.oid, type: opts.type, message: text };
      if (pics.length) body.pictures = pics;
      if (st2.replyTo) { body.root = st2.replyTo.root; body.parent = st2.replyTo.parent; }
      jpost('/api/comments/send', body).then(function (x) {
        if (!x.r.ok) { toast(x.d.error || '发送失败'); if (x.r.status === 401) setTimeout(function () { location.href = '/account'; }, 1200); return; }
        ta.value = ''; pics = []; renderPending(); emotePanel.classList.remove('show');
        var reply = x.d.reply;
        if (reply) {
          if (st2.replyTo) {
            var rootId = String(st2.replyTo.root);
            var subs = root.querySelector('.cm-subs[data-root="' + CSS.escape(rootId) + '"]');
            var html = itemHTML(reply, true, rootId);
            if (subs) subs.insertAdjacentHTML('afterbegin', html);
            else {
              var main = root.querySelector('.cm-item[data-rpid="' + CSS.escape(rootId) + '"] .cm-main');
              if (main) main.insertAdjacentHTML('beforeend', '<div class="cm-subs" data-root="' + esc(rootId) + '">' + html + '</div>');
            }
          } else {
            var empty = listEl.querySelector('.cm-state'); if (empty) empty.remove();
            listEl.insertAdjacentHTML('afterbegin', itemHTML(reply, false));
          }
        }
        if (opts.onCountDelta) opts.onCountDelta(1);
        resetTarget();
        toast('评论发送成功');
      }).catch(function () { toast('网络异常，请重试'); }).then(function () { sendBtn.disabled = false; });
    }

    function onClick(e) {
      var t = e.target;
      if (t.closest('[data-cm-send]')) { send(); return; }
      if (t.closest('[data-cm-loadmore]')) { load(false); return; }
      if (t.closest('[data-cm-retry]')) { load(st2.retryFirst); return; }
      if (t.closest('[data-cm-cancel]')) { resetTarget(); return; }
      var rm = t.closest('[data-cm-rm]');
      if (rm) { pics.splice(Number(rm.dataset.cmRm), 1); renderPending(); return; }
      var em = t.closest('[data-cm-emote]');
      if (em) { insertAtCaret(em.dataset.cmEmote); emotePanel.classList.remove('show'); return; }

      var rbtn = t.closest('[data-cm-reply]');
      if (rbtn) {
        var row = rbtn.closest('.cm-item');
        st2.replyTo = { root: row.dataset.root, parent: row.dataset.rpid, uname: row.dataset.uname };
        tgt.innerHTML = '回复 @' + esc(row.dataset.uname) + '<button type="button" data-cm-cancel>取消</button>';
        tgt.classList.add('show'); ta.placeholder = '回复 @' + row.dataset.uname; ta.focus();
        return;
      }

      var lbtn = t.closest('[data-cm-like]');
      if (lbtn) {
        var lrow = lbtn.closest('.cm-item');
        var want = !lbtn.classList.contains('on');
        var span = lbtn.querySelector('span');
        var paint = function (on) {
          lbtn.classList.toggle('on', on);
          var n = Math.max(0, Number(span.dataset.n || 0) + (on ? 1 : -1));
          span.dataset.n = String(n); span.textContent = n ? fmtCount(n) : '点赞';
        };
        paint(want);
        jpost('/api/comments/like', { oid: opts.oid, type: opts.type, rpid: lrow.dataset.rpid, like: want }).then(function (x) {
          if (!x.r.ok) { paint(!want); toast(x.d.error || '点赞失败'); }
        }).catch(function () { paint(!want); toast('网络异常，请重试'); });
        return;
      }

      var dbtn = t.closest('[data-cm-del]');
      if (dbtn) {
        if (!confirm('确定删除这条评论吗？')) return;
        var drow = dbtn.closest('.cm-item');
        jpost('/api/comments/delete', { oid: opts.oid, type: opts.type, rpid: drow.dataset.rpid }).then(function (x) {
          if (!x.r.ok) { toast(x.d.error || '删除失败'); return; }
          drow.remove(); if (opts.onCountDelta) opts.onCountDelta(-1);
        }).catch(function () { toast('网络异常，请重试'); });
        return;
      }

      var more = t.closest('[data-more]');
      if (more) {
        more.disabled = true; more.textContent = '加载中…';
        var rootId = more.dataset.more, pn = Number(more.dataset.pn);
        var q = new URLSearchParams({ oid: opts.oid, type: opts.type, root: rootId, pn: pn });
        fetch('/api/comments/replies?' + q).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { r: r, d: d }; }); })
          .then(function (x) {
            if (!x.r.ok) throw new Error(x.d.error || '回复加载失败');
            var box = more.closest('.cm-subs');
            if (pn === 1) box.querySelectorAll('.cm-item').forEach(function (n) { n.remove(); });   // 首次展开：完整列表替换预览的前 3 条
            more.insertAdjacentHTML('beforebegin', x.d.list.map(function (c) { return itemHTML(c, true, rootId); }).join(''));
            if (x.d.list.length >= 10) { more.disabled = false; more.dataset.pn = String(pn + 1); more.textContent = '查看更多回复'; }
            else more.remove();
          }).catch(function (err) { more.disabled = false; more.textContent = err.message || '加载失败，点击重试'; });
      }
    }
    root.addEventListener('click', onClick);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });

    if (window.BiliLightbox) {
      BiliLightbox.bind(root, '.cm-pic', function (el) {
        var box = el.closest('.cm-pics');
        var imgs = box ? Array.prototype.slice.call(box.querySelectorAll('.cm-pic')) : [el];
        return { list: imgs.map(function (i) { return i.currentSrc || i.src; }), index: imgs.indexOf(el) };
      });
    }

    load(true);
    return { destroy: function () { slot.innerHTML = ''; } };
  }

  window.DynComments = { mount: mount };
})();
