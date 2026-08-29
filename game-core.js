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

/* ==================== 事件钩子：由环境注入 ==================== */
const HOOKS = {
  onStateChanged: () => {},  // 状态变了（浏览器=重绘界面；服务器=广播给所有玩家）
  onToast: () => {},         // 需要提示一条消息
  onGameOver: () => {},      // 对局结束（浏览器=弹结算框；服务器=广播）
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

// 永久加成：玩家已收服的宝可梦按颜色计数
function bonusOf(p) {
  const b = { red: 0, blue: 0, black: 0, pink: 0, yellow: 0 };
  p.cards.forEach((cd) => b[cd.bonus]++);
  return b;
}
// 收服一张卡的实际支付方案：先抵扣加成，再用对应颜色球，最后用大师球补足
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
  return { pay, useJokers, totNeed, canPay: totPay + useJokers >= totNeed };
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
  return { net, tot, effTot: Math.max(0, tot - p.balls.master) };
}

/* ==================== 牌堆：从 config.js 的卡牌表读取 ==================== */
function buildDecksFromTable() {
  const decks = { 1: [], 2: [], 3: [] };
  shuffle(CARD_TABLE).forEach((row, i) => {
    const [name, tier, vp, r, b, k, p, y, bonus] = row;
    if (!decks[tier]) { console.error(`卡牌表第 ${i + 1} 行「${name}」阶数无效：只能是 1/2/3`); return; }
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
      bonus, name, evoTo, evoNeed,
    });
  });
  return decks;
}

/* ==================== 对局状态 ==================== */
let S = null;       // 当前对局状态
let lastCfg = null; // 最近一局的设置（用于"再来一局"）

function newGame(cfg) {
  const n = cfg.players.length;
  const per = RULES.poolPerPlayer[n]; // 2人局每种基础球4个，3人局5个，4人局7个
  const pool = {};
  COLORS.forEach((c) => { pool[c] = per; });
  pool.master = RULES.masterCount;
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
    market: { 1: [], 2: [], 3: [] },
    current: Math.floor(Math.random() * n),
    turnIdx: 0,
    phase: 'normal',   // normal | discard | evolve | gameover
    mode: null,        // 本地模式下人类玩家的操作模式（联机时由客户端各自维护）
    selColors: [],     // 选中的精灵球颜色
    selCard: null,     // 选中的宝可梦
    evoOptions: null,  // 回合结束时的进化选项
    endTriggered: false, endPlayer: null,
    over: false,
  };
  [1, 2, 3].forEach((t) => {
    for (let i = 0; i < RULES.marketSize; i++) S.market[t].push(S.decks[t].pop() || null);
  });
}

function curPlayer() { return S.players[S.current]; }
function allMarketCards() {
  const out = [];
  [1, 2, 3].forEach((t) => S.market[t].forEach((c) => { if (c) out.push(c); }));
  return out;
}

