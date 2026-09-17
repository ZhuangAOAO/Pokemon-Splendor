'use strict';
/* ==================== 阶段 E 第二步：大游戏 PPO + 对手池 ====================
 * 把 ppo-mini 的 PPO 机器 + lqlearn 的 56 维特征机器合体，上真实游戏。
 * 座位 A = 学习者（线性 softmax Actor + 线性 Critic）；B/C 从对手池抽取。
 * 裁判 = 固定困难 AI（基线 33.3%）。目标：打赢自己的启发式 AI。
 *
 * 用法（在项目根目录运行）：
 *   node 工具/rl/ppo-big.js [训练局数] [评估间隔]
 * 例：node 工具/rl/ppo-big.js 100000 2000
 *
 * ⚠️ 结构要点：
 *   - φ(s,a) 56 维（lqlearn 同款：状态 0/9~42 + 动作 43~55 + 类型独热 1~8）
 *   - ψ(s) 35 维（φ 的状态段：0 与 9~42，Q37 的结论）
 *   - 每条转移存 movesPhi（当时所有合法动作的 φ）供 K 个 epoch 重算 logp——
 *     on-policy 数据反复用的标准做法（批内约几 MB，可接受）
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const nTrain = +process.argv[2] || 100000;
const EVAL_EVERY = +process.argv[3] || 2000;
const EVAL_GAMES = 200;
const REPORT_ONLY = process.argv.includes('--report-only');
const BASE_SEED = 20260917;

// PPO 超参（第 10 课标准值；α 比迷你版小一档——56 维特征摊薄）
const GAMMA = 0.99, LAMBDA = 0.95, CLIP_EPS = 0.2;
const ALPHA = 3e-3, BETA = 1e-2, ENT_COEF = 0.01; // β>α：老师先站稳（Q38）
const SHAPE_W = 0.1; // 势函数塑形权重（阶段 D 实测教训：w=1 会淹没胜负信号）
const K_EPOCHS = 4, BATCH_EPS = 16;
const SNAPSHOT_EVERY = 2000;
const MAX_TURNS = 800;
const TARGET = 18;
const POOL_MAX = 14;

const COLORS = H.COLORS;
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const S = new Proxy({}, { get: (_t, k) => H.S[k] });

/* ==================== 特征机器（lqlearn 同款，56 维） ==================== */
const KIND_OF = { buy: 1, buyReserved: 2, reserve: 3, reserveBlind: 4, takeMaster: 5, take3: 6, take2: 7, return: 8 };
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
// ψ(s) 35 维 = 状态段：索引 0 与 9~42（Q37）
const STATE_IDX = [0, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42];
const N_STATE = STATE_IDX.length;
const psiOf = (phi) => STATE_IDX.map((i) => phi[i]);

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
  const opp = opps[0];
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
    base[23 + i] = p.balls[c] / 4;
    base[28 + i] = opp.balls[c] / 4;
    base[33 + i] = S.pool[c] / 5;
    base[38 + i] = bonus[c] / 5;
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
    f[47] = (m.type !== 'reserve' && p.points + card.vp >= S.target && !S.endTriggered) ? 1 : 0;
  }
  if (m.type === 'reserve' || m.type === 'reserveBlind') {
    f[48] = S.pool.master > 0 ? 1 : 0;
    if (m.type === 'reserveBlind') f[45] = m.tier / 5;
  }
  if (m.type === 'take3' || m.type === 'take2') {
    const colors = m.type === 'take2' ? [m.color, m.color] : m.colors;
    const count = {};
    colors.forEach((c) => { count[c] = (count[c] || 0) + 1; });
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
    f[55] = -0.5;
  }
  return f;
}

