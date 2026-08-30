'use strict';

/* ================================================================
   璀璨宝石·宝可梦 — 客户端（界面渲染 + 交互 + 联机）
   · 用 file:// 打开 index.html = 本地单机模式（游戏逻辑在本页运行）
   · 用 http:// 打开（服务器提供的地址）= 联机模式（游戏逻辑在服务器上）
   ================================================================ */

const $ = (sel) => document.querySelector(sel);
const ONLINE = location.protocol !== 'file:';
const TIER_NAMES = { 1: '一阶', 2: '二阶', 3: '三阶', 4: '稀有', 5: '传说' };

/* ==================== 音效（WebAudio 合成，零资源文件） ==================== */
const SOUND_CFG = window.SOUND || { enabled: true, volume: 0.4 };
let audioCtx = null;
let soundOn = localStorage.getItem('spSound') ? (localStorage.getItem('spSound') === 'on') : (SOUND_CFG.enabled !== false);
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function tone(freq, dur, type, vol, when) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + (when || 0);
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}
function playSound(name) {
  if (!soundOn) return;
  const v = SOUND_CFG.volume;
  switch (name) {
    case 'take': tone(520, 0.09, 'triangle', v); tone(680, 0.09, 'triangle', v, 0.07); break;
    case 'buy': tone(523, 0.12, 'sine', v); tone(659, 0.12, 'sine', v, 0.1); tone(784, 0.22, 'sine', v, 0.2); break;
    case 'reserve': tone(440, 0.1, 'square', v * 0.5); break;
    case 'evolve': tone(392, 0.1, 'triangle', v); tone(523, 0.1, 'triangle', v, 0.09); tone(659, 0.1, 'triangle', v, 0.18); tone(784, 0.25, 'triangle', v, 0.27); break;
    case 'master': tone(880, 0.1, 'sine', v); tone(1175, 0.16, 'sine', v, 0.08); break;
    case 'turn': tone(784, 0.12, 'sine', v * 0.8); break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', v, i * 0.13)); break;
    case 'error': tone(170, 0.18, 'sawtooth', v * 0.5); break;
  }
}

/* ---- 联机身份 ---- */
let mySeat = -1;   // 联机：自己的座位号
let myName = '';   // 联机：自己的账号名
let myCid = null;  // 联机：连接编号
let myToken = '';  // 联机：登录令牌
let myRole = '';   // 联机：账号角色（admin 才显示管理入口）
let myNickname = ''; // 联机：游戏内昵称（默认真实姓名）
let room = null;   // 联机：房间信息（最新一次广播）
let connOk = true; // 联机：连接状态
let overShown = false; // 本局结算框是否已弹出
let prevSnap = null;      // 上一次状态快照（漂移动画差分用）
const lastMarketIds = {}; // 每个市场槽位上次的卡 id（只给新补的卡播入场动画）
let prevMyTurn = false;   // 轮到自己时的提示音触发

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
  ['setup', 'login', 'join', 'lobby', 'game'].forEach((s) => {
    const el = document.getElementById('screen-' + s);
    if (el) el.hidden = (s !== id);
  });
}

/* ==================== 渲染（读取全局 S） ==================== */
function render() {
  if (!S) return;
  floatDiff(); // 先差分状态、计算漂移动画（要用旧 DOM 的位置，必须最先执行）
  renderHeader(); renderMarket(); renderRareLegend(); renderPool(); renderPlayers(); renderActions();
}

/* ==================== 行动漂移动画 ==================== */
function snapOf() {
  return JSON.stringify({
    pool: S.pool,
    market: { 1: S.market[1].map((c) => (c ? c.id : null)), 2: S.market[2].map((c) => (c ? c.id : null)), 3: S.market[3].map((c) => (c ? c.id : null)), 4: S.market[4].map((c) => (c ? c.id : null)), 5: S.market[5].map((c) => (c ? c.id : null)) },
    players: S.players.map((p) => ({
      balls: p.balls,
      cardIds: p.cards.map((c) => c.id),
      resIds: p.reserved.map((c) => c.id),
    })),
  });
}
function findCardById(id) {
  for (const t of [1, 2, 3, 4, 5]) {
    const c = S.market[t].find((x) => x && x.id === id);
    if (c) return c;
  }
  for (const p of S.players) {
    const c = p.cards.find((x) => x.id === id) || p.reserved.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}
function boardRect(seat) {
  const el = document.querySelector('.player[data-p="' + seat + '"]');
  return el ? el.getBoundingClientRect() : null;
}
function spawnFloat(el, from, to, delay, duration) {
  el.style.position = 'fixed';
  el.style.left = (from.left + from.width / 2 - 16) + 'px';
  el.style.top = (from.top + from.height / 2 - 24) + 'px';
  el.style.zIndex = '300';
  el.style.pointerEvents = 'none';
  el.style.opacity = '0';
  el.style.transition = 'transform ' + duration + 'ms cubic-bezier(.35,.15,.35,1), opacity ' + duration + 'ms ease';
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.transform = 'translate(' + (to.left + to.width / 2 - (from.left + from.width / 2)) + 'px,' + (to.top + to.height / 2 - (from.top + from.height / 2)) + 'px) scale(.65)';
    el.style.opacity = '.95';
  }, delay + 20);
  setTimeout(() => { el.style.opacity = '0'; }, delay + duration * 0.75);
  setTimeout(() => el.remove(), delay + duration + 400);
}
function spawnBallFloat(c, from, to, delay) {
  const el = document.createElement('span');
  el.className = 'ball';
  el.style.setProperty('--bc', BALLS[c].top);
  el.style.setProperty('--band', BALLS[c].band);
  spawnFloat(el, from, to, delay, 1500);
}
function spawnCardFloat(card, from, to, delay) {
  const el = document.createElement('img');
  el.src = 'pictures/' + encodeURIComponent(card.name) + '.jpg';
  el.style.width = '64px';
  el.style.aspectRatio = '1335/2063';
  el.style.objectFit = 'cover';
  el.style.borderRadius = '8px';
  el.style.boxShadow = '0 10px 24px rgba(0,0,0,.4)';
  spawnFloat(el, from, to, delay, 1700);
}
// 对比新旧状态：谁拿了球/卡，就从源头飘一个动画到他的面板
function floatDiff() {
  if (!prevSnap) { prevSnap = snapOf(); return; }
  const nowStr = snapOf();
  const prev = JSON.parse(prevSnap);
  const now = JSON.parse(nowStr);
  prevSnap = nowStr;
  // 位置从"旧 DOM"取（render 尚未重建）
  const poolRects = {};
  document.querySelectorAll('#pool .pool-group').forEach((g) => { poolRects[g.dataset.color] = g.getBoundingClientRect(); });
  const labelRects = {};
  document.querySelectorAll('#market .tier-label, #rl-wrap .tier-label').forEach((l) => { labelRects[+l.dataset.tier] = l.getBoundingClientRect(); });
  // 球：供应区减少 → 飞向获得球的玩家
  COLORS.concat(['master']).forEach((c) => {
    const taken = prev.pool[c] - now.pool[c];
    if (taken <= 0) return;
    const who = now.players.findIndex((p2, i) => p2.balls[c] > prev.players[i].balls[c]);
    if (who < 0) return;
    const from = poolRects[c], to = boardRect(who);
    if (!from || !to) return;
    playSound(c === 'master' ? 'master' : 'take');
    for (let k = 0; k < taken; k++) spawnBallFloat(c, from, to, k * 240);
  });
  // 卡：玩家新增（收服/预约/进化）→ 从市场槽位（或盲抽的牌堆标签）飞向玩家
  now.players.forEach((p2, i) => {
    const prevIds = new Set((prev.players[i].cardIds || []).concat(prev.players[i].resIds || []));
    const newIds = (p2.cardIds || []).concat(p2.resIds || []).filter((id) => !prevIds.has(id));
    if (!newIds.length) return;
    // 音效：进化优先于预约，其余按收服处理
    if ((p2.evolutions || 0) > (prev.players[i].evolutions || 0)) playSound('evolve');
    else if (newIds.some((id) => (p2.resIds || []).includes(id))) playSound('reserve');
    else playSound('buy');
    const to = boardRect(i);
    if (!to) return;
    newIds.forEach((id, k) => {
      const card = findCardById(id);
      if (!card) return;
      let from = null;
      for (const t of [1, 2, 3, 4, 5]) {
        const idx = (prev.market[t] || []).indexOf(id);
        if (idx >= 0) {
          const slot = document.querySelector('.card[data-tier="' + t + '"][data-idx="' + idx + '"]');
          if (slot) { from = slot.getBoundingClientRect(); break; }
        }
      }
      if (!from) from = labelRects[card.tier]; // 盲抽：从牌堆标签飞出
      if (from) spawnCardFloat(card, from, to, k * 280);
    });
  });
}

