'use strict';
/* ==================== 阶段 E 第三步：大游戏 神经网络 PPO + 对手池 ====================
 * ppo-big 的 NN 版：Actor = MLP(56→H→1)（φ(s,a) 进、logit 出），Critic = MLP(35→H→1)。
 * 对照基线：线性 PPO 峰值 60.5%（2 万局）/ 10 万局 51%，对称基线 33.3%。
 *
 * 速度优化：take3 只枚举 3 色组合（1/2 色仅在供应不足 3 色时动态加入——
 * 合法动作数从 ~40 降到 ~20，NN 反向传播是大头）。
 *
 * 用法：node 工具/rl/ppo-big-nn.js [训练局数] [评估间隔]
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');
const N = require('./nn');

const nTrain = +process.argv[2] || 10000;
const EVAL_EVERY = +process.argv[3] || 1000;
const EVAL_GAMES = 200;
const BASE_SEED = 20260917;

const GAMMA = 0.99, LAMBDA = 0.95, CLIP_EPS = 0.2;
const ALPHA = 3e-3, BETA = 1e-2, ENT_COEF = 0.01;
const SHAPE_W = 0.1;
const K_EPOCHS = 2, BATCH_EPS = 8;
const SNAPSHOT_EVERY = 2000;
const MAX_TURNS = 800;
const TARGET = 18;
const HIDDEN = 32;

const COLORS = H.COLORS;
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const S = new Proxy({}, { get: (_t, k) => H.S[k] });

/* ==================== 特征机器（lqlearn/ppo-big 同款，56 维） ==================== */
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
  // 速度优化：正常局面只枚举 3 色组合；供应不足 3 色时才加入 1/2 色变体（保合法性）
  if (avail.length >= 3) {
    for (let i = 0; i < avail.length; i++)
      for (let j = i + 1; j < avail.length; j++)
        for (let k = j + 1; k < avail.length; k++)
          moves.push({ type: 'take3', colors: [avail[i], avail[j], avail[k]] });
  } else {
    for (let i = 0; i < avail.length; i++)
      for (let j = i + 1; j < avail.length; j++)
        moves.push({ type: 'take3', colors: [avail[i], avail[j]] });
    avail.forEach((c) => moves.push({ type: 'take3', colors: [c] }));
  }
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
  const base = new Float64Array(N_FEAT);
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
  const f = Float64Array.from(ctx.base);
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

/* ==================== Actor（NN softmax） ==================== */
function scanActor(actor, p) {
  const ctx = buildCtx(p);
  const moves = enumerateMoves(p);
  const phis = moves.map((mv) => featuresFor(p, mv, ctx));
  const zs = phis.map((phi) => N.forward(actor, phi).out);
  let maxZ = -Infinity;
  for (const z of zs) if (z > maxZ) maxZ = z;
  let lse = 0;
  for (const z of zs) lse += Math.exp(z - maxZ);
  lse = maxZ + Math.log(lse);
  return { moves, phis, zs, lse };
}
function sampleMove(actor, p, rng) {
  const sc = scanActor(actor, p);
  if (!sc.moves.length) return { sc, pick: null, logp: 0, phi: null };
  const r = rng();
  let cum = 0;
  for (let j = 0; j < sc.moves.length; j++) {
    cum += Math.exp(sc.zs[j] - sc.lse);
    if (r < cum) return { sc, pick: sc.moves[j], logp: sc.zs[j] - sc.lse, phi: sc.phis[j] };
  }
  const j = sc.moves.length - 1;
  return { sc, pick: sc.moves[j], logp: sc.zs[j] - sc.lse, phi: sc.phis[j] };
}
function greedyMove(actor, p) {
  const sc = scanActor(actor, p);
  if (!sc.moves.length) return null;
  let best = 0;
  for (let j = 1; j < sc.moves.length; j++) if (sc.zs[j] > sc.zs[best]) best = j;
  return sc.moves[best];
}
const V = (critic, psi) => N.forward(critic, Float64Array.from(psi)).out;