/* ==================== Actor（线性 softmax，56 维 φ） ==================== */
function dot(w, x) { let s = 0; for (let i = 0; i < x.length; i++) s += w[i] * x[i]; return s; }
const V = (w, psi) => dot(w, psi);
// 一次扫描：枚举 + 特征 + logits（选动作与存 movesPhi 共用）
function scan(theta, p) {
  const ctx = buildCtx(p);
  const moves = enumerateMoves(p);
  const scored = [];
  let maxZ = -Infinity;
  for (const mv of moves) {
    const phi = featuresFor(p, mv, ctx);
    const z = dot(theta, phi);
    scored.push({ move: mv, phi, z });
    if (z > maxZ) maxZ = z;
  }
  let lse = 0;
  for (const x of scored) lse += Math.exp(x.z - maxZ);
  lse = maxZ + Math.log(lse);
  return { scored, lse };
}
function sampleMove(theta, p, rng) {
  const sc = scan(theta, p);
  if (!sc.scored.length) return { sc, pick: null, logp: 0 };
  const r = rng();
  let cum = 0;
  for (const x of sc.scored) {
    cum += Math.exp(x.z - sc.lse);
    if (r < cum) return { sc, pick: x, logp: x.z - sc.lse };
  }
  const last = sc.scored[sc.scored.length - 1];
  return { sc, pick: last, logp: last.z - sc.lse };
}
function greedyMove(theta, p) {
  const sc = scan(theta, p);
  if (!sc.scored.length) return null;
  let best = sc.scored[0];
  for (const x of sc.scored) if (x.z > best.z) best = x;
  return best.move;
}

/* ==================== 对手池（第 11 课） ==================== */
const pool = [
  { name: 'heuristic', kind: 'def' },
  { name: 'random', kind: 'rand' },
];
const poolHistory = [];
let snapshots = 0;
const poolPick = () => pool[Math.floor(Math.random() * pool.length)];
function poolMove(p, def, member) {
  if (member.kind === 'def') return def(p);
  if (member.kind === 'rand') {
    const moves = enumerateMoves(p);
    return moves.length ? moves[Math.floor(Math.random() * moves.length)] : null;
  }
  return greedyMove(member.theta, p); // net 快照：温度 0
}

