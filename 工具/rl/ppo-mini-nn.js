'use strict';
/* ==================== 阶段 E 第三步：迷你游戏 神经网络 PPO + 对手池 ====================
 * ppo-mini 的 NN 版：Actor = MLP(23→32→1)（φ(s,a) 进、logit 出），
 * Critic = MLP(16→32→1)。对照基线：线性 PPO 80.0%（表格 Q 77.4%）。
 *
 * 用法：node 工具/rl/ppo-mini-nn.js [训练局数] [评估间隔]
 */

const fs = require('fs');
const path = require('path');
const E = require('./mini-env');
const N = require('./nn');

const nTrain = +process.argv[2] || 50000;
const EVAL_EVERY = +process.argv[3] || 1000;
const EVAL_GAMES = 200;
const BASE_SEED = 20260917;

const GAMMA = 0.99, LAMBDA = 0.95, CLIP_EPS = 0.2;
const ALPHA = 3e-3, BETA = 1e-2, ENT_COEF = 0.01;
const K_EPOCHS = 3, BATCH_EPS = 32;
const SNAPSHOT_EVERY = 2000;
const MAX_TURNS = 200;
const HIDDEN = 32;

const [C1, C2] = E.COLORS;
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const PATTERNS = [];
E.CARD_TABLE.forEach((row) => {
  const key = row[3] + '-' + row[4] + '-' + row[8];
  if (!PATTERNS.includes(key)) PATTERNS.push(key);
});
const NULL_PAT = PATTERNS.length;
const N_STATE = 16, N_ACT = 7, N_PHI = N_STATE + N_ACT;

function psiOf(o) {
  const psi = new Float64Array(N_STATE);
  psi[0] = 1;
  psi[1] = o.meR / 4; psi[2] = o.meB / 4;
  psi[3] = o.oppR / 4; psi[4] = o.oppB / 4;
  psi[5] = o.myPts / 3; psi[6] = o.oppPts / 3;
  psi[7 + o.cardPat] = 1;
  return psi;
}
function phiOf(psi, a) {
  const phi = new Float64Array(N_PHI);
  phi.set(psi, 0);
  phi[N_STATE + a] = 1;
  return phi;
}
function observe(p) {
  const opp = E.S.players[1 - p.id];
  const card = E.S.market[1][0];
  return {
    meR: p.balls[C1], meB: p.balls[C2],
    oppR: opp.balls[C1], oppB: opp.balls[C2],
    myPts: p.points, oppPts: opp.points,
    cardPat: card ? PATTERNS.indexOf(card.cost[C1] + '-' + card.cost[C2] + '-' + card.bonus) : NULL_PAT,
    affordable: !!card && E.canAfford(p, card),
    poolR: E.S.pool[C1], poolB: E.S.pool[C2],
  };
}
function legalActions(o) {
  const acts = [];
  const balls = o.meR + o.meB;
  if (o.poolR > 0 && balls < 4) acts.push(0);
  if (o.poolB > 0 && balls < 4) acts.push(1);
  if (o.poolR > 0 && o.poolB > 0 && balls <= 2) acts.push(2);
  if (o.affordable) acts.push(3);
  if (o.meR > 0) acts.push(4);
  if (o.meB > 0) acts.push(5);
  acts.push(6);
  return acts;
}
function moveFor(a) {
  switch (a) {
    case 0: return { type: 'take3', colors: [C1] };
    case 1: return { type: 'take3', colors: [C2] };
    case 2: return { type: 'take3', colors: [C1, C2] };
    case 3: return { type: 'buy', tier: 1, idx: 0 };
    case 4: return { type: 'return', color: C1 };
    case 5: return { type: 'return', color: C2 };
    default: return null;
  }
}

