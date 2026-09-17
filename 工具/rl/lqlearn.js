'use strict';
/* ==================== 阶段 D：真实游戏上的线性函数逼近 Q_θ ====================
 * 第 07 课的"级别 2"直接上大游戏：几十个参数替代 Q 表，学完整动作空间的策略。
 * 座位 A = ε-greedy 线性 Q_θ；B/C = 手写困难 AI（修复后版本）。
 *
 * 用法（在项目根目录运行）：
 *   node 工具/rl/lqlearn.js [训练局数] [评估间隔] [--sarsa]
 * 例：node 工具/rl/lqlearn.js 100000 1000
 *
 * ⚠️ 致命三要素（第 07 课 §6）：线性逼近 + 自举 + 异策略可能发散。
 *    --sarsa 开关去掉"异策略"；α 取小；残差暴涨即发散信号。
 *
 * 性能要点：每回合 buildCtx 只做一次（全场卡 missingFor / globalNeed / 共享特征），
 * 每个候选动作只做轻量算术；maxQ 与选动作共用同一次扫描。
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const nTrain = +process.argv[2] || 100000;
const EVAL_EVERY = +process.argv[3] || 1000;
const EVAL_GAMES = 200;
const SARSA = process.argv.includes('--sarsa');
const USE_TARGET = process.argv.includes('--target'); // 目标网络（第 07 课 §6.3 第二个补丁）：
//   冻结一份 θ⁻ 供 TD 目标用，每隔 SYNC_EVERY 局同步一次——治"目标追移动靶"导致的震荡
const SYNC_EVERY = 500;
const BASE_SEED = 20260916;
const ALPHA = 0.1, GAMMA = 0.99, EPS = 0.1; // α=0.1 与迷你游戏同档（α=0.01 实测：θ 微小到贪心≈随机，8% 胜率）
const SHAPE_W = 0.1; // ⭐ 势函数塑形权重（实测教训）：r = w·Δ分 + 终局±1。
//    若 w=1，Φ=分（量级~18）会淹没胜负信号（±1），且 V=「还能拿多少分」
//    导致"分越高状态越不值钱"的反直觉值函数；任何正倍数仍是合法势函数
//    （Ng et al. 1999 不改变最优策略），缩小 10 倍让胜负信号浮出水面。
const MAX_TURNS = 800;
const TARGET = 18;

const COLORS = H.COLORS;
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// H.S 是 getter（每次取当前对局状态）；用 Proxy 让裸名 S.xxx 始终读最新值
const S = new Proxy({}, { get: (_t, k) => H.S[k] });

/* ==================== 合法动作枚举 ==================== */
function enumerateMoves(p) {
  const moves = [];
  [1, 2, 3, 4, 5].forEach((t) => S.market[t].forEach((c, idx) => {
    if (c && H.canAfford(p, c)) moves.push({ type: 'buy', tier: t, idx, card: c });
  }));
  p.reserved.forEach((c, ridx) => {
    if (H.canAfford(p, c)) moves.push({ type: 'buyReserved', ridx, card: c });
  });
  if (p.reserved.length < H.RULES.reserveLimit) {
    [1, 2, 3].forEach((t) => S.market[t].forEach((c, idx) => {
      if (c) moves.push({ type: 'reserve', tier: t, idx, card: c });
    }));
    [1, 2, 3].forEach((t) => { if (S.decks[t].length > 0) moves.push({ type: 'reserveBlind', tier: t }); });
  }
  if (H.RULES.takeMasterAlone !== false && S.pool.master > 0) moves.push({ type: 'takeMaster' });
  const avail = COLORS.filter((c) => S.pool[c] > 0);
  for (let i = 0; i < avail.length; i++)
    for (let j = i + 1; j < avail.length; j++)
      for (let k = j + 1; k < avail.length; k++)
        moves.push({ type: 'take3', colors: [avail[i], avail[j], avail[k]] });
  for (let i = 0; i < avail.length; i++)
    for (let j = i + 1; j < avail.length; j++)
      moves.push({ type: 'take3', colors: [avail[i], avail[j]] });
  avail.forEach((c) => moves.push({ type: 'take3', colors: [c] }));
  COLORS.forEach((c) => { if (S.pool[c] >= H.RULES.takeTwoMin) moves.push({ type: 'take2', color: c }); });
  COLORS.forEach((c) => { if (p.balls[c] > 0) moves.push({ type: 'return', color: c }); });
  if (p.balls.master > 0) moves.push({ type: 'return', color: 'master' });
  return moves;
}

