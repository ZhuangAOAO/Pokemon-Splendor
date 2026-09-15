'use strict';
/* ================================================================
   对局回放页（/replay）：
   登录 → 选回放 → 从开局快照起步，按记录逐步重放行动，复用 client.js 渲染。
   本页把 client.js 切到本地渲染模式（client.js 顶部 ONLINE 判断），
   所有互动入口被封死（dispatch/actDiscardOne/newGame/backToSetup/postApi），
   电脑的自动决策由 S.replay 标记禁用（game-core 的 scheduleAI 守卫）。
   ================================================================ */
(() => {
  if (location.pathname.indexOf('replay') < 0) return; // 只在回放页激活

  /* ---- 1. 保存真实入口，然后封死一切会改动对局的出口（观看者只读） ---- */
  const api = postApi; // 真实网络请求（登录 / 取回放数据）
  const real = {
    take3: actTakeThree, take2: actTakeTwo, ret: actReturnBall, discard: actDiscardOne,
    master: actTakeMaster, reserve: actReserve, reserveBlind: actReserveBlind,
    buy: actBuy, buyReserved: actBuyReserved, evolve: actEvolve, skipEvolve: actSkipEvolve,
    after: afterActionDone,
  };
  window.dispatch = () => {};        // 行动分发入口（联机/本地）
  window.actDiscardOne = () => {};   // 本地退球直调（client.js 里有一处）
  window.newGame = () => {};         // 结算弹窗「再来一局」
  window.backToSetup = () => {};     // 「返回设置」
  window.postApi = () => Promise.resolve({ ok: false }); // 其余网络请求全部无效

  /* ---- 2. 钩子：静默快进时不弹提示不重绘，正常单步时照常 ---- */
  const origToast = HOOKS.onToast;
  const origChanged = HOOKS.onStateChanged;
  const origOver = HOOKS.onGameOver;
  let silent = false;
  HOOKS.onToast = (m) => { $('#rp-event').textContent = m; if (!silent) origToast(m); };
  HOOKS.onStateChanged = () => { if (!silent) origChanged(); };
  HOOKS.onGameOver = () => { if (!silent) origOver(); stopPlay(); };
  HOOKS.onAction = () => {};

  /* ---- 2.5 结算弹窗补「关闭」按钮：回放页隐藏了「再来一局/返回设置」，没有它观看者会被卡在弹窗后面 ---- */
  (() => {
    const go = document.querySelector('#modal-gameover');
    if (go) {
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.style.marginTop = '14px';
      btn.textContent = '关闭';
      btn.addEventListener('click', hideModals);
      go.appendChild(btn);
    }
  })();

  /* ---- 3. 回放状态 ---- */
  const NAME_CN = {
    take3: '拿取精灵球', take2: '拿取 2 个同色球', takeMaster: '拿取大师球',
    return: '退还精灵球', discard: '退还多余精灵球', reserve: '预约宝可梦',
    reserveBlind: '盲抽预约', buy: '收服宝可梦', buyReserved: '收服预约的宝可梦',
    evolve: '宝可梦进化', skipEvolve: '跳过进化', skip: '没有可执行的行动，跳过',
  };
  const COLORS_CN = window.COLORS && window.BALLS ? Object.fromEntries(window.COLORS.map((c) => [c, window.BALLS[c].name])) : {};
  // 与主页面共用同一个令牌（client.js 登录时写 localStorage 'spToken'）：
  // 主页面登录后进回放页免二次登录，反向亦然
  let rpToken = localStorage.getItem('spToken') || '';
  let rpMe = '';       // 当前登录账号名（用来在列表里认出“我”那一局）
  let rp = null;       // 当前回放数据
  let cur = 0;         // 已应用行动数
  let playing = false;
  let playTimer = null;

  const gate = $('#rp-gate'), bar = $('#rp-bar'), slider = $('#rp-slider');

  /* ---- 4. 登录门 ---- */
  function showGate() {
    stopPlay();
    bar.hidden = true;
    document.querySelectorAll('[id^="screen-"]').forEach((s) => { s.hidden = true; });
    hideModals();
    gate.hidden = false;
    $('#rp-page').hidden = true;
    $('#rp-login-form').hidden = false;
  }
  function descAction(a) {
    if (!rp) return '';
    const who = (rp.players[a.seat] && rp.players[a.seat].name) || '?';
    let what = NAME_CN[a.k] || a.k;
    if (a.k === 'take3' && a.p.colors) what += '：' + a.p.colors.map((c) => COLORS_CN[c] || c).join('、');
    else if ((a.k === 'take2' || a.k === 'return' || a.k === 'discard') && a.p.color) what += '：' + (COLORS_CN[a.p.color] || a.p.color);
    return `${who} · ${what}`;
  }
  function updatePos() {
    slider.value = cur;
    $('#rp-pos').textContent = `${cur} / ${rp.actions.length}`;
    if (cur > 0) $('#rp-event').textContent = descAction(rp.actions[cur - 1]);
    else $('#rp-event').textContent = '开局';
  }
  async function login() {
    const j = await api({ type: 'login', name: $('#rp-name').value.trim(), password: $('#rp-pass').value });
    if (!j.ok) { toast(j.msg || '登录失败'); return; }
    rpToken = j.token;
    rpMe = ($('#rp-name').value || '').trim();
    localStorage.setItem('spToken', rpToken);
    afterLogin();
  }
  function afterLogin() {
    const id = Number(new URLSearchParams(location.search).get('id'));
    if (id) loadReplay(id);
    else showList();
  }
  // 胜负徽章：自己参与的对局判“胜/负/平”，管理员看别人的局则标出胜者
  function resultOf(r) {
    const winners = r.winners || [];
    if (!winners.length) return { badge: '', chip: '' };
    const me = (r.players || []).find((p) => p.account && rpMe && p.account === rpMe);
    if (!me) return { badge: '', chip: `<span class="rp-chip">胜者 ${winners.join('、')}</span>` };
    if (!winners.includes(me.name)) return { badge: '<span class="rp-badge lose">负</span>', chip: '' };
    return {
      badge: winners.length > 1 ? '<span class="rp-badge tie">平</span>' : '<span class="rp-badge win">胜</span>',
      chip: '',
    };
  }
  async function showList() {
    stopPlay();
    bar.hidden = true;
    document.querySelectorAll('[id^="screen-"]').forEach((s) => { s.hidden = true; });
    hideModals();
    gate.hidden = true;                       // 登录后收起「门」，换成整页列表
    $('#rp-page').hidden = false;
    const j = await api({ type: 'replayList', token: rpToken });
    const sub = $('#rp-page-sub');
    if (!j.ok) {
      sub.textContent = '';
      $('#rp-list').innerHTML = `<div class="rp-empty">${j.msg || '加载失败'}</div>`;
      return;
    }
    const list = j.list || [];
    // 管理员能看所有人的对局，普通玩家只能看自己参与的，说明文字同步
    sub.textContent = j.admin
      ? `管理员视角：最近 ${list.length} 局（最多 50 条），点「观看」逐步重放`
      : `共 ${list.length} 局，点「观看」逐步重放每一步行动`;
    $('#rp-list').innerHTML = list.length
      ? list.map((r) => {
          const res = resultOf(r);
          const score = (r.scores || []).length
            ? `<span class="rp-chip">比分 ${r.scores.map((s) => s.points).join(' : ')}</span>` : '';
          return `
        <a class="rp-card" href="/replay?id=${r.id}">
          ${res.badge}
          <div class="rp-card-main">
            <div class="rp-card-when">${r.createdAt || '时间未知'}</div>
            <div class="rp-card-who">${(r.players || []).map((p) => p.name).join(' vs ') || '—'}</div>
            <div class="rp-chips">
              <span class="rp-chip">房间 ${r.roomId}</span>
              <span class="rp-chip">目标 ${r.target} 分</span>
              <span class="rp-chip">${r.steps} 步</span>
              ${score}${res.chip}
            </div>
          </div>
          <span class="rp-go">观看 ›</span>
        </a>`;
        }).join('')
      : `<div class="rp-empty">${j.admin ? '还没有任何对局记录' : '你还没有对局记录，先开局打一局吧'}</div>`;
  }

  /* ---- 5. 回放驱动 ---- */
  function applyAction(a) {
    switch (a.k) {
      case 'take3': real.take3(a.p.colors); break;
      case 'take2': real.take2(a.p.color); break;
      case 'return': real.ret(a.p.color); break;
      case 'discard': real.discard(a.p.color); break;
      case 'takeMaster': real.master(); break;
      case 'reserve': real.reserve(a.p.tier, a.p.idx); break;
      case 'reserveBlind': real.reserveBlind(a.p.tier); break;
      case 'buy': real.buy(a.p.tier, a.p.idx); break;
      case 'buyReserved': real.buyReserved(a.p.ridx); break;
      case 'evolve': real.evolve(a.p.loc); break;
      case 'skipEvolve': real.skipEvolve(); break;
      case 'skip': real.after(); break; // 电脑无行动可做：与真实对局一致直接推进
    }
  }
  // 从开局快照重放前 k 步（静默：不弹提示不重绘，最后统一渲染）
  function stepTo(k) {
    if (!rp) return;
    if (k < 0) k = 0;
    if (k > rp.actions.length) k = rp.actions.length;
    stopPlay();
    silent = true;
    overShown = false;
    hideModals();
    window.S = JSON.parse(JSON.stringify(rp.initial)); // 深拷贝：重放会改动状态，别污染原快照
    S.replay = true; // 禁用电脑自动决策（scheduleAI 守卫）
    for (let i = 0; i < k; i++) applyAction(rp.actions[i]);
    silent = false;
    cur = k;
    render();
    if (S.over) origOver(); // 跳到最后一步时补弹结算
    updatePos();
  }
  function stepNext() {
    if (!rp || cur >= rp.actions.length) return;
    applyAction(rp.actions[cur]);
    cur++;
    updatePos();
  }
  function startPlay() {
    if (!rp || playing || cur >= rp.actions.length) return;
    playing = true;
    $('#rp-play').textContent = '暂停';
    playTimer = setInterval(() => {
      if (cur >= rp.actions.length) { stopPlay(); return; }
      stepNext();
    }, 1300);
  }
  function stopPlay() {
    if (!playing) return;
    playing = false;
    clearInterval(playTimer);
    $('#rp-play').textContent = '自动播放';
  }

  async function loadReplay(id) {
    const j = await api({ type: 'replay', token: rpToken, id });
    if (!j.ok) { toast(j.msg || '加载失败'); showList(); return; }
    rp = j.replay;
    if (!rp || !rp.initial) { toast('回放数据不完整'); showList(); return; }
    cur = 0;
    $('#rp-bar-title').textContent = `房间 ${rp.roomId} · 目标 ${rp.target} 分 · ${(rp.players || []).map((p) => p.name).join(' vs ')}`;
    slider.max = rp.actions.length;
    gate.hidden = true;
    $('#rp-page').hidden = true;              // 进入观看：列表页收起
    bar.hidden = false;
    showScreen('game');
    hideModals();
    overShown = false;
    window.S = JSON.parse(JSON.stringify(rp.initial)); // 深拷贝：重放会改动状态，别污染原快照
    S.replay = true;
    render();
    updatePos();
  }

  /* ---- 6. 事件绑定 ---- */
  $('#rp-login').addEventListener('click', login);
  $('#rp-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('#rp-logout').addEventListener('click', async () => {
    await api({ type: 'logout', token: rpToken });
    rpToken = '';
    localStorage.removeItem('spToken');
    location.href = '/replay';
  });
  $('#rp-link-list').addEventListener('click', (e) => { e.preventDefault(); showList(); });
  $('#rp-reset').addEventListener('click', () => stepTo(0));
  $('#rp-back').addEventListener('click', () => stepTo(cur - 1));
  $('#rp-next').addEventListener('click', () => { stopPlay(); stepNext(); }); // 手动操作即中断自动播放
  $('#rp-end').addEventListener('click', () => stepTo(rp ? rp.actions.length : 0));
  $('#rp-play').addEventListener('click', () => { if (playing) stopPlay(); else startPlay(); });
  slider.addEventListener('input', () => stepTo(+slider.value));
  document.addEventListener('keydown', (e) => {
    if (!rp || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight') { stopPlay(); stepNext(); }
    else if (e.key === 'ArrowLeft') stepTo(cur - 1);
  });

  /* ---- 7. 启动：有会话直接进，否则停在登录门 ---- */
  showGate();
  (async () => {
    if (!rpToken) return;
    const j = await api({ type: 'whoami', token: rpToken });
    if (j && j.ok) { rpMe = j.name || rpMe; afterLogin(); }
    else { rpToken = ''; localStorage.removeItem('spToken'); showGate(); }
  })();
})();
