'use strict';

/* ================================================================
   璀璨宝石·宝可梦 — 游戏核心逻辑（浏览器 / 服务器 共用）
   原生 JavaScript，无依赖，不碰 DOM、不写数值。
   · 所有可调数值都在 config.js
   · 界面在 client.js，网络在 server.js
   · 状态变化通过 HOOKS 通知所在环境（浏览器渲染 / 服务器广播）
   ================================================================ */

/* ==================== 常量与数据（从 config.js 读取） ==================== */

// Node 环境（服务器）下用 global 充当 window，浏览器不受影响
if (typeof window === 'undefined') { global.window = global; }

const COLORS = window.COLORS;
const BALLS = window.BALLS;
const RULES = window.RULES;
const AI_CONFIG = window.AI_CONFIG;
const CARD_TABLE = window.CARD_TABLE || [];
const EVO_LINES = window.EVOLUTION_LINES || [];
const EVO_NEEDS = window.EVOLUTION_NEEDS || {};

// 卡名去掉数字后缀："波波2" → "波波"（同一进化线的多张卡共用名字判定）
function baseNameOf(name) { return String(name).replace(/\d+$/, ''); }
const TIER_CN = { 1: '一阶', 2: '二阶', 3: '三阶', 4: '稀有', 5: '传说' };

/* ==================== 会话工厂：每个房间（或本地一局）一个独立会话 ==================== */
// 服务器多房间时每房调用一次 createSession()，互不干扰；
// 浏览器/本地单机用全局兼容层（见文件末尾）。
function createSession() {
let S = null;       // 当前对局状态
let lastCfg = null; // 最近一局的设置（用于"再来一局"）

/* ---- 事件钩子：由环境注入 ---- */
const HOOKS = {
  onStateChanged: () => {},  // 状态变了（浏览器=重绘界面；服务器=广播给所有玩家）
  onToast: () => {},         // 需要提示一条消息
  onGameOver: () => {},      // 对局结束（浏览器=弹结算框；服务器=广播）
  onAction: () => {},        // 执行了一个真实行动（服务器=记回放；含人类与电脑的行动，不含自动退球/自动进化）
};

/* ==================== 工具函数 ==================== */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function totalBalls(p) { return COLORS.reduce((s, c) => s + p.balls[c], 0) + p.balls.master; }
function totalCost(card) { return COLORS.reduce((s, c) => s + (card.cost[c] || 0), 0); }

// 永久加成：玩家已收服的宝可梦按颜色计数（稀有/传说提供双倍加成）
function bonusOf(p) {
  const b = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0 };
  p.cards.forEach((cd) => { b[cd.bonus] += (cd.tier >= 4 ? 2 : 1); });
  return b;
}
// 收服一张卡的实际支付方案：先抵扣加成，再用对应颜色球，颜色缺口用大师球补，
// 最后额外支付卡面的大师球费用（稀有/传说必须用大师球支付）
function payPlan(p, card) {
  const b = bonusOf(p);
  const pay = {}; let totPay = 0, totNeed = 0;
  COLORS.forEach((c) => {
    const need = Math.max(0, (card.cost[c] || 0) - b[c]);
    totNeed += need;
    const use = Math.min(need, p.balls[c]);
    pay[c] = use; totPay += use;
  });
  const useJokers = Math.min(totNeed - totPay, p.balls.master);
  const masterCost = card.masterCost || 0;
  return {
    pay, useJokers, masterCost, totNeed,
    canPay: totPay + useJokers >= totNeed && p.balls.master >= useJokers + masterCost,
  };
}
function canAfford(p, card) { return payPlan(p, card).canPay; }
// 还差多少球才能收服（供 AI 收集资源用）
function missingFor(p, card) {
  const b = bonusOf(p);
  const net = {}; let tot = 0;
  COLORS.forEach((c) => {
    const m = Math.max(0, (card.cost[c] || 0) - b[c] - p.balls[c]);
    net[c] = m; tot += m;
  });
  return { net, tot, effTot: Math.max(0, tot + (card.masterCost || 0) - p.balls.master) };
}

