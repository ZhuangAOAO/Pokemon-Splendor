/* ============================================================================
   confirm-dialog.js —— 统一确认框（替代浏览器原生 confirm）
   用法：const ok = await spConfirm({ title, message, confirmText, cancelText, danger });
   交互：Enter = 确认；Esc = 取消；点遮罩 = 取消；危险操作焦点默认落在「取消」
   约束：只用现有 CSS 变量（带兜底值）；圆角/阴影/遮罩/动效时长与站内弹层一致；
         遮罩期间阻止底层点击；844×390 横屏下不溢出、按钮不被裁
   ========================================================================== */
(function () {
  const CSS = [
    '.spc2-mask{ position:fixed; inset:0; z-index:900; display:flex; align-items:center; justify-content:center;',
    '  background:rgba(18,26,38,.46); padding:16px; animation:spc2In .22s cubic-bezier(.4,0,.2,1); }',
    '.spc2-mask[hidden]{ display:none; }',
    '@keyframes spc2In{ from{ opacity:0 } to{ opacity:1 } }',
    '.spc2-box{ background:var(--paper,#fff); color:var(--ink,#22303d); border-radius:22px; padding:24px 26px;',
    '  width:min(420px,92vw); max-height:86vh; overflow:auto; box-shadow:0 24px 70px rgba(0,0,0,.4);',
    '  animation:spc2Pop .28s cubic-bezier(.2,.9,.3,1.2); text-align:center; }',
    '@keyframes spc2Pop{ from{ opacity:0; transform:translateY(10px) scale(.96) } to{ opacity:1; transform:none } }',
    '.spc2-box h3{ margin:0 0 8px; font-size:18px; font-weight:900; }',
    '.spc2-msg{ color:var(--ink-soft,#5b6b7c); font-size:13px; line-height:1.6; margin:0 0 18px; }',
    '.spc2-actions{ display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }',
    /* 危险操作：用更深一档的红 + 更重的投影（品牌主按钮本身就是红，故靠"更深+更沉"区分） */
    '.spc2-danger{ background:var(--red-deep,#b5260a) !important; box-shadow:0 6px 18px rgba(181,38,10,.42) !important; }',
    '.spc2-danger:hover{ filter:brightness(1.06); }',
    '@media (max-height:480px){',
    '  .spc2-box{ padding:16px 18px; border-radius:18px; }',
    '  .spc2-box h3{ font-size:16px; margin-bottom:6px; }',
    '  .spc2-msg{ margin-bottom:12px; }',
    '  .spc2-actions .btn{ padding:8px 16px; font-size:14px; }',
    '}',
    '@media (prefers-reduced-motion: reduce){ .spc2-mask,.spc2-box{ animation-duration:.01ms !important; } }',
  ].join('\n');

  let host = null, box = null, titleEl = null, msgEl = null, okBtn = null, cancelBtn = null;
  let resolveFn = null, keyHandler = null;

  function installCSS() {
    if (document.getElementById('spc2-style')) return;
    const st = document.createElement('style');
    st.id = 'spc2-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.className = 'spc2-mask';
    host.id = 'spc2-mask';
    host.hidden = true;
    host.innerHTML = '<div class="spc2-box" role="dialog" aria-modal="true">'
      + '<h3 id="spc2-title"></h3><p class="spc2-msg" id="spc2-msg"></p>'
      + '<div class="spc2-actions">'
      + '<button type="button" class="btn ghost" id="spc2-cancel">取消</button>'
      + '<button type="button" class="btn primary" id="spc2-ok">确定</button>'
      + '</div></div>';
    document.body.appendChild(host);
    box = host.querySelector('.spc2-box');
    titleEl = host.querySelector('#spc2-title');
    msgEl = host.querySelector('#spc2-msg');
    okBtn = host.querySelector('#spc2-ok');
    cancelBtn = host.querySelector('#spc2-cancel');
    okBtn.addEventListener('click', () => done(true));
    cancelBtn.addEventListener('click', () => done(false));
    // 点遮罩 = 取消；并阻止点击穿透到底层
    host.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === host) done(false);
    });
    host.addEventListener('mousedown', (e) => e.stopPropagation());
    host.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    else if (e.key === 'Enter') {
      // 焦点在「取消」上时，Enter 也按"当前焦点按钮"走（危险操作防误触的关键）
      e.preventDefault(); e.stopPropagation();
      if (document.activeElement === cancelBtn) done(false); else done(true);
    }
  }

  function done(val) {
    if (host) host.hidden = true;
    if (keyHandler) { document.removeEventListener('keydown', keyHandler, true); keyHandler = null; }
    const r = resolveFn; resolveFn = null;
    if (r) r(val);
  }

  // 兼容旧调用：spConfirm('一句话') 亦可
  window.spConfirm = function (opts) {
    const o = (typeof opts === 'string') ? { message: opts } : (opts || {});
    installCSS(); build();
    titleEl.textContent = o.title || '请确认';
    msgEl.textContent = o.message || '';
    okBtn.textContent = o.confirmText || (o.danger ? '确定' : '确定');
    cancelBtn.textContent = o.cancelText || '取消';
    okBtn.className = 'btn primary' + (o.danger ? ' spc2-danger' : '');
    host.hidden = false;
    keyHandler = onKey;
    document.addEventListener('keydown', keyHandler, true);
    // 危险操作焦点默认落在「取消」，防误触；普通操作落在「确定」
    setTimeout(() => { (o.danger ? cancelBtn : okBtn).focus(); }, 30);
    return new Promise((resolve) => { resolveFn = resolve; });
  };
})();