/* ==================== Actor（NN softmax） ==================== */
function scanActor(actor, o) {
  const leg = legalActions(o);
  const psi = psiOf(o);
  const phis = leg.map((a) => phiOf(psi, a));
  const zs = phis.map((phi) => N.forward(actor, phi).out);
  let maxZ = -Infinity;
  for (const z of zs) if (z > maxZ) maxZ = z;
  let lse = 0;
  for (const z of zs) lse += Math.exp(z - maxZ);
  lse = maxZ + Math.log(lse);
  return { leg, phis, zs, lse };
}
function sampleAct(actor, o, rng) {
  const sc = scanActor(actor, o);
  const r = rng();
  let cum = 0;
  for (let j = 0; j < sc.leg.length; j++) {
    cum += Math.exp(sc.zs[j] - sc.lse);
    if (r < cum) return { a: sc.leg[j], psi: psiOf(o), phi: sc.phis[j], logp: sc.zs[j] - sc.lse, movesPhi: sc.phis };
  }
  const j = sc.leg.length - 1;
  return { a: sc.leg[j], psi: psiOf(o), phi: sc.phis[j], logp: sc.zs[j] - sc.lse, movesPhi: sc.phis };
}
function greedyAct(actor, o) {
  const sc = scanActor(actor, o);
  let best = 0;
  for (let j = 1; j < sc.leg.length; j++) if (sc.zs[j] > sc.zs[best]) best = j;
  return sc.leg[best];
}
const V = (critic, psi) => N.forward(critic, psi).out;

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
    const o = observe(p);
    const leg = legalActions(o);
    return moveFor(leg[Math.floor(Math.random() * leg.length)]);
  }
  return moveFor(greedyAct(member.actor, observe(p)));
}