/* ==================== 牌堆：从 config.js 的卡牌表读取 ==================== */
function buildDecksFromTable() {
  const decks = { 1: [], 2: [], 3: [], 4: [], 5: [] }; // 4=稀有 5=传说
  shuffle(CARD_TABLE).forEach((row, i) => {
    const [name, tier, vp, r, b, k, p, y, bonus, mcost] = row;
    if (!decks[tier]) { console.error(`卡牌表第 ${i + 1} 行「${name}」阶数无效：只能是 1/2/3/4/5`); return; }
    if (!COLORS.includes(bonus)) { console.error(`卡牌表第 ${i + 1} 行「${name}」加成色无效：${bonus}`); return; }
    // 推导进化关系：一阶/二阶卡在进化线里找下一形态。
    // 进化条件印在"未进化的卡"上（比如波波的卡面写着进化成比比鸟需要什么）
    let evoTo = null, evoNeed = null;
    if (tier <= 2) {
      const base = baseNameOf(name);
      const line = EVO_LINES.find((ln) => ln.includes(base));
      if (line) {
        const li = line.indexOf(base);
        if (li < line.length - 1) {
          evoTo = line[li + 1];
          // 进化条件：优先取覆盖表（按这张未进化卡的名字），否则默认
          // 一阶卡进化需 2 个加成、二阶卡进化需 3 个（颜色错开自身加成色）
          evoNeed = EVO_NEEDS[name] || EVO_NEEDS[base] ||
            { [COLORS[(COLORS.indexOf(bonus) + tier + 1) % 5]]: tier + 1 };
        }
      }
    }
    decks[tier].push({
      id: `${tier}-${i}`, tier, vp,
      cost: { red: r, blue: b, black: k, pink: p, yellow: y },
      masterCost: mcost || 0, // 稀有/传说卡面的大师球费用（必须用大师球支付）
      bonus, name, evoTo, evoNeed,
    });
  });
  return decks;
}

/* ==================== 对局状态 ==================== */
function newGame(cfg) {
  const n = cfg.players.length;
  const per = RULES.poolPerPlayer[n]; // 2人局每种基础球4个，3人局5个，4人局7个
  const pool = {};
  COLORS.forEach((c) => { pool[c] = per; });
  pool.master = RULES.masterCount;
  const startSeat = Math.floor(Math.random() * n); // 随机先手
  S = {
    n,
    target: cfg.target,
    players: cfg.players.map((pc, i) => ({
      id: i,
      name: pc.name || ('玩家' + (i + 1)),
      isAI: pc.type !== 'human',
      aiLevel: pc.type === 'easy' ? 'easy' : (pc.type === 'hard' ? 'hard' : null),
      balls: { red: 0, blue: 0, black: 0, pink: 0, yellow: 0, master: 0 },
      cards: [],
      reserved: [], // 预约的卡（上限 RULES.reserveLimit 张）
      dex: [],      // 图鉴：被进化替换掉的卡（面朝下，不再提供加成和分数）
      evolutions: 0, // 进化次数（终局平局判定用）
      points: 0,
    })),
    pool,
    decks: buildDecksFromTable(),
    market: { 1: [], 2: [], 3: [], 4: [], 5: [] },
    current: startSeat,
    firstPlayer: startSeat, // 先手座位：公平轮的轮次边界
    turnIdx: 0,
    phase: 'normal',   // normal | discard | evolve | gameover
    mode: null,        // 本地模式下人类玩家的操作模式（联机时由客户端各自维护）
    selColors: [],     // 选中的精灵球颜色
    selCard: null,     // 选中的宝可梦
    evoOptions: null,  // 回合结束时的进化选项
    endTriggered: false,
    over: false,
  };
  [1, 2, 3, 4, 5].forEach((t) => {
    // 每阶场上展示数量：一/二/三阶各 4 张，稀有/传说各 1 张
    const size = (RULES.marketSizes && RULES.marketSizes[t]) || (t <= 3 ? 4 : 1);
    for (let i = 0; i < size; i++) S.market[t].push(S.decks[t].pop() || null);
  });
  HOOKS.onToast(`${S.players[startSeat].name} 先手`);
}

