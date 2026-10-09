'use strict';

/* ================================================================
   璀璨宝石·宝可梦 — 客户端（界面渲染 + 交互 + 联机）
   · 用 file:// 打开 index.html = 本地单机模式（游戏逻辑在本页运行）
   · 用 http:// 打开（服务器提供的地址）= 联机模式（游戏逻辑在服务器上）
   ================================================================ */

const $ = (sel) => document.querySelector(sel);
// 回放页（/replay）虽经 http 打开，但走本地渲染模式：无联机流程，对局由 replay.js 驱动
const ONLINE = location.protocol !== 'file:' && location.pathname.indexOf('replay') < 0;
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
let esConn = null;  // 联机：SSE 连接实例（看门狗监控用）
let lastEventTs = Date.now(); // 联机：最近一次收到服务器消息的时间
let actingLock = false; // 联机：行动已发送、等待服务器回推期间的防连点锁
let actingSeq = 0;     // 行动发送序号：迟到的旧回包/超时不得干扰最新一次发送
let overShown = false; // 本局结算框是否已弹出
let prevSnap = null;      // 上一次状态快照（漂移动画差分用）
let pendingCardTargets = {}; // 本次市场换牌对应的收服者座位：卡牌 id -> seat
const lastMarketIds = {}; // 每个市场槽位上次的卡 id（只给新补的卡播入场动画）
// 系统"减弱动态效果"偏好：装饰动画（入场/离场）自动降级，状态时序不受影响
const REDUCED_MOTION = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const motionReduced = () => !!(REDUCED_MOTION && REDUCED_MOTION.matches);
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
  // 过场只在"真的切屏"时播：进来前这一屏已经可见 → 不播。
  // 否则联机每次服务器推送状态（handleServerMsg → showScreen('game')）都会重放
  // 一次全屏球体开合，对局中每动一下屏幕就闪一下。
  const targetEl = document.getElementById('screen-' + id);
  const alreadyShown = !!(targetEl && !targetEl.hidden);
  ['setup', 'login', 'lobby', 'game'].forEach((s) => {
    const el = document.getElementById('screen-' + s);
    if (el) el.hidden = (s !== id);
  });
  // C1 切屏转场（球体开合 .30s）：只给「本次被显示的那一屏」加一次性 class，动画跑完就摘掉。
  // 关掉：删掉这一段（或删掉 style.css 里的 .pk-anim-switch / @keyframes pkOpen）。
  const shownEl = targetEl;
  if (shownEl && !alreadyShown && !motionReduced()) {
    shownEl.classList.remove('pk-anim-switch');
    void shownEl.offsetWidth;                       // 强制重排：连着切同一屏也能重放
    shownEl.classList.add('pk-anim-switch');
    setTimeout(() => shownEl.classList.remove('pk-anim-switch'), 420);
  }
  // 大厅刚显示出来（此前 display:none、rail 无布局，量不到矩形）——
  // 这时才能量到 rail 的真实矩形，把压在 rail 上的装饰球挪开（方案 1 的“布局后复测”）
  if (id === 'lobby' && typeof fixDecoRail === 'function') fixDecoRail();
}

/* ==================== 最终回合大横幅（屏幕中央登场约 1 秒 → 缩进顶栏小徽章） ==================== */
let endBannerActive = false;
let endTriggeredPrev = false;
let endBannerTimer = null;
function showFinalBanner() {
  const big = $('#end-banner-big');
  const pill = $('#end-banner');
  // 顶栏小徽章此刻还是隐藏的：先临时亮出量好它的位置（同一帧内恢复，不会闪烁）
  pill.hidden = false;
  void pill.offsetWidth;
  const pr = pill.getBoundingClientRect();
  pill.hidden = true;
  endBannerActive = true;
  big.hidden = false;
  void big.offsetWidth; // 强制布局，拿到屏幕中央的准确位置
  const br = big.getBoundingClientRect();
  const s = Math.min(pr.width / br.width, pr.height / br.height);
  const dx = (pr.left + pr.width / 2) - (br.left + br.width / 2);
  const dy = (pr.top + pr.height / 2) - (br.top + br.height / 2);
  clearTimeout(endBannerTimer);
  endBannerTimer = setTimeout(() => {
    const inner = big.querySelector('.ebg-inner');
    inner.style.animation = 'none'; // 停止呼吸，干净利落地缩进顶栏
    big.style.transition = 'transform .65s cubic-bezier(.3,.9,.35,1.12)';
    big.style.transform = `translate(${dx}px,${dy}px) scale(${s})`;
    const onEnd = () => {
      big.removeEventListener('transitionend', onEnd);
      big.hidden = true;
      big.style.transition = '';
      big.style.transform = ''; // 复位，下次从屏幕中央重新登场
      inner.style.animation = '';
      endBannerActive = false;
      pill.hidden = false;
    };
    big.addEventListener('transitionend', onEnd);
  }, 1100);
}
function cancelFinalBanner() {
  clearTimeout(endBannerTimer);
  endBannerActive = false;
  $('#end-banner-big').hidden = true;
}

/* ==================== 渲染（读取全局 S） ==================== */
function render() {
  if (!S) return;
  // 回放是观战视图：不显示会随当前行动者轮换的底部“主角”面板。
  // 这个状态类也让 CSS 能在不影响实时对局的情况下收紧回放布局。
  $('#screen-game').classList.toggle('replay-view', !!S.replay);
  // 最终回合（公平轮）：全场切换紧张氛围（红调暗角），对局结束/新一局自动还原
  const fr = S.endTriggered && !S.over;
  $('#screen-game').classList.toggle('final-round', fr);
  if (fr && !endTriggeredPrev) showFinalBanner(); // 刚进入最终回合：大横幅登场
  endTriggeredPrev = fr;
  if (S.over) cancelFinalBanner(); // 对局突然结束（投票等）：撤掉还在登场的大横幅
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
// 对比新旧状态：球从供应区飘向玩家；卡牌离场/入场由市场动画统一处理。
function floatDiff() {
  if (!prevSnap) { prevSnap = snapOf(); return; }
  const nowStr = snapOf();
  const prev = JSON.parse(prevSnap);
  const now = JSON.parse(nowStr);
  prevSnap = nowStr;
  pendingCardTargets = {};
  // 位置从"旧 DOM"取（render 尚未重建）
  const poolRects = {};
  document.querySelectorAll('#pool .pool-group').forEach((g) => { poolRects[g.dataset.color] = g.getBoundingClientRect(); });
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
    newIds.forEach((id) => { pendingCardTargets[id] = i; });
    // 音效：进化优先于预约，其余按收服处理
    if ((p2.evolutions || 0) > (prev.players[i].evolutions || 0)) playSound('evolve');
    else if (newIds.some((id) => (p2.resIds || []).includes(id))) playSound('reserve');
    else playSound('buy');
    // 卡牌本体的“拿起 → 飞入自己面板”由 renderMarket() 的 card-lift 统一负责。
    // 这里不再调用旧的 spawnCardFloat，否则一次收服会出现两张卡同时飞向玩家面板。
  });
}