function renderHeader() {
  const round = Math.floor(S.turnIdx / S.n) + 1;
  $('#round-info').textContent = `第 ${round} 轮`;
  const p = curPlayer();
  const myTurn = ONLINE ? (mySeat === S.current) : !p.isAI;
  $('#turn-info').innerHTML = `轮到 <b>${p.name}</b>${myTurn ? (p.isAI ? '（电脑思考中…）' : '（请行动）') : ''}`;
  $('#target-info').textContent = `目标 ${S.target} 分`;
  $('#end-banner').hidden = !S.endTriggered;
  // 轮到自己时的提示音（上升沿触发）
  if (myTurn && !prevMyTurn && !S.over) playSound('turn');
  prevMyTurn = myTurn;
  // 联机对局进行中：所有人都可以发起结束投票（投票进行中隐藏按钮，横幅代替）
  const canStop = ONLINE && S && !S.over && !(room && room.vote);
  $('#btn-stop-game').hidden = !canStop;
  // 结束对局投票横幅
  const vb = $('#vote-banner');
  if (ONLINE && room && room.vote) {
    clearTimeout(voteFadeTimer); // 新一轮投票出现，取消待执行的淡出
    vb.style.opacity = '';
    vb.style.transition = '';
    vb.hidden = false;
    const voted = !!(room.you && room.you.voted);
    const offlineCount = (room.humans || []).filter((h) => !h.connected).length;
    vb.innerHTML = `
      <span class="vote-text">${room.vote.by} 发起结束对局投票（${room.vote.yes}/${room.vote.total} 已同意${offlineCount > 0 ? '，离线 ' + offlineCount + ' 人自动视为同意' : ''}）</span>
      <button class="btn sm primary" id="vote-yes" ${voted ? 'disabled' : ''}>${voted ? '已同意' : '同意'}</button>
      <button class="btn sm ghost" id="vote-no" ${voted ? 'disabled' : ''}>反对</button>`;
    if (!voted) {
      $('#vote-yes').addEventListener('click', () => postApi({ type: 'voteEndAnswer', cid: myCid, answer: 'yes' }));
      $('#vote-no').addEventListener('click', () => postApi({ type: 'voteEndAnswer', cid: myCid, answer: 'no' }));
    }
  } else if (!ONLINE || !S) {
    vb.hidden = true; // 本地模式或大厅：不显示
  }
}
let voteFadeTimer = null;
// 对局结束回大厅：横幅短暂停留后淡出消失
function fadeVoteBanner() {
  const vb = $('#vote-banner');
  if (vb.hidden) return;
  vb.innerHTML = '<span class="vote-text">对局已结束，已返回大厅</span>';
  voteFadeTimer = setTimeout(() => {
    vb.style.transition = 'opacity .6s ease';
    vb.style.opacity = '0';
    setTimeout(() => { vb.hidden = true; vb.style.opacity = ''; vb.style.transition = ''; }, 650);
  }, 1500);
}