/* ==================== 对手池 ==================== */
const pool = [
  { name: 'heuristic', kind: 'def' },
  { name: 'random', kind: 'rand' },
];
let snapshots = 0;
const poolPick = () => pool[Math.floor(Math.random() * pool.length)];
function poolMove(p, def, member) {
  if (member.kind === 'def') return def(p);
  if (member.kind === 'rand') {
    const moves = enumerateMoves(p);
    return moves.length ? moves[Math.floor(Math.random() * moves.length)] : null;
  }
  return greedyMove(member.actor, p);
}

/* ==================== 收集一局 ==================== */
function collectEpisode(seed, actor) {
  H.seedRNG(seed);
  const members = [poolPick(), poolPick()];
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
      const smp = sampleMove(actor, p, Math.random);
      chosen = smp.pick;
      if (pending) {
        pending.r = SHAPE_W * (p.points - pending.prevPts);
        traj.push(pending);
      }
      pending = smp.pick
        ? { phi: smp.phi, a: smp.pick, logp: smp.logp, prevPts: p.points, r: 0, movesPhi: smp.sc.phis }
        : null;
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
    traj.push(pending);
  }
  H.HOOKS.chooseAIMove = null;
  return { traj, finished, winnerSeat, leak: H.checkConservation(), members: members.map((m) => m.name).join('+') };
}

/* ==================== GAE ==================== */
function computeGAE(traj, critic) {
  const T = traj.length;
  const adv = new Array(T).fill(0);
  const vTarget = new Array(T).fill(0);
  let gae = 0;
  for (let t = T - 1; t >= 0; t--) {
    const vNext = t + 1 < T ? V(critic, psiOf(traj[t + 1].phi)) : 0;
    const vCur = V(critic, psiOf(traj[t].phi));
    const delta = traj[t].r + GAMMA * vNext - vCur;
    gae = delta + GAMMA * LAMBDA * gae;
    adv[t] = gae;
    vTarget[t] = gae + vCur;
  }
  return { adv, vTarget };
}

/* ==================== PPO 更新（NN 反向传播版，同 ppo-mini-nn） ==================== */
function ppoUpdate(actor, critic, batch) {
  for (let epoch = 0; epoch < K_EPOCHS; epoch++) {
    N.zeroGrads(actor); N.zeroGrads(critic);
    for (const tr of batch) {
      const zs = [], saveds = [];
      for (const phi of tr.movesPhi) {
        const f = N.forward(actor, phi);
        zs.push(f.out); saveds.push(f.saved);
      }
      let maxZ = -Infinity;
      for (const z of zs) if (z > maxZ) maxZ = z;
      let lse = 0;
      for (const z of zs) lse += Math.exp(z - maxZ);
      lse = maxZ + Math.log(lse);
      const probs = zs.map((z) => Math.exp(z - lse));
      const aIdx = tr.movesPhi.indexOf(tr.phi);
      const logpNew = zs[aIdx] - lse;
      const ratio = Math.exp(logpNew - tr.logp);
      const clipped = Math.max(1 - CLIP_EPS, Math.min(1 + CLIP_EPS, ratio));
      const A = tr.adv;
      const gA = (ratio * A <= clipped * A) ? A * ratio : 0;
      let H = 0;
      for (let j = 0; j < zs.length; j++) H -= probs[j] * (zs[j] - lse);
      for (let j = 0; j < zs.length; j++) {
        const lp = zs[j] - lse;
        const gz = (j === aIdx ? gA : 0) - probs[j] * gA - ENT_COEF * probs[j] * (lp + H);
        N.backward(actor, saveds[j], gz);
      }
      const psi = psiOf(tr.phi);
      const cf = N.forward(critic, Float64Array.from(psi));
      N.backward(critic, cf.saved, tr.vTarget - cf.out);
    }
    N.adamStep(actor, ALPHA);
    N.adamStep(critic, BETA);
  }
}