function renderHeader() {
  const round = Math.floor(S.turnIdx / S.n) + 1;
  $('#round-info').textContent = `第 ${round} 轮`;
  const p = curPlayer();
  const myTurn = ONLINE ? (mySeat === S.current) : !p.isAI;
  // 联机轮到自己：直接说「到你操作」，不显示自己的名字
  $('#turn-info').innerHTML = (ONLINE && myTurn && !p.isAI)
    ? `<b>到你操作</b>`
    : `轮到 <b>${p.name}</b>${myTurn ? (p.isAI ? '（电脑思考中…）' : '（请行动）') : ''}`;
  $('#target-info').textContent = `目标 ${S.target} 分`;
  $('#end-banner').hidden = !S.endTriggered || endBannerActive; // 大横幅归位前，顶栏小徽章先不亮
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

// 离场动画：本回合从场上消失的卡（被收服/预约后顶掉）→ 克隆旧卡面播"拿起"动画，播完再移除。
// 视觉口径 = demo ⑥「拿起·翘右上（微变形，520ms）」：
//   第一段(~40%) 只有角动：绕对角支点 3D 翘起 + 卡面 9 段逐条微弯（轻微变形）+ 接触阴影拉开
//   第二段(~60%) 角领着整张牌沿掀角方向被带走（缓出）
// 纯视觉层：新卡照常立即渲染，行动时序不受影响；系统开了"减弱动态效果"则直接跳过。
const LIFT_MS = 460;

// 造一个"拿起"幽灵：保持完整卡面，避免切片在小尺寸真卡上产生断裂和闪烁。
// 飞行终点取自己的玩家面板，动作方向因此随布局自动适配。
function buildLiftGhost(el, rect, targetSeat){
  const wrap = document.createElement('div');
  wrap.className = 'card-lift';
  const tr = boardRect(targetSeat);
  const tx = tr ? tr.left + tr.width / 2 - (rect.left + rect.width / 2) : 0;
  const ty = tr ? tr.top + Math.min(80, tr.height / 2) - (rect.top + rect.height / 2) : 70;
  wrap.style.cssText = 'position:fixed;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;margin:0;z-index:60;pointer-events:none;will-change:transform,opacity;--fly-x:' + tx.toFixed(1) + 'px;--fly-y:' + ty.toFixed(1) + 'px;';
  const sh = document.createElement('div');
  sh.className = 'sh';
  wrap.appendChild(sh);
  const ghost = el.cloneNode(true);
  ghost.classList.add('lift-card');
  ghost.classList.remove('new', 'selected', 'affordable', 'leaving');
  ghost.style.cssText = 'width:100%;height:100%;margin:0;';
  wrap.appendChild(ghost);
  return wrap;
}

function spawnLeaveGhosts(root) {
  if (motionReduced()) return;
  root.querySelectorAll('.card[data-tier]:not(.empty)').forEach((el) => {
    const t = +el.dataset.tier;
    const idx = +el.dataset.idx;
    const prevIds = lastMarketIds[t] || [];
    const cur = S.market[t] ? S.market[t][idx] : null;
    if (prevIds[idx] == null) return; // 上一帧这个槽位没卡（新登场），不播离场
    if (prevIds[idx] === (cur ? cur.id : null)) return; // 槽位没换卡，不播
    const rect = el.getBoundingClientRect();
    const oldId = prevIds[idx];
    const targetSeat = pendingCardTargets[oldId];
    const ghost = buildLiftGhost(el, rect, targetSeat);
    // 先入 DOM，再让浏览器把幽灵提升为合成层，避免动画首帧和布局重排挤在同一帧。
    document.body.appendChild(ghost);
    setTimeout(() => ghost.remove(), LIFT_MS + 60); // 动画播完再移除 DOM
  });
}

/* ==================== 就地更新（只改变化的那部分） ====================
   整块 innerHTML 重建会把未变的卡／座位／球格销毁重建：<img> 重新解码、无限动画从第 0 帧重启，
   观感就像"被刷新了一下、有的地方还得加载一会"。下面三个小工具让 render 只动真正变了的东西：
   - reconcile：按 key 复用子节点，key 相同就原样留着（连它的 <img>／动画／事件），只改差异
   - setRegion：只在"内容签名"变了时才重填 innerHTML
   - setClass：只在类变化时才 toggle（不重复写同名 class）
   key 必须能表达"这就是同一个东西"：卡片用 card.id，球格用颜色，玩家块用座位号。 */
function reconcile(parent, items, keyOf, build, update) {
  const old = new Map();
  for (const el of Array.from(parent.children)) {
    const k = el.__pkk; // 记账用 JS 属性（不进 DOM）：不污染 innerHTML，也就不会影响任何选择器/CSS
    if (k !== undefined && !old.has(k)) old.set(k, el);
  }
  let prev = null;
  items.forEach((item, i) => {
    const k = String(keyOf(item, i));
    let el = old.get(k);
    if (el) { old.delete(k); if (update) update(el, item, i); }
    // 新建的节点 build 只搭骨架（如空的 .tier-row / 座位块），必须再走一次 update 才算填好
    else { el = build(item, i); el.__pkk = k; if (update) update(el, item, i); }
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (el !== want) parent.insertBefore(el, want);
    prev = el;
  });
  for (const el of old.values()) el.remove();
}
function setRegion(el, sig, htmlFn) {
  if (!el) return;
  if (el.__sig === sig) return;
  el.__sig = sig; // 同上：签名放 JS 属性，不写在节点上
  el.innerHTML = htmlFn();
}
function setClass(el, name, on) {
  if (!el) return;
  if (el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
}
function tierLabelHtml(t) {
  return `<span class="tier-dot t${t}"></span>${TIER_NAMES[t]}宝可梦<span class="deck-count">剩 ${S.decks[t].length} 张</span>`;
}
function tierLabelEl(t, extraCls, blindable, withTierAttr) {
  const label = document.createElement('div');
  label.className = 'tier-label' + (extraCls ? ' ' + extraCls : '');
  if (withTierAttr) label.dataset.tier = t;
  if (blindable) label.classList.add('blind-clickable');
  label.innerHTML = tierLabelHtml(t);
  return label;
}
function syncTierLabel(el, t, blindable) {
  setClass(el, 'blind-clickable', blindable);
  setRegion(el, 'lbl|' + t + '|' + (blindable ? 1 : 0) + '|' + S.decks[t].length, () => tierLabelHtml(t));
}
// 复用卡片节点时只同步"随状态变"的部分（行/列位置、可收服、已选中）
function syncCardEl(el, card, t, idx) {
  if (!card) return; // 空槽（牌堆耗尽）：保持原样
  if (el.dataset.idx !== String(idx)) el.dataset.idx = String(idx);
  const p = curPlayer();
  const myTurn = ONLINE ? (mySeat === S.current) : !p.isAI;
  const humanTurn = myTurn && S.phase === 'normal';
  setClass(el, 'affordable', humanTurn && canAfford(p, card));
  const sel = !!(S.selCard && S.selCard.kind === 'market' && S.selCard.tier === t && S.selCard.idx === idx
    && (S.mode === 'buy' || S.mode === 'reserve'));
  setClass(el, 'selected', sel);
}

function renderMarket() {
  const mk = $('#market');
  spawnLeaveGhosts(mk); // 先让旧 DOM 里消失的卡"掀角"离场，再做就地更新（没变的卡不动）
  reconcile(mk, [3, 2, 1], (t) => 'row' + t,
    () => { const row = document.createElement('div'); row.className = 'tier-row'; return row; },
    (row, t) => fillTierRow(row, t, false));
  [1, 2, 3].forEach((t) => { lastMarketIds[t] = S.market[t].map((c) => (c ? c.id : null)); });
}
// 一行 = 1 个牌堆标签 + 4 张卡；卡按 id 复用 → 没换卡的那几格连 <img> 都不动
function fillTierRow(row, t, mini) {
  const blindable = !mini && S.mode === 'reserve' && t <= 3 && S.decks[t].length > 0;
  const prevIds = lastMarketIds[t] || [];
  const items = [{ label: t }].concat(S.market[t].map((card, idx) => ({ card, idx })));
  reconcile(row, items,
    (it) => (it.label !== undefined) ? ('label' + it.label)
      : ('c:' + (it.card ? it.card.id : 'empty' + t + '_' + it.idx)),
    (it) => (it.label !== undefined)
      ? tierLabelEl(it.label, '', blindable, true)
      : cardEl(it.card, t, it.idx, false, prevIds.indexOf(it.card ? it.card.id : null) < 0), // 只有新补的卡播放入场动画
    (el, it) => {
      if (it.label !== undefined) syncTierLabel(el, it.label, blindable);
      else syncCardEl(el, it.card, t, it.idx);
    });
}
// 新补的卡入场：必须"只播一次、播完即摘"。
//   .card.affordable{animation:pulseGold} 与 .card.new{animation:cardIn} 是两条互斥的 animation 简写，
//   谁在 CSS 里靠后谁生效（affordable 在 378 行、new 在 282 行 → affordable 赢）。
//   原实现只加 .new 类且永不摘除 → 凡是"回合易手让 myTurn 变化"（买完牌轮到对手/电脑）时，
//   整排卡的 affordable 被摘掉 → 那些还留着 .new 的卡把 cardIn 重播一遍 = 买一张牌同排全动。
//   对策：入场 animation 写成**内联**（内联优先级压过任何类规则，affordable/selected 都盖不掉它），
//   播完（animationend，另有 1.1s 兜底）先把 .new 摘掉、再清内联 → 之后任何类变化都不可能重播。
const CARD_ENTER_ANIM = 'cardIn .9s cubic-bezier(.25,.7,.35,1)';
function playCardEnter(el) {
  el.style.animation = CARD_ENTER_ANIM;
  let cleared = false;
  const done = () => {
    if (cleared) return; // 不能拿 el.style.animation 去比字符串：读回来是规范化过的值，永远比不中
    cleared = true;
    el.classList.remove('new'); // 顺序要紧：先摘类再清内联，反过来会立刻重启一次 cardIn
    el.style.animation = '';
  };
  const onEnd = (e) => { if (e.animationName !== 'cardIn') return; el.removeEventListener('animationend', onEnd); done(); };
  el.addEventListener('animationend', onEnd);
  setTimeout(done, 1100); // 兜底：动画被跳过（标签页隐藏等）时不会触发 animationend
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
  if (isNew) playCardEnter(d); // 只有"这一帧才补上"的那张卡播入场（其余卡连类都不动）
  return d;
}

// 稀有/传说：右栏顶部并排展示（粉=稀有，紫=传说）
function renderRareLegend() {
  const box = $('#rl-wrap');
  spawnLeaveGhosts(box); // 稀有/传说同理：被收服顶掉的旧卡先离场，再做就地更新
  const items = [{ label: 4 }]
    .concat(S.market[4].map((card, idx) => ({ card, idx, t: 4 })))
    .concat([{ label: 5 }])
    .concat(S.market[5].map((card, idx) => ({ card, idx, t: 5 })));
  reconcile(box, items,
    (it) => (it.label !== undefined) ? ('label' + it.label)
      : ('c:' + (it.card ? it.card.id : 'empty' + it.t + '_' + it.idx)),
    (it) => (it.label !== undefined)
      ? tierLabelEl(it.label, 'rl-label', false, false) // rl 标签一直不带 data-tier（保持原行为）
      : cardEl(it.card, it.t, it.idx, true, (lastMarketIds[it.t] || []).indexOf(it.card ? it.card.id : null) < 0),
    (el, it) => {
      if (it.label !== undefined) syncTierLabel(el, it.label, false);
      else syncCardEl(el, it.card, it.t, it.idx);
    });
  [4, 5].forEach((t) => { lastMarketIds[t] = S.market[t].map((c) => (c ? c.id : null)); });
}

function renderPool() {
  const pool = $('#pool');
  // 球格按颜色复用：数量变了只改那个数字，节点不重建 → 大师球的光晕/星点不从头重播
  reconcile(pool, COLORS.concat(['master']), (c) => 'pool:' + c,
    (c) => {
      const g = document.createElement('div');
      g.dataset.color = c;
      if (c === 'master') {
        // 大师球：万能球，只能通过预约（或 config 开放的"只拿大师球"行动）获得
        g.className = 'pool-group master';
        g.title = '大师球（万能球，可代替任意颜色）';
        g.innerHTML = `${ballHtml('master')}<i class="spark"></i><i class="spark spark2"></i><span class="pool-count">${S.pool.master}</span>`;
      } else {
        g.className = 'pool-group c-' + c; // 每种球用主题色底色，便于辨别
        g.title = BALLS[c].name; // 名字不占画面，悬停可见
        g.innerHTML = `${ballHtml(c)}<span class="pool-count">${S.pool[c]}</span>`;
      }
      return g;
    },
    (g, c) => syncPoolGroup(g, c));
}
function syncPoolGroup(g, c) {
  const cnt = (c === 'master') ? S.pool.master : S.pool[c];
  const cntEl = g.querySelector('.pool-count');
  if (cntEl && cntEl.textContent !== String(cnt)) cntEl.textContent = cnt;
  if (c === 'master') return; // 大师球格不是行动目标：没有 clickable/selected 语义
  // 已选中的颜色也保持可点：再点一次 = 取消选择
  const selectable =
    (S.mode === 'take3' && cnt > 0) ||
    (S.mode === 'take2' && cnt >= RULES.takeTwoMin);
  setClass(g, 'clickable', selectable);
  setClass(g, 'selected', S.selColors.includes(c));
}

function renderPlayers() {
  const col = $('#players');
  const heroBox = $('#my-panel');
  col.dataset.n = S.n; // 人数：CSS 用来自适应密度（4 人局更紧凑）
  // 回放没有“观看者座位”。所有玩家固定留在左侧列表，避免底部主面板
  // 随着 S.current 改变而不断换人，观感也更接近赛事观战。
  if (S.replay) {
    heroBox.hidden = true;
    heroBox.innerHTML = '';
    const allSeats = S.players.map((_, pi) => pi);
    reconcile(col, allSeats, (pi) => 'seat:' + pi,
      () => document.createElement('div'),
      (el, pi) => boardEl(el, S.players[pi], pi, false));
    return;
  }
  heroBox.hidden = false;
  // 主角面板：联机=自己；本地=当前玩家。其余玩家放左侧竖排。
  const heroSeat = ONLINE ? mySeat : S.current;
  // 座位块按座位号复用：没变化的座位不重建（里面的卡面 <img> 也就不会重新解码）
  const sideSeats = S.players.map((_, pi) => pi).filter((pi) => pi !== heroSeat);
  // heroSeat 理论上一定有；真缺失时就不渲染主角块（与原行为一致：原来靠 pi === undefined 比较也不渲染）
  const heroOk = !!(heroSeat != null && S.players[heroSeat]);
  reconcile(col, sideSeats, (pi) => 'seat:' + pi,
    () => document.createElement('div'),
    (el, pi) => boardEl(el, S.players[pi], pi, false));
  reconcile(heroBox, heroOk ? [heroSeat] : [], (pi) => 'seat:' + pi,
    () => document.createElement('div'),
    (el, pi) => boardEl(el, S.players[pi], pi, true));
}
// 把一个座位块"就地"填好：外框 + 四个区域（头像行 / 球行 / 卡牌行 / 侧栏），
// 每个区域只在"内容签名"变了才重填 → 没变的卡面不重解码、没变的动画不重播
function boardEl(b, p, pi, isHero) {
  b.className = 'player' + (pi === S.current ? ' active' : '') + (ONLINE && pi === mySeat ? ' self' : '') + (isHero ? ' hero' : '');
  b.dataset.p = pi; // 漂移动画的定位锚点
  const discarding = S.phase === 'discard' && pi === S.current;
  const returning = S.mode === 'returnBalls' && pi === S.current && !p.isAI;
  // 骨架（主角面板=左身份+右卡牌区；其他人=竖排）只在"身份变了"时重建一次
  const kind = isHero ? 'hero' : 'side';
  if (b.__kind !== kind) {
    b.__kind = kind;
    b.innerHTML = isHero
      ? '<div class="hero-left"><div class="p-head"></div></div>'
        + '<div class="hero-body"><div class="p-balls pp"></div><div class="p-cards"></div></div>'
      : '<div class="p-head"></div><div class="p-balls"></div><div class="p-cards"></div>';
    delete b.querySelector('.p-head').__sig;
    delete b.querySelector('.p-balls').__sig;
    delete b.querySelector('.p-cards').__sig;
  }
  setClass(b, 'discarding', discarding);
  const typeLabel = p.isAI
    ? (p.aiLevel === 'easy' ? '电脑·简单' : (p.aiLevel === 'champion' ? '电脑·阿尔宙斯' : '电脑·困难'))
    : ''; // 真人玩家不显示标签
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
  // 头像行（.p-head 的壳在骨架里，这里只填里面的 span）
  setRegion(b.querySelector('.p-head'),
    'h|' + [avatar, nameLabel, typeLabel, pi === S.firstPlayer ? 1 : 0, p.evolutions, p.points, isHero ? 1 : 0, p.cards.length].join('|'),
    () => `
      <span class="p-avatar">${avatar}</span>
      <span class="p-name">${nameLabel}</span>
      ${typeLabel ? `<span class="p-type">${typeLabel}</span>` : ''}
      ${pi === S.firstPlayer ? `<span class="p-first">先手</span>` : ''}
      ${p.evolutions > 0 ? `<span class="p-evo">进化 ${p.evolutions}</span>` : ''}
      <span class="p-pts">${p.points} 分</span>
      ${isHero ? `<span class="p-count">${p.cards.length} 只</span>` : ''}`);
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
    setRegion(b.querySelector('.p-balls'),
      'pp|' + [discarding ? 1 : 0, returning ? 1 : 0, totalBalls(p), p.balls.master, COLORS.map((c) => p.balls[c] + '+' + bonus[c]).join(',')].join('|'),
      () => ppHtml);
  } else {
    setRegion(b.querySelector('.p-balls'),
      'b|' + [discarding ? 1 : 0, returning ? 1 : 0, p.balls.master, COLORS.map((c) => p.balls[c]).join(',')].join('|'),
      () => ballsHtml);
  }
  // 卡牌行：按卡 id 复用节点（主角的卡牌行不带标签，非主角带「N 只」标签）
  fillCardsRow(b.querySelector('.p-cards'), sortedCards, p, isHero);
  // 预约 + 图鉴：没有内容就整块不建，有则按名单就地更新
  fillSide(b, p, pi, isHero);
  return b;
}
// 卡牌缩略图（收藏 / 预约 / 图鉴共用）
function pcardImgHtml(name, alt) {
  return `<img class="pcard-img" alt="${alt}" src="pictures/${encodeURIComponent(name)}.jpg" loading="lazy">`;
}
function pcardEl(cd) {
  const s = document.createElement('span');
  s.className = 'pcard';
  s.title = `${cd.name}（+${cd.tier >= 4 ? '2×' : ''}${BALLS[cd.bonus].name}加成）`;
  s.innerHTML = pcardImgHtml(cd.name, cd.name);
  return s;
}
function fillCardsRow(box, sortedCards, p, isHero) {
  if (!box) return;
  const items = sortedCards.map((cd) => ({ cd }));
  const all = isHero ? items.slice() : [{ label: p.cards.length }].concat(items);
  if (!items.length) all.push({ empty: 1 });
  reconcile(box, all,
    (it) => (it.label !== undefined) ? 'lbl' : (it.empty ? 'empty' : 'card:' + it.cd.id),
    (it) => {
      if (it.label !== undefined) { const s = document.createElement('span'); s.className = 'p-label'; s.textContent = it.label + ' 只'; return s; }
      if (it.empty) { const s = document.createElement('span'); s.className = 'p-empty'; s.textContent = '还没有宝可梦'; return s; }
      return pcardEl(it.cd);
    },
    (el, it) => {
      if (it.label === undefined) return;
      const txt = it.label + ' 只';
      if (el.textContent !== txt) el.textContent = txt;
    });
}
function fillSide(b, p, pi, isHero) {
  const host = isHero ? b.querySelector('.hero-body') : b;
  if (!host) return;
  // 盲抽的卡：本地模式只有"当前玩家（主角）"可见；联机模式服务器已按人打码
  const seeBlind = ONLINE ? (pi === mySeat) : isHero;
  const reserved = p.reserved || [];
  const dex = p.dex || [];
  let el = host.querySelector('.p-side');
  if (!(reserved.length + dex.length)) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.className = 'p-side';
    el.title = '预约与图鉴';
    host.appendChild(el);
  }
  const sig = 's|' + reserved.map((rc) => (rc.blind && !seeBlind ? '?' : rc.name)).join(',')
    + '|' + dex.map((cd) => cd.name).join(',');
  setRegion(el, sig, () => {
    const thumbs = reserved.map((rc) => {
      const hidden = rc.blind && !seeBlind;
      return `<span class="pcard reserved ${hidden ? 'blind' : ''}" title="${hidden ? '盲抽的卡（未知）' : rc.name}">${pcardImgHtml(rc.name, hidden ? '?' : rc.name)}</span>`;
    }).join('')
      + dex.map((cd) => `<span class="pcard dex" title="${cd.name}">${pcardImgHtml(cd.name, cd.name)}</span>`).join('');
    return (reserved.length ? `<span class="p-label">预约 ${reserved.length}</span>` : '')
      + (dex.length ? `<span class="p-label">图鉴 ${dex.length}</span>` : '')
      + thumbs;
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
  if (S.replay) {
    box.innerHTML = '<div class="action-hint">观战模式 · 使用底部回放控制条逐步查看行动</div>';
    return;
  }
  const p = curPlayer();
  if (S.phase === 'gameover') return;

  // 联机：行动已发送、等待服务器回推——期间不显示可点按钮（防连点）
  if (ONLINE && actingLock) {
    box.innerHTML = `<div class="action-hint">行动已发送，请稍候…</div>`;
    return;
  }

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
    // C2 加载等待（摇摆 .9s 循环）：坐在现有等待提示上。关掉：去掉 pk-anim-loading 类
    box.innerHTML = `<div class="action-hint pk-anim-loading">${waiting}</div>`;
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
    if (actingLock) return; // 上一次行动还在路上：忽略连点，防止重复发送
    if (!connOk) { toast('连接中断，正在重连，请稍候…'); return; }
    actingLock = true;
    const seq = ++actingSeq;
    // 暂存本次选择（含回合上下文），被拒绝时原样恢复，让玩家可以直接重新点确认
    const savedSel = { turn: S.turnIdx, me: S.current, phase: S.phase, mode: S.mode, colors: S.selColors.slice(), card: S.selCard, blind: S.selBlind };
    // 立即清空本机选择态并显示等待：服务器回推到达前不再接受第二次行动
    S.mode = null; S.selColors = []; S.selCard = null; S.selBlind = null;
    render();
    postApi({ type: 'action', cid: myCid, action: a }, 8000).then((j) => {
      if (seq !== actingSeq) return; // 迟到的旧回包：已有新行动在途，忽略
      if (!j.ok) {
        // 行动被拒绝/发送失败：解锁并恢复按钮，别卡在"请稍候"（服务器拒绝时不会广播）
        actingLock = false;
        // 回合没变才恢复选择；若推送已让回合前进（或人已离开对局）直接渲染当前状态
        if (S && S.turnIdx === savedSel.turn && S.current === savedSel.me && S.phase === savedSel.phase) {
          S.mode = savedSel.mode; S.selColors = savedSel.colors; S.selCard = savedSel.card; S.selBlind = savedSel.blind;
        }
        render();
        return;
      }
      // 服务器已受理：正常回推立刻就到；若 SSE 半死（假活）回推永远不来，5 秒后兜底解锁，
      // 防止界面永远停在"行动已发送，请稍候"（真正的恢复靠下面的 SSE 看门狗重建连接）
      setTimeout(() => {
        if (seq === actingSeq && actingLock) {
          actingLock = false;
          render();
          toast('状态同步超时，请稍后重试');
        }
      }, 5000);
    });
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

/* ---- 版本更新弹窗：发版说明，每台设备每个版本只弹一次 ---- */
let updLatestVer = ''; // 本次弹出的最新版本号（关闭时写入已读标记）
async function checkUpdate() {
  try {
    const r = await fetch('更新日志.json', { cache: 'no-store' });
    if (!r.ok) return;
    const log = await r.json();
    const vers = Object.keys(log);
    if (!vers.length) return;
    const latest = vers[0]; // 约定：最新版本排最前
    if (localStorage.getItem('update-seen-' + latest)) return; // 本设备已读过这一版
    updLatestVer = latest;
    $('#upd-ver').textContent = 'v' + latest;
    $('#upd-body').innerHTML = (log[latest] || []).map((s) => `<li>${s}</li>`).join('');
    showModal('#modal-update');
  } catch (e) { /* 拉取失败（本地 file:// 模式等）不打扰玩家 */ }
}

function showGameOver() {
  if (!S || overShown) return;
  overShown = true;
  playSound('win');
  $('#zoom').hidden = true; // 结算时若卡面大图还开着，先关掉，别挡住结算弹窗
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
  // 单机设置页 + 联机三屏（登录 / 加入 / 大厅）都铺一层漂浮精灵球，背景与单机保持一致
  const hosts = ['screen-setup', 'screen-login', 'screen-lobby']
    .map((id) => document.getElementById(id)).filter(Boolean);
  const cols = ['red', 'blue', 'black', 'pink', 'yellow'];
  // 网格分区：先把屏幕切成 5×4 格，每屏随机取 9 个不同格子，每颗球只在自己格子里浮动。
  // 这样既不会两颗叠在一起，也不会半边挤满、半边空着（原来是各自独立随机坐标）。
  const COLS = 5, ROWS = 4;
  const cellW = window.innerWidth / COLS;
  const cellH = window.innerHeight / ROWS;
  const maxSize = Math.max(24, Math.min(96, Math.min(cellW, cellH) * 0.5));
  // 均衡模板：9 个格子预先排好，保证每行每列都有球（不会出现半边空着）；
  // 每屏再随机做水平/垂直镜像 + 格内抖动，观感才不呆板。
  const TEMPLATE = [[0, 0], [3, 0], [1, 1], [4, 1], [0, 2], [3, 2], [2, 2], [1, 3], [4, 3]];
  // rail（左侧导航栏）矩形：按**当前布局实时算**——宽度是 clamp(150px,15vw,210px)，会随窗口变，不能写死
  const railEl = document.querySelector('.rail');
  const railR = railEl ? railEl.getBoundingClientRect() : null;
  const PAD = 12; // 给漂浮动画留余量：把 rail 矩形外扩，防浮动时压进去
  const hitsRail = (x, y, size) => {
    if (!railR) return false;
    return !(x + size < railR.left - PAD || x > railR.right + PAD
      || y + size < railR.top - PAD || y > railR.bottom + PAD);
  };
  const cellsShuffled = () => {
    const a = [];
    for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++) a.push([gx, gy]);
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };
  // 布点器：**绝不丢球**（每屏近景 9 + 远景 3，恒为 12 颗）。
  // 先在自己那一格里抖动重试；失败就**换格子**（20 格洗牌逐个试）；再不行落到「rail 右侧」的确定性兜底。
  // （上一版的坑：只在自己那一格里抖 20 次 —— 格子正好落在 rail 那一列时全失败 → 球被丢掉。）
  const placeBall = (size, hostRect, spanW0, spanH0, prefCell) => {
    const spanW = Math.max(spanW0, size), spanH = Math.max(spanH0, size);
    const inCell = (c, r, jitter) => {
      const jx = Math.max(0, cellW - size) * 0.25, jy = Math.max(0, cellH - size) * 0.25;
      const cx = c * cellW + (cellW - size) / 2 + (jitter ? (Math.random() * 2 - 1) * jx : 0);
      const cy = r * cellH + (cellH - size) / 2 + (jitter ? (Math.random() * 2 - 1) * jy : 0);
      return { left: cx, top: cy, ok: !hitsRail(hostRect.left + cx, hostRect.top + cy, size) };
    };
    if (prefCell) for (let t = 0; t < 20; t++) { const p = inCell(prefCell[0], prefCell[1], true); if (p.ok) return p; }
    const cells = cellsShuffled();
    for (let i = 0; i < cells.length; i++) {
      if (prefCell && cells[i][0] === prefCell[0] && cells[i][1] === prefCell[1]) continue;
      const p = inCell(cells[i][0], cells[i][1], false);
      if (p.ok) return p;
      const q = inCell(cells[i][0], cells[i][1], true);
      if (q.ok) return q;
    }
    // 确定性兜底：rail 在左边 → 贴着它右边放；夹回 host 范围内（宁可贴边，也不丢球）
    const fx = railR ? Math.min(railR.right + PAD + 4, Math.max(0, spanW - size)) : Math.max(0, (spanW - size) / 2);
    const fy = Math.random() * Math.max(0, spanH - size);
    return { left: fx, top: fy, ok: !hitsRail(hostRect.left + fx, hostRect.top + fy, size) };
  };
  for (const host of hosts) {
    const hostRect = host.getBoundingClientRect();
    const flipX = Math.random() < 0.5, flipY = Math.random() < 0.5;
    // 先量一次 host 的可用宽高（远景球要在整个 host 里随机撒点；量不到就用视口兜底）
    const spanW = Math.max(cellW, hostRect.width || window.innerWidth);
    const spanH = Math.max(cellH, hostRect.height || window.innerHeight);
    for (let i = 0; i < TEMPLATE.length; i++) {
      const c = flipX ? COLS - 1 - TEMPLATE[i][0] : TEMPLATE[i][0];
      const r = flipY ? ROWS - 1 - TEMPLATE[i][1] : TEMPLATE[i][1];
      const b = BALLS[pick(cols)];
      // 布点：先在自己那一格里抖动；失败就换格子（20 格洗牌逐个试）→ **绝不丢球**（近景 9 颗恒满）
      const size = maxSize * (0.65 + Math.random() * 0.35);
      const spot = placeBall(size, hostRect, spanW, spanH, [c, r]);
      const left = spot.left, top = spot.top;
      const d = document.createElement('span');
      d.className = 'ball deco';
      d.style.cssText = `--bc:${b.top};--band:${b.band};width:${size}px;height:${size}px;left:${left}px;top:${top}px;animation-delay:${-Math.random() * 6}s;`;
      host.appendChild(d);
    }
    // A v3 氛围层：近景 9 颗之后，再撒 3 颗远景球（同一套 .ball / 同色 / 尺寸口径与近景一致）。
    // 位置铺在**整个 host**（不限制在卡片外），但必须避开 rail：复用上面的 hitsRail()，
    // 撒不开就换格子找（见 placeBall），**绝不丢球**。
    for (let i = 0; i < 3; i++) {
      const b = BALLS[pick(cols)];
      // 远景球先在整个 host 里随机撒点；撒不开就换格子找 —— 同样**绝不丢球**（远景 3 颗恒满）
      const size = maxSize * (0.65 + Math.random() * 0.35);
      let spot = null;
      for (let t = 0; t < 20 && !spot; t++) {
        const lx = Math.random() * Math.max(0, spanW - size);
        const ly = Math.random() * Math.max(0, spanH - size);
        if (!hitsRail(hostRect.left + lx, hostRect.top + ly, size)) spot = { left: lx, top: ly };
      }
      if (!spot) spot = placeBall(size, hostRect, spanW, spanH, null);
      const left = spot.left, top = spot.top;
      // 外层是「浮动 + 模糊 + 淡出」的容器（className 按约定 = ball deco far，尺寸与近景同口径），
      // 球由内层同一套 .ball 画（style.css 里 .deco.far .ball{ transform:scale(.72) }）。
      const d = document.createElement('span');
      d.className = 'ball deco far';
      d.style.cssText = `--bc:${b.top};--band:${b.band};width:${size}px;height:${size}px;left:${left}px;top:${top}px;animation-delay:${-Math.random() * 9}s;`;
      const inner = document.createElement('span');
      inner.className = 'ball';
      inner.style.cssText = `--bc:${b.top};--band:${b.band};width:100%;height:100%;`;
      d.appendChild(inner);
      host.appendChild(d);
    }
  }
}

/* 布局后复测/避让：`buildDeco()` 在页面加载时跑，那时大厅/rail 还是 display:none（矩形量到 0×0），
   排除判断等于空转。这里在**大厅刚显示**时用真实矩形复测一次，把压在**左侧导航栏 rail**
   上的装饰球（近景 + 远景）重新布点：20 个格子洗牌逐个试，全不行再随机 20 次，
   最后才移除（球数守恒优先：近景 9 + 远景 3 = 12 颗，不循环等待，量不到就不动）。*/
/* 注：卡片内文字**不再是**禁区 —— 球层已压到卡面下层（见 style.css 的 .deco{z-index:0}）。*/
function decorForbidden() {
  const list = [];
  const rail = document.querySelector('.rail');
  if (rail) {
    const r = rail.getBoundingClientRect();
    if (r.width) list.push({ l: r.left - 16, t: r.top - 16, r: r.right + 16, b: r.bottom + 16 });   // rail：外扩 16px
  }
  // **只避 rail**（2026-09-18 第二轮修复）：卡片内文字/控件不再是禁区。
  // 理由：球已由 style.css 的 .deco{z-index:0} + #screen-lobby .shell/.sec{z-index:1} 压到卡面**下层**，
  // 就算压在文字上也看不见，不需要把球挪走。上一版把「卡片内文字」也列为禁区，
  // 结果球被大量移除（实测只剩 4~7 颗，最少一次只剩 1 颗），还把球数守恒搞坏了。
  return list;
}

function fixDecoRail() {
  const rail = document.querySelector('.rail');
  const rr = rail ? rail.getBoundingClientRect() : null;
  if (!rr || !rr.width) return;                      // rail 仍无布局 → 本次不动（防死循环）
  const bad = decorForbidden();                      // 只剩 rail 一类禁区
  const overlaps = (x, y, w, h) => bad.some((z) => !(x + w <= z.l || x >= z.r || y + h <= z.t || y >= z.b));
  const gw = window.innerWidth / 5, gh = window.innerHeight / 4;
  document.querySelectorAll('#screen-lobby .deco').forEach((el) => {
    const host = el.parentElement;
    const hr = host.getBoundingClientRect();
    // 用 offset* 而不是 getBoundingClientRect：offset 量的是**未加 transform 的布局位置**，
    // 不会被浮动动画的当前相位带偏（否则同一颗球会时对时错）。
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!overlaps(hr.left + el.offsetLeft, hr.top + el.offsetTop, w, h)) return;
    const spanW = Math.max(hr.width, w, gw), spanH = Math.max(hr.height, h, gh);
    // 候选点 = 5×4=20 个格子**洗牌后逐个试**（球数守恒优先，见下）。
    const cells = [];
    for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 5; gx++) cells.push([gx, gy]);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); const t = cells[i]; cells[i] = cells[j]; cells[j] = t;
    }
    let nx = null, ny = null;
    for (let i = 0; i < cells.length && nx === null; i++) {
      const cx = Math.min(Math.max(0, cells[i][0] * gw + (gw - w) / 2), Math.max(0, spanW - w));
      const cy = Math.min(Math.max(0, cells[i][1] * gh + (gh - h) / 2), Math.max(0, spanH - h));
      if (!overlaps(hr.left + cx, hr.top + cy, w, h)) { nx = cx; ny = cy; }
    }
    // 20 格全不行（理论上不会发生）：再随机 20 次；仍不行才移除这颗。
    // 上一版是在**自己所在的那一个格子**里抖 20 次 —— 格子正好落在 rail 那一列时 20 次全失败 →
    // 球被 remove() 丢掉（实测球掉到 4~7 颗，最少只剩 1 颗）。换成「换格子」后 12 颗恒满。
    for (let t = 0; t < 20 && nx === null; t++) {
      const cx = Math.random() * Math.max(0, spanW - w);
      const cy = Math.random() * Math.max(0, spanH - h);
      if (!overlaps(hr.left + cx, hr.top + cy, w, h)) { nx = cx; ny = cy; }
    }
    if (nx === null) { el.remove(); return; }        // 兜底：宁少一颗，也不让球压在导航栏上
    el.style.left = nx + 'px';
    el.style.top = ny + 'px';
  });
}

