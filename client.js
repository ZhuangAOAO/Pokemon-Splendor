'use strict';

/* ================================================================
   璀璨宝石·宝可梦 — 客户端（界面渲染 + 交互 + 联机）
   · 用 file:// 打开 index.html = 本地单机模式（游戏逻辑在本页运行）
   · 用 http:// 打开（服务器提供的地址）= 联机模式（游戏逻辑在服务器上）
   ================================================================ */

const $ = (sel) => document.querySelector(sel);
const ONLINE = location.protocol !== 'file:';
const TIER_NAMES = { 1: '一阶', 2: '二阶', 3: '三阶' };

/* ---- 联机身份 ---- */
let mySeat = -1;   // 联机：自己的座位号
let myName = '';   // 联机：自己的名字
let myCid = null;  // 联机：连接编号
let room = null;   // 联机：房间信息（最新一次广播）
let connOk = true; // 联机：连接状态
let overShown = false; // 本局结算框是否已弹出

/* ---- 核心事件钩子：本地模式下由 game-core 驱动界面 ---- */
HOOKS.onStateChanged = () => { if (!ONLINE) render(); };
HOOKS.onToast = toast;
HOOKS.onGameOver = () => { if (!ONLINE) showGameOver(); };

/* ==================== 渲染小工具 ==================== */
function ballHtml(c, size) {
  const b = BALLS[c];
  return `<span class="ball ${size || ''}" style="--bc:${b.top};--band:${b.band}"></span>`;
}
function ballMini(c, n) {
  return `<span class="cost-item">${ballHtml(c, 'xs')}<b>${n}</b></span>`;
}

/* ==================== 提示气泡 ==================== */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth; // 重新触发过渡动画
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 350);
  }, 2600);
}

/* ==================== 屏幕切换 ==================== */
function showScreen(id) {
  ['setup', 'join', 'lobby', 'game'].forEach((s) => {
    const el = document.getElementById('screen-' + s);
    if (el) el.hidden = (s !== id);
  });
}

/* ==================== 渲染（读取全局 S） ==================== */
function render() {
  if (!S) return;
  renderHeader(); renderMarket(); renderPool(); renderPlayers(); renderActions();
}

function renderHeader() {
  const round = Math.floor(S.turnIdx / S.n) + 1;
  $('#round-info').textContent = `第 ${round} 轮`;
  const p = curPlayer();
  const myTurn = ONLINE ? (mySeat === S.current) : !p.isAI;
  $('#turn-info').innerHTML = `轮到 <b>${p.name}</b>${myTurn ? (p.isAI ? '（电脑思考中…）' : '（请行动）') : ''}`;
  $('#target-info').textContent = `🏁 目标 ${S.target} 分`;
  $('#end-banner').hidden = !S.endTriggered;
}