function curPlayer() { return S.players[S.current]; }
function allMarketCards() {
  const out = [];
  [1, 2, 3, 4, 5].forEach((t) => S.market[t].forEach((c) => { if (c) out.push(c); }));
  return out;
}

/* ==================== 玩家行动 ==================== */
function actTakeThree(keys) {
  const p = curPlayer();
  HOOKS.onAction('take3', { colors: keys.slice() });
  keys.forEach((c) => { S.pool[c]--; p.balls[c]++; });
  HOOKS.onToast(`${p.name} 拿取了 ${keys.map((c) => BALLS[c].name).join('、')}${keys.length < 3 ? '（供应不足3色）' : ''}`);
  S.mode = null; S.selColors = [];
  afterGain();
}
function actTakeTwo(c) {
  const p = curPlayer();
  HOOKS.onAction('take2', { color: c });
  S.pool[c] -= 2; p.balls[c] += 2;
  HOOKS.onToast(`${p.name} 拿取了 2 个${BALLS[c].name}`);
  S.mode = null; S.selColors = [];
  afterGain();
}
function afterGain() {
  const p = curPlayer();
  if (totalBalls(p) > RULES.handLimit) {
    if (p.isAI) {
      aiDiscard(p);
      HOOKS.onToast(`${p.name} 退回了多余的精灵球`);
      afterActionDone();
    } else {
      S.phase = 'discard';
      S.discardNeed = totalBalls(p) - RULES.handLimit;
    }
  } else {
    afterActionDone();
  }
  HOOKS.onStateChanged();
}
function actDiscardOne(c) {
  const p = curPlayer();
  HOOKS.onAction('discard', { color: c });
  p.balls[c]--; S.pool[c]++;
  if (totalBalls(p) <= RULES.handLimit) {
    S.phase = 'normal'; S.discardNeed = 0;
    HOOKS.onToast(`精灵球数量已回到 ${RULES.handLimit} 个以内`);
    afterActionDone();
  }
  HOOKS.onStateChanged();
}
function actBuy(tier, idx) {
  const p = curPlayer();
  HOOKS.onAction('buy', { tier, idx });
  const card = S.market[tier][idx];
  payForCard(p, card);
  p.cards.push(card);
  p.points += card.vp;
  S.market[tier][idx] = S.decks[tier].pop() || null;
  HOOKS.onToast(`${p.name} 收服了 ${card.name}！${card.vp > 0 ? '（+' + card.vp + '分）' : ''}`);
  afterBuyPointsCheck(p);
  afterActionDone();
}
function actBuyReserved(ridx) {
  const p = curPlayer();
  HOOKS.onAction('buyReserved', { ridx });
  const card = p.reserved[ridx];
  payForCard(p, card);
  card.blind = false; // 收服后公开
  p.reserved.splice(ridx, 1);
  p.cards.push(card);
  p.points += card.vp;
  HOOKS.onToast(`${p.name} 收服了预约的 ${card.name}！${card.vp > 0 ? '（+' + card.vp + '分）' : ''}`);
  afterBuyPointsCheck(p);
  afterActionDone();
}
function payForCard(p, card) {
  const plan = payPlan(p, card);
  COLORS.forEach((c) => { p.balls[c] -= plan.pay[c]; S.pool[c] += plan.pay[c]; });
  const masterPaid = plan.useJokers + plan.masterCost;
  p.balls.master -= masterPaid; S.pool.master += masterPaid;
}
function afterBuyPointsCheck(p) {
  if (p.points >= S.target && !S.endTriggered) {
    S.endTriggered = true;
    HOOKS.onToast('有人达到目标分，进入最终回合！');
  }
}
// 盲抽预约：从指定阶牌堆顶部抽一张（面朝下，只有自己知道），同样拿大师球
function actReserveBlind(tier) {
  const p = curPlayer();
  if (p.reserved.length >= RULES.reserveLimit) return;
  const card = S.decks[tier].pop();
  if (!card) return;
  HOOKS.onAction('reserveBlind', { tier });
  card.blind = true; // 标记为盲抽：对其他玩家保密
  p.reserved.push(card);
  let gotMaster = false;
  if (S.pool.master > 0) { S.pool.master--; p.balls.master++; gotMaster = true; }
  HOOKS.onToast(`${p.name} 从${TIER_CN[tier]}牌堆盲抽了一张卡${gotMaster ? '，并获得 1 个大师球' : ''}`);
  afterGain(); // 大师球也计入手牌上限，超了要退球
}
// 只拿大师球、不预约：config 里 takeMasterAlone=true 时开放的行动
function actTakeMaster() {
  const p = curPlayer();
  HOOKS.onAction('takeMaster', {});
  S.pool.master--; p.balls.master++;
  HOOKS.onToast(`${p.name} 拿取了 1 个大师球`);
  afterGain();
}
// 退还精灵球：把 1 个球退回供应区（供应区被拿空时的周转行动，防止游戏卡死）
function actReturnBall(c) {
  const p = curPlayer();
  HOOKS.onAction('return', { color: c });
  p.balls[c]--; S.pool[c]++;
  HOOKS.onToast(`${p.name} 退还了 1 个${BALLS[c].name}`);
  S.mode = null; S.selColors = [];
  afterActionDone();
}
function actReserve(tier, idx) {
  const p = curPlayer();
  if (p.reserved.length >= RULES.reserveLimit) return;
  const card = S.market[tier][idx];
  if (card.tier >= 4) return; // 稀有/传说宝可梦不能预约，只能直接收服
  HOOKS.onAction('reserve', { tier, idx });
  S.market[tier][idx] = S.decks[tier].pop() || null;
  p.reserved.push(card);
  let gotMaster = false;
  if (S.pool.master > 0) { S.pool.master--; p.balls.master++; gotMaster = true; }
  HOOKS.onToast(`${p.name} 预约了 ${card.name}${gotMaster ? '，并获得 1 个大师球' : '（大师球已领完）'}`);
  S.mode = null; S.selCard = null;
  afterGain(); // 大师球也计入手牌上限，超了要退球
}
// 每次行动完成后的入口：先给当前玩家一次免费进化机会（每回合最多 1 次），再推进回合。
// 只有存在"条件满足"的进化选项时才进入进化阶段，否则不打扰直接过。
function afterActionDone() {
  const p = curPlayer();
  const opts = evolveOptions(p).filter((o) => o.ok);
  if (opts.length) {
    if (p.isAI) {
      // AI 自动挑收益最高的进化（新分 - 旧分最大）
      const best = opts.sort((a, b) => (b.card.vp - b.base.vp) - (a.card.vp - a.base.vp))[0];
      doEvolve(p, best.loc, best.card, best.base);
    } else {
      // 人类玩家：进入进化阶段，等玩家选择进化或跳过
      S.phase = 'evolve';
      S.evoOptions = opts;
      HOOKS.onStateChanged();
      return;
    }
  }
  advanceTurn();
}
// 推进到下一回合（跳过进化 / 无进化机会 / 断线兜底时调用）
function advanceTurn() {
  const next = (S.current + 1) % S.n;
  // 公平轮：终局触发后，轮到"先手玩家"时本局结束——
  // 这样每名玩家行动次数完全相同（触发者之前的玩家不会多走一轮）
  if (S.endTriggered && next === S.firstPlayer) { finishGame(); return; }
  S.current = next;
  S.turnIdx++;
  S.phase = 'normal'; S.mode = null; S.selColors = []; S.selCard = null; S.evoOptions = null;
  HOOKS.onStateChanged();
  scheduleAI();
}