/* ==================== 收集一局 ==================== */
function collectEpisode(seed, theta) {
  H.seedRNG(seed);
  const members = [poolPick(), poolPick()]; // B 和 C 各抽一个
  let chosen = null;
  H.HOOKS.chooseAIMove = (p, def) => {
    if (p.id === 0) return chosen;
    return poolMove(p, def, members[p.id - 1]);
  };
  H.newGame({ target: TARGET, players: [{ name: 'A', type: 'hard' }, { name: 'B', type: 'hard' }, { name: 'C', type: 'hard' }] });
  const traj = [];
  let pending = null;
  let guard = 0, finished = false, winnerSeat = -1;
  while (!S.over && guard < MAX_TURNS) {
    const p = H.curPlayer();
    if (p.id === 0) {
      const { sc, pick, logp } = sampleMove(theta, p, Math.random);
      chosen = pick ? pick.move : null;
      if (pending) {
        pending.r = SHAPE_W * (p.points - pending.prevPts);
        traj.push(pending);
      }
      // movesPhi = 做动作那一刻的合法动作集（供 K 个 epoch 重算 logp 的分母）
      pending = pick ? { phi: pick.phi, a: pick.move, logp, prevPts: p.points, r: 0, movesPhi: sc.scored.map((x) => x.phi) } : null;
    }
    H.aiTurn(p);
    guard++;
    if (S.over) {
      const rank = S.players.slice().sort((a, b) =>
        (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
      winnerSeat = rank[0].id;
      finished = true;
      break;
    }
  }
  if (pending) {
    pending.r = SHAPE_W * (S.players[0].points - pending.prevPts) + (finished ? (winnerSeat === 0 ? 1 : -1) : -1);
    traj.push(pending); // movesPhi 在决策时已存，终局照常可用于重算 logp
  }
  H.HOOKS.chooseAIMove = null;
  return { traj, finished, winnerSeat, leak: H.checkConservation(), members: members.map((m) => m.name).join('+') };
}

/* ==================== GAE（第 10 课 §4） ==================== */
function computeGAE(traj, w) {
  const T = traj.length;
  const adv = new Array(T).fill(0);
  const vTarget = new Array(T).fill(0);
  let gae = 0;
  for (let t = T - 1; t >= 0; t--) {
    const vNext = t + 1 < T ? V(w, psiOf(traj[t + 1].phi)) : 0;
    const vCur = V(w, psiOf(traj[t].phi));
    const delta = traj[t].r + GAMMA * vNext - vCur;
    gae = delta + GAMMA * LAMBDA * gae;
    adv[t] = gae;
    vTarget[t] = gae + vCur;
  }
  return { adv, vTarget };
}

/* ==================== PPO 更新（clip + 熵） ==================== */
function ppoUpdate(theta, w, batch) {
  for (let epoch = 0; epoch < K_EPOCHS; epoch++) {
    for (const tr of batch) {
      const A = tr.adv;
      // 用存的 movesPhi 重算当前 θ 下的 logits/lse（每转移每 epoch 一次，O(动作×维)）
      const zs = tr.movesPhi.map((phi) => dot(theta, phi));
      let maxZ = -Infinity;
      for (const z of zs) if (z > maxZ) maxZ = z;
      let lse = 0;
      for (const z of zs) lse += Math.exp(z - maxZ);
      lse = maxZ + Math.log(lse);
      const probs = zs.map((z) => Math.exp(z - lse));
      const ePhi = new Array(N_FEAT).fill(0);
      for (let j = 0; j < tr.movesPhi.length; j++)
        for (let i = 0; i < N_FEAT; i++) ePhi[i] += probs[j] * tr.movesPhi[j][i];
      const logpNew = dot(theta, tr.phi) - lse;
      const ratio = Math.exp(logpNew - tr.logp);
      const clipped = Math.max(1 - CLIP_EPS, Math.min(1 + CLIP_EPS, ratio));
      const grad = new Array(N_FEAT).fill(0);
      if (ratio * A <= clipped * A) { // min 里未裁剪侧生效
        const coef = A * ratio;
        for (let i = 0; i < N_FEAT; i++) grad[i] += coef * (tr.phi[i] - ePhi[i]);
      }
      // 熵梯度：−Σ π·logπ·(φ − E[φ])
      for (let j = 0; j < tr.movesPhi.length; j++) {
        const lp = zs[j] - lse;
        for (let i = 0; i < N_FEAT; i++) grad[i] -= ENT_COEF * probs[j] * lp * (tr.movesPhi[j][i] - ePhi[i]);
      }
      for (let i = 0; i < N_FEAT; i++) theta[i] += ALPHA * grad[i];
      const psi = psiOf(tr.phi);
      for (let i = 0; i < N_STATE; i++) w[i] += BETA * (tr.vTarget - V(w, psi)) * psi[i];
    }
  }
}

/* ==================== 评估：贪心 vs 两个启发式（裁判） ==================== */
function evalVs(theta, seed0, nGames) {
  let wins = 0, leaks = 0, finished = 0;
  H.HOOKS.chooseAIMove = (p, def) => (p.id === 0 ? greedyMove(theta, p) : def(p));
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

/* ==================== 主循环 ==================== */
if (REPORT_ONLY) {
  const s2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'episodes', `ppo-big-${nTrain}.summary.json`), 'utf8'));
  fs.writeFileSync(path.join(__dirname, 'data', 'ppo-big-report.html'), buildReport(s2));
  console.log('报告已重建');
  process.exit(0);
}
console.log(`大游戏 PPO + 对手池：训练 ${nTrain} 局（批 ${BATCH_EPS} 局 × ${K_EPOCHS} epoch，ε=${CLIP_EPS} λ=${LAMBDA}），座位 A=学习者，B/C 从池抽，每 ${EVAL_EVERY} 局对裁判评估 ${EVAL_GAMES} 局（基线 33.3%）`);
const theta = new Array(N_FEAT).fill(0);
const w = new Array(N_STATE).fill(0);
const evalCurve = [], poolCurve = [];
const t0 = Date.now();
let batch = [], batchEps = 0;
let lastLeak = 0, lastStall = 0;