function renderMarket() {
  const mk = $('#market');
  mk.innerHTML = '';
  const tierLabel = (t) => {
    const label = document.createElement('div');
    label.className = 'tier-label';
    label.dataset.tier = t;
    // 预约模式下，一/二/三阶的牌堆标签可点击盲抽
    const blindable = S.mode === 'reserve' && t <= 3 && S.decks[t].length > 0;
    if (blindable) label.classList.add('blind-clickable');
    label.innerHTML = `<span class="tier-dot t${t}"></span>${TIER_NAMES[t]}宝可梦<span class="deck-count">剩 ${S.decks[t].length} 张</span>`;
    return label;
  };
  [3, 2, 1].forEach((t) => {
    const row = document.createElement('div');
    row.className = 'tier-row';
    row.appendChild(tierLabel(t));
    const prevIds = lastMarketIds[t] || [];
    S.market[t].forEach((card, idx) => {
      const isNew = prevIds[idx] !== (card ? card.id : null); // 只有新补的卡播放入场动画
      row.appendChild(cardEl(card, t, idx, false, isNew));
    });
    mk.appendChild(row);
  });
  [1, 2, 3].forEach((t) => { lastMarketIds[t] = S.market[t].map((c) => (c ? c.id : null)); });
}
function cardEl(card, t, idx, mini, isNew) {
  if (!card) {
    const d = document.createElement('div');
    d.className = 'card empty' + (mini ? ' mini' : '');
    d.innerHTML = '<span>牌堆耗尽</span>';
    return d;
  }
  const b = BALLS[card.bonus];
  const d = document.createElement('div');
  d.className = 'card t' + t + (t === 4 ? ' rare' : '') + (t === 5 ? ' legend' : '') + (mini ? ' mini' : '') + (isNew ? ' new' : '');
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
  const costHtml = COLORS.map((c) => (card.cost[c] ? ballMini(c, card.cost[c]) : '')).join('') +
    (card.masterCost ? ballMini('master', card.masterCost) : '');
  d.innerHTML = `
    <div class="card-head">
      <span class="tier-badge">${TIER_NAMES[t]}</span>
      <span class="vp-badge ${card.vp === 0 ? 'zero' : ''}">${card.vp}</span>
    </div>
    <div class="card-ball">${ballHtml(card.bonus, 'lg')}</div>
    <div class="card-name">${card.name}</div>
    <div class="card-cost">${costHtml}</div>`;
  d.title = `${card.name} · 加成：${BALLS[card.bonus].name}${card.tier >= 4 ? '×2（双倍）' : ''}${card.masterCost ? ' · 需大师球×' + card.masterCost : ''}`;
  // 卡面图片：pictures/宝可梦名.jpg；加载成功盖住默认样式，加载失败自动移除
  const img = document.createElement('img');
  img.className = 'card-img';
  img.alt = card.name;
  img.src = 'pictures/' + encodeURIComponent(card.name) + '.jpg';
  img.addEventListener('error', () => img.remove());
  d.appendChild(img);
  return d;
}

// 稀有/传说：右栏顶部并排展示（粉=稀有，紫=传说）
function renderRareLegend() {
  const box = $('#rl-wrap');
  box.innerHTML = '';
  [4, 5].forEach((t) => {
    const label = document.createElement('div');
    label.className = 'tier-label rl-label';
    label.innerHTML = `<span class="tier-dot t${t}"></span>${TIER_NAMES[t]}宝可梦<span class="deck-count">剩 ${S.decks[t].length} 张</span>`;
    box.appendChild(label);
    const prevIds = lastMarketIds[t] || [];
    S.market[t].forEach((card, idx) => {
      const isNew = prevIds[idx] !== (card ? card.id : null);
      box.appendChild(cardEl(card, t, idx, true, isNew));
    });
    lastMarketIds[t] = S.market[t].map((c) => (c ? c.id : null));
  });
}

function renderPool() {
  const pool = $('#pool');
  pool.innerHTML = '';
  COLORS.forEach((c) => {
    const g = document.createElement('div');
    g.className = 'pool-group c-' + c; // 每种球用主题色底色，便于辨别
    g.dataset.color = c;
    const cnt = S.pool[c];
    g.title = BALLS[c].name; // 名字不占画面，悬停可见
    g.innerHTML = `${ballHtml(c)}<span class="pool-count">${cnt}</span>`;
    // 已选中的颜色也保持可点：再点一次 = 取消选择
    const selectable =
      (S.mode === 'take3' && cnt > 0) ||
      (S.mode === 'take2' && cnt >= RULES.takeTwoMin);
    if (selectable) g.classList.add('clickable');
    if (S.selColors.includes(c)) g.classList.add('selected');
    pool.appendChild(g);
  });
  // 大师球：万能球，只能通过预约（或 config 开放的"只拿大师球"行动）获得
  const gm = document.createElement('div');
  gm.className = 'pool-group master';
  gm.dataset.color = 'master';
  gm.title = '大师球（万能球，可代替任意颜色）';
  gm.innerHTML = `${ballHtml('master')}<i class="spark"></i><i class="spark spark2"></i><span class="pool-count">${S.pool.master}</span>`;
  pool.appendChild(gm);
}