/* ==================== 收集一局 ==================== */
function collectEpisode(seed, actor) {
  E.seedRNG(seed);
  const member = poolPick();
  let chosen = null;
  E.HOOKS.chooseAIMove = (p, def) => (p.id === 0 ? (chosen ? chosen.move : null) : poolMove(p, def, member));
  E.newGame({ target: 3, players: [{ name: 'A', type: 'hard' }, { name: 'B', type: 'hard' }] });
  const traj = [];
  let pending = null;
  let guard = 0, finished = false, winnerSeat = -1;
  while (!E.S.over && guard < MAX_TURNS) {
    const p = E.curPlayer();
    if (p.id === 0) {
      const o = observe(p);
      const smp = sampleAct(actor, o, Math.random);
      chosen = { move: moveFor(smp.a) };
      if (pending) {
        pending.r = 0;
        pending.psiPrime = psiOf(o);
        traj.push(pending);
      }
      pending = { psi: smp.psi, phi: smp.phi, a: smp.a, logp: smp.logp, movesPhi: smp.movesPhi, r: 0, psiPrime: null };
    }
    E.aiTurn(p);
    guard++;
    if (E.S.over) {
      const rank = E.S.players.slice().sort((a, b) =>
        (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
      winnerSeat = rank[0].id;
      finished = true;
      break;
    }
  }
  if (pending) {
    pending.r = finished ? (winnerSeat === 0 ? 1 : -1) : -1;
    pending.psiPrime = null;
    traj.push(pending);
  }
  E.HOOKS.chooseAIMove = null;
  return { traj, finished, winnerSeat, leak: E.checkConservation(), member: member.name };
}

/* ==================== GAE ==================== */
function computeGAE(traj, critic) {
  const T = traj.length;
  const adv = new Array(T).fill(0);
  const vTarget = new Array(T).fill(0);
  let gae = 0;
  for (let t = T - 1; t >= 0; t--) {
    const vNext = t + 1 < T ? V(critic, traj[t + 1].psi) : 0;
    const vCur = V(critic, traj[t].psi);
    const delta = traj[t].r + GAMMA * vNext - vCur;
    gae = delta + GAMMA * LAMBDA * gae;
    adv[t] = gae;
    vTarget[t] = gae + vCur;
  }
  return { adv, vTarget };
}

/* ==================== PPO 更新（NN 反向传播版） ==================== */
function ppoUpdate(actor, critic, batch) {
  for (let epoch = 0; epoch < K_EPOCHS; epoch++) {
    N.zeroGrads(actor); N.zeroGrads(critic);
    for (const tr of batch) {
      // 前向全部合法动作（saved 供反向传播）
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
      const gA = (ratio * A <= clipped * A) ? A * ratio : 0; // min 生效侧（裁剪侧梯度为 0）
      // 熵 H 及其梯度（∂H/∂z_b = −π_b(logπ_b + H)，注意负号）
      let H = 0;
      for (let j = 0; j < zs.length; j++) H -= probs[j] * (zs[j] - lse);
      for (let j = 0; j < zs.length; j++) {
        const lp = zs[j] - lse;
        const gz = (j === aIdx ? gA : 0) - probs[j] * gA - ENT_COEF * probs[j] * (lp + H);
        N.backward(actor, saveds[j], gz);
      }
      // Critic：最小化 (vTarget − V)²/2
      const cf = N.forward(critic, tr.psi);
      N.backward(critic, cf.saved, tr.vTarget - cf.out);
    }
    N.adamStep(actor, ALPHA);
    N.adamStep(critic, BETA);
  }
}

/* ==================== 评估 ==================== */
function evalVsHeuristic(actor, seed0, nGames) {
  let wins = 0, leaks = 0, finished = 0;
  E.HOOKS.chooseAIMove = (p, def) => (p.id === 0 ? moveFor(greedyAct(actor, observe(p))) : def(p));
  for (let i = 0; i < nGames; i++) {
    E.seedRNG(seed0 + i);
    E.newGame({ target: 3, players: [{ name: 'A', type: 'hard' }, { name: 'B', type: 'hard' }] });
    let guard = 0;
    while (!E.S.over && guard < MAX_TURNS) { E.aiTurn(E.curPlayer()); guard++; }
    if (E.S.over) {
      finished++;
      const rank = E.S.players.slice().sort((a, b) =>
        (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
      if (rank[0].id === 0) wins++;
    }
    if (E.checkConservation()) leaks++;
  }
  E.HOOKS.chooseAIMove = null;
  return { winRate: finished ? wins / finished : 0, leaks, finished };
}

/* ==================== 主循环 ==================== */
console.log(`迷你游戏 神经网络 PPO + 对手池：训练 ${nTrain} 局（MLP 23→${HIDDEN}→1 Actor / 16→${HIDDEN}→1 Critic，批 ${BATCH_EPS} × ${K_EPOCHS} epoch）`);
console.log('基准线：线性 PPO = 80.0% ｜ 表格 Q = 77.4% ｜ 启发式对称 = 50%');
const actor = N.makeMLP([N_PHI, HIDDEN, 1], Math.random);
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
    const r = evalVsHeuristic(actor, BASE_SEED + 900000, EVAL_GAMES);
    evalCurve.push({ ep: ep + 1, rate: r.winRate, leaks: r.leaks });
    console.log(`  [${String(ep + 1).padStart(6)}/${nTrain}] 贪心 vs 启发式 ${(r.winRate * 100).toFixed(1)}% ｜ 池 ${pool.length}${r.leaks ? ' ⚠️违规' + r.leaks : ''}`);
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

/* ==================== 落盘 ==================== */
const summary = {
  name: `ppo-mini-nn-${nTrain}`, seed: BASE_SEED, n: nTrain,
  gamma: GAMMA, lambda: LAMBDA, clipEps: CLIP_EPS, alpha: ALPHA, beta: BETA,
  entCoef: ENT_COEF, kEpochs: K_EPOCHS, batchEps: BATCH_EPS, hidden: HIDDEN,
  evalCurve, poolSize: pool.length, snapshots,
  actor: N.serialize(actor), critic: N.serialize(critic),
  leaks: lastLeak, stalls: lastStall, elapsed,
  createdAt: new Date().toISOString(),
};
const epsDir = path.join(__dirname, 'data', 'episodes');
fs.mkdirSync(epsDir, { recursive: true });
fs.writeFileSync(path.join(epsDir, `ppo-mini-nn-${nTrain}.summary.json`), JSON.stringify(summary));

console.log(`\n训练完成：守恒违规 ${lastLeak} ｜ 卡死 ${lastStall} ｜ 池 ${pool.length} ｜ 耗时 ${elapsed}s`);
console.log(`最终胜率：${(evalCurve[evalCurve.length - 1].rate * 100).toFixed(1)}%（线性 PPO 80.0%）`);