function renderMarket() {
  const mk = $('#market');
  mk.innerHTML = '';
  [3, 2, 1].forEach((t) => {
    const row = document.createElement('div');
    row.className = 'tier-row';
    const label = document.createElement('div');
    label.className = 'tier-label';
    label.innerHTML = `<span class="tier-dot t${t}"></span>${TIER_NAMES[t]}宝可梦<span class="deck-count">剩 ${S.decks[t].length} 张</span>`;
    row.appendChild(label);
    S.market[t].forEach((card, idx) => row.appendChild(cardEl(card, t, idx)));
    mk.appendChild(row);
  });
}
function cardEl(card, t, idx) {
  if (!card) {
    const d = document.createElement('div');
    d.className = 'card empty';
    d.innerHTML = '<span>牌堆耗尽</span>';
    return d;
  }
  const b = BALLS[card.bonus];
  const d = document.createElement('div');
  d.className = 'card t' + t;
  d.dataset.tier = t;
  d.dataset.idx = idx;
  d.style.setProperty('--bc', b.top);
  d.style.setProperty('--blight', b.light);
  d.style.setProperty('--band', b.band);
  const p = curPlayer();
  const myTurn = ONLINE ? (mySeat === S.current) : !p.isAI;
  const humanTurn = myTurn && S.phase === 'normal';
  if (humanTurn && canAfford(p, card)) d.classList.add('affordable');
  if (S.mode === 'buy' && S.selCard && S.selCard.kind === 'market' && S.selCard.tier === t && S.selCard.idx === idx) {
    d.classList.add('selected');
  }
  if (S.mode === 'reserve' && S.selCard && S.selCard.kind === 'market' && S.selCard.tier === t && S.selCard.idx === idx) {
    d.classList.add('selected');
  }
  const costHtml = COLORS.map((c) => (card.cost[c] ? ballMini(c, card.cost[c]) : '')).join('');
  d.innerHTML = `
    <div class="card-head">
      <span class="tier-badge">${TIER_NAMES[t]}</span>
      <span class="vp-badge ${card.vp === 0 ? 'zero' : ''}">${card.vp}</span>
    </div>
    <div class="card-ball">${ballHtml(card.bonus, 'lg')}</div>
    <div class="card-name">${card.name}</div>
    <div class="card-cost">${costHtml}</div>`;
  d.title = `${card.name} · 加成：${BALLS[card.bonus].name}`;
  // 卡面图片：pictures/宝可梦名.jpg；加载成功盖住默认样式，加载失败自动移除
  const img = document.createElement('img');
  img.className = 'card-img';
  img.alt = card.name;
  img.src = 'pictures/' + encodeURIComponent(card.name) + '.jpg';
  img.addEventListener('error', () => img.remove());
  d.appendChild(img);
  return d;
}

function renderPool() {
  const pool = $('#pool');
  pool.innerHTML = '';
  COLORS.forEach((c) => {
    const g = document.createElement('div');
    g.className = 'pool-group';
    g.dataset.color = c;
    const cnt = S.pool[c];
    g.innerHTML = `${ballHtml(c)}<span class="pool-count">${cnt}</span><span class="pool-name">${BALLS[c].name}</span>`;
    const selectable =
      (S.mode === 'take3' && cnt > 0 && !S.selColors.includes(c)) ||
      (S.mode === 'take2' && cnt >= RULES.takeTwoMin);
    if (selectable) g.classList.add('clickable');
    if (S.selColors.includes(c)) g.classList.add('selected');
    pool.appendChild(g);
  });
  // 大师球：万能球，只能通过预约获得
  const gm = document.createElement('div');
  gm.className = 'pool-group master';
  gm.dataset.color = 'master';
  gm.innerHTML = `${ballHtml('master')}<span class="pool-count">${S.pool.master}</span><span class="pool-name">大师球</span><span class="wild-tag">万能</span>`;
  pool.appendChild(gm);
}

function renderPlayers() {
  const box = $('#players');
  box.innerHTML = '';
  S.players.forEach((p, pi) => {
    const b = document.createElement('div');
    b.className = 'player' + (pi === S.current ? ' active' : '') + (ONLINE && pi === mySeat ? ' self' : '');
    const discarding = S.phase === 'discard' && pi === S.current;
    const returning = S.mode === 'returnBalls' && pi === S.current && !p.isAI;
    if (discarding) b.classList.add('discarding');
    const typeLabel = p.isAI ? (p.aiLevel === 'easy' ? '🤖 电脑·简单' : '🤖 电脑·困难') : '🙋 人类';
    const offline = ONLINE && !p.isAI && !isConnected(pi);
    const nameLabel = p.name + (offline ? ' 🔌' : '') + (ONLINE && pi === mySeat ? '（你）' : '');
    const ballRow = (c, cnt) => `
      <span class="pball ${((discarding || returning) && cnt > 0) ? 'clickable' : ''}" data-p="${pi}" data-c="${c}">
        ${ballHtml(c, 'sm')}<b>${cnt}</b>
      </span>`;
    const ballsHtml = COLORS.map((c) => ballRow(c, p.balls[c])).join('') + ballRow('master', p.balls.master);
    const groups = {};
    COLORS.forEach((c) => { groups[c] = p.cards.filter((cd) => cd.bonus === c).length; });
    const cardsHtml = COLORS.map((c) =>
      groups[c] > 0 ? `<span class="pcard">${ballHtml(c, 'xs')}×${groups[c]}</span>` : ''
    ).join('');
    const reservedHtml = p.reserved.length
      ? `<div class="p-reserved">📌 预约：${p.reserved.map((rc) =>
          `<span class="rchip sm">${rc.name}<b class="r-vp ${rc.vp === 0 ? 'zero' : ''}">${rc.vp}</b></span>`).join('')}</div>`
      : '';
    b.innerHTML = `
      <div class="p-head">
        <span class="p-name">${nameLabel}</span>
        <span class="p-type">${typeLabel}</span>
        <span class="p-pts">★ ${p.points} 分</span>
        <span class="p-count">🃏 ${p.cards.length} 只</span>
      </div>
      <div class="p-balls">${ballsHtml}</div>
      <div class="p-cards" title="已收服：${p.cards.map((cd) => cd.name).join('、')}">${cardsHtml || '还没有宝可梦'}</div>
      ${reservedHtml}`;
    box.appendChild(b);
  });
}
// 联机：某座位的人类玩家是否在线
function isConnected(seat) {
  if (!room || !room.humans) return true;
  const h = room.humans.find((x) => x.seat === seat);
  return h ? !!h.connected : true;
}