/* ==================== 玩家行动 ==================== */
function actTakeThree(keys) {
  const p = curPlayer();
  keys.forEach((c) => { S.pool[c]--; p.balls[c]++; });
  HOOKS.onToast(`${p.name} 拿取了 ${keys.map((c) => BALLS[c].name).join('、')}${keys.length < 3 ? '（供应不足3色）' : ''}`);
  S.mode = null; S.selColors = [];
  afterGain();
}
function actTakeTwo(c) {
  const p = curPlayer();
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
  const card = p.reserved[ridx];
  payForCard(p, card);
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
  p.balls.master -= plan.useJokers; S.pool.master += plan.useJokers;
}
function afterBuyPointsCheck(p) {
  if (p.points >= S.target && !S.endTriggered) {
    S.endTriggered = true;
    S.endPlayer = S.current;
    HOOKS.onToast('🏁 有人达到目标分，进入最终回合！');
  }
}
// 只拿大师球、不预约：config 里 takeMasterAlone=true 时开放的行动
function actTakeMaster() {
  const p = curPlayer();
  S.pool.master--; p.balls.master++;
  HOOKS.onToast(`${p.name} 拿取了 1 个大师球`);
  afterGain();
}
// 退还精灵球：把 1 个球退回供应区（供应区被拿空时的周转行动，防止游戏卡死）
function actReturnBall(c) {
  const p = curPlayer();
  p.balls[c]--; S.pool[c]++;
  HOOKS.onToast(`${p.name} 退还了 1 个${BALLS[c].name}`);
  S.mode = null; S.selColors = [];
  afterActionDone();
}
function actReserve(tier, idx) {
  const p = curPlayer();
  if (p.reserved.length >= RULES.reserveLimit) return;
  const card = S.market[tier][idx];
  S.market[tier][idx] = S.decks[tier].pop() || null;
  p.reserved.push(card);
  let gotMaster = false;
  if (S.pool.master > 0) { S.pool.master--; p.balls.master++; gotMaster = true; }
  HOOKS.onToast(`${p.name} 预约了 ${card.name}${gotMaster ? '，并获得 1 个大师球' : '（大师球已领完）'}`);
  S.mode = null; S.selCard = null;
  afterActionDone();
}
// 每次行动完成后的入口：先给当前玩家一次免费进化机会（每回合最多 1 次），再推进回合
function afterActionDone() {
  const p = curPlayer();
  const opts = evolveOptions(p);
  if (opts.length) {
    if (p.isAI) {
      // AI 自动挑收益最高的进化（新分 - 旧分最大）
      const best = opts.filter((o) => o.ok)
        .sort((a, b) => (b.card.vp - b.base.vp) - (a.card.vp - a.base.vp))[0];
      if (best) doEvolve(p, best.loc, best.card, best.base);
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
  // 终局触发者再次轮到时，本轮结束
  if (S.endTriggered && next === S.endPlayer) { finishGame(); return; }
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
      if (card && card.tier > base.tier && baseNameOf(card.name) === base.evoTo) {
        opts.push({ loc: { kind: 'market', tier: t, idx }, card, base, ok: okNeed });
      }
    }));
    p.reserved.forEach((card, ridx) => {
      if (card && card.tier > base.tier && baseNameOf(card.name) === base.evoTo) {
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
  if (loc.kind === 'reserved') p.reserved.splice(loc.ridx, 1);
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
  doEvolve(p, op.loc, op.card, op.base);
  finishEvolvePhase();
}
function actSkipEvolve() {
  if (S.phase !== 'evolve') return;
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
  if (S.phase === 'normal' && p.isAI && !S.over) {
    setTimeout(() => {
      if (S === g && !S.over && S.phase === 'normal' && curPlayer() === p) aiTurn(p);
    }, AI_CONFIG.thinkMin + Math.random() * (AI_CONFIG.thinkMax - AI_CONFIG.thinkMin));
  }
}
function aiTurn(p) {
  const move = chooseAIMove(p);
  if (move === null) { HOOKS.onToast(`${p.name} 没有可执行的行动，跳过`); afterActionDone(); return; }
  if (move.type === 'buy') actBuy(move.tier, move.idx);
  else if (move.type === 'buyReserved') actBuyReserved(move.ridx);
  else if (move.type === 'reserve') actReserve(move.tier, move.idx);
  else if (move.type === 'takeMaster') actTakeMaster();
  else if (move.type === 'return') actReturnBall(move.color);
  else if (move.type === 'take2') actTakeTwo(move.color);
  else actTakeThree(move.colors);
}
function chooseAIMove(p) {
  const simple = p.aiLevel === 'easy';
  if (simple && Math.random() < AI_CONFIG.easyRandomRate) return randomMove(p);

  // 能收服就收服：优先高分的卡（含预约的卡）
  const aff = [];
  [1, 2, 3].forEach((t) => S.market[t].forEach((c, idx) => {
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
    if (engine && tier !== undefined && card.tier === 3) score -= 8; // 前期不为三阶囤球
    if (score > bestScore) { bestScore = score; best = { card, tier, idx, ridx }; }
  };
  [1, 2, 3].forEach((t) => S.market[t].forEach((c, idx) => consider(c, t, idx, undefined)));
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
  [1, 2, 3].forEach((t) => S.market[t].forEach((c, idx) => {
    if (c && canAfford(p, c)) opts.push({ type: 'buy', tier: t, idx });
  }));
  p.reserved.forEach((c, ridx) => {
    if (canAfford(p, c)) opts.push({ type: 'buyReserved', ridx });
  });
  const t = pickTarget(p);
  if (t && t.tier !== undefined && p.reserved.length < RULES.reserveLimit) {
    opts.push({ type: 'reserve', tier: t.tier, idx: t.idx });
  }
  if (RULES.takeMasterAlone !== false && S.pool.master > 0) opts.push({ type: 'takeMaster' });
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

/* ==================== 导出（Node 用 require 加载；浏览器直接共享全局作用域） ==================== */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    get S() { return S; },
    set S(v) { S = v; },
    get lastCfg() { return lastCfg; },
    set lastCfg(v) { lastCfg = v; },
    HOOKS,
    COLORS, BALLS, RULES,
    newGame, curPlayer, allMarketCards,
    actTakeThree, actTakeTwo, actDiscardOne, actBuy, actBuyReserved, actReserve, actReturnBall, actTakeMaster,
    afterActionDone, advanceTurn, scheduleAI, aiTurn,
    actEvolve, actSkipEvolve, evolveOptions, sameLoc, baseNameOf,
    canAfford, payPlan, missingFor, totalBalls, totalCost, globalNeed,
    shuffle, pick,
  };
}
