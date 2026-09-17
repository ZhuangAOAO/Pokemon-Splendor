'use strict';
/* ==================== RL 实验台（阶段 A/B） ====================
 * 无头加载 config.js + game-core.js，提供：种子 RNG、对局记录、
 * 拿球老虎机、跑局/跑系列 API、对局数据落盘（JSONL + summary）。
 *
 * 用法：由 工具/rl/ 下的实验脚本 require（如 seed-demo.js、bandit-battle.js）。
 *
 * ⚠️ 结构注意（重要，勿改）：
 *   1. eval 加载后 module.exports 会被 config.js:235 和 game-core.js:609
 *      先后覆盖（两个文件各自的 Node 导出副作用）——本文件自己的导出
 *      必须写在 eval 之后，否则 require 会拿到"幽灵会话 D"的 API。
 *   2. 全程用裸名（newGame / S / aiTurn / HOOKS / COLORS / RULES …）访问
 *      window 路径（= B 会话）；绝不碰 module.exports.HOOKS（那是 D 会话的，
 *      对它设钩子会静默无效）。
 *   3. setTimeout 已打桩，但 game-core.js:407 的思考延时表达式在调用点
 *      立即求值——每回合仍会消耗 1 次随机数。这是确定性的一部分，勿"清理"。
 *   4. 每局必须 fresh seed（seedRNG），不做跨局沿用，保证局与局独立可复现。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(__dirname, 'data');
const EPS_DIR = path.join(DATA_DIR, 'episodes');

global.window = global;      // game-core 依赖 window（config.js 里也会设，幂等）
global.setTimeout = () => 0; // 打桩：AI 思考不真等（同步驱动，见 sim.js 同款）

eval(
  fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(ROOT, 'game-core.js'), 'utf8')
);

/* ==================== 种子 RNG ==================== */
// mulberry32：纯整数位运算，同 seed 跨机器逐位一致
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 替换全局 Math.random（game-core 全部 6 处随机源都走它）；每局调用一次
function seedRNG(seed) { Math.random = mulberry32(seed); }

/* ==================== 对局记录 ==================== */
// 行动序列记录器，格式同 server.js 回放：{ k, p, seat, t }
function makeRecorder() {
  const rec = [];
  HOOKS.onAction = (kind, params) => {
    rec.push({ k: kind, p: JSON.parse(JSON.stringify(params)), seat: S.current, t: S.turnIdx });
  };
  return rec;
}

/* ==================== 奖励：全场可见卡的最小有效缺口 ==================== */
// 与 globalNeed 同口径（场上 5 阶 + 自己的预约区）；不含对手的盲抽卡（POMDP 作弊线）
function minEffTot(p) {
  let m = Infinity;
  allMarketCards().concat(p.reserved).forEach((c) => {
    const e = missingFor(p, c).effTot;
    if (e < m) m = e;
  });
  return m === Infinity ? 0 : m;
}

/* ==================== 拿球老虎机（15 臂） ==================== */
// 臂：5 个 take2（每色一个）+ 10 个 take3（C(5,3) 三色组合）
function makeArms() {
  const arms = [];
  COLORS.forEach((c) => arms.push({ type: 'take2', color: c }));
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++)
      for (let k = j + 1; k < 5; k++)
        arms.push({ type: 'take3', colors: [COLORS[i], COLORS[j], COLORS[k]] });
  return arms;
}

// 行动掩码（硬性必需：actTakeTwo 无校验，非法臂会把 pool 扣成负数）
function feasibleArms(arms) {
  return arms.filter((a) => a.type === 'take2'
    ? S.pool[a.color] >= RULES.takeTwoMin
    : a.colors.every((c) => S.pool[c] > 0));
}

// opts: { eps=0.1, qInit=0 }
// ε=1 即"均匀随机"基线；qInit=3（≈单步奖励上限）即乐观初始化
function makeBandit(arms, opts = {}) {
  const eps = opts.eps != null ? opts.eps : 0.1;
  const Q = arms.map(() => (opts.qInit != null ? opts.qInit : 0));
  const N = arms.map(() => 0);
  const bandit = { pending: null };

  // 决策（在动作执行前被钩子调用）：掩码 → ε-greedy → 暂存 pending
  // 可行集为空（供应不足 3 色等）→ pending=null，回退 def 的原选择（不学习）
  bandit.decide = (defMove) => {
    const fea = feasibleArms(arms);
    if (!fea.length) { bandit.pending = null; return defMove; }
    let arm;
    if (Math.random() < eps) {
      arm = fea[Math.floor(Math.random() * fea.length)]; // ε 硬币走全局种子 RNG
    } else {
      let bi = 0;
      fea.forEach((a, i) => { if (Q[arms.indexOf(a)] > Q[arms.indexOf(fea[bi])]) bi = i; });
      arm = fea[bi];
    }
    bandit.pending = { arm };
    return arm.type === 'take2' ? { type: 'take2', color: arm.color }
                                : { type: 'take3', colors: arm.colors.slice() };
  };

  // 学习（动作执行完之后由主循环调用）：增量平均 Q += (r − Q)/N
  bandit.learn = (r) => {
    const i = arms.indexOf(bandit.pending.arm);
    N[i]++;
    Q[i] += (r - Q[i]) / N[i];
    bandit.pending = null;
  };

  bandit.table = () => arms.map((a, i) => ({ type: a.type, color: a.color, colors: a.colors && a.colors.slice(), Q: Q[i], N: N[i] }));
  return bandit;
}