/* ==================== 宝可梦进化（回合结束免费，每回合限 1 次） ==================== */
// 当前玩家的可选进化：自己已收服的一阶/二阶卡，且其下一形态在场上或预约区
function evolveOptions(p) {
  const opts = [];
  const bonus = bonusOf(p);
  p.cards.forEach((base) => {
    if (!base.evoTo) return;
    const okNeed = COLORS.every((c) => bonus[c] >= (base.evoNeed[c] || 0));
    [1, 2, 3].forEach((t) => S.market[t].forEach((card, idx) => {
      // 进化目标只能是普通一/二/三阶卡（稀有/传说不能作为进化目标）
      if (card && card.tier <= 3 && card.tier > base.tier && baseNameOf(card.name) === base.evoTo) {
        opts.push({ loc: { kind: 'market', tier: t, idx }, card, base, ok: okNeed });
      }
    }));
    p.reserved.forEach((card, ridx) => {
      if (card && card.tier <= 3 && card.tier > base.tier && baseNameOf(card.name) === base.evoTo) {
        opts.push({ loc: { kind: 'reserved', ridx }, card, base, ok: okNeed });
      }
    });
  });
  return opts;
}
// 执行进化：进化卡替换基础形态卡，基础卡进图鉴
function doEvolve(p, loc, card, base) {
  const bi = p.cards.findIndex((c) => c === base);
  if (bi < 0) return;
  p.cards.splice(bi, 1);
  p.dex.push(base);
  p.evolutions++;
  p.points += card.vp - base.vp;
  if (loc.kind === 'reserved') { p.reserved.splice(loc.ridx, 1); card.blind = false; } // 进化后公开
  else S.market[loc.tier][loc.idx] = S.decks[loc.tier].pop() || null;
  p.cards.push(card);
  const gain = card.vp - base.vp;
  HOOKS.onToast(`${p.name} 进化：${base.name} → ${card.name}！（${gain > 0 ? '+' + gain + '分' : '0分'}）`);
  afterBuyPointsCheck(p); // 进化也可能触发终局
}
function actEvolve(loc) {
  const p = curPlayer();
  if (S.phase !== 'evolve') return;
  const op = (S.evoOptions || []).find((o) => sameLoc(o.loc, loc));
  if (!op || !op.ok) return; // 无此选项或进化条件不满足
  HOOKS.onAction('evolve', { loc: JSON.parse(JSON.stringify(loc)) });
  doEvolve(p, op.loc, op.card, op.base);
  finishEvolvePhase();
}
function actSkipEvolve() {
  if (S.phase !== 'evolve') return;
  HOOKS.onAction('skipEvolve', {});
  finishEvolvePhase();
}
function finishEvolvePhase() {
  S.phase = 'normal';
  S.evoOptions = null;
  HOOKS.onStateChanged();
  advanceTurn();
}
function sameLoc(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'reserved' ? (a.ridx === b.ridx) : (a.tier === b.tier && a.idx === b.idx);
}