function renderActions() {
  const box = $('#actions');
  box.innerHTML = '';
  const p = curPlayer();
  if (S.phase === 'gameover') return;

  if (S.phase === 'discard') {
    box.innerHTML = `<div class="action-hint warn">⚠️ 你的精灵球超过 ${RULES.handLimit} 个！点击下方自己的精灵球退还（还需 ${S.discardNeed} 个）</div>`;
    return;
  }
  if (S.phase !== 'normal') return;

  const myTurn = ONLINE ? (mySeat === S.current) : !p.isAI;

  if (!p.isAI && myTurn) {
    if (S.mode === 'take3') {
      const avail = COLORS.filter((c) => S.pool[c] > 0).length;
      const need = Math.min(3, avail);
      box.innerHTML = `
        <div class="action-hint">🎯 请选择 ${need} 种不同颜色的精灵球（已选 ${S.selColors.length}/${need}）</div>
        <div class="action-btns">
          <button class="btn primary" id="act-confirm" ${S.selColors.length === need ? '' : 'disabled'}>确认拿取</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('take3');
      return;
    }
    if (S.mode === 'take2') {
      box.innerHTML = `
        <div class="action-hint">🎯 请选择一种精灵球（供应区中该色至少 ${RULES.takeTwoMin} 个）</div>
        <div class="action-btns">
          <button class="btn primary" id="act-confirm" ${S.selColors.length === 1 ? '' : 'disabled'}>确认拿取</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('take2');
      return;
    }
    if (S.mode === 'returnBalls') {
      box.innerHTML = `
        <div class="action-hint">🎯 点击下方你自己的 1 个精灵球，把它退回供应区（周转用，通常只在没别的行动时做）</div>
        <div class="action-btns">
          <button class="btn primary" id="act-confirm" ${S.selColors.length === 1 ? '' : 'disabled'}>确认退还</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('returnBalls');
      return;
    }
    if (S.mode === 'reserve') {
      let mid = '<div class="action-hint">🎯 点击场上一张宝可梦进行预约（预约后可拿 1 个大师球）</div>';
      if (S.selCard) {
        const card = selCardCard();
        const masterInfo = S.pool.master > 0
          ? '并立刻获得 1 个大师球（万能）'
          : '⚠️ 供应区大师球已领完，无法获得大师球';
        mid = `
          <div class="buy-confirm">
            <div class="buy-name">预约 ${card.name}？</div>
            <div class="buy-cost">把它收进你的预约区，${masterInfo}。之后任意回合可以收服它。</div>
          </div>`;
      }
      box.innerHTML = mid + `
        <div class="action-btns">
          <button class="btn primary" id="act-confirm" ${S.selCard ? '' : 'disabled'}>确认预约</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('reserve');
      return;
    }
    if (S.mode === 'buy') {
      let mid = '<div class="action-hint">🎯 点击场上发光的宝可梦，或下方已预约的宝可梦</div>';
      if (p.reserved.length) {
        mid += '<div class="reserved-strip"><span class="rs-label">📌 已预约：</span>' + p.reserved.map((rc, ri) => {
          const ok = canAfford(p, rc);
          return `<span class="rchip ${ok ? 'clickable' : ''} ${S.selCard && S.selCard.kind === 'reserved' && S.selCard.ridx === ri ? 'selected' : ''}" data-ridx="${ri}" ${ok ? '' : `title="还不够精灵球收服它"`}>${rc.name}<b class="r-vp ${rc.vp === 0 ? 'zero' : ''}">${rc.vp}</b></span>`;
        }).join('') + '</div>';
      }
      if (S.selCard) {
        const card = selCardCard();
        const plan = payPlan(p, card);
        const payHtml = COLORS.map((c) => (plan.pay[c] > 0 ? ballMini(c, plan.pay[c]) : '')).join('') +
          (plan.useJokers > 0 ? ballMini('master', plan.useJokers) : '');
        mid += `
          <div class="buy-confirm">
            <div class="buy-name">收服 ${card.name}？</div>
            <div class="buy-cost">${plan.totNeed === 0 ? '🎉 免费收服！' : `实付：${payHtml}<span class="dim">（已计入你的加成）</span>`}</div>
          </div>`;
      }
      box.innerHTML = mid + `
        <div class="action-btns">
          <button class="btn primary" id="act-confirm" ${S.selCard && canAfford(p, selCardCard()) ? '' : 'disabled'}>确认收服</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('buy');
      return;
    }
  }

  // 普通状态
  if (!p.isAI && myTurn) {
    const avail = COLORS.filter((c) => S.pool[c] > 0).length;
    const hasTwo = COLORS.some((c) => S.pool[c] >= RULES.takeTwoMin);
    const hasAff = allMarketCards().some((c) => canAfford(p, c)) || p.reserved.some((c) => canAfford(p, c));
    const canReserve = allMarketCards().length > 0 && p.reserved.length < RULES.reserveLimit;
    box.innerHTML = `
      <div class="action-hint">🎮 你的回合：选择一个行动</div>
      <div class="action-btns">
        <button class="btn primary" id="act-take3" ${avail === 0 ? 'disabled' : ''}>拿 3 个不同球</button>
        <button class="btn secondary" id="act-take2" ${hasTwo ? '' : 'disabled'}>拿 2 个相同球</button>
        <button class="btn buy" id="act-buy" ${hasAff ? '' : 'disabled'}>收服宝可梦</button>
        <button class="btn ghost" id="act-reserve" ${canReserve ? '' : 'disabled'}>预约宝可梦</button>
        <button class="btn ghost sm" id="act-return" ${totalBalls(p) > 0 ? '' : 'disabled'}>退还精灵球</button>
      </div>`;
    $('#act-take3').addEventListener('click', () => { S.mode = 'take3'; S.selColors = []; render(); });
    $('#act-take2').addEventListener('click', () => { S.mode = 'take2'; S.selColors = []; render(); });
    $('#act-buy').addEventListener('click', () => { S.mode = 'buy'; S.selCard = null; render(); });
    $('#act-reserve').addEventListener('click', () => { S.mode = 'reserve'; S.selCard = null; render(); });
    $('#act-return').addEventListener('click', () => { S.mode = 'returnBalls'; S.selColors = []; render(); });
  } else {
    const waiting = p.isAI ? `${p.name} 正在思考…` : `等待 ${p.name} 行动…`;
    box.innerHTML = `<div class="action-hint">🤔 ${waiting}</div>`;
  }
}
function selCardCard() {
  if (!S.selCard) return null;
  return S.selCard.kind === 'reserved'
    ? curPlayer().reserved[S.selCard.ridx]
    : S.market[S.selCard.tier][S.selCard.idx];
}
function bindConfirmCancel(type) {
  $('#act-confirm').addEventListener('click', () => {
    if (type === 'take3') dispatch({ kind: 'take3', colors: S.selColors.slice() });
    else if (type === 'take2') dispatch({ kind: 'take2', color: S.selColors[0] });
    else if (type === 'returnBalls') dispatch({ kind: 'return', color: S.selColors[0] });
    else if (type === 'reserve' && S.selCard) dispatch({ kind: 'reserve', tier: S.selCard.tier, idx: S.selCard.idx });
    else if (type === 'buy' && S.selCard) {
      if (S.selCard.kind === 'reserved') dispatch({ kind: 'buy', reserved: true, ridx: S.selCard.ridx });
      else dispatch({ kind: 'buy', tier: S.selCard.tier, idx: S.selCard.idx });
    }
  });
  $('#act-cancel').addEventListener('click', () => {
    S.mode = null; S.selColors = []; S.selCard = null;
    render();
  });
}

/* ==================== 行动分发：本地直接执行 / 联机发给服务器 ==================== */
function dispatch(a) {
  if (ONLINE) {
    postApi({ type: 'action', cid: myCid, action: a });
    return;
  }
  if (a.kind === 'take3') actTakeThree(a.colors);
  else if (a.kind === 'take2') actTakeTwo(a.color);
  else if (a.kind === 'return') actReturnBall(a.color);
  else if (a.kind === 'discard') actDiscardOne(a.color);
  else if (a.kind === 'reserve') actReserve(a.tier, a.idx);
  else if (a.kind === 'buy') {
    if (a.reserved) actBuyReserved(a.ridx);
    else actBuy(a.tier, a.idx);
  }
}

/* ==================== 弹窗 ==================== */
function showModal(id) {
  document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
  $(id).hidden = false;
  $('#modal-overlay').hidden = false;
}
function hideModals() { $('#modal-overlay').hidden = true; }

function showGameOver() {
  if (!S || overShown) return;
  overShown = true;
  const rank = S.players.slice().sort((a, b) =>
    (b.points - a.points) || (a.cards.length - b.cards.length));
  const top = rank[0];
  const tied = rank.filter((p) => p.points === top.points && p.cards.length === top.cards.length);
  const title = tied.length > 1
    ? `🏆 并列获胜：${tied.map((p) => p.name).join('、')}（${top.points} 分）`
    : `🏆 ${top.name} 获胜！共 ${top.points} 分`;
  $('#go-title').textContent = title;
  const medals = ['🥇', '🥈', '🥉', '④'];
  $('#go-result').innerHTML = rank.map((p, i) => `
    <div class="go-row ${i === 0 ? 'first' : ''}">
      <span class="go-medal">${medals[i]}</span>
      <span class="go-name">${p.name}</span>
      <span class="go-pts">${p.points} 分</span>
      <span class="go-cnt">${p.cards.length} 只宝可梦</span>
    </div>`).join('');
  const againBtn = $('#btn-again');
  const backBtn = $('#btn-back-setup');
  const isHost = ONLINE ? !!(room && room.you && room.you.isHost) : true;
  if (ONLINE && !isHost) {
    againBtn.textContent = '等待房主操作…';
    againBtn.disabled = true;
    backBtn.hidden = true;
  } else {
    againBtn.disabled = false;
    backBtn.hidden = false;
    againBtn.textContent = '再来一局';
    backBtn.textContent = ONLINE ? '返回大厅' : '返回设置';
    againBtn.onclick = () => {
      if (ONLINE) postApi({ type: 'restart', cid: myCid });
      else if (lastCfg) {
        newGame(lastCfg);
        overShown = false;
        hideModals();
        render();
        scheduleAI();
      }
    };
    backBtn.onclick = () => {
      if (ONLINE) postApi({ type: 'backToLobby', cid: myCid });
      else backToSetup();
    };
  }
  $('#modal-gameover').hidden = false;
  $('#modal-overlay').hidden = false;
}

/* ==================== 交互事件 ==================== */
function onMarketClick(e) {
  const el = e.target.closest('.card');
  if (!el || !S || el.classList.contains('empty')) return;
  const t = +el.dataset.tier, idx = +el.dataset.idx;
  const card = S.market[t][idx];
  const p = curPlayer();
  if (S.phase !== 'normal' || p.isAI) return;
  if (ONLINE && mySeat !== S.current) return;
  if (S.mode === 'buy') {
    if (canAfford(p, card)) { S.selCard = { kind: 'market', tier: t, idx }; render(); }
  } else if (S.mode === 'reserve') {
    if (p.reserved.length < RULES.reserveLimit) { S.selCard = { kind: 'market', tier: t, idx }; render(); }
  } else if (S.mode === null) {
    if (canAfford(p, card)) { S.mode = 'buy'; S.selCard = { kind: 'market', tier: t, idx }; render(); }
  }
}
function onPoolClick(e) {
  const g = e.target.closest('.pool-group');
  if (!g || !S) return;
  const c = g.dataset.color;
  const p = curPlayer();
  if (S.phase !== 'normal' || p.isAI || c === 'master') return; // 大师球不能直接拿
  if (ONLINE && mySeat !== S.current) return;
  if (S.mode === 'take3') {
    if (S.pool[c] <= 0 || S.selColors.includes(c)) return;
    const avail = COLORS.filter((x) => S.pool[x] > 0).length;
    const need = Math.min(3, avail);
    if (S.selColors.length < need) { S.selColors.push(c); render(); }
  } else if (S.mode === 'take2') {
    if (S.pool[c] >= RULES.takeTwoMin) { S.selColors = [c]; render(); }
  }
}
function onPlayerClick(e) {
  const b = e.target.closest('.pball');
  if (!b || !S) return;
  const pi = +b.dataset.p, c = b.dataset.c;
  const p = curPlayer();
  if (ONLINE && mySeat !== pi) return;
  if (S.phase === 'discard' && pi === S.current && !p.isAI && p.balls[c] > 0) {
    if (ONLINE) dispatch({ kind: 'discard', color: c });
    else actDiscardOne(c);
    return;
  }
  // "退还精灵球"模式：点击选择自己 1 个球
  if (S.mode === 'returnBalls' && S.phase === 'normal' && pi === S.current && !p.isAI && p.balls[c] > 0) {
    S.selColors = [c];
    render();
  }
}
function onActionsClick(e) {
  const chip = e.target.closest('.rchip');
  if (!chip || !S) return;
  const p = curPlayer();
  if (S.mode === 'buy' && S.phase === 'normal' && !p.isAI) {
    if (ONLINE && mySeat !== S.current) return;
    const ridx = +chip.dataset.ridx;
    if (canAfford(p, p.reserved[ridx])) { S.selCard = { kind: 'reserved', ridx }; render(); }
  }
}

/* ==================== 本地模式：设置界面 ==================== */
function addPlayerRow(pc) {
  const rows = $('#player-rows');
  const row = document.createElement('div');
  row.className = 'player-row';
  row.innerHTML = `
    <span class="row-idx"></span>
    <input class="row-name" maxlength="8" value="${pc.name}">
    <select class="row-type">
      <option value="human" ${pc.type === 'human' ? 'selected' : ''}>🙋 人类</option>
      <option value="easy" ${pc.type === 'easy' ? 'selected' : ''}>🤖 电脑·简单</option>
      <option value="hard" ${pc.type === 'hard' ? 'selected' : ''}>🤖 电脑·困难</option>
    </select>
    <button class="btn ghost sm row-del">✕</button>`;
  row.querySelector('.row-del').addEventListener('click', () => {
    if (rows.children.length <= 2) return;
    row.remove();
    renumberRows();
  });
  rows.appendChild(row);
  renumberRows();
}
function renumberRows() {
  const rows = $('#player-rows').children;
  [...rows].forEach((r, i) => { r.querySelector('.row-idx').textContent = i + 1; });
  $('#btn-add-player').disabled = rows.length >= 4;
  [...rows].forEach((r) => { r.querySelector('.row-del').disabled = rows.length <= 2; });
}
function startGameLocal() {
  const rows = [...document.querySelectorAll('#player-rows .player-row')];
  const players = rows.map((r) => ({
    name: r.querySelector('.row-name').value.trim() || '玩家',
    type: r.querySelector('.row-type').value,
  }));
  const targetEl = document.querySelector('#screen-setup input[name="target"]:checked');
  const cfg = { players, target: targetEl ? +targetEl.value : RULES.defaultTarget };
  lastCfg = cfg;
  newGame(cfg);
  overShown = false;
  showScreen('game');
  hideModals();
  render();
  scheduleAI();
}
function backToSetup() {
  S = null;
  showScreen('setup');
  hideModals();
}
function buildDeco() {
  const host = document.getElementById('screen-setup');
  const cols = ['red', 'blue', 'black', 'pink', 'yellow'];
  for (let i = 0; i < 9; i++) {
    const d = document.createElement('span');
    const c = pick(cols);
    const b = BALLS[c];
    const size = 40 + Math.random() * 60;
    d.className = 'ball deco';
    d.style.cssText = `--bc:${b.top};--band:${b.band};width:${size}px;height:${size}px;left:${Math.random() * 92}%;top:${Math.random() * 92}%;animation-delay:${-Math.random() * 6}s;`;
    host.appendChild(d);
  }
}

/* ==================== 联机模式 ==================== */
const AI_NAMES = ['小智', '小霞', '小刚', '武藏'];

async function postApi(obj) {
  try {
    const r = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) toast('⚠️ ' + (j.msg || '请求失败'));
    return j;
  } catch (err) {
    toast('⚠️ 与服务器通信失败');
    return { ok: false };
  }
}
function updateConnDot() {
  const dot = $('#conn-status');
  if (!ONLINE) { dot.hidden = true; return; }
  dot.hidden = false;
  dot.textContent = connOk ? '🟢 已连接' : '🔴 连接中断，重连中…';
}
function handleServerMsg(m) {
  if (m.type === 'state') {
    room = m.room;
    if (m.you) { mySeat = m.you.seat; myName = m.you.name; }
    if (m.game) {
      S = m.game;
      if (!S.over) overShown = false;
      showScreen('game');
      render();
      if (S.over && !overShown) showGameOver();
    } else {
      S = null;
      showScreen('lobby');
      renderLobby();
    }
  } else if (m.type === 'toast') {
    toast(m.msg);
  } else if (m.type === 'error') {
    toast('⚠️ ' + m.msg);
  }
}
function renderLobby() {
  if (!room) return;
  const isHost = !!(room.you && room.you.isHost);
  const humans = room.humans || [];
  const ais = room.ais || [];
  const total = humans.filter((h) => h.connected).length + ais.length;

  $('#lobby-roster').innerHTML = humans.map((h) => `
    <div class="lobby-row">
      <span class="lobby-dot ${h.connected ? 'on' : 'off'}"></span>
      <span class="lobby-name">${h.name}${h.isHost ? ' 👑' : ''}${h.name === myName ? '（你）' : ''}</span>
      <span class="lobby-tag">🙋 人类</span>
      ${h.connected ? '' : '<span class="lobby-tag off">已断线</span>'}
    </div>`).join('') +
    ais.map((a) => `
    <div class="lobby-row">
      <span class="lobby-dot on"></span>
      <span class="lobby-name">${a.name}</span>
      <span class="lobby-tag">🤖 电脑·${a.level === 'easy' ? '简单' : '困难'}</span>
    </div>`).join('');

  // 房主控制区
  $('#lobby-host').hidden = !isHost;
  if (isHost) {
    renderAiRows();
    renderLobbyTarget();
    $('#btn-lobby-start').disabled = !(total >= 2 && total <= 4);
  }
  $('#lobby-hint').textContent = isHost
    ? `当前 ${total} 名玩家（2~4 人可开始），把本页地址发给局域网内朋友一起加入`
    : '等待房主开始游戏…';
}
function renderAiRows() {
  const box = $('#lobby-ais');
  box.innerHTML = '';
  (room.ais || []).forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `
      <span class="row-idx">AI</span>
      <input class="ai-name" maxlength="8" value="${a.name}">
      <select class="ai-level">
        <option value="easy" ${a.level === 'easy' ? 'selected' : ''}>🤖 电脑·简单</option>
        <option value="hard" ${a.level === 'hard' ? 'selected' : ''}>🤖 电脑·困难</option>
      </select>
      <button class="btn ghost sm ai-del">✕</button>`;
    const send = () => {
      const ais = [];
      [...box.querySelectorAll('.player-row')].forEach((r) => {
        ais.push({
          name: r.querySelector('.ai-name').value.trim() || '电脑',
          level: r.querySelector('.ai-level').value,
        });
      });
      postApi({ type: 'setAIs', cid: myCid, ais });
    };
    row.querySelector('.ai-name').addEventListener('change', send);
    row.querySelector('.ai-level').addEventListener('change', send);
    row.querySelector('.ai-del').addEventListener('click', () => { row.remove(); send(); });
    box.appendChild(row);
  });
}
function renderLobbyTarget() {
  const row = $('#lobby-target');
  row.innerHTML = '<span class="label">🏁 目标分数</span>' +
    RULES.targets.map((t) => `
      <label><input type="radio" name="lobby-target" value="${t}" ${t === room.target ? 'checked' : ''}> ${t} 分</label>`).join('');
  row.querySelectorAll('input').forEach((inp) =>
    inp.addEventListener('change', () => postApi({ type: 'setTarget', cid: myCid, target: +inp.value })));
}
function openEvents(cid) {
  connOk = true;
  updateConnDot();
  const es = new EventSource('/events?cid=' + encodeURIComponent(cid));
  es.onopen = () => { connOk = true; updateConnDot(); };
  es.onmessage = (e) => {
    try { handleServerMsg(JSON.parse(e.data)); } catch (err) { /* 忽略坏消息 */ }
  };
  es.onerror = () => { connOk = false; updateConnDot(); }; // EventSource 会自动重连
}
async function joinGame() {
  const name = $('#join-name').value.trim();
  if (!name) { toast('⚠️ 请输入名字'); return; }
  const j = await postApi({ type: 'join', name });
  if (j.ok) {
    myCid = j.cid;
    openEvents(j.cid);
  }
}

function initOnline() {
  showScreen('join');
  updateConnDot();
  $('#btn-join').addEventListener('click', joinGame);
  $('#join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });
  $('#btn-add-ai').addEventListener('click', () => {
    if ((room.ais || []).length + (room.humans || []).filter((h) => h.connected).length >= 4) return;
    const ais = (room.ais || []).concat([{ name: AI_NAMES[(room.ais || []).length % 4], level: 'easy' }]);
    postApi({ type: 'setAIs', cid: myCid, ais });
  });
  $('#btn-lobby-start').addEventListener('click', () => postApi({ type: 'start', cid: myCid }));
}

/* ==================== 初始化 ==================== */
function init() {
  buildDeco();

  // 本地设置界面
  addPlayerRow({ name: '玩家1', type: 'human' });
  addPlayerRow({ name: '小智', type: 'easy' });
  addPlayerRow({ name: '小霞', type: 'hard' });
  const targetRow = document.querySelector('#screen-setup .target-row');
  targetRow.innerHTML = '<span class="label">🏁 目标分数</span>' +
    RULES.targets.map((t) => `
      <label><input type="radio" name="target" value="${t}" ${t === RULES.defaultTarget ? 'checked' : ''}> ${t} 分</label>`).join('');

  $('#btn-add-player').addEventListener('click', () => {
    const n = document.querySelectorAll('#player-rows .player-row').length;
    if (n >= 4) return;
    addPlayerRow({ name: '玩家' + (n + 1), type: 'human' });
  });
  $('#btn-start').addEventListener('click', startGameLocal);
  document.querySelectorAll('.js-rules').forEach((b) =>
    b.addEventListener('click', () => showModal('#modal-rules')));
  $('#btn-exit').addEventListener('click', () => {
    if (ONLINE) {
      if (confirm('确定退出房间吗？')) location.reload();
      return;
    }
    if (!S || S.over) { backToSetup(); return; }
    if (confirm('确定退出当前对局？进度将丢失。')) backToSetup();
  });
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', hideModals));

  $('#market').addEventListener('click', onMarketClick);
  $('#pool').addEventListener('click', onPoolClick);
  $('#players').addEventListener('click', onPlayerClick);
  $('#actions').addEventListener('click', onActionsClick);

  if (ONLINE) initOnline();
  else showScreen('setup');
}

init();