/* ==================== 评估 ==================== */
function evalVs(actor, seed0, nGames) {
  let wins = 0, leaks = 0, finished = 0;
  H.HOOKS.chooseAIMove = (p, def) => (p.id === 0 ? greedyMove(actor, p) : def(p));
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
console.log(`大游戏 神经网络 PPO + 对手池：训练 ${nTrain} 局（Actor MLP 56→${HIDDEN}→1 / Critic MLP 35→${HIDDEN}→1，批 ${BATCH_EPS} × ${K_EPOCHS} epoch）`);
console.log('基准线：线性 PPO 峰值 60.5% ｜ 对称基线 33.3%');
const actor = N.makeMLP([N_FEAT, HIDDEN, 1], Math.random);
const critic = N.makeMLP([N_STATE, HIDDEN, 1], Math.random);
const evalCurve = [];
const t0 = Date.now();
let batch = [], batchEps = 0;
let lastLeak = 0, lastStall = 0;

for (let ep = 0; ep < nTrain; ep++) {
  const res = collectEpisode(BASE_SEED + ep, actor);
  if (res.leak) lastLeak++;
  if (!res.finished) lastStall++;
  const { adv, vTarget } = computeGAE(res.traj, critic);
  res.traj.forEach((tr, i) => { tr.adv = adv[i]; tr.vTarget = vTarget[i]; });
  batch.push(...res.traj);
  batchEps++;
  if (batchEps >= BATCH_EPS) {
    ppoUpdate(actor, critic, batch);
    batch = []; batchEps = 0;
  }
  if ((ep + 1) % SNAPSHOT_EVERY === 0 && pool.length < 14) {
    pool.push({ name: 'snap' + (++snapshots), kind: 'net', actor: N.deserialize(N.serialize(actor)) });
  }
  if ((ep + 1) % EVAL_EVERY === 0) {
    const r = evalVs(actor, BASE_SEED + 900000, EVAL_GAMES);
    evalCurve.push({ ep: ep + 1, rate: r.winRate, leaks: r.leaks });
    console.log(`  [${String(ep + 1).padStart(6)}/${nTrain}] 贪心 vs 启发式 ${(r.winRate * 100).toFixed(1)}% ｜ 池 ${pool.length}${r.leaks ? ' ⚠️违规' + r.leaks : ''}`);
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

/* ==================== 落盘 ==================== */
const summary = {
  name: `ppo-big-nn-${nTrain}`, seed: BASE_SEED, n: nTrain,
  gamma: GAMMA, lambda: LAMBDA, clipEps: CLIP_EPS, alpha: ALPHA, beta: BETA,
  entCoef: ENT_COEF, shapeW: SHAPE_W, kEpochs: K_EPOCHS, batchEps: BATCH_EPS,
  hidden: HIDDEN, nFeat: N_FEAT, nState: N_STATE, featNames: FEAT_NAMES,
  evalCurve, poolSize: pool.length, snapshots,
  actor: N.serialize(actor), critic: N.serialize(critic),
  leaks: lastLeak, stalls: lastStall, elapsed,
  createdAt: new Date().toISOString(),
};
const epsDir = path.join(__dirname, 'data', 'episodes');
fs.mkdirSync(epsDir, { recursive: true });
fs.writeFileSync(path.join(epsDir, `ppo-big-nn-${nTrain}.summary.json`), JSON.stringify(summary));

console.log(`\n训练完成：守恒违规 ${lastLeak} ｜ 卡死 ${lastStall} ｜ 池 ${pool.length} ｜ 耗时 ${elapsed}s`);
console.log(`最终胜率：${(evalCurve[evalCurve.length - 1].rate * 100).toFixed(1)}%（线性 PPO 峰值 60.5%）`);