/* ==================== 特征 φ(s,a)（26 维，归一化烘进特征计算——Q30 教训） ==================== */
const KIND_OF = { buy: 1, buyReserved: 2, reserve: 3, reserveBlind: 4, takeMaster: 5, take3: 6, take2: 7, return: 8 };
// ⚠️ 特征共线教训（实测两例）：
//   ① "离目标分 = 1 − 我的分"与常数、我的分完全线性相关——已删；
//   ② 总量特征与分色特征线性相关（Σ分色/4 = 总量/4，总量/10 是它的倍数）——
//      所以有分色就删总量：我的总球数、对手总球数、我的总加成均已删除。
//    保留特征两两线性无关；每色球/池/加成各 5 维，市场结构/预约区/回合数补全状态。
const FEAT_NAMES = [
  '常数',
  '类型=buy', '类型=buyReserved', '类型=reserve', '类型=reserveBlind',
  '类型=takeMaster', '类型=take3', '类型=take2', '类型=return',
  '我的分', '对手领先', '终局轮',
  '我的大师球', '对手大师球', '对手加成',
  '我的预约数', '我的预约总分', '对手预约数',
  '市场非空卡数', '市场最高分', '市场总分', '我可负担卡数', '回合数',
  '我的球·普通', '我的球·超级', '我的球·高级', '我的球·治愈', '我的球·快速',
  '对手球·普通', '对手球·超级', '对手球·高级', '对手球·治愈', '对手球·快速',
  '供应区·普通', '供应区·超级', '供应区·高级', '供应区·治愈', '供应区·快速',
  '我的加成·普通', '我的加成·超级', '我的加成·高级', '我的加成·治愈', '我的加成·快速',
  '卡分', '−缺口(effTot)', '卡阶', '卡成本', '买它触发终局', '预约得大师球',
  '一步前瞻(拿球)', '命中缺口色', '池余量', '超手牌风险',
  '已有大师球', '退球富余', '退球惩罚',
];
const N_FEAT = FEAT_NAMES.length;
// 状态特征区段（0..42 共享，43 起动作相关）
const F_MYBALLS = 23;   // 23..27 我的每色球
const F_OPPBALLS = 28;  // 28..32 对手每色球
const F_POOL = 33;      // 33..37 供应区每色
const F_MYBONUS = 38;   // 38..42 我的每色加成

/* ==================== 每回合上下文（一次算清，全体动作共享） ==================== */
function buildCtx(p) {
  const cards = [];
  H.allMarketCards().concat(p.reserved).forEach((c) => {
    const m = H.missingFor(p, c);
    cards.push({ card: c, effTot: m.effTot, net: m.net });
  });
  let minEff = Infinity;
  cards.forEach((x) => { if (x.effTot < minEff) minEff = x.effTot; });
  const need = H.globalNeed(p);
  const opps = S.players.filter((x) => x !== p);
  const oppMax = Math.max(...opps.map((x) => x.points));
  const opp = opps[0]; // 3 人局：两个对手，取其"最强项"聚合见下
  const bonus = H.bonusOf(p);
  const base = new Array(N_FEAT).fill(0);
  base[0] = 1;
  base[9] = p.points / TARGET;
  base[10] = (oppMax - p.points) / TARGET;
  base[11] = S.endTriggered ? 1 : 0;
  base[12] = p.balls.master / 3;
  base[13] = opp.balls.master / 3;
  base[14] = COLORS.reduce((s, c) => s + (H.bonusOf(opp)[c] || 0), 0) / 12;
  base[15] = p.reserved.length / 3;
  base[16] = p.reserved.reduce((s, c) => s + c.vp, 0) / 12;
  base[17] = opp.reserved.length / 3;
  const market = H.allMarketCards();
  base[18] = market.length / 14;
  base[19] = (market.length ? Math.max(...market.map((c) => c.vp)) : 0) / 5;
  base[20] = market.reduce((s, c) => s + c.vp, 0) / 40;
  base[21] = market.filter((c) => H.canAfford(p, c)).length / 6;
  base[22] = Math.min(1, S.turnIdx / 40);
  COLORS.forEach((c, i) => {
    base[F_MYBALLS + i] = p.balls[c] / 4;
    base[F_OPPBALLS + i] = opp.balls[c] / 4;
    base[F_POOL + i] = S.pool[c] / 5;
    base[F_MYBONUS + i] = bonus[c] / 5;
  });
  return { cards, minEff: minEff === Infinity ? 0 : minEff, need, base };
}