for (let ep = 0; ep < nTrain; ep++) {
  const res = collectEpisode(BASE_SEED + ep, theta);
  if (res.leak) lastLeak++;
  if (!res.finished) lastStall++;
  const { adv, vTarget } = computeGAE(res.traj, w);
  res.traj.forEach((tr, i) => { tr.adv = adv[i]; tr.vTarget = vTarget[i]; });
  batch.push(...res.traj);
  batchEps++;
  if (batchEps >= BATCH_EPS) {
    ppoUpdate(theta, w, batch);
    batch = []; batchEps = 0;
  }
  if ((ep + 1) % SNAPSHOT_EVERY === 0 && pool.length < POOL_MAX) {
    pool.push({ name: 'snap' + (++snapshots), kind: 'net', theta: theta.slice() });
  }
  if ((ep + 1) % EVAL_EVERY === 0) {
    const r = evalVs(theta, BASE_SEED + 900000, EVAL_GAMES);
    evalCurve.push({ ep: ep + 1, rate: r.winRate, leaks: r.leaks });
    poolCurve.push({ ep: ep + 1, size: pool.length });
    console.log(`  [${String(ep + 1).padStart(6)}/${nTrain}] 贪心 vs 启发式 ${(r.winRate * 100).toFixed(1)}% ｜ 池 ${pool.length}${r.leaks ? ' ⚠️违规' + r.leaks : ''}`);
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

/* ==================== 样本局 ==================== */
function sampleGame(theta) {
  H.seedRNG(BASE_SEED + 777);
  const rec = H.makeRecorder();
  H.HOOKS.chooseAIMove = (p, def) => (p.id === 0 ? greedyMove(theta, p) : def(p));
  H.newGame({ target: TARGET, players: [{ name: 'A(PPO)', type: 'hard' }, { name: 'B(启发式)', type: 'hard' }, { name: 'C(启发式)', type: 'hard' }] });
  let guard = 0;
  while (!S.over && guard < MAX_TURNS) { H.aiTurn(H.curPlayer()); guard++; }
  H.HOOKS.chooseAIMove = null;
  const rank = S.players.slice().sort((a, b) =>
    (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
  return { actions: rec, winner: rank[0].name, final: S.players.map((p) => `${p.name}:${p.points}分`).join(' ') };
}
const sample = sampleGame(theta);

/* ==================== 落盘 + 报告 ==================== */
const summary = {
  name: `ppo-big-${nTrain}`, seed: BASE_SEED, n: nTrain,
  gamma: GAMMA, lambda: LAMBDA, clipEps: CLIP_EPS, alpha: ALPHA, beta: BETA,
  entCoef: ENT_COEF, shapeW: SHAPE_W, kEpochs: K_EPOCHS, batchEps: BATCH_EPS,
  nFeat: N_FEAT, nState: N_STATE, featNames: FEAT_NAMES,
  evalCurve, poolCurve, poolSize: pool.length, snapshots,
  actorTheta: theta, criticW: w,
  leaks: lastLeak, stalls: lastStall, sampleGame: sample, elapsed,
  createdAt: new Date().toISOString(),
};
const epsDir = path.join(__dirname, 'data', 'episodes');
fs.mkdirSync(epsDir, { recursive: true });
const summaryFile = path.join(epsDir, `ppo-big-${nTrain}.summary.json`);
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

const reportPath = path.join(__dirname, 'data', 'ppo-big-report.html');
fs.writeFileSync(reportPath, buildReport(summary));
console.log(`\n训练完成：守恒违规 ${lastLeak} ｜ 卡死 ${lastStall} ｜ 池 ${pool.length} ｜ 耗时 ${elapsed}s`);
console.log(`📊 报告已生成：${reportPath}`);
try {
  const { spawn } = require('child_process');
  spawn('cmd', ['/c', 'start', '', reportPath], { detached: true, stdio: 'ignore' }).unref();
} catch (e) { /* 打不开不阻塞 */ }

/* ==================== 报告构建 ==================== */
function buildReport(s) {
  const W = 760, H = 260, P = { l: 46, r: 20, t: 14, b: 30 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const xOf = (ep) => P.l + iw * (ep / s.n);
  const yOfW = (v) => P.t + ih * (1 - v);
  const wPts = s.evalCurve.map((r) => `${xOf(r.ep).toFixed(1)},${yOfW(r.rate).toFixed(1)}`).join(' ');
  const baseY = yOfW(1 / 3);
  const poolPts = s.poolCurve.map((r) => `${xOf(r.ep).toFixed(1)},${(P.t + ih - r.size / 14 * ih).toFixed(1)}`).join(' ');
  const curveSvg = `
  <svg viewBox="0 0 ${W} ${H}" class="curve">
    <line x1="${P.l}" y1="${baseY}" x2="${W - P.r}" y2="${baseY}" stroke="#999" stroke-dasharray="4 3"/>
    <text x="${W - P.r - 4}" y="${baseY - 4}" text-anchor="end" font-size="10" fill="#999">对称基线 33.3%</text>
    <polyline points="${wPts}" fill="none" stroke="#16a085" stroke-width="2"/>
    <polyline points="${poolPts}" fill="none" stroke="#e67e22" stroke-width="1.5" opacity="0.7"/>
    <line x1="${P.l}" y1="${P.t}" x2="${P.l}" y2="${P.t + ih}" stroke="#333"/>
    <line x1="${P.l}" y1="${P.t + ih}" x2="${W - P.r}" y2="${P.t + ih}" stroke="#333"/>
    <text x="${P.l - 6}" y="${P.t + 10}" text-anchor="end" font-size="10">100%</text>
    <line x1="${W - P.r}" y1="${P.t}" x2="${W - P.r}" y2="${P.t + ih}" stroke="#e67e22" stroke-dasharray="3 2"/>
    <text x="${W - P.r + 4}" y="${P.t + 6}" font-size="10" fill="#e67e22">池14</text>
    <text x="${W - P.r + 4}" y="${P.t + ih + 4}" font-size="10" fill="#e67e22">池0</text>
    <text x="${W - P.r + 4}" y="${P.t + ih / 2 + 4}" font-size="9" fill="#e67e22">池大小</text>
    <text x="${P.l}" y="${H - 6}" font-size="10">训练局数 →
      <tspan fill="#16a085">绿=贪心 vs 启发式胜率</tspan>
      <tspan fill="#e67e22">橙=对手池大小（右轴）</tspan></text>
  </svg>`;

  const maxAbs = Math.max(...s.actorTheta.map((v) => Math.abs(v)), 1e-9);
  const thetaBars = s.actorTheta.map((v, i) => {
    const w2 = Math.abs(v) / maxAbs * 100;
    return `<div class="row">
      <div class="rlabel">${esc(s.featNames[i])}</div>
      <div class="ttrack"><div class="tbar ${v >= 0 ? 'pos' : 'neg'}" style="width:${w2}%"></div></div>
      <div class="rnum">${v.toFixed(3)}</div>
    </div>`;
  }).join('');

  const cn = { red: '普通球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '快速球', master: '大师球' };
  const trace = s.sampleGame.actions.slice(0, 40).map((a) => {
    const desc = a.k === 'take3' ? '拿 ' + a.p.colors.map((c) => cn[c]).join('、')
      : a.k === 'take2' ? '拿 2×' + cn[a.p.color]
      : a.k === 'buy' ? '收服' + a.p.tier + '阶#' + a.p.idx
      : a.k === 'buyReserved' ? '收服预约#' + a.p.ridx
      : a.k === 'reserve' ? '预约' + a.p.tier + '阶#' + a.p.idx
      : a.k === 'reserveBlind' ? '盲抽' + a.p.tier + '阶'
      : a.k === 'return' ? '退 ' + cn[a.p.color]
      : a.k === 'takeMaster' ? '拿大师球' : a.k;
    return `<div class="row"><div class="rlabel">第${a.t}手 座${a.seat}</div><div class="rtrack" style="background:none">${esc(desc)}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>PPO + 对手池报告（大游戏）</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; color: #333; background: #fafafa; }
  h1 { font-size: 22px; border-bottom: 3px solid #e3350d; padding-bottom: 8px; }
  h2 { font-size: 17px; margin-top: 28px; }
  .meta { color: #777; font-size: 13px; }
  .curve { width: 100%; height: auto; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; }
  section { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 18px; margin-top: 12px; }
  .row { display: flex; align-items: center; margin: 3px 0; font-size: 13px; }
  .rlabel { width: 170px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rtrack { flex: 1; height: 14px; background: #eee; border-radius: 3px; }
  .tbar { height: 100%; border-radius: 3px; }
  .tbar.pos { background: #16a085; float: left; }
  .tbar.neg { background: #c0392b; float: right; }
  .rnum { width: 90px; text-align: right; color: #555; }
</style></head>
<body>
<h1>🚀 PPO + 对手池报告（大游戏 · 阶段 E 第二步）</h1>
<p class="meta">训练 ${s.n} 局（ε=${s.clipEps} λ=${s.lambda} α=${s.alpha} β=${s.beta} K=${s.kEpochs} 塑形${s.shapeW}）｜ 池最终 ${s.poolSize} 成员（含 ${s.snapshots} 快照）｜ 守恒违规 ${s.leaks} ｜ 卡死 ${s.stalls} ｜ 耗时 ${s.elapsed}s</p>

<section><h2>① 学习曲线：贪心 PPO vs 两个启发式（裁判，基线 33.3%）</h2>
${curveSvg}
</section>

<section><h2>② Actor 学到的 θ（56 维，绿=正价值 红=负价值）</h2>
${thetaBars}
</section>

<section><h2>③ 一局样本（前 40 手，胜者：${esc(s.sampleGame.winner)}，${esc(s.sampleGame.final)}）</h2>
${trace}
</section>
</body></html>`;
}