/* ==================== 联机模式 ==================== */
const AI_NAMES = ['小智', '小霞', '小刚', '武藏'];

async function postApi(obj, timeoutMs) {
  // timeoutMs：请求超过此时长仍未响应就中断（fetch 本身没有超时，弱网下可能永远挂起）
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { toast(j.msg || '请求失败'); playSound('error'); }
    return j;
  } catch (err) {
    toast('与服务器通信失败');
    playSound('error');
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 从服务器读取真实发布身份，不依赖 HTML 里的手写版本号。
// 这样即使云端漏传了某个文件，也会得到不同的 build 指纹，排查“本地好了、线上没好”更直接。
async function loadAppInfo() {
  const el = $('#lobby-rail-foot');
  if (!ONLINE || !el) return;
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    if (!r.ok) return;
    const info = await r.json();
    if (!info.ok) return;
    el.textContent = `v${info.version} · ${info.build}`;
    const started = info.startedAt ? new Date(info.startedAt).toLocaleString('zh-CN', { hour12: false }) : '未知';
    el.title = `服务器版本 v${info.version}\n构建 ${info.build}\n启动时间 ${started}`;
  } catch (e) { /* 诊断标识加载失败不影响登录和游戏 */ }
}
function updateConnDot() {
  const dot = $('#conn-status');
  if (!ONLINE) { dot.hidden = true; return; }
  dot.hidden = false;
  dot.textContent = connOk ? '已连接' : '连接中断，重连中…';
}
function handleServerMsg(m) {
  if (m.type === 'hb') return; // 心跳：只用来刷新"最近活跃"时间，无业务内容
  if (m.type === 'state') {
    room = m.room;
    room.you = m.you || null; // 服务器把 you 放在 room 旁边，客户端统一挂在 room.you 上
    if (m.you) { mySeat = m.you.seat; myName = m.you.name; }
    if (m.game) {
      const prev = S;
      S = m.game;
      actingLock = false; // 服务器回推到达：行动流程结束
      // 同回合内的推送（别人重连、投票、断线等）不能清掉正在进行的本地选择：
      // 行动真正完成时回合号会前进，那时才重置 UI 模式（服务器状态的 mode 为 null）
      if (prev && !prev.over && prev.turnIdx === S.turnIdx && prev.current === S.current && prev.phase === S.phase) {
        S.mode = prev.mode; S.selColors = prev.selColors; S.selCard = prev.selCard; S.selBlind = prev.selBlind;
      }
      if (prev && prev.over && !S.over) { hideModals(); $('#zoom').hidden = true; } // 再来一局：关掉上一局的结算弹窗
      if (!S.over) overShown = false;
      showScreen('game');
      render();
      if (S.over && !overShown) showGameOver();
    } else {
      const wasInGame = !!S;
      S = null;
      if (wasInGame) { hideModals(); $('#zoom').hidden = true; } // 对局结束回大厅：关掉结算弹窗/卡面大图，别让它们悬在大厅上
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
// 阿尔宙斯 RL 的口径标签：只标「训练人数档」，不标胜率（胜率留给榜单/说明页）
function lobbyAiLabel(level, total) {
  if (level === 'easy') return '电脑·简单';
  if (level === 'hard') return '电脑·困难';
  if (level === 'champion') return `阿尔宙斯（${total} 人局）`;
  return '电脑';
}

// ---- 大厅一级导航（方案 A：宽屏顶部导航 / 窄屏左竖栏；两处容器渲染同一份按钮）----
const LOBBY_NAV = [
  { id: 'start',  icon: '▶', label: '开始对局', cls: 'primary' },   // 对齐 demo：首项是红色主按钮
  { id: 'champ',  icon: '★', label: '挑战阿尔宙斯' },
  { id: 'rank',   icon: '≡', label: '训练家排行', group: '查看记录' },
  { id: 'replay', icon: '⟲', label: '对局回放' },
  { id: 'honor',  icon: '♛', label: '名人堂' },
];

function showLobbySection(id) {
  const it = LOBBY_NAV.find((x) => x.id === id);
  const t = $('#lobby-sec-title');
  if (t && it) t.textContent = it.label;
  document.querySelectorAll('#lobby-nav .nav-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.sec === id);
  });
  // 排行和回放本身就是内容页，导航点击直接打开，避免出现“先点入口区、再点按钮”的重复操作。
  if (id === 'rank') { $('#link-leaderboard').click(); return; }
  if (id === 'replay') { window.open('/replay', '_blank'); return; }
  document.querySelectorAll('#screen-lobby .sec').forEach((s) => { s.hidden = s.id !== 'lobby-sec-' + id; });
  // 挑战阿尔宙斯的人数档（2/3/4 人局 → 建 mode=challenge 专用房）
  const champ = $('#champ-size');
  if (champ && !champ.dataset.done) {
    champ.dataset.done = '1';
    [2, 3, 4].forEach((n) => {
      const c = document.createElement('button');
      c.type = 'button';
      // 默认档 = 3 人局：与 #champ-start 的 `|| '3'` 和 server 端 `size 不合法时取 3` 保持一致
      // （旧写法把默认高亮画在 2 人局上，但真正建出来的是 3 人局 → 高亮和实际不一致）
      c.className = 'chip' + (n === 3 ? ' on' : '');
      c.textContent = n + ' 人局';
      c.addEventListener('click', () => {
        champ.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
      });
      champ.appendChild(c);
    });
    champ.dataset.size = '3';   // 初始默认档写进 dataset，别让「高亮」和「真建出来的人数」两套说法
  }
  // ④ 名人堂：进到这个分区才拉数据
  if (id === 'honor') loadHall(false);
}

function renderLobbyNav() {
  const box = $('#lobby-nav');
  if (!box || box.dataset.done) return;
  box.dataset.done = '1';
  let group = '';
  LOBBY_NAV.forEach((it) => {
    if (it.group && it.group !== group) {
      group = it.group;
      const label = document.createElement('span');
      label.className = 'nav-group-label';
      label.textContent = group;
      box.appendChild(label);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn nav-btn' + (it.cls ? ' ' + it.cls : '');
    b.dataset.sec = it.id;
    b.innerHTML = '<span class="nav-ico">' + it.icon + '</span><span>' + it.label + '</span>';
    b.addEventListener('click', () => showLobbySection(it.id));
    box.appendChild(b);
  });
}

// ==================== ④ 名人堂：殿堂（永久）/ 本赛季（按模型版本分季） ====================
let hallCache = null;
let hallScope = 'hall';
let hallSize = 2;
let hallView = 'card';

async function loadHall(force) {
  const box = $('#hall-list');
  if (!box) return;
  if (!hallCache || force) {
    // C2 加载等待（摇摆 .9s 循环）：套在现有等待元素上。关掉：去掉这里的 pk-anim-loading 类
    box.innerHTML = '<div class="hall-empty"><b>正在读取名人堂…</b></div>';
    box.firstChild.classList.add('pk-anim-loading');
    const j = await postApi({ type: 'hallOfFame', token: myToken });
    hallCache = (j && j.ok) ? j : { ok: false, entries: [], seasons: [] };
  }
  renderHall();
}

function renderHall() {
  const box = $('#hall-list');
  if (!box || !hallCache) return;
  const all = hallCache.entries || [];
  const seasons = hallCache.seasons || [];
  const seasonKey = seasons.length ? seasons[0].key : null;
  const scoped = (hallScope === 'season' && seasonKey)
    ? all.filter((e) => ((e.aiVer || 'unknown') + '|' + (e.aiName || '')) === seasonKey)
    : all;
  const rows = scoped.filter((e) => e.size === hallSize);
  const sizeLabel = (n) => n + ' 人局';
  if (!rows.length) {
    // 空榜也要好看：群体小，常常只有几条
    box.innerHTML = `<div class="hall-empty">`
      + `<div class="hall-empty-ico">🏅</div>`
      + `<b>${sizeLabel(hallSize)}还没人上榜</b>`
      + `<span>${hallScope === 'season' ? '本赛季' : '殿堂'}还没有 ${sizeLabel(hallSize)} 的挑战记录 —— 去「挑战阿尔宙斯」打一局，赢了就留名。</span>`
      + '</div>';
    return;
  }
  // 挑战回放对全站登录用户开放（canView）；普通回放仍只给参与者
  const openBtn = (e) => (e.canView || e.mine)
    ? `<button class="btn ghost sm hall-open" data-id="${e.id}">看回放</button>`
    : '<span class="hall-tag dim">仅参与者可看</span>';
  if (hallView === 'row') {
    box.innerHTML = '<div class="hall-rows">' + rows.map((e, i) => `
      <div class="hall-row">
        <span class="hall-rank">${i + 1}</span>
        <span class="pk-badge" aria-hidden="true"></span>
        <span class="hall-who">${(e.humans || []).map((h) => h.name).join('、') || '—'}</span>
        <span class="hall-tag">${sizeLabel(e.size)}</span>
        <span class="hall-tag dim">阿尔宙斯</span>
        <span class="hall-date">${(e.createdAt || '').slice(5, 16)}</span>
        ${openBtn(e)}
      </div>`).join('') + '</div>';
    return;
  }
  box.innerHTML = '<div class="hall-cards">' + rows.map((e, i) => `
    <div class="hall-card">
      <div class="hall-card-top">
        <span class="hall-rank">${i + 1}</span>
        <span class="pk-badge" aria-hidden="true"></span>
        <span class="hall-tag">${sizeLabel(e.size)}</span>
      </div>
      <div class="hall-who">${(e.humans || []).map((h) => h.name).join('、') || '—'}</div>
      <div class="hall-meta">${(e.winners || []).length ? '胜者：' + e.winners.join('、') : '未产生胜者'}</div>
      <div class="hall-meta dim">阿尔宙斯 · ${(e.createdAt || '').slice(0, 16)}</div>
      ${openBtn(e)}
    </div>`).join('') + '</div>';
}

// ==================== ⑤ 手机横屏：竖屏进对局时弹遮罩（不做 transform 强制旋转） ====================
const portraitMQ = window.matchMedia('(orientation: portrait) and (max-width: 900px)');
function updateRotateMask() {
  const mask = $('#rotate-mask');
  if (!mask) return;
  const g = $('#screen-game');
  mask.hidden = !(portraitMQ.matches && g && !g.hidden);
}
// ② 大厅专用：不阻断的横屏提示（可忽略；忽略后本次会话不再出）
// 显示判定条件（2026-09-18 写死口径）：**窗口宽 > 高（横屏）时一律不显示**；
// 只有「竖屏（高 ≥ 宽）且宽 ≤ 900px」且未被忽略时才出。
// 理由：844×390 是横屏手机，本来就该满屏看，弹这条提示是错的。
function updateLandscapeTip() {
  const tip = $('#landscape-tip');
  if (!tip) return;
  const dismissed = sessionStorage.getItem('spLandscapeTip') === '1';
  const lb = $('#screen-lobby');
  const landscape = window.innerWidth > window.innerHeight;   // 宽 > 高 = 横屏 → 不显示
  tip.hidden = !(portraitMQ.matches && !landscape && lb && !lb.hidden && !dismissed);
}
function updateOrientationUI() {
  updateRotateMask();
  updateLandscapeTip();
}
function initRotateMask() {
  const btn = $('#btn-rotate-go');
  const hint = $('#rotate-hint');
  const canLock = !!(document.documentElement.requestFullscreen && window.screen && screen.orientation && screen.orientation.lock);
  if (hint && !canLock) hint.hidden = false;   // iOS/Safari：不支持就如实写出来，不假装支持
  if (btn) btn.addEventListener('click', async () => {
    try {
      if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      if (window.screen && screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
    } catch (e) { toast('此设备不支持自动横屏，请手动旋转设备'); }
    setTimeout(updateOrientationUI, 300);
  });
  const ltClose = $('#lt-close');
  if (ltClose) ltClose.addEventListener('click', () => {
    sessionStorage.setItem('spLandscapeTip', '1');
    updateLandscapeTip();
  });
  if (portraitMQ.addEventListener) portraitMQ.addEventListener('change', updateOrientationUI);
  else if (portraitMQ.addListener) portraitMQ.addListener(updateOrientationUI);
  window.addEventListener('orientationchange', () => setTimeout(updateOrientationUI, 200));
  window.addEventListener('resize', updateOrientationUI);
  setInterval(updateOrientationUI, 1000);   // 轻量兜底：进/出屏幕时不用逐处挂钩
  updateOrientationUI();
}

// 同一套外壳，只换中间那张卡：未进房 = #join-card，已进房 = #room-card
function setLobbyMode(hasRoom) {
  const jc = $('#join-card'), rc = $('#room-card');
  if (jc) jc.hidden = !!hasRoom;
  if (rc) rc.hidden = !hasRoom;
  const logsBtn = $('#lobby-logs');
  if (logsBtn) logsBtn.hidden = !hasRoom;   // 「记录」要看房间日志，没房时藏掉
  const title = $('#lobby-sec-title');
  if (title) title.textContent = '开始对局';   // 对齐 demo：加入态也叫「开始对局」
}

function renderLobby() {
  if (!room) return;
  renderLobbyNav();
  setLobbyMode(true);
  const isHost = !!(room.you && room.you.isHost);
  const humans = (room.humans || []).filter((h) => h.connected);
  const ais = room.ais || [];
  const total = humans.length + ais.length;

  // ---- 区 1 · 房间身份（只读）----
  $('#lobby-room-info').innerHTML = `<div class="lobby-roomid">房间号 <b>${room.id}</b>`
    + ` <button class="btn ghost sm" id="lobby-copy-room">复制</button></div>`
    + `<div class="lobby-vis">${room.isPublic ? '公开（可被搜索）' : '私有（仅凭房间号加入）'}</div>`;
  $('#lobby-target-ro').innerHTML = `目标分数 <b>${room.target}</b> 分`;
  $('#lobby-target-ro').hidden = isHost;   // 房主看得到下面的可改控件，这里不重复（非房主必须看得到 ✓）
  $('#lobby-hint').textContent = isHost
    ? (total >= 2 ? `已就座 ${total} 人，可以开始了` : `还差 ${2 - total} 人就座才能开始（2~4 人）`)
    : `等待房主开始游戏…（已就座 ${total} 人）`;

  // ---- 区 2 · 座位（固定 4 槽；房主可在座位上直接操作）----
  const seats = humans.map((h) => ({ kind: 'human', h })).concat(ais.map((a, i) => ({ kind: 'ai', a, aiIdx: i })));
  let html = '';
  for (let i = 0; i < 4; i++) {
    const s = seats[i];
    if (!s) {
      html += `<div class="lobby-seat empty"><span class="seat-no">${i + 1}</span><span class="seat-empty">空位</span></div>`;
      continue;
    }
    if (s.kind === 'human') {
      const h = s.h;
      html += `<div class="lobby-seat${h.name === myName ? ' self' : ''}">`
        + `<span class="seat-no">${i + 1}</span><span class="lobby-dot on"></span>`
        + `<span class="lobby-name">${h.name}${h.isHost ? '（房主）' : ''}${h.name === myName ? '（你）' : ''}</span>`
        + (isHost && h.name !== myName ? `<button class="btn ghost sm kick-btn" data-cid="${h.cid}">踢出</button>` : '')
        + '</div>';
      continue;
    }
    const a = s.a;
    html += '<div class="lobby-seat ai">'
      + `<span class="seat-no">${i + 1}</span><span class="lobby-dot on"></span>`
      + `<span class="lobby-tag${a.level === 'champion' ? ' champ' : ''}">${lobbyAiLabel(a.level, total)}</span>`
      + (isHost
        ? `<input class="seat-ai-name" data-ai="${s.aiIdx}" maxlength="8" value="${a.name}">`
          + (room.mode === 'challenge'
            ? '<span class="lobby-tag champ">挑战房 · 固定阿尔宙斯级</span>'
            : `<select class="seat-ai-level" data-ai="${s.aiIdx}">`
              + `<option value="easy" ${a.level === 'easy' ? 'selected' : ''}>电脑·简单</option>`
              + `<option value="hard" ${a.level === 'hard' ? 'selected' : ''}>电脑·困难</option>`
              + '</select>')
          + '<button class="btn ghost sm seat-ai-del" data-ai="' + s.aiIdx + '" title="移除该电脑玩家" aria-label="移除该电脑玩家">×</button>'
        : '')
      + '</div>';
  }
  $('#lobby-seats').innerHTML = html;
  $('#lobby-add-ai-box').hidden = !isHost || total >= 4;

  // ---- 区 3 · 房主设置（仅房主）----
  $('#lobby-host').hidden = !isHost;
  if (isHost) renderLobbyTarget();
  const startBtn = $('#btn-lobby-start');
  startBtn.textContent = isHost ? '开始游戏' : '等待房主开始';
  startBtn.disabled = isHost ? !(total >= 2 && total <= 4) : true;

  // ---- 区 4 · 次级入口（弱化；音效标签跟随状态）----
  $('#lobby-sound').textContent = soundOn ? '音效：开' : '音效：关';

  // 复制房间号（每次渲染重建，绑一次）
  const cp = $('#lobby-copy-room');
  if (cp) cp.addEventListener('click', () => {
    try {
      navigator.clipboard.writeText(room.id);
      cp.textContent = '已复制';
      setTimeout(() => { cp.textContent = '复制'; }, 1200);
    } catch (e) { /* 不支持剪贴板时不影响 */ }
  });
}
// （原 renderAiRows 已废弃：AI 的改名/训练家等级/移除现在都在区 2 的座位上直接操作，见 renderLobby 与 #lobby-seats 委托）
function renderLobbyTarget() {
  const row = $('#lobby-target');
  row.innerHTML = '<span class="label">调整目标分数</span><span class="lobby-chip">房主可改</span>' +
    RULES.targets.map((t) => `
      <label><input type="radio" name="lobby-target" value="${t}" ${t === room.target ? 'checked' : ''}> ${t} 分</label>`).join('');
  row.querySelectorAll('input').forEach((inp) =>
    inp.addEventListener('change', () => postApi({ type: 'setTarget', cid: myCid, target: +inp.value })));
}
function openEvents(cid) {
  if (esConn) { try { esConn.close(); } catch (e) { /* 旧连接 */ } }
  connOk = true;
  lastEventTs = Date.now();
  updateConnDot();
  esConn = new EventSource('/events?cid=' + encodeURIComponent(cid));
  esConn.onopen = () => { connOk = true; lastEventTs = Date.now(); updateConnDot(); };
  esConn.onmessage = (e) => {
    lastEventTs = Date.now();
    try { handleServerMsg(JSON.parse(e.data)); } catch (err) { /* 忽略坏消息 */ }
  };
  esConn.onerror = () => { connOk = false; updateConnDot(); }; // EventSource 会自动重连
}
async function joinGame(mode, size) {
  // mode='challenge' → 不填房间号，直接新建专用房（对手固定阿尔宙斯级）
  const roomId = mode ? '' : $('#join-roomid').value.trim();
  const isPublic = mode === 'challenge'
    ? false
    : ((document.querySelector('input[name="visibility"]:checked') || {}).value === 'public');
  // 昵称有改动时先保存，再以新昵称加入
  const nickname = $('#nickname-input').value.trim();
  if (!nickname) { toast('请填写游戏内昵称'); return; }
  if (nickname !== myNickname) {
    const r = await postApi({ type: 'setNickname', token: myToken, nickname });
    if (!r.ok) return;
    myNickname = r.nickname;
    myName = r.nickname;
  }
  const j = await postApi({ type: 'join', token: myToken, roomId: roomId || undefined, isPublic, mode: mode || undefined, size: size || undefined });
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
  showScreen('lobby');   // 与大厅共用同一套外壳（不再单独一屏）
  renderLobbyNav();      // 加入态也把导航渲出来（与进房后同一套）
  setLobbyMode(false);   // 未进房 → 显示「加入卡」
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
  $('#btn-join').addEventListener('click', () => joinGame());
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
      if (j.ok) {
        myToken = saved; myName = j.name; myRole = j.role || ''; myNickname = j.nickname || j.name;
        enterJoinScreen();
        tryStartPendingChallenge();   // 登录态 + 加入界面都就绪了，这时候才能真正建挑战房
      } else {
        sessionStorage.removeItem('spChallenge');   // 拿不到登录态：这次挑战请求兑现不了，丢弃，别留到下次登录
        showScreen('login');
      }
    });
  } else {
    sessionStorage.removeItem('spChallenge');   // 同上：没登录态就丢弃，避免「隔夜」标记在下次登录时突然建房
    showScreen('login');
  }
  // 座位区：踢人 / AI 改名改训练家等级 / 移除 / 加电脑（委托处理，座位重排后不用重绑）
  const postAIs = (ais) => postApi({ type: 'setAIs', cid: myCid, ais });
  const readAIs = () => (room.ais || []).map((a) => ({ name: a.name, level: a.level }));
  function addLobbyAI() {
    const used = (room.ais || []).length + (room.humans || []).filter((h) => h.connected).length;
    if (used >= 4) return;
    postAIs((room.ais || []).concat([{ name: AI_NAMES[(room.ais || []).length % 4], level: 'easy' }]));
  }
  $('#lobby-seats').addEventListener('click', async (e) => {
    const b = e.target.closest('.kick-btn');
    if (b) {
      const t = (room.humans || []).find((h) => h.cid === b.dataset.cid);
      // 危险操作：await 自定义确认框，避免同步改异步后跳步
      if (t && await spConfirm({ title: '移出房间', message: '确定把 ' + t.name + ' 移出房间吗？', confirmText: '移出', danger: true })) {
        postApi({ type: 'kick', cid: myCid, targetCid: b.dataset.cid });
      }
      return;
    }
    const del = e.target.closest('.seat-ai-del');
    if (del) { postAIs(readAIs().filter((_, i) => i !== +del.dataset.ai)); return; }
  });
  $('#lobby-seats').addEventListener('change', (e) => {
    const sel = e.target.closest('.seat-ai-level');
    if (sel) {
      const i = +sel.dataset.ai;
      postAIs(readAIs().map((a, k) => (k === i ? { name: a.name, level: sel.value } : a)));
      return;
    }
    const nm = e.target.closest('.seat-ai-name');
    if (nm) {
      const i = +nm.dataset.ai;
      postAIs(readAIs().map((a, k) => (k === i ? { name: nm.value.trim() || '电脑', level: a.level } : a)));
    }
  });
  $('#btn-add-ai').addEventListener('click', addLobbyAI);
  // 工具条（照搬 demo 方案 A：账号 / 教程 / 说明 / 音效）—— 弹层内容接生产真实入口
  const LOBBY_POP = {
    account: '<h3>账号</h3>'
      + '<button type="button" class="btn ghost sm" data-lpop="pw">修改密码</button> '
      + '<button type="button" class="btn ghost sm" data-lpop="logout">退出登录</button>',
    tutorial: '<h3>新手教程</h3>'
      + '<button type="button" class="btn secondary sm" data-lpop="tutgo">开始教程</button>',
    rules: '<h3>规则说明</h3>'
      + '<button type="button" class="btn secondary sm" data-lpop="rulesgo">打开规则</button>',
  };
  const popBox = $('#lobby-pop'), popBody = $('#lobby-pop-body');
  function openLobbyPop(key) {
    if (!popBox || !popBody) return;
    popBody.innerHTML = LOBBY_POP[key] || '';
    popBox.hidden = false;
    requestAnimationFrame(() => popBox.classList.add('open'));
  }
  function closeLobbyPop() {
    if (!popBox) return;
    popBox.classList.remove('open');
    setTimeout(() => { popBox.hidden = true; }, 230);
  }
  if (popBox) {
    document.addEventListener('click', (e) => {
      const util = e.target.closest('[data-util]');
      if (util && $('#screen-lobby') && !$('#screen-lobby').hidden) { openLobbyPop(util.dataset.util); return; }
      const b = e.target.closest('[data-lpop]');
      if (b) {
        const k = b.dataset.lpop;
        if (k === 'pw') { closeLobbyPop(); $('#link-password').click(); }
        else if (k === 'logout') { localStorage.removeItem('spToken'); location.reload(); }
        else if (k === 'tutgo') { closeLobbyPop(); if (typeof startTutorial === 'function') startTutorial(); else toast('教程入口待接入'); }
        else if (k === 'rulesgo') { closeLobbyPop(); $('#btn-rules').click(); }
        return;
      }
      if (!popBox.hidden && !popBox.contains(e.target)) closeLobbyPop();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !popBox.hidden) closeLobbyPop(); });
  }
  $('#lobby-logs').addEventListener('click', () => $('#btn-logs').click());
  $('#lobby-sound').addEventListener('click', () => $('#btn-sound').click());
  // 导航分区里的入口按钮
  // 排行函数在 init() 内定义；这里通过兼容入口触发，避免初始化阶段引用未进入作用域的局部函数。
  $('#lobby-rank-open').addEventListener('click', () => $('#link-leaderboard').click());
  // 对局回放入口：旧写法错接到「对局记录」弹窗（$('#btn-logs')）——点的是「对局回放」，
  // 弹出来的却是一段纯文字日志（濠哥：「对局回放怎么显示的是日志」）。
  // 现在直接开回放页 /replay：回放页与游戏共用 localStorage 的 spToken，登录态跟着走。
  $('#lobby-replay-open').addEventListener('click', () => window.open('/replay', '_blank'));
  // ③ 挑战阿尔宙斯：选人数（2/3/4）→ 建专用房 mode=challenge（对手固定阿尔宙斯级）
  const champBox = $('#champ-size');
  if (champBox) {
    champBox.addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (c) champBox.dataset.size = (c.textContent.match(/[0-9]/) || ['3'])[0];
    });
  }
  const champStart = $('#champ-start');
  // 跨刷新发起挑战房时**必须等登录态就绪**：重载之后 myToken 要等异步 whoami 才恢复，
  // 同步检查只会读到空值 → 挑战房永远建不起来（旧写法就丢在这里，玩家再点「进入游戏」就落普通房）
  function tryStartPendingChallenge() {
    const size = sessionStorage.getItem('spChallenge');
    if (!size) return false;
    if (!myToken) return false;                 // 登录态没好：标记先留着，等 whoami 成功那次调用
    sessionStorage.removeItem('spChallenge');   // 先清标记再建房，避免重复发起
    joinGame('challenge', +size);               // 此刻昵称输入框已由 enterJoinScreen 填好
    return true;
  }
  if (champStart) champStart.addEventListener('click', () => {
    const size = (champBox && champBox.dataset.size) || '3';
    sessionStorage.setItem('spChallenge', size);   // 跨刷新传递（建房会换房，直接重载最干净）
    location.reload();
  });
  tryStartPendingChallenge();   // 重载后先试一次（通常此时还没登录态 → 标记留着，等 whoami 成功那次）
  // ④ 名人堂：殿堂/本赛季、人数分栏、版式切换、打开回放
  const hallScopeBar = $('#hall-scope');
  if (hallScopeBar) hallScopeBar.addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    hallScope = c.dataset.scope;
    hallScopeBar.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    renderHall();
  });
  const hallSizeBar = $('#hall-size');
  if (hallSizeBar) hallSizeBar.addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    hallSize = +c.dataset.size;
    hallSizeBar.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    renderHall();
  });
  const hallViewBar = $('#hall-view');
  if (hallViewBar) hallViewBar.addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    hallView = c.dataset.view;
    hallViewBar.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    renderHall();
  });
  const hallList = $('#hall-list');
  if (hallList) hallList.addEventListener('click', (e) => {
    const b = e.target.closest('.hall-open');
    if (b) window.open('/replay?id=' + b.dataset.id, '_blank');
  });
  initRotateMask();   // ⑤ 手机横屏提示
  // E8：内容区构图档位 —— 默认档 2（居中 + 放大）；?card=center 回到档 1（仅居中）
  if (new URLSearchParams(location.search).get('card') !== 'center') {
    const lbCard = $('#screen-lobby');
    if (lbCard) lbCard.classList.add('card-lg');
  }
  $('#btn-lobby-start').addEventListener('click', () => postApi({ type: 'start', cid: myCid }));
  // 退出大厅回到主页面（加入界面）
  $('#btn-lobby-leave').addEventListener('click', async () => {
    if (await spConfirm({ title: '退出大厅', message: '确定退出大厅吗？' })) location.reload();
  });
  // SSE 看门狗：服务器每 20 秒发一次心跳，若 45 秒毫无动静说明连接半死（TCP 假活），
  // 强制重建连接（新连接会顶掉服务器上的旧连接，随后补发全量状态）
  setInterval(() => {
    if (esConn && connOk && myCid && Date.now() - lastEventTs > 45000) {
      openEvents(myCid);
    }
  }, 10000);
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
  $('#btn-exit').addEventListener('click', async () => {
    if (ONLINE) {
      if (await spConfirm({ title: '退出房间', message: '确定退出房间吗？对局会在服务器上继续。' })) {
        postApi({ type: 'logout', token: myToken });
        localStorage.removeItem('spToken');
        location.reload();
      }
      return;
    }
    if (!S || S.over) { backToSetup(); return; }
    if (await spConfirm({ title: '退出对局', message: '确定退出当前对局？进度将丢失。', confirmText: '退出对局', danger: true })) backToSetup();
  });
  // 结束对局：任何人发起投票，需要所有在线玩家同意
  $('#btn-stop-game').addEventListener('click', async () => {
    if (!ONLINE) return;
    if (await spConfirm({ title: '结束对局投票', message: '发起结束对局投票？需要所有在线玩家同意才能结束。', confirmText: '发起投票', danger: true })) {
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
  // 训练家排行：大厅导航和兼容旧入口共用同一个打开函数
  async function openLeaderboard(e) {
    if (e && e.preventDefault) e.preventDefault();
    const j = await postApi({ type: 'leaderboard', token: myToken });
    if (!j.ok) return;
    const list = j.list || [];
    $('#lb-body').innerHTML = list.length
      ? `<table class="lb-table">
          <thead><tr><th class="lb-rank-col">排名</th><th>训练家</th><th>胜场</th><th>场次</th><th>胜率</th><th>平均分</th><th>进化</th></tr></thead>
          <tbody>${list.map((r, i) => `
            <tr class="lb-row ${i < 3 ? 'lb-top-' + (i + 1) : ''}">
              <td class="lb-rank-col"><span class="lb-rank">${i + 1}</span></td>
              <td class="lb-name"><b>${r.realName || r.nickname}</b><small>${r.nickname && r.nickname !== (r.realName || r.nickname) ? r.nickname : ''}</small></td>
              <td class="lb-strong">${r.wins}</td>
              <td>${r.games}</td>
              <td><span class="lb-rate">${r.winRate}%</span></td>
              <td>${r.avgPoints}</td>
              <td>${r.evolutions}</td>
            </tr>`).join('')}</tbody>
        </table>`
      : '<div class="lb-empty">还没有战绩记录，快去开局吧！</div>';
    showModal('#modal-leaderboard');
  }
  $('#link-leaderboard').addEventListener('click', openLeaderboard);
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
  // 版本更新弹窗：关闭时记下"已读"，本设备不再弹这一版
  $('#btn-upd-close').addEventListener('click', () => {
    if (updLatestVer) localStorage.setItem('update-seen-' + updLatestVer, '1');
    hideModals();
  });

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

  if (ONLINE) { initOnline(); loadAppInfo(); checkUpdate(); } // 联机模式：同步发布身份，并检查未读更新说明
  else showScreen('setup');
}

init();