function renderPlayers() {
  const col = $('#players');
  const heroBox = $('#my-panel');
  col.innerHTML = '';
  heroBox.innerHTML = '';
  col.dataset.n = S.n; // 人数：CSS 用来自适应密度（4 人局更紧凑）
  // 主角面板：联机=自己；本地=当前玩家。其余玩家放左侧竖排。
  const heroSeat = ONLINE ? mySeat : S.current;
  S.players.forEach((p, pi) => {
    if (pi === heroSeat) heroBox.appendChild(boardEl(p, pi, true));
    else col.appendChild(boardEl(p, pi, false));
  });
}
function boardEl(p, pi, isHero) {
  const b = document.createElement('div');
  b.className = 'player' + (pi === S.current ? ' active' : '') + (ONLINE && pi === mySeat ? ' self' : '') + (isHero ? ' hero' : '');
  b.dataset.p = pi; // 漂移动画的定位锚点
  const discarding = S.phase === 'discard' && pi === S.current;
  const returning = S.mode === 'returnBalls' && pi === S.current && !p.isAI;
  if (discarding) b.classList.add('discarding');
  const typeLabel = p.isAI ? (p.aiLevel === 'easy' ? '电脑·简单' : '电脑·困难') : ''; // 真人玩家不显示标签
  const offline = ONLINE && !p.isAI && !isConnected(pi);
  const nameLabel = p.name + (offline ? '（离线）' : '') + (ONLINE && pi === mySeat ? '（你）' : '');
  const avatar = p.name.slice(-1); // 头像 = 名字尾字
  const ballRow = (c, cnt) => `
    <span class="pball ${((discarding || returning) && cnt > 0) ? 'clickable' : ''}" data-p="${pi}" data-c="${c}">
      ${ballHtml(c, 'sm')}<b>${cnt}</b>
    </span>`;
  const ballsHtml = COLORS.map((c) => ballRow(c, p.balls[c])).join('') + ballRow('master', p.balls.master);
  // 已收服的宝可梦：按加成颜色分组排列（红→蓝→黑→粉→黄，组内按到手顺序）
  const sortedCards = COLORS.flatMap((c) => p.cards.filter((cd) => cd.bonus === c));
  const cardsHtml = sortedCards.map((cd) => `
    <span class="pcard" title="${cd.name}（+${cd.tier >= 4 ? '2×' : ''}${BALLS[cd.bonus].name}加成）">
      <img class="pcard-img" alt="${cd.name}" src="pictures/${encodeURIComponent(cd.name)}.jpg" loading="lazy">
    </span>`).join('');
  // 预约 + 图鉴合并成一行（省高度）。
  // 盲抽的卡：本地模式只有"当前玩家（主角）"可见；联机模式服务器已按人打码
  const seeBlind = ONLINE ? (pi === mySeat) : isHero;
  const sideThumbs = [
    ...p.reserved.map((rc) => {
      const hidden = rc.blind && !seeBlind;
      return `<span class="pcard reserved ${hidden ? 'blind' : ''}" title="${hidden ? '盲抽的卡（未知）' : rc.name}"><img class="pcard-img" alt="${hidden ? '?' : rc.name}" src="pictures/${encodeURIComponent(rc.name)}.jpg" loading="lazy"></span>`;
    }),
    ...(p.dex || []).map((cd) => `<span class="pcard dex" title="${cd.name}"><img class="pcard-img" alt="${cd.name}" src="pictures/${encodeURIComponent(cd.name)}.jpg" loading="lazy"></span>`),
  ].join('');
  const sideHtml = sideThumbs
    ? `<div class="p-side" title="预约与图鉴">${p.reserved.length ? `<span class="p-label">预约 ${p.reserved.length}</span>` : ''}${(p.dex && p.dex.length) ? `<span class="p-label">图鉴 ${p.dex.length}</span>` : ''}${sideThumbs}</div>`
    : '';
  const headHtml = `
    <div class="p-head">
      <span class="p-avatar">${avatar}</span>
      <span class="p-name">${nameLabel}</span>
      ${typeLabel ? `<span class="p-type">${typeLabel}</span>` : ''}
      ${pi === S.firstPlayer ? `<span class="p-first">先手</span>` : ''}
      ${p.evolutions > 0 ? `<span class="p-evo">进化 ${p.evolutions}</span>` : ''}
      <span class="p-pts">${p.points} 分</span>
      ${isHero ? `<span class="p-count">${p.cards.length} 只</span>` : ''}
    </div>`;
  // 主角面板的卡牌行不带标签（第一张卡贴左缘，与上方球行对齐）
  const cardsRow = isHero
    ? `<div class="p-cards">${cardsHtml || '<span class="p-empty">还没有宝可梦</span>'}</div>`
    : `<div class="p-cards"><span class="p-label">${p.cards.length} 只</span>${cardsHtml || '<span class="p-empty">还没有宝可梦</span>'}</div>`;
  if (isHero) {
    // 主角面板：左侧身份 + 购买力（手持精灵球 + 永久加成合并显示），右侧卡牌区
    const bonus = bonusOf(p);
    const ppHtml = COLORS.map((c) => `
      <span class="pball ${((discarding || returning) && p.balls[c] > 0) ? 'clickable' : ''}" data-p="${pi}" data-c="${c}" title="${BALLS[c].name}：手持 ${p.balls[c]} + 加成 ${bonus[c]}">
        ${ballHtml(c, 'sm')}<b>${p.balls[c]}</b>${bonus[c] > 0 ? `<i>+${bonus[c]}</i>` : ''}
      </span>`).join('') + `
      <span class="pball master ${((discarding || returning) && p.balls.master > 0) ? 'clickable' : ''}" data-p="${pi}" data-c="master" title="大师球（万能，可代替任意颜色）">
        ${ballHtml('master', 'sm')}<b>${p.balls.master}</b>
      </span>
      <span class="pball total${totalBalls(p) > RULES.handLimit ? ' over' : ''}" title="手牌总数（含大师球），上限 ${RULES.handLimit} 个">共 ${totalBalls(p)}/${RULES.handLimit}</span>`;
    b.innerHTML = `
      <div class="hero-left">
        ${headHtml}
      </div>
      <div class="hero-body">
        <div class="p-balls pp">${ppHtml}</div>
        ${cardsRow}
        ${sideHtml}
      </div>`;
  } else {
    b.innerHTML = `${headHtml}
      <div class="p-balls">${ballsHtml}</div>
      ${cardsRow}
      ${sideHtml}`;
  }
  return b;
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
    box.innerHTML = `<div class="action-hint warn">你的精灵球超过 ${RULES.handLimit} 个！点击下方自己的精灵球退还（还需 ${S.discardNeed} 个）</div>`;
    return;
  }
  if (S.phase === 'evolve') {
    const myTurn = ONLINE ? (mySeat === S.current) : !p.isAI;
    if (myTurn && !p.isAI) {
      // 服务器/核心只会把"条件已满足"的选项放进 evoOptions
      const opts = S.evoOptions || [];
      const list = opts.map((o, i) => {
        const needTxt = COLORS.map((c) => (o.base.evoNeed && o.base.evoNeed[c] ? `${BALLS[c].name}加成×${o.base.evoNeed[c]}` : '')).filter(Boolean).join('、');
        const gain = o.card.vp - o.base.vp;
        return `<button class="btn evolve" id="act-evo-${i}">
          ${o.base.name} → ${o.card.name}（${gain > 0 ? '+' + gain + '分' : '0分'} · 需${needTxt}）
        </button>`;
      }).join('');
      box.innerHTML = `
        <div class="action-hint">回合结束免费进化：选择 1 只进化的宝可梦（每回合最多 1 次）</div>
        <div class="action-btns">${list}<button class="btn ghost" id="act-skip-evo">跳过进化</button></div>`;
      opts.forEach((o, i) => {
        const b = $('#act-evo-' + i);
        if (b) b.addEventListener('click', () => dispatch({ kind: 'evolve', loc: o.loc }));
      });
      $('#act-skip-evo').addEventListener('click', () => dispatch({ kind: 'skipEvolve' }));
    } else {
      box.innerHTML = `<div class="action-hint">${p.name} 正在思考…</div>`;
    }
    return;
  }
  if (S.phase !== 'normal') return;

  const myTurn = ONLINE ? (mySeat === S.current) : !p.isAI;

  if (!p.isAI && myTurn) {
    if (S.mode === 'take3') {
      const avail = COLORS.filter((c) => S.pool[c] > 0).length;
      const need = Math.min(3, avail);
      box.innerHTML = `
        <div class="action-hint">请选择 ${need} 种不同颜色的精灵球（已选 ${S.selColors.length}/${need}，再点一次已选颜色可取消）</div>
        <div class="action-btns">
          <button class="btn primary" id="act-confirm" ${S.selColors.length === need ? '' : 'disabled'}>确认拿取</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('take3');
      return;
    }
    if (S.mode === 'take2') {
      box.innerHTML = `
        <div class="action-hint">请选择一种精灵球（供应区中该色至少 ${RULES.takeTwoMin} 个）</div>
        <div class="action-btns">
          <button class="btn primary" id="act-confirm" ${S.selColors.length === 1 ? '' : 'disabled'}>确认拿取</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('take2');
      return;
    }
    if (S.mode === 'returnBalls') {
      box.innerHTML = `
        <div class="action-hint">点击下方你自己的 1 个精灵球，把它退回供应区（周转用，通常只在没别的行动时做）</div>
        <div class="action-btns">
          <button class="btn primary" id="act-confirm" ${S.selColors.length === 1 ? '' : 'disabled'}>确认退还</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('returnBalls');
      return;
    }
    if (S.mode === 'takeMaster') {
      box.innerHTML = `
        <div class="action-hint">拿取 1 个大师球（万能球，可代替任意颜色的球）？</div>
        <div class="buy-confirm">
          <div class="buy-name">不预约卡牌，只拿 1 个大师球</div>
          <div class="buy-cost">拿完后结束你的回合。</div>
        </div>
        <div class="action-btns">
          <button class="btn primary" id="act-confirm">确认拿取</button>
          <button class="btn ghost" id="act-cancel">取消</button>
        </div>`;
      bindConfirmCancel('takeMaster');
      return;
    }
    if (S.mode === 'reserve') {
      let mid = '<div class="action-hint">点击场上一张宝可梦预约，或点击左侧一/二/三阶的牌堆盲抽一张（只有你能看到）</div>';
      if (S.selCard) {
        const card = selCardCard();
        const masterInfo = S.pool.master > 0
          ? '同时送你 1 个大师球（万能球，可代替任意颜色的球）'
          : '大师球已领完，这次预约没有球可拿';
        mid = `
          <div class="buy-confirm">
            <div class="buy-name">预约「${card.name}」？</div>
            <div class="buy-cost">预约 = 把这张卡收进你的预约区（最多 ${RULES.reserveLimit} 张），${masterInfo}。之后任意回合都可以收服它。「取消」则什么都不发生。</div>
          </div>`;
      } else if (S.selBlind) {
        mid = `
          <div class="buy-confirm">
            <div class="buy-name">盲抽${TIER_NAMES[S.selBlind]}牌堆？</div>
            <div class="buy-cost">从牌堆顶部抽一张卡收进你的预约区（<b>只有你能看到</b>），${S.pool.master > 0 ? '同时送你 1 个大师球' : '大师球已领完，没有球可拿'}。</div>
          </div>`;
        box.innerHTML = mid + `
          <div class="action-btns">
            <button class="btn primary" id="act-confirm">确认盲抽</button>
            <button class="btn ghost" id="act-cancel">取消</button>
          </div>`;
        bindConfirmCancel('reserveBlind');
        return;
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
      let mid = '<div class="action-hint">点击场上发光的宝可梦，或下方已预约的宝可梦</div>';
      if (p.reserved.length) {
        mid += '<div class="reserved-strip"><span class="rs-label">已预约：</span>' + p.reserved.map((rc, ri) => {
          const ok = canAfford(p, rc);
          return `<span class="rchip ${ok ? 'clickable' : ''} ${S.selCard && S.selCard.kind === 'reserved' && S.selCard.ridx === ri ? 'selected' : ''}" data-ridx="${ri}" ${ok ? '' : `title="还不够精灵球收服它"`}><img class="rchip-img" src="pictures/${encodeURIComponent(rc.name)}.jpg" alt="${rc.name}"><b class="r-vp ${rc.vp === 0 ? 'zero' : ''}">${rc.vp}</b></span>`;
        }).join('') + '</div>';
      }
      if (S.selCard) {
        const card = selCardCard();
        const plan = payPlan(p, card);
        const payHtml = COLORS.map((c) => (plan.pay[c] > 0 ? ballMini(c, plan.pay[c]) : '')).join('') +
          (plan.useJokers > 0 ? ballMini('master', plan.useJokers) : '') +
          (plan.masterCost > 0 ? `<span class="cost-item master-fee">${ballHtml('master', 'xs')}<b>${plan.masterCost}</b></span>` : '');
        mid += `
          <div class="buy-confirm">
            <div class="buy-name">收服 ${card.name}？</div>
            <div class="buy-cost">${plan.totNeed === 0 && plan.masterCost === 0 ? '免费收服！' : `实付：${payHtml}<span class="dim">（已计入你的加成）</span>`}</div>
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
    // 稀有/传说不能预约：只统计一/二/三阶场上的卡
    const canReserve = [1, 2, 3].some((t) => S.market[t].some(Boolean)) && p.reserved.length < RULES.reserveLimit;
    box.innerHTML = `
      <div class="action-hint">你的回合：选择一个行动</div>
      <div class="action-btns">
        <button class="btn primary" id="act-take3" ${avail === 0 ? 'disabled' : ''}>拿 3 个不同球</button>
        <button class="btn secondary" id="act-take2" ${hasTwo ? '' : 'disabled'}>拿 2 个相同球</button>
        <button class="btn buy" id="act-buy" ${hasAff ? '' : 'disabled'}>收服宝可梦</button>
        <button class="btn ghost" id="act-reserve" ${canReserve ? '' : 'disabled'}>预约宝可梦</button>
        <button class="btn ghost sm" id="act-return" ${totalBalls(p) > 0 ? '' : 'disabled'}>退还精灵球</button>
        ${RULES.takeMasterAlone !== false ? `<button class="btn master-ball" id="act-master" ${S.pool.master > 0 ? '' : 'disabled'}>拿大师球</button>` : ''}
      </div>`;
    $('#act-take3').addEventListener('click', () => { S.mode = 'take3'; S.selColors = []; render(); });
    $('#act-take2').addEventListener('click', () => { S.mode = 'take2'; S.selColors = []; render(); });
    $('#act-buy').addEventListener('click', () => { S.mode = 'buy'; S.selCard = null; render(); });
    $('#act-reserve').addEventListener('click', () => { S.mode = 'reserve'; S.selCard = null; render(); });
    $('#act-return').addEventListener('click', () => { S.mode = 'returnBalls'; S.selColors = []; render(); });
    const actMaster = $('#act-master');
    if (actMaster) actMaster.addEventListener('click', () => { S.mode = 'takeMaster'; render(); });
  } else {
    const waiting = p.isAI ? `${p.name} 正在思考…` : `等待 ${p.name} 行动…`;
    box.innerHTML = `<div class="action-hint">${waiting}</div>`;
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
    else if (type === 'takeMaster') dispatch({ kind: 'takeMaster' });
    else if (type === 'reserveBlind') dispatch({ kind: 'reserveBlind', tier: S.selBlind });
    else if (type === 'reserve' && S.selCard) dispatch({ kind: 'reserve', tier: S.selCard.tier, idx: S.selCard.idx });
    else if (type === 'buy' && S.selCard) {
      if (S.selCard.kind === 'reserved') dispatch({ kind: 'buy', reserved: true, ridx: S.selCard.ridx });
      else dispatch({ kind: 'buy', tier: S.selCard.tier, idx: S.selCard.idx });
    }
  });
  $('#act-cancel').addEventListener('click', () => {
    S.mode = null; S.selColors = []; S.selCard = null; S.selBlind = null;
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
  else if (a.kind === 'takeMaster') actTakeMaster();
  else if (a.kind === 'evolve') actEvolve(a.loc);
  else if (a.kind === 'skipEvolve') actSkipEvolve();
  else if (a.kind === 'reserveBlind') actReserveBlind(a.tier);
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
  playSound('win');
  // 平局判定（官方规则）：先比分数 → 再比进化次数 → 再比宝可梦数量
  const rank = S.players.slice().sort((a, b) =>
    (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
  const top = rank[0];
  const tied = rank.filter((p) => p.points === top.points && p.evolutions === top.evolutions && p.cards.length === top.cards.length);
  const title = tied.length > 1
    ? `并列获胜：${tied.map((p) => p.name).join('、')}（${top.points} 分）`
    : `${top.name} 获胜！共 ${top.points} 分`;
  $('#go-title').textContent = title;
  const medals = ['1', '2', '3', '4'];
  $('#go-result').innerHTML = rank.map((p, i) => `
    <div class="go-row ${i === 0 ? 'first' : ''}">
      <span class="go-medal">${medals[i]}</span>
      <span class="go-name">${p.name}</span>
      <span class="go-pts">${p.points} 分</span>
      <span class="go-cnt">${p.cards.length} 只 · 进化 ${p.evolutions} 次</span>
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
// 卡面大图：点击没有触发行动的市场卡/缩略图时放大查看
function openZoom(src) {
  $('#zoom-img').src = src;
  $('#zoom').hidden = false;
}
function onMarketClick(e) {
  // 预约模式下点击左侧牌堆标签 = 盲抽该阶牌堆
  const lbl = e.target.closest('.tier-label');
  if (lbl && S) {
    const t = +lbl.dataset.tier;
    const p = curPlayer();
    if (S.mode === 'reserve' && S.phase === 'normal' && !p.isAI && (!ONLINE || mySeat === S.current)) {
      if ([1, 2, 3].includes(t) && S.decks[t].length > 0) {
        if (p.reserved.length < RULES.reserveLimit) { S.selBlind = t; S.selCard = null; render(); }
        else toast('预约区已满（最多 ' + RULES.reserveLimit + ' 张）');
      }
    }
    return;
  }
  const el = e.target.closest('.card');
  if (!el || !S || el.classList.contains('empty')) return;
  const t = +el.dataset.tier, idx = +el.dataset.idx;
  const card = S.market[t][idx];
  const p = curPlayer();
  if (S.phase !== 'normal' || p.isAI) { zoomCard(el); return; }
  if (ONLINE && mySeat !== S.current) { zoomCard(el); return; }
  let acted = false;
  if (S.mode === 'buy') {
    if (canAfford(p, card)) { S.selCard = { kind: 'market', tier: t, idx }; render(); acted = true; }
  } else if (S.mode === 'reserve') {
    if (card.tier >= 4) { toast('稀有/传说宝可梦不能预约，只能直接收服'); return; }
    if (p.reserved.length < RULES.reserveLimit) { S.selCard = { kind: 'market', tier: t, idx }; render(); acted = true; }
  } else if (S.mode === null) {
    if (canAfford(p, card)) { S.mode = 'buy'; S.selCard = { kind: 'market', tier: t, idx }; render(); acted = true; }
  }
  if (!acted) zoomCard(el);
}
function zoomCard(el) {
  const img = el.querySelector('.card-img');
  if (img) openZoom(img.src);
}
function onPoolClick(e) {
  const g = e.target.closest('.pool-group');
  if (!g || !S) return;
  const c = g.dataset.color;
  const p = curPlayer();
  if (S.phase !== 'normal' || p.isAI || c === 'master') return; // 大师球不能直接拿
  if (ONLINE && mySeat !== S.current) return;
  if (S.mode === 'take3') {
    // 再点一次已选中的颜色 = 取消选择
    if (S.selColors.includes(c)) { S.selColors = S.selColors.filter((x) => x !== c); render(); return; }
    if (S.pool[c] <= 0) return;
    const avail = COLORS.filter((x) => S.pool[x] > 0).length;
    const need = Math.min(3, avail);
    if (S.selColors.length < need) { S.selColors.push(c); render(); }
  } else if (S.mode === 'take2') {
    if (S.pool[c] >= RULES.takeTwoMin) { S.selColors = S.selColors[0] === c ? [] : [c]; render(); }
  }
}
function onPlayerClick(e) {
  const b = e.target.closest('.pball');
  if (b && S) {
    const pi = +b.dataset.p, c = b.dataset.c;
    const p = curPlayer();
    if (ONLINE && mySeat !== pi) return;
    if (S.phase === 'discard' && pi === S.current && !p.isAI && p.balls[c] > 0) {
      if (ONLINE) dispatch({ kind: 'discard', color: c });
      else actDiscardOne(c);
      return;
    }
    // "退还精灵球"模式：点击选择自己 1 个球，再点一次取消
    if (S.mode === 'returnBalls' && S.phase === 'normal' && pi === S.current && !p.isAI && p.balls[c] > 0) {
      S.selColors = S.selColors[0] === c ? [] : [c];
      render();
      return;
    }
  }
  // 点击缩略图放大看卡面
  const pc = e.target.closest('.pcard');
  if (pc) {
    const img = pc.querySelector('.pcard-img');
    if (img) openZoom(img.src);
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
      <option value="human" ${pc.type === 'human' ? 'selected' : ''}>玩家</option>
      <option value="easy" ${pc.type === 'easy' ? 'selected' : ''}>电脑·简单</option>
      <option value="hard" ${pc.type === 'hard' ? 'selected' : ''}>电脑·困难</option>
    </select>
    <button class="btn ghost sm row-del">×</button>`;
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
    if (!j.ok) { toast(j.msg || '请求失败'); playSound('error'); }
    return j;
  } catch (err) {
    toast('与服务器通信失败');
    playSound('error');
    return { ok: false };
  }
}
function updateConnDot() {
  const dot = $('#conn-status');
  if (!ONLINE) { dot.hidden = true; return; }
  dot.hidden = false;
  dot.textContent = connOk ? '已连接' : '连接中断，重连中…';
}
function handleServerMsg(m) {
  if (m.type === 'state') {
    room = m.room;
    room.you = m.you || null; // 服务器把 you 放在 room 旁边，客户端统一挂在 room.you 上
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
      fadeVoteBanner(); // 投票结束后横幅短暂停留再淡出
    }
  } else if (m.type === 'toast') {
    toast(m.msg);
  } else if (m.type === 'error') {
    toast(m.msg);
  } else if (m.type === 'kicked') {
    toast(m.msg || '你被移出了房间');
    setTimeout(() => location.reload(), 1200);
  }
}
function renderLobby() {
  if (!room) return;
  const isHost = !!(room.you && room.you.isHost);
  const humans = room.humans || [];
  const ais = room.ais || [];
  const total = humans.filter((h) => h.connected).length + ais.length;

  $('#lobby-room-info').innerHTML = `房间号 <b>${room.id}</b> · ${room.isPublic ? '公开（可被搜索）' : '私有（仅凭房间号加入）'}`;

  $('#lobby-roster').innerHTML = humans.map((h) => `
    <div class="lobby-row">
      <span class="lobby-dot ${h.connected ? 'on' : 'off'}"></span>
      <span class="lobby-name">${h.name}${h.isHost ? '（房主）' : ''}${h.name === myName ? '（你）' : ''}</span>
      ${h.connected ? '' : '<span class="lobby-tag off">已断线</span>'}
      ${isHost && h.name !== myName ? `<button class="btn ghost sm kick-btn" data-cid="${h.cid}">踢出</button>` : ''}
    </div>`).join('') +
    ais.map((a) => `
    <div class="lobby-row">
      <span class="lobby-dot on"></span>
      <span class="lobby-name">${a.name}</span>
      <span class="lobby-tag">电脑·${a.level === 'easy' ? '简单' : '困难'}</span>
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
        <option value="easy" ${a.level === 'easy' ? 'selected' : ''}>电脑·简单</option>
        <option value="hard" ${a.level === 'hard' ? 'selected' : ''}>电脑·困难</option>
      </select>
      <button class="btn ghost sm ai-del">×</button>`;
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
  row.innerHTML = '<span class="label">目标分数</span>' +
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
  const roomId = $('#join-roomid').value.trim();
  const isPublic = (document.querySelector('input[name="visibility"]:checked') || {}).value === 'public';
  // 昵称有改动时先保存，再以新昵称加入
  const nickname = $('#nickname-input').value.trim();
  if (!nickname) { toast('请填写游戏内昵称'); return; }
  if (nickname !== myNickname) {
    const r = await postApi({ type: 'setNickname', token: myToken, nickname });
    if (!r.ok) return;
    myNickname = r.nickname;
    myName = r.nickname;
  }
  const j = await postApi({ type: 'join', token: myToken, roomId: roomId || undefined, isPublic });
  if (j.ok) {
    myCid = j.cid;
    openEvents(j.cid);
  }
}
async function showRoomList() {
  const box = $('#room-list-box');
  const j = await postApi({ type: 'listRooms' });
  if (!j.ok || !j.rooms) return;
  if (!j.rooms.length) {
    box.hidden = false;
    box.innerHTML = '<div class="room-list-empty">暂时没有公开房间</div>';
    return;
  }
  box.hidden = false;
  box.innerHTML = j.rooms.map((r) => `
    <div class="room-list-row">
      <span class="room-list-id">房间 ${r.id}</span>
      <span class="room-list-host">房主 ${r.host} · ${r.count}/4 人${r.ais ? '（含电脑 ' + r.ais + '）' : ''}</span>
      <button class="btn primary sm" data-room="${r.id}">加入</button>
    </div>`).join('');
  box.querySelectorAll('button[data-room]').forEach((b) => {
    b.addEventListener('click', () => { $('#join-roomid').value = b.dataset.room; joinGame(); });
  });
}

function enterJoinScreen() {
  $('#nickname-input').value = myNickname || myName; // 默认昵称 = 真实姓名（或账号名）
  $('#admin-links').hidden = myRole !== 'admin'; // 管理入口只对管理员显示
  showScreen('join');
}
async function doLogin() {
  const name = $('#login-name').value.trim();
  const pass = $('#login-pass').value;
  if (!name || !pass) { toast('请输入用户名和密码'); return; }
  const j = await postApi({ type: 'login', name, password: pass });
  if (!j.ok) return; // postApi 已提示错误
  myToken = j.token;
  myName = j.name;
  myRole = j.role || '';
  myNickname = j.nickname || j.name;
  localStorage.setItem('spToken', j.token);
  if (j.welcome) toast('你的申请已通过，欢迎加入！');
  enterJoinScreen();
}
async function doRegister() {
  const name = $('#reg-name').value.trim();
  const pass = $('#reg-pass').value;
  const pass2 = $('#reg-pass2').value;
  const realName = $('#reg-real').value.trim();
  const gradYear = $('#reg-grad').value.trim();
  if (pass !== pass2) { toast('两次输入的密码不一致'); return; }
  const j = await postApi({ type: 'register', name, password: pass, realName, gradYear });
  if (j.ok) toast(j.msg || '申请已提交，请等待管理员审核');
}
function initOnline() {
  updateConnDot();
  $('#btn-join').addEventListener('click', joinGame);
  $('#btn-room-list').addEventListener('click', showRoomList);
  $('#join-roomid').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(); });
  // 登录 / 注册
  $('#btn-login').addEventListener('click', doLogin);
  $('#btn-register').addEventListener('click', doRegister);
  $('#tab-login').addEventListener('click', () => { $('#login-form').hidden = false; $('#register-form').hidden = true; });
  $('#tab-register').addEventListener('click', () => { $('#login-form').hidden = true; $('#register-form').hidden = false; });
  $('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#reg-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });
  // 自动登录（localStorage 有令牌时直接进入加入界面）
  const saved = localStorage.getItem('spToken');
  if (saved) {
    postApi({ type: 'whoami', token: saved }).then((j) => {
      if (j.ok) { myToken = saved; myName = j.name; myRole = j.role || ''; myNickname = j.nickname || j.name; enterJoinScreen(); }
      else showScreen('login');
    });
  } else {
    showScreen('login');
  }
  // 房主踢人
  $('#lobby-roster').addEventListener('click', (e) => {
    const b = e.target.closest('.kick-btn');
    if (!b) return;
    const target = (room.humans || []).find((h) => h.cid === b.dataset.cid);
    if (!target) return;
    if (confirm('确定把 ' + target.name + ' 移出房间吗？')) {
      postApi({ type: 'kick', cid: myCid, targetCid: b.dataset.cid });
    }
  });
  $('#btn-add-ai').addEventListener('click', () => {
    if ((room.ais || []).length + (room.humans || []).filter((h) => h.connected).length >= 4) return;
    const ais = (room.ais || []).concat([{ name: AI_NAMES[(room.ais || []).length % 4], level: 'easy' }]);
    postApi({ type: 'setAIs', cid: myCid, ais });
  });
  $('#btn-lobby-start').addEventListener('click', () => postApi({ type: 'start', cid: myCid }));
  // 退出大厅回到主页面（加入界面）
  $('#btn-lobby-leave').addEventListener('click', () => {
    if (confirm('确定退出大厅吗？')) location.reload();
  });
}

/* ==================== 初始化 ==================== */
function init() {
  buildDeco();

  // 本地设置界面
  addPlayerRow({ name: '玩家1', type: 'human' });
  addPlayerRow({ name: '小智', type: 'easy' });
  addPlayerRow({ name: '小霞', type: 'hard' });
  const targetRow = document.querySelector('#screen-setup .target-row');
  targetRow.innerHTML = '<span class="label">目标分数</span>' +
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
      if (confirm('确定退出房间吗？对局会在服务器上继续。')) {
        postApi({ type: 'logout', token: myToken });
        localStorage.removeItem('spToken');
        location.reload();
      }
      return;
    }
    if (!S || S.over) { backToSetup(); return; }
    if (confirm('确定退出当前对局？进度将丢失。')) backToSetup();
  });
  // 结束对局：任何人发起投票，需要所有在线玩家同意
  $('#btn-stop-game').addEventListener('click', () => {
    if (!ONLINE) return;
    if (confirm('发起结束对局投票？需要所有在线玩家同意才能结束。')) {
      postApi({ type: 'voteEnd', cid: myCid });
    }
  });
  // 音效开关
  const soundBtn = $('#btn-sound');
  soundBtn.textContent = soundOn ? '音效：开' : '音效：关';
  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('spSound', soundOn ? 'on' : 'off');
    soundBtn.textContent = soundOn ? '音效：开' : '音效：关';
    if (soundOn) playSound('turn');
  });
  // 修改密码
  $('#link-password').addEventListener('click', (e) => {
    e.preventDefault();
    $('#password-box').hidden = !$('#password-box').hidden;
  });
  $('#btn-password-cancel').addEventListener('click', () => { $('#password-box').hidden = true; });
  $('#btn-password').addEventListener('click', async () => {
    const oldPass = $('#pw-old').value;
    const newPass = $('#pw-new').value;
    const newPass2 = $('#pw-new2').value;
    if (newPass !== newPass2) { toast('两次输入的新密码不一致'); return; }
    const j = await postApi({ type: 'changePassword', token: myToken, oldPassword: oldPass, newPassword: newPass });
    if (j.ok) {
      toast(j.msg || '密码已修改');
      $('#password-box').hidden = true;
      $('#pw-old').value = ''; $('#pw-new').value = ''; $('#pw-new2').value = '';
    }
  });
  // 排行榜
  $('#link-leaderboard').addEventListener('click', async (e) => {
    e.preventDefault();
    const j = await postApi({ type: 'leaderboard', token: myToken });
    if (!j.ok) return;
    const list = j.list || [];
    $('#lb-body').innerHTML = list.length
      ? `<table class="lb-table">
          <thead><tr><th>名次</th><th>昵称</th><th>胜场</th><th>场次</th><th>胜率</th><th>平均分</th><th>进化</th></tr></thead>
          <tbody>${list.map((r, i) => `
            <tr>
              <td>${i + 1}</td>
              <td class="lb-name">${r.nickname}</td>
              <td>${r.wins}</td>
              <td>${r.games}</td>
              <td>${r.winRate}%</td>
              <td>${r.avgPoints}</td>
              <td>${r.evolutions}</td>
            </tr>`).join('')}</tbody>
        </table>`
      : '<div class="lb-empty">还没有战绩记录，快去开局吧！</div>';
    showModal('#modal-leaderboard');
  });
  // 对局记录面板
  $('#btn-logs').addEventListener('click', () => {
    const list = (room && room.log) || [];
    $('#logs-body').innerHTML = list.length
      ? list.map((e) => `<div class="log-line"><span class="log-time">${e.time}</span>${e.text}</div>`).join('')
      : '<div class="log-empty">还没有记录</div>';
    showModal('#modal-logs');
  });
  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', hideModals));

  // config 里开放"只拿大师球"行动时，在规则说明的大师球章节补充一句
  if (RULES.takeMasterAlone !== false) {
    const ul = document.querySelector('#rules-master-sec ul');
    if (ul) {
      const li = document.createElement('li');
      li.textContent = '本局开启了「拿大师球」行动：可以只拿 1 个大师球、不预约卡牌';
      ul.appendChild(li);
    }
  }

  // 市场卡点击（收服/预约选择/放大）与玩家面板点击（退球/退还/缩略图放大）
  // 都委托到整个游戏界面：卡牌或面板以后挪到任何容器都不会漏绑
  $('#screen-game').addEventListener('click', onMarketClick);
  $('#screen-game').addEventListener('click', onPlayerClick);
  $('#pool').addEventListener('click', onPoolClick);
  $('#actions').addEventListener('click', onActionsClick);
  // 卡面大图：点击遮罩关闭
  $('#zoom').addEventListener('click', () => { $('#zoom').hidden = true; });

  if (ONLINE) initOnline();
  else showScreen('setup');
}

init();