function featuresFor(p, m, ctx) {
  const f = ctx.base.slice();
  f[KIND_OF[m.type]] = 1;
  const card = m.card;
  if (m.type === 'buy' || m.type === 'buyReserved' || m.type === 'reserve') {
    f[43] = card.vp / 3;
    f[44] = -(ctx.cards.find((x) => x.card === card) || { effTot: 0 }).effTot / 6;
    f[45] = card.tier / 5;
    f[46] = H.totalCost(card) / 8;
    f[47] = (m.type !== 'reserve' && p.points + card.vp >= S.target && !S.endTriggered) ? 1 : 0; // 买它触发终局
  }
  if (m.type === 'reserve' || m.type === 'reserveBlind') {
    f[48] = S.pool.master > 0 ? 1 : 0; // 预约附赠大师球
    if (m.type === 'reserveBlind') f[45] = m.tier / 5; // 盲抽看不到卡：只有阶数信息
  }
  if (m.type === 'take3' || m.type === 'take2') {
    const colors = m.type === 'take2' ? [m.color, m.color] : m.colors;
    const count = {};
    colors.forEach((c) => { count[c] = (count[c] || 0) + 1; });
    // 一步前瞻：模拟拿球后全场最小缺口的减少量（逐卡增量法，避免重扫 missingFor）
    let afterMin = Infinity;
    ctx.cards.forEach((x) => {
      let red = 0;
      for (const c in count) red += Math.min(x.net[c] || 0, count[c]);
      const after = Math.max(0, x.effTot - red);
      if (after < afterMin) afterMin = after;
    });
    f[49] = (ctx.minEff - (afterMin === Infinity ? 0 : afterMin)) / 3;
    let hit = 0;
    colors.forEach((c) => { if (ctx.need[c] - p.balls[c] > 0) hit++; });
    f[50] = hit / 3;
    f[51] = colors.reduce((s, c) => s + Math.min(4, S.pool[c]), 0) / colors.length / 4;
    f[52] = H.totalBalls(p) + colors.length > H.RULES.handLimit ? -1 : 0;
  }
  if (m.type === 'takeMaster') f[53] = p.balls.master / 3;
  if (m.type === 'return') {
    f[54] = m.color === 'master' ? p.balls.master / 5 : (p.balls[m.color] - ctx.need[m.color]) / 5;
    f[55] = -0.5; // 退球 = 浪费半回合
  }
  return f;
}

/* ==================== 扫描 + 评分（一次扫描同时供选动作与 maxQ 用） ==================== */
function score(theta, phi) {
  let s = 0;
  for (let i = 0; i < N_FEAT; i++) s += theta[i] * phi[i];
  return s;
}
function scanMoves(theta, p) {
  const ctx = buildCtx(p);
  const moves = enumerateMoves(p);
  const scored = [];
  let maxQ = -Infinity;
  for (const mv of moves) {
    const phi = featuresFor(p, mv, ctx);
    const q = score(theta, phi);
    scored.push({ move: mv, phi, q });
    if (q > maxQ) maxQ = q;
  }
  return { scored, maxQ: scored.length ? maxQ : 0 };
}
// ε-greedy 挑动作；返回 { pick, maxQ }
function pickFromScan(theta, p, eps) {
  const sc = scanMoves(theta, p);
  if (!sc.scored.length) return { pick: null, maxQ: 0 };
  let pick;
  if (Math.random() < eps) pick = sc.scored[Math.floor(Math.random() * sc.scored.length)];
  else {
    pick = sc.scored[0];
    for (const x of sc.scored) if (x.q > pick.q) pick = x;
  }
  return { pick, maxQ: sc.maxQ };
}

function updateTheta(theta, phi, target, stats) {
  const d = ALPHA * (target - score(theta, phi));
  for (let i = 0; i < N_FEAT; i++) theta[i] += d * phi[i];
  stats.sumD += Math.abs(d); stats.cntD++;
}