/* ==================== 电脑 AI ==================== */
function scheduleAI() {
  const g = S;
  const p = curPlayer();
  // 回放模式（S.replay）：电脑行动由回放记录驱动，不自动决策
  if (S.phase === 'normal' && p.isAI && !S.over && !S.replay) {
    setTimeout(() => {
      if (S === g && !S.over && S.phase === 'normal' && curPlayer() === p) aiTurn(p);
    }, AI_CONFIG.thinkMin + Math.random() * (AI_CONFIG.thinkMax - AI_CONFIG.thinkMin));
  }
}
function aiTurn(p) {
  const move = chooseAIMove(p);
  if (move === null) { HOOKS.onAction('skip', {}); HOOKS.onToast(`${p.name} 没有可执行的行动，跳过`); afterActionDone(); return; }
  if (move.type === 'buy') actBuy(move.tier, move.idx);
  else if (move.type === 'buyReserved') actBuyReserved(move.ridx);
  else if (move.type === 'reserve') actReserve(move.tier, move.idx);
  else if (move.type === 'reserveBlind') actReserveBlind(move.tier);
  else if (move.type === 'takeMaster') actTakeMaster();
  else if (move.type === 'return') actReturnBall(move.color);
  else if (move.type === 'take2') actTakeTwo(move.color);
  else actTakeThree(move.colors);
}
function chooseAIMove(p) {
  const simple = p.aiLevel === 'easy';
  if (simple && Math.random() < AI_CONFIG.easyRandomRate) return randomMove(p);

  // 能收服就收服：优先高分的卡（含稀有/传说与预约的卡）
  const aff = [];
  [1, 2, 3, 4, 5].forEach((t) => S.market[t].forEach((c, idx) => {
    if (c && canAfford(p, c)) aff.push({ kind: 'buy', tier: t, idx, card: c });
  }));
  p.reserved.forEach((c, ridx) => {
    if (canAfford(p, c)) aff.push({ kind: 'buyReserved', ridx, card: c });
  });
  if (aff.length) {
    const vpCards = aff.filter((a) => a.card.vp > 0);
    const list = vpCards.length ? vpCards : aff;
    const best = list.slice().sort((a, b) =>
      (b.card.vp - a.card.vp) || (b.card.tier - a.card.tier) || (totalCost(a.card) - totalCost(b.card))
    )[0];
    return best.kind === 'buy' ? { type: 'buy', tier: best.tier, idx: best.idx }
                               : { type: 'buyReserved', ridx: best.ridx };
  }

  // 收不起 → 预约场上最有价值的卡（附带大师球），破局也靠它
  const reserveTarget = pickMarketTarget(p);
  if (reserveTarget && p.reserved.length < RULES.reserveLimit && (S.pool.master > 0 || reserveTarget.card.vp >= 2)) {
    return { type: 'reserve', tier: reserveTarget.tier, idx: reserveTarget.idx };
  }
  // 开启"只拿大师球"行动时：预约没得约了，就攒大师球当万能球用
  if (RULES.takeMasterAlone !== false && S.pool.master > 0 && p.balls.master < 3) {
    return { type: 'takeMaster' };
  }
  // 偶尔从牌堆盲抽（同样拿大师球），尤其是没有好明牌时
  if (p.reserved.length < RULES.reserveLimit && S.pool.master > 0) {
    const tiers = [1, 2, 3].filter((t) => S.decks[t].length > 0);
    if (tiers.length && Math.random() < 0.3) return { type: 'reserveBlind', tier: pick(tiers) };
  }

  // 收集资源：参考全场可见卡（场上+已预约）对各颜色的需求
  const need = globalNeed(p);
  const avail = COLORS.filter((c) => S.pool[c] > 0);
  const wanted = avail.filter((c) => need[c] > 0);
  const surplus = COLORS.filter((c) => p.balls[c] > 0 && p.balls[c] > need[c]);
  // 池子里没有自己需要的球 → 退还富余的球周转供应区（防止全桌卡死）
  if (!wanted.length) {
    if (surplus.length) {
      return { type: 'return', color: surplus.sort((a, b) => (p.balls[b] - need[b]) - (p.balls[a] - need[a]))[0] };
    }
    if (avail.length) return { type: 'take3', colors: [pick(avail)] };
    return bailOut(p);
  }

  const twoOpts = COLORS.filter((c) => S.pool[c] >= RULES.takeTwoMin && need[c] >= 2).sort((a, b) => need[b] - need[a]);
  if (twoOpts.length) return { type: 'take2', color: twoOpts[0] };

  const chosen = wanted.sort((a, b) => need[b] - need[a]).slice(0, 3);
  while (chosen.length < Math.min(3, avail.length)) {
    chosen.push(pick(avail.filter((x) => !chosen.includes(x))));
  }
  return { type: 'take3', colors: chosen };
}
// 全场可见卡（场上+已预约）对每种颜色还缺多少球（不考虑玩家已持有的）
// 供 AI 拿球与弃球时参考，避免只盯一张卡造成换球死循环
function globalNeed(p) {
  const need = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0 };
  const b = bonusOf(p);
  allMarketCards().concat(p.reserved).forEach((card) => {
    COLORS.forEach((c) => {
      need[c] = Math.max(need[c], Math.max(0, (card.cost[c] || 0) - b[c]));
    });
  });
  return need;
}
// 只扫场上的卡，供"预约"行动挑目标
// 前期（少于 AI_CONFIG.engineCards 张卡）不碰三阶，先建经济，避免全桌囤高阶卡把供应区抽干
function pickMarketTarget(p) {
  const engine = p.cards.length < AI_CONFIG.engineCards;
  let best = null, bestScore = -1e9;
  [1, 2, 3].forEach((t) => S.market[t].forEach((c, idx) => {
    if (!c || (engine && c.tier === 3)) return;
    const m = missingFor(p, c);
    const score = c.vp * 4 - m.effTot * 1.1 + c.tier * 0.5 - totalCost(c) * 0.05;
    if (score > bestScore) { bestScore = score; best = { card: c, tier: t, idx }; }
  }));
  return best;
}
// 为目标卡打分（场上 + 已预约）：分数高、还差得少、阶数高 → 分高
function pickTarget(p) {
  const engine = p.cards.length < AI_CONFIG.engineCards;
  let best = null, bestScore = -1e9;
  const consider = (card, tier, idx, ridx) => {
    if (!card) return;
    const m = missingFor(p, card);
    let score = card.vp * 4 - m.effTot * 1.1 + card.tier * 0.5 - totalCost(card) * 0.05 + (ridx !== undefined ? 0.5 : 0);
    if (engine && tier !== undefined && card.tier >= 3) score -= 8; // 前期不囤高阶/稀有/传说
    if (score > bestScore) { bestScore = score; best = { card, tier, idx, ridx }; }
  };
  [1, 2, 3, 4, 5].forEach((t) => S.market[t].forEach((c, idx) => consider(c, t, idx, undefined)));
  p.reserved.forEach((c, ridx) => consider(c, undefined, undefined, ridx));
  return best;
}
// 最后的兜底：实在没有好行动时，退掉任意 1 个球，绝不跳过回合
function bailOut(p) {
  const held = COLORS.filter((c) => p.balls[c] > 0);
  if (held.length) return { type: 'return', color: pick(held) };
  if (p.balls.master > 0) return { type: 'return', color: 'master' };
  return null;
}
function randomMove(p) {
  const opts = [];
  [1, 2, 3, 4, 5].forEach((t) => S.market[t].forEach((c, idx) => {
    if (c && canAfford(p, c)) opts.push({ type: 'buy', tier: t, idx });
  }));
  p.reserved.forEach((c, ridx) => {
    if (canAfford(p, c)) opts.push({ type: 'buyReserved', ridx });
  });
  const t = pickTarget(p);
  // 稀有/传说（4/5 阶）不能预约
  if (t && t.tier !== undefined && t.tier <= 3 && p.reserved.length < RULES.reserveLimit) {
    opts.push({ type: 'reserve', tier: t.tier, idx: t.idx });
  }
  if (RULES.takeMasterAlone !== false && S.pool.master > 0) opts.push({ type: 'takeMaster' });
  const blindTiers = [1, 2, 3].filter((t) => S.decks[t].length > 0);
  if (p.reserved.length < RULES.reserveLimit && blindTiers.length) opts.push({ type: 'reserveBlind', tier: pick(blindTiers) });
  COLORS.forEach((c) => { if (S.pool[c] >= RULES.takeTwoMin) opts.push({ type: 'take2', color: c }); });
  const avail = COLORS.filter((c) => S.pool[c] > 0);
  if (avail.length) opts.push({ type: 'take3', colors: shuffle(avail).slice(0, Math.min(3, avail.length)) });
  return opts.length ? pick(opts) : null;
}
// AI 超出手牌上限时：优先退还"全场没人需要"的球（大师球留到最后才退）
function aiDiscard(p) {
  const need = globalNeed(p);
  while (totalBalls(p) > RULES.handLimit) {
    // 按富余量从大到小退：富余 = 持有 - 全场最大需求
    const basics = COLORS.filter((x) => p.balls[x] > 0)
      .sort((a, b) => ((p.balls[b] - need[b]) - (p.balls[a] - need[a])) || (p.balls[b] - p.balls[a]));
    const c = basics.length ? basics[0] : 'master';
    p.balls[c]--; S.pool[c]++;
  }
}