// 钩子：seat 号玩家（默认 0）的 take2/take3 决策交给老虎机，其余（收服/预约/退球）走原逻辑
function installBanditHook(bandit, seat = 0) {
  HOOKS.chooseAIMove = (p, def) => {
    if (!bandit || p.id !== seat) return def(p);
    const mv = def(p);
    if (mv && (mv.type === 'take3' || mv.type === 'take2')) return bandit.decide(mv);
    return mv;
  };
}
function clearBanditHook() { HOOKS.chooseAIMove = null; }

/* ==================== 守恒校验（防非法动作污染状态） ==================== */
function checkConservation() {
  let cards = 0;
  [1, 2, 3, 4, 5].forEach((t) => {
    cards += S.decks[t].length;
    S.market[t].forEach((c) => { if (c) cards++; });
  });
  S.players.forEach((p) => { cards += p.cards.length + p.reserved.length + p.dex.length; });
  if (cards !== CARD_TABLE.length) return '卡牌守恒：' + cards + ' ≠ ' + CARD_TABLE.length;
  const n = S.players.length;
  for (const c of COLORS) {
    let balls = S.pool[c];
    S.players.forEach((p) => { balls += p.balls[c]; });
    if (balls !== RULES.poolPerPlayer[n]) return '球守恒(' + c + ')：' + balls + ' ≠ ' + RULES.poolPerPlayer[n];
  }
  let master = S.pool.master;
  S.players.forEach((p) => { master += p.balls.master; });
  if (master !== RULES.masterCount) return '大师球守恒：' + master + ' ≠ ' + RULES.masterCount;
  return null;
}

/* ==================== 跑局 / 跑系列 ==================== */
// 跑一局。bandit 非空时：每回合记录 动作前 minEffTot，aiTurn 返回后算
// 奖励 r = before − after 并 learn（此时 aiDiscard 已同步完成，p.balls 是终值）。
// 返回 { seed, finished, turns, winner, actions, initial, final, leak }
function runEpisode({ seed, players, target, bandit = null, maxTurns = 800, record = true }) {
  seedRNG(seed);
  const rec = record ? makeRecorder() : [];
  newGame({ target, players });
  const initial = JSON.parse(JSON.stringify(S));
  let guard = 0;
  while (!S.over && guard < maxTurns) {
    const p = curPlayer();
    const before = bandit ? minEffTot(p) : 0;
    aiTurn(p);
    if (bandit && bandit.pending) {
      const r = before - minEffTot(p); // 奖励 = 这一手把"最小缺口"推进了多少
      bandit.learn(r);
      if (record && rec.length) rec[rec.length - 1].r = r;
    }
    guard++;
  }
  const final = JSON.parse(JSON.stringify(S));
  const rank = S.players.slice().sort((a, b) =>
    (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
  const leak = checkConservation();
  return {
    seed, finished: !!S.over, turns: S.turnIdx,
    winner: S.over ? rank[0].name : null,
    actions: rec, initial, final, leak,
  };
}

// 跑一个系列：共享 bandit 的 Q 表；第 i 局 seedRNG(seed + i)；
// 每局落盘 JSONL（回放表格式 + seed/winner/r），并写 summary.json。
// 返回 { winRate, wins, n, episodes, dataFile, summaryFile }
function runSeries({ name, seed, n, players, target, bandit = null, maxTurns = 800 }) {
  const episodes = [];
  let wins = 0;
  const winList = [];
  const leaks = [];
  for (let i = 0; i < n; i++) {
    const ep = runEpisode({ seed: seed + i, players, target, bandit, maxTurns });
    episodes.push(ep);
    if (ep.leak) leaks.push({ i, leak: ep.leak });
    if (ep.winner === players[0].name) wins++;
    winList.push(wins / (i + 1));
    if (ep.leak) console.error(`⚠️ [${name}] 第 ${i} 局守恒违规：${ep.leak}`);
  }
  fs.mkdirSync(EPS_DIR, { recursive: true });
  const dataFile = path.join(EPS_DIR, `${name}-${seed}-${n}.jsonl`);
  fs.writeFileSync(dataFile, episodes.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const summary = {
    name, seed, n, target,
    players: players.map((p) => ({ name: p.name, type: p.type })),
    winRate: wins / n, wins, winList, leaks,
    q: bandit ? bandit.table() : null,
    createdAt: new Date().toISOString(),
  };
  const summaryFile = path.join(EPS_DIR, `${name}-${seed}-${n}.summary.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  return { winRate: wins / n, wins, n, episodes, winList, leaks, dataFile, summaryFile, q: summary.q };
}

/* ==================== 导出（必须在 eval 之后） ==================== */
module.exports = {
  mulberry32, seedRNG,
  makeRecorder, minEffTot,
  makeArms, feasibleArms, makeBandit,
  installBanditHook, clearBanditHook,
  checkConservation,
  runEpisode, runSeries,
  DATA_DIR, EPS_DIR, ROOT,
  COLORS, BALLS, RULES, CARD_TABLE, // config 数据（供实验脚本标注/自检用）
  // game-core 会话 API（window 路径 = B 会话；S 用 getter 保持实时）
  newGame, aiTurn, curPlayer, totalBalls, allMarketCards, missingFor, HOOKS,
  canAfford, globalNeed, bonusOf, totalCost,
  get S() { return S; },
};