/* ==================== 训练一局 ==================== */
function trainEpisode(seed, theta, thetaT, stats) {
  H.seedRNG(seed);
  H.newGame({ target: TARGET, players: [{ name: 'A', type: 'hard' }, { name: 'B', type: 'hard' }, { name: 'C', type: 'hard' }] });
  let pending = null; // { phi, prevPts } —— A 上一手的特征与当时分数
  let chosen = null;  // 主循环为 A 选好的动作，钩子原样返回
  H.HOOKS.chooseAIMove = (p, def) => (p.id === 0 ? chosen : def(p));
  let guard = 0;
  while (!S.over && guard < MAX_TURNS) {
    const p = H.curPlayer();
    if (p.id === 0) {
      const { pick, maxQ } = pickFromScan(theta, p, EPS);
      chosen = pick ? pick.move : null; // 钩子返回 chosen（null = 跳过）
      if (pending) { // 结算 A 的上一手：s' = 当前局面
        const r = SHAPE_W * (p.points - pending.prevPts); // 势函数塑形 r = w·Δ分
        let nextQ;
        if (SARSA) {
          // 同策略：用本回合实际选的动作；目标网络模式下其价值从 θ⁻ 读
          nextQ = pick ? (USE_TARGET ? score(thetaT, pick.phi) : pick.q) : 0;
        } else {
          // 异策略：s' 的 max_a Q；目标网络模式下从 θ⁻ 读
          nextQ = USE_TARGET ? scanMoves(thetaT, p).maxQ : maxQ;
        }
        updateTheta(theta, pending.phi, r + GAMMA * nextQ, stats);
        pending = null;
      }
      pending = pick ? { phi: pick.phi, prevPts: p.points } : null;
    }
    H.aiTurn(p);
    guard++;
    if (S.over) {
      if (pending) {
        const rank = S.players.slice().sort((a, b) =>
          (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
        const win = rank[0].id === 0;
        updateTheta(theta, pending.phi, SHAPE_W * (S.players[0].points - pending.prevPts) + (win ? 1 : -1), stats);
        pending = null;
      }
      break;
    }
  }
  if (!S.over && pending) { // 卡死：−1（阶段 C 教训：不推进 = 失败）
    updateTheta(theta, pending.phi, SHAPE_W * (S.players[0].points - pending.prevPts) - 1, stats);
  }
  H.HOOKS.chooseAIMove = null;
  return { leak: H.checkConservation(), finished: !!S.over };
}

/* ==================== 评估：贪心 θ（座位 A）对 B/C 困难 AI ==================== */
function evalVs(theta, seed0, nGames) {
  let wins = 0, leaks = 0, finished = 0;
  H.HOOKS.chooseAIMove = (p, def) => {
    if (p.id !== 0) return def(p);
    const { pick } = pickFromScan(theta, p, 0);
    return pick ? pick.move : null;
  };
  for (let i = 0; i < nGames; i++) {
    H.seedRNG(seed0 + i);
    H.newGame({ target: TARGET, players: [{ name: 'A', type: 'hard' }, { name: 'B', type: 'hard' }, { name: 'C', type: 'hard' }] });
    let guard = 0;
    while (!S.over && guard < MAX_TURNS) { H.aiTurn(H.curPlayer()); guard++; }
    if (S.over) {
      finished++;
      const rank = S.players.slice().sort((a, b) =>
        (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
      if (rank[0].id === 0) wins++;
    }
    if (H.checkConservation()) leaks++;
  }
  H.HOOKS.chooseAIMove = null;
  return { winRate: finished ? wins / finished : 0, leaks, finished };
}

/* ==================== 主流程 ==================== */
const modeName = (SARSA ? 'SARSA' : 'Q-Learning') + (USE_TARGET ? '+目标网络' : '');
console.log(`线性函数逼近（大游戏）${modeName}：训练 ${nTrain} 局，座位 A=ε-greedy θ(${N_FEAT} 维)，B/C=困难 AI，每 ${EVAL_EVERY} 局评估 ${EVAL_GAMES} 局（对称基线 33.3%）`);
const theta = new Array(N_FEAT).fill(0);
let thetaT = theta.slice(); // 目标网络 θ⁻（每 SYNC_EVERY 局同步）
const stats = { sumD: 0, cntD: 0 };
const residual = [], evalCurve = [];
const t0 = Date.now();
let lastLeak = 0, lastStall = 0;

for (let ep = 0; ep < nTrain; ep++) {
  stats.sumD = 0; stats.cntD = 0;
  const res = trainEpisode(BASE_SEED + ep, theta, thetaT, stats);
  if (res.leak) lastLeak++;
  if (!res.finished) lastStall++;
  if (USE_TARGET && (ep + 1) % SYNC_EVERY === 0) thetaT = theta.slice();
  if (ep % Math.max(1, Math.round(nTrain / 500)) === 0) residual.push({ ep, d: stats.cntD ? stats.sumD / stats.cntD : 0 });
  if ((ep + 1) % EVAL_EVERY === 0) {
    const r = evalVs(theta, BASE_SEED + 900000, EVAL_GAMES);
    evalCurve.push({ ep: ep + 1, rate: r.winRate, leaks: r.leaks });
    console.log(`  [${String(ep + 1).padStart(6)}/${nTrain}] 贪心θ vs 困难AI ${(r.winRate * 100).toFixed(1)}% ｜ 平均残差 ${residual[residual.length - 1].d.toFixed(4)}${r.leaks ? ' ⚠️违规' + r.leaks : ''}`);
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

/* ==================== 样本局 ==================== */
function sampleGame(theta) {
  H.seedRNG(BASE_SEED + 777);
  const rec = H.makeRecorder();
  H.HOOKS.chooseAIMove = (p, def) => {
    if (p.id !== 0) return def(p);
    const { pick } = pickFromScan(theta, p, 0);
    return pick ? pick.move : null;
  };
  H.newGame({ target: TARGET, players: [{ name: 'A(线性Q)', type: 'hard' }, { name: 'B(启发式)', type: 'hard' }, { name: 'C(启发式)', type: 'hard' }] });
  let guard = 0;
  while (!S.over && guard < MAX_TURNS) { H.aiTurn(H.curPlayer()); guard++; }
  H.HOOKS.chooseAIMove = null;
  const rank = S.players.slice().sort((a, b) =>
    (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
  return { actions: rec, winner: rank[0].name, final: S.players.map((p) => `${p.name}:${p.points}分`).join(' ') };
}
const sample = sampleGame(theta);

/* ==================== 落盘 ==================== */
const summary = {
  name: `lqlearn-${modeName.toLowerCase()}-${nTrain}`, seed: BASE_SEED, n: nTrain,
  mode: modeName, alpha: ALPHA, gamma: GAMMA, eps: EPS, nFeat: N_FEAT,
  featNames: FEAT_NAMES, theta, residual, evalCurve, leaks: lastLeak, stalls: lastStall,
  sampleGame: sample, elapsed, createdAt: new Date().toISOString(),
};
const epsDir = path.join(__dirname, 'data', 'episodes');
fs.mkdirSync(epsDir, { recursive: true });
const summaryFile = path.join(epsDir, `lqlearn-${nTrain}.summary.json`);
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

/* ==================== 报告 ==================== */
const reportPath = path.join(__dirname, 'data', 'lqlearn-report.html');
fs.writeFileSync(reportPath, buildReport(summary));
console.log(`\n训练完成：守恒违规 ${lastLeak} 局 ｜ 卡死 ${lastStall} 局 ｜ 耗时 ${elapsed}s`);
console.log(`📊 报告已生成：${reportPath}`);
try {
  const { spawn } = require('child_process');
  spawn('cmd', ['/c', 'start', '', reportPath], { detached: true, stdio: 'ignore' }).unref();
} catch (e) { /* 打不开不阻塞 */ }

/* ==================== 报告构建 ==================== */
function buildReport(s) {
  const W = 760, H = 260, P = { l: 46, r: 14, t: 14, b: 30 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const xOf = (ep) => P.l + iw * (ep / s.n);
  let dMin = Infinity, dMax = -Infinity;
  s.residual.forEach((r) => { const v = Math.log10(Math.max(1e-9, r.d)); if (v < dMin) dMin = v; if (v > dMax) dMax = v; });
  const yOfD = (v) => P.t + ih * (1 - (Math.log10(Math.max(1e-9, v)) - dMin) / Math.max(1e-9, dMax - dMin));
  const dPts = s.residual.map((r) => `${xOf(r.ep).toFixed(1)},${yOfD(r.d).toFixed(1)}`).join(' ');
  const yOfW = (v) => P.t + ih * (1 - v);
  const wPts = s.evalCurve.map((r) => `${xOf(r.ep).toFixed(1)},${yOfW(r.rate).toFixed(1)}`).join(' ');
  const baseY = yOfW(1 / 3);
  const curveSvg = `
  <svg viewBox="0 0 ${W} ${H}" class="curve">
    <line x1="${P.l}" y1="${baseY}" x2="${W - P.r}" y2="${baseY}" stroke="#999" stroke-dasharray="4 3"/>
    <text x="${W - P.r - 4}" y="${baseY - 4}" text-anchor="end" font-size="10" fill="#999">对称基线 33.3%</text>
    <polyline points="${dPts}" fill="none" stroke="#c0392b" stroke-width="1.5" opacity="0.8"/>
    <polyline points="${wPts}" fill="none" stroke="#16a085" stroke-width="2"/>
    <line x1="${P.l}" y1="${P.t}" x2="${P.l}" y2="${P.t + ih}" stroke="#333"/>
    <line x1="${P.l}" y1="${P.t + ih}" x2="${W - P.r}" y2="${P.t + ih}" stroke="#333"/>
    <text x="${P.l - 6}" y="${P.t + 10}" text-anchor="end" font-size="10">100%</text>
    <text x="${P.l}" y="${H - 6}" font-size="10">训练局数 →
      <tspan fill="#c0392b">红=平均残差 |δ|（对数轴）</tspan>
      <tspan fill="#16a085">绿=贪心θ vs 困难AI 胜率</tspan></text>
  </svg>`;

  const maxAbs = Math.max(...s.theta.map((v) => Math.abs(v)), 1e-9);
  const thetaBars = s.theta.map((v, i) => {
    const w = Math.abs(v) / maxAbs * 100;
    const side = v >= 0 ? 'pos' : 'neg';
    return `<div class="row">
      <div class="rlabel">${esc(s.featNames[i])}</div>
      <div class="ttrack"><div class="tbar ${side}" style="width:${w}%"></div></div>
      <div class="rnum">${v.toFixed(3)}</div>
    </div>`;
  }).join('');

  const cn = { red: '普通球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '快速球', master: '大师球' };
  const trace = s.sampleGame.actions.map((a) => {
    const desc = a.k === 'take3' ? '拿 ' + a.p.colors.map((c) => cn[c]).join('、')
      : a.k === 'take2' ? '拿 2×' + cn[a.p.color]
      : a.k === 'buy' ? '收服' + a.p.tier + '阶#' + a.p.idx
      : a.k === 'buyReserved' ? '收服预约#' + a.p.ridx
      : a.k === 'reserve' ? '预约' + a.p.tier + '阶#' + a.p.idx
      : a.k === 'reserveBlind' ? '盲抽预约' + a.p.tier + '阶'
      : a.k === 'return' ? '退 ' + cn[a.p.color]
      : a.k === 'takeMaster' ? '拿大师球' : a.k;
    return `<div class="row"><div class="rlabel">第${a.t}手 座${a.seat}</div><div class="rtrack" style="background:none">${esc(desc)}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>线性函数逼近 Q_θ 报告（大游戏）</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; color: #333; background: #fafafa; }
  h1 { font-size: 22px; border-bottom: 3px solid #e3350d; padding-bottom: 8px; }
  h2 { font-size: 17px; margin-top: 28px; }
  .meta { color: #777; font-size: 13px; }
  .curve { width: 100%; height: auto; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; }
  section { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 18px; margin-top: 12px; }
  .row { display: flex; align-items: center; margin: 3px 0; font-size: 13px; }
  .rlabel { width: 170px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ttrack { flex: 1; height: 14px; background: #eee; border-radius: 3px; }
  .tbar { height: 100%; border-radius: 3px; }
  .tbar.pos { background: #16a085; float: left; }
  .tbar.neg { background: #c0392b; float: right; }
  .rnum { width: 90px; text-align: right; color: #555; }
</style></head>
<body>
<h1>🧮 线性函数逼近 Q_θ 报告（${esc(s.mode)} · 大游戏）</h1>
<p class="meta">训练 ${s.n} 局（ε=${s.eps} α=${s.alpha} γ=${s.gamma}）｜ θ 共 ${s.nFeat} 维 ｜ 守恒违规 ${s.leaks} ｜ 卡死 ${s.stalls} ｜ 耗时 ${s.elapsed}s</p>

<section><h2>① 学习曲线（座位 A 的胜率 vs 两个困难 AI）</h2>
${curveSvg}
</section>

<section><h2>② 学到的 θ 权重——每个特征"值多少钱"（绿=正价值，红=负价值）</h2>
<p class="meta">线性 Q 的独特福利：θ 可读。检查符号是否符合直觉——卡分应为正、"−缺口"应为正（缺口越小越好买）、退球惩罚应为负……</p>
${thetaBars}
</section>

<section><h2>③ 一局样本（贪心 θ vs 两个启发式，胜者：${esc(s.sampleGame.winner)}，${esc(s.sampleGame.final)}）</h2>
${trace}
</section>
</body></html>`;
}