/* ==================== 终局结算 ==================== */
function finishGame() {
  S.over = true;
  S.phase = 'gameover';
  HOOKS.onGameOver();
}

  return {
    get S() { return S; },
    set S(v) { S = v; },
    get lastCfg() { return lastCfg; },
    set lastCfg(v) { lastCfg = v; },
    HOOKS,
    newGame, curPlayer, allMarketCards,
    actTakeThree, actTakeTwo, actDiscardOne, actBuy, actBuyReserved, actReserve, actReturnBall, actTakeMaster,
    actReserveBlind,
    afterActionDone, advanceTurn, scheduleAI, aiTurn,
    actEvolve, actSkipEvolve, evolveOptions, sameLoc,
    canAfford, payPlan, missingFor, totalBalls, totalCost, globalNeed, bonusOf,
    shuffle, pick,
  };
}

/* ==================== 导出 ==================== */
// 浏览器/无头环境：默认单会话挂到全局（客户端与 sim.js 无需改动）
if (typeof window !== 'undefined') {
  const B = createSession();
  Object.defineProperty(window, 'S', { get: () => B.S, set: (v) => { B.S = v; }, configurable: true });
  Object.defineProperty(window, 'lastCfg', { get: () => B.lastCfg, set: (v) => { B.lastCfg = v; }, configurable: true });
  Object.assign(window, {
    HOOKS: B.HOOKS,
    newGame: B.newGame, curPlayer: B.curPlayer, allMarketCards: B.allMarketCards,
    actTakeThree: B.actTakeThree, actTakeTwo: B.actTakeTwo, actDiscardOne: B.actDiscardOne,
    actBuy: B.actBuy, actBuyReserved: B.actBuyReserved, actReserve: B.actReserve,
    actReturnBall: B.actReturnBall, actTakeMaster: B.actTakeMaster, actReserveBlind: B.actReserveBlind,
    TIER_CN,
    afterActionDone: B.afterActionDone, advanceTurn: B.advanceTurn, scheduleAI: B.scheduleAI, aiTurn: B.aiTurn,
    actEvolve: B.actEvolve, actSkipEvolve: B.actSkipEvolve, evolveOptions: B.evolveOptions,
    sameLoc: B.sameLoc, baseNameOf,
    canAfford: B.canAfford, payPlan: B.payPlan, missingFor: B.missingFor,
    totalBalls: B.totalBalls, totalCost: B.totalCost, globalNeed: B.globalNeed, bonusOf: B.bonusOf,
    shuffle: B.shuffle, pick: B.pick,
  });
}
// Node：导出工厂（多房间各建一个会话）+ 单会话兼容导出（服务器房间化改造前的过渡）
if (typeof module !== 'undefined' && module.exports) {
  const D = createSession();
  module.exports = {
    createSession,
    get S() { return D.S; },
    set S(v) { D.S = v; },
    get lastCfg() { return D.lastCfg; },
    set lastCfg(v) { D.lastCfg = v; },
    HOOKS: D.HOOKS,
    COLORS, BALLS, RULES,
    newGame: D.newGame, curPlayer: D.curPlayer, allMarketCards: D.allMarketCards,
    actTakeThree: D.actTakeThree, actTakeTwo: D.actTakeTwo, actDiscardOne: D.actDiscardOne,
    actBuy: D.actBuy, actBuyReserved: D.actBuyReserved, actReserve: D.actReserve,
    actReturnBall: D.actReturnBall, actTakeMaster: D.actTakeMaster, actReserveBlind: D.actReserveBlind,
    TIER_CN,
    afterActionDone: D.afterActionDone, advanceTurn: D.advanceTurn, scheduleAI: D.scheduleAI, aiTurn: D.aiTurn,
    actEvolve: D.actEvolve, actSkipEvolve: D.actSkipEvolve, evolveOptions: D.evolveOptions,
    sameLoc: D.sameLoc, baseNameOf,
    canAfford: D.canAfford, payPlan: D.payPlan, missingFor: D.missingFor,
    totalBalls: D.totalBalls, totalCost: D.totalCost, globalNeed: D.globalNeed,
    shuffle: D.shuffle, pick: D.pick,
  };
}
