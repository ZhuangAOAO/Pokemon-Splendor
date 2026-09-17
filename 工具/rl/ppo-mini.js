'use strict';
/* ==================== 阶段 E 第一步：迷你游戏 PPO + 对手池 ====================
 * 第 10 课（PPO）+ 第 11 课（对手池）的第一次合体，在迷你游戏这个干净的
 * 基准场上跑通——对照阶段 C 表格 Q 的 77.4%（裁判 = 启发式 AI）。
 *
 * 用法（在项目根目录运行）：
 *   node 工具/rl/ppo-mini.js [训练局数] [评估间隔]
 * 例：node 工具/rl/ppo-mini.js 100000 2000
 *
 * 结构：
 *   Actor：线性 softmax，φ(s,a) = [ψ(s) 16 维, 动作独热 7 维] = 23 维
 *   Critic：线性 V_w，ψ(s) 16 维
 *   对手池：初始 {启发式, 均匀随机}，每 SNAPSHOT_EVERY 局把 θ 快照入池
 *   （第 11 课：不能一上来就自对弈——池子里先有外人）
 *   评估裁判：固定启发式 AI（自对弈胜率恒 50%，不能当指标——第 11 课 §4）
 */

const fs = require('fs');
const path = require('path');
const E = require('./mini-env');

const nTrain = +process.argv[2] || 100000;
const EVAL_EVERY = +process.argv[3] || 2000;
const REPORT_ONLY = process.argv.includes('--report-only');
const EVAL_GAMES = 200;
const BASE_SEED = 20260917;

// PPO 超参（第 10 课标准值）
const GAMMA = 0.99, LAMBDA = 0.95, CLIP_EPS = 0.2;
const ALPHA = 1e-2, BETA = 3e-2, ENT_COEF = 0.01; // β>α：老师先站稳（Q38）
const K_EPOCHS = 4, BATCH_EPS = 32;
const SNAPSHOT_EVERY = 2000;
const MAX_TURNS = 200;

const [C1, C2] = E.COLORS;
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const PATTERNS = [];
E.CARD_TABLE.forEach((row) => {
  const key = row[3] + '-' + row[4] + '-' + row[8];
  if (!PATTERNS.includes(key)) PATTERNS.push(key);
});
const NULL_PAT = PATTERNS.length;

/* ==================== 状态 ψ(s) 与动作 ==================== */
const N_STATE = 16; // [1, meR/4, meB/4, oppR/4, oppB/4, myPts/3, oppPts/3, 模式独热 9]
const N_ACT = 7;    // 0拿红 1拿蓝 2拿红蓝 3买 4退红 5退蓝 6跳过（同 qlearn）
const N_PHI = N_STATE + N_ACT;

function psiOf(o) {
  const psi = new Array(N_STATE).fill(0);
  psi[0] = 1;
  psi[1] = o.meR / 4; psi[2] = o.meB / 4;
  psi[3] = o.oppR / 4; psi[4] = o.oppB / 4;
  psi[5] = o.myPts / 3; psi[6] = o.oppPts / 3;
  psi[7 + o.cardPat] = 1;
  return psi;
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
    default: return null; // 跳过
  }
}

/* ==================== Actor（线性 softmax） ==================== */
function dot(w, x) { let s = 0; for (let i = 0; i < x.length; i++) s += w[i] * x[i]; return s; }
function phiOf(psi, a) {
  const phi = psi.slice();
  phi.push(...new Array(N_ACT).fill(0));
  phi[N_STATE + a] = 1;
  return phi;
}
function softmaxInfo(theta, o) {
  const leg = legalActions(o);
  const logits = {};
  let maxZ = -Infinity;
  for (const a of leg) {
    const z = dot(theta, phiOf(psiOf(o), a));
    logits[a] = z;
    if (z > maxZ) maxZ = z;
  }
  let lse = 0;
  for (const a of leg) lse += Math.exp(logits[a] - maxZ);
  lse = maxZ + Math.log(lse);
  return { logits, lse, leg };
}
const logpiOf = (info, a) => info.logits[a] - info.lse;
function sampleAct(theta, o, rng) {
  const info = softmaxInfo(theta, o);
  const p = rng();
  let cum = 0;
  for (const a of info.leg) {
    cum += Math.exp(info.logits[a] - info.lse);
    if (p < cum) return { a, info };
  }
  return { a: info.leg[info.leg.length - 1], info };
}
const V = (w, psi) => dot(w, psi);

/* ==================== 对手池（第 11 课） ==================== */
const pool = [
  { name: 'heuristic', kind: 'def' },
  { name: 'random', kind: 'rand' },
];
const poolHistory = [];
let snapshots = 0;
const poolPick = () => pool[Math.floor(Math.random() * pool.length)];
// 池成员出招（非学习者座位）
function poolMove(p, def, member) {
  if (member.kind === 'def') return def(p);
  if (member.kind === 'rand') {
    const o = observe(p);
    const leg = legalActions(o);
    return moveFor(leg[Math.floor(Math.random() * leg.length)]);
  }
  const o = observe(p); // net 快照：贪心（温度 0）
  const info = softmaxInfo(member.theta, o);
  let best = info.leg[0], bz = -Infinity;
  for (const a of info.leg) if (info.logits[a] > bz) { bz = info.logits[a]; best = a; }
  return moveFor(best);
}

/* ==================== 收集一局（学习者轨迹） ==================== */
function collectEpisode(seed, theta) {
  E.seedRNG(seed);
  const member = poolPick();
  let chosen = null;
  E.HOOKS.chooseAIMove = (p, def) => (p.id === 0 ? (chosen ? chosen.move : null) : poolMove(p, def, member));
  E.newGame({ target: 3, players: [{ name: 'A', type: 'hard' }, { name: 'B', type: 'hard' }] });
  const traj = [];
  let pending = null; // { obs, psi, phi, a, logp }
  let guard = 0, finished = false, winnerSeat = -1;
  while (!E.S.over && guard < MAX_TURNS) {
    const p = E.curPlayer();
    if (p.id === 0) {
      const o = observe(p);
      const { a, info } = sampleAct(theta, o, Math.random);
      chosen = { move: moveFor(a) };
      if (pending) {
        pending.r = 0;
        pending.obsPrime = o;
        traj.push(pending);
      }
      pending = {
        obs: o, psi: psiOf(o), phi: phiOf(psiOf(o), a), a,
        logp: logpiOf(info, a), r: 0, obsPrime: null,
      };
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
    pending.r = finished ? (winnerSeat === 0 ? 1 : -1) : -1; // 卡死=平局惩罚（阶段 C 教训）
    pending.obsPrime = null; // 终态
    traj.push(pending);
  }
  E.HOOKS.chooseAIMove = null;
  return { traj, finished, winnerSeat, leak: E.checkConservation(), member: member.name };
}

/* ==================== GAE（第 10 课 §4） ==================== */
function computeGAE(traj, w) {
  const T = traj.length;
  const adv = new Array(T).fill(0);
  const vTarget = new Array(T).fill(0);
  let gae = 0;
  for (let t = T - 1; t >= 0; t--) {
    const vNext = t + 1 < T ? V(w, traj[t + 1].psi) : 0;
    const vCur = V(w, traj[t].psi);
    const delta = traj[t].r + GAMMA * vNext - vCur;
    gae = delta + GAMMA * LAMBDA * gae;
    adv[t] = gae;
    vTarget[t] = gae + vCur; // Â ≈ G − V ⇒ V 目标 ≈ Â + V
  }
  return { adv, vTarget };
}

/* ==================== PPO 更新（clip + 熵，第 10 课 §3/§5） ==================== */
function ppoUpdate(theta, w, batch) {
  for (let epoch = 0; epoch < K_EPOCHS; epoch++) {
    for (const tr of batch) {
      const info = softmaxInfo(theta, tr.obs);
      const logpNew = logpiOf(info, tr.a);
      const ratio = Math.exp(logpNew - tr.logp);
      const clipped = Math.max(1 - CLIP_EPS, Math.min(1 + CLIP_EPS, ratio));
      const A = tr.adv;
      const useUnclipped = ratio * A <= clipped * A; // min 里哪一侧生效
      const grad = new Array(N_PHI).fill(0);
      if (useUnclipped) {
        const coef = A * ratio; // ∇(r·Â) = Â·∇r = Â·r·∇logπ
        const ePhi = new Array(N_PHI).fill(0);
        for (const aa of info.leg) {
          const p = Math.exp(info.logits[aa] - info.lse);
          for (let i = 0; i < N_STATE; i++) ePhi[i] += p * tr.psi[i];
          ePhi[N_STATE + aa] += p;
        }
        for (let i = 0; i < N_PHI; i++) grad[i] += coef * (tr.phi[i] - ePhi[i]);
      }
      // 熵梯度：∇H = −Σ π(a)·logπ(a)·(φ(a) − E[φ])（Σπ(φ−Eφ)=0 消掉了 +1 项）
      for (const aa of info.leg) {
        const p = Math.exp(info.logits[aa] - info.lse);
        const lp = info.logits[aa] - info.lse;
        const phiA = tr.psi.slice().concat(new Array(N_ACT).fill(0));
        phiA[N_STATE + aa] = 1;
        for (let i = 0; i < N_PHI; i++) {
          let ePhiI = 0;
          for (const bb of info.leg) {
            const pb = Math.exp(info.logits[bb] - info.lse);
            ePhiI += pb * (i >= N_STATE ? (i - N_STATE === bb ? 1 : 0) : tr.psi[i]);
          }
          grad[i] -= ENT_COEF * p * lp * (phiA[i] - ePhiI);
        }
      }
      for (let i = 0; i < N_PHI; i++) theta[i] += ALPHA * grad[i];
      for (let i = 0; i < N_STATE; i++) w[i] += BETA * (tr.vTarget - V(w, tr.psi)) * tr.psi[i];
    }
  }
}

/* ==================== 评估：贪心学习者 vs 启发式（裁判） ==================== */
function evalVsHeuristic(theta, seed0, nGames) {
  let wins = 0, leaks = 0, finished = 0;
  E.HOOKS.chooseAIMove = (p, def) => {
    if (p.id !== 0) return def(p);
    const o = observe(p);
    const info = softmaxInfo(theta, o);
    let best = info.leg[0], bz = -Infinity;
    for (const a of info.leg) if (info.logits[a] > bz) { bz = info.logits[a]; best = a; }
    return moveFor(best);
  };
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
if (REPORT_ONLY) { // 只重建报告：node 工具/rl/ppo-mini.js --report-only
  const epsDir = path.join(__dirname, 'data', 'episodes');
  const s2 = JSON.parse(fs.readFileSync(path.join(epsDir, `ppo-mini-${nTrain}.summary.json`), 'utf8'));
  fs.writeFileSync(path.join(__dirname, 'data', 'ppo-mini-report.html'), buildReport(s2));
  console.log('报告已重建：' + path.join(__dirname, 'data', 'ppo-mini-report.html'));
  process.exit(0);
}
console.log(`迷你游戏 PPO + 对手池：训练 ${nTrain} 局（批 32 × ${K_EPOCHS} epoch，ε=${CLIP_EPS} λ=${LAMBDA}），每 ${EVAL_EVERY} 局对裁判（启发式）评估 ${EVAL_GAMES} 局`);
console.log('基准线：表格 Q（阶段 C）= 77.4% ｜ 启发式对称 = 50%');
const theta = new Array(N_PHI).fill(0);
const w = new Array(N_STATE).fill(0);
const evalCurve = [], poolCurve = [];
const t0 = Date.now();
let batch = [];
let lastLeak = 0, lastStall = 0;

for (let ep = 0; ep < nTrain; ep++) {
  const res = collectEpisode(BASE_SEED + ep, theta);
  if (res.leak) lastLeak++;
  if (!res.finished) lastStall++;
  // GAE 必须按"整局"从后往前递推（第 10 课 §4 的 Â_t = δ_t + γλδ_{t+1} + …）
  const { adv, vTarget } = computeGAE(res.traj, w);
  res.traj.forEach((tr, i) => { tr.adv = adv[i]; tr.vTarget = vTarget[i]; });
  batch.push(...res.traj);
  if (batch.length >= BATCH_EPS * 6) { // 攒够一批（每局 ~6 步学习者回合）
    ppoUpdate(theta, w, batch);
    batch = [];
  }
  if ((ep + 1) % SNAPSHOT_EVERY === 0 && snapshots < 12) { // 池上限 12 + 2 外人
    pool.push({ name: 'snap' + (++snapshots), kind: 'net', theta: theta.slice() });
    poolHistory.push({ ep: ep + 1, size: pool.length });
  }
  if ((ep + 1) % EVAL_EVERY === 0) {
    const r = evalVsHeuristic(theta, BASE_SEED + 900000, EVAL_GAMES);
    evalCurve.push({ ep: ep + 1, rate: r.winRate, leaks: r.leaks });
    poolCurve.push({ ep: ep + 1, size: pool.length });
    console.log(`  [${String(ep + 1).padStart(6)}/${nTrain}] 贪心 vs 启发式 ${(r.winRate * 100).toFixed(1)}% ｜ 池大小 ${pool.length}${r.leaks ? ' ⚠️违规' + r.leaks : ''}`);
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

/* ==================== 样本局 ==================== */
function sampleGame(theta) {
  E.seedRNG(BASE_SEED + 777);
  const rec = E.makeRecorder();
  E.HOOKS.chooseAIMove = (p, def) => {
    if (p.id !== 0) return def(p);
    const o = observe(p);
    const info = softmaxInfo(theta, o);
    let best = info.leg[0], bz = -Infinity;
    for (const a of info.leg) if (info.logits[a] > bz) { bz = info.logits[a]; best = a; }
    return moveFor(best);
  };
  E.newGame({ target: 3, players: [{ name: 'A(PPO)', type: 'hard' }, { name: 'B(启发式)', type: 'hard' }] });
  let guard = 0;
  while (!E.S.over && guard < MAX_TURNS) { E.aiTurn(E.curPlayer()); guard++; }
  E.HOOKS.chooseAIMove = null;
  const rank = E.S.players.slice().sort((a, b) =>
    (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
  return { actions: rec, winner: rank[0].name, final: E.S.players.map((p) => `${p.name}:${p.points}分`).join(' ') };
}
const sample = sampleGame(theta);

/* ==================== 落盘 + 报告 ==================== */
const summary = {
  name: `ppo-mini-${nTrain}`, seed: BASE_SEED, n: nTrain,
  gamma: GAMMA, lambda: LAMBDA, clipEps: CLIP_EPS, alpha: ALPHA, beta: BETA,
  entCoef: ENT_COEF, kEpochs: K_EPOCHS, batchEps: BATCH_EPS,
  nState: N_STATE, nAct: N_ACT, nPhi: N_PHI,
  evalCurve, poolCurve, poolSize: pool.length, snapshots,
  actorTheta: theta, criticW: w,
  leaks: lastLeak, stalls: lastStall, sampleGame: sample, elapsed,
  createdAt: new Date().toISOString(),
};
const epsDir = path.join(__dirname, 'data', 'episodes');
fs.mkdirSync(epsDir, { recursive: true });
const summaryFile = path.join(epsDir, `ppo-mini-${nTrain}.summary.json`);
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

const reportPath = path.join(__dirname, 'data', 'ppo-mini-report.html');
fs.writeFileSync(reportPath, buildReport(summary));
console.log(`\n训练完成：守恒违规 ${lastLeak} ｜ 卡死 ${lastStall} ｜ 池大小 ${pool.length} ｜ 耗时 ${elapsed}s`);
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
  const yOfW = (v) => P.t + ih * (1 - v);
  const wPts = s.evalCurve.map((r) => `${xOf(r.ep).toFixed(1)},${yOfW(r.rate).toFixed(1)}`).join(' ');
  const base77 = yOfW(0.774), base50 = yOfW(0.5);
  const poolPts = s.poolCurve.map((r) => `${xOf(r.ep).toFixed(1)},${(P.t + ih - r.size / 14 * ih).toFixed(1)}`).join(' ');
  const curveSvg = `
  <svg viewBox="0 0 ${W} ${H}" class="curve">
    <line x1="${P.l}" y1="${base77}" x2="${W - P.r}" y2="${base77}" stroke="#8e44c7" stroke-dasharray="4 3"/>
    <text x="${W - P.r - 4}" y="${base77 - 4}" text-anchor="end" font-size="10" fill="#8e44c7">表格 Q 基准 77.4%</text>
    <line x1="${P.l}" y1="${base50}" x2="${W - P.r}" y2="${base50}" stroke="#999" stroke-dasharray="4 3"/>
    <text x="${W - P.r - 4}" y="${base50 - 4}" text-anchor="end" font-size="10" fill="#999">启发式对称 50%</text>
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

  const cn = { red: '红', blue: '蓝' };
  const trace = s.sampleGame.actions.map((a) => {
    const desc = a.k === 'take3' ? '拿 ' + a.p.colors.map((c) => cn[c]).join('+')
      : a.k === 'buy' ? '买卡(+1分)' : a.k === 'return' ? '退 ' + cn[a.p.color] : a.k;
    return `<div class="row"><div class="rlabel">第${a.t}手 座位${a.seat}</div><div class="rtrack" style="background:none">${esc(desc)}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>PPO + 对手池报告（迷你游戏）</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; color: #333; background: #fafafa; }
  h1 { font-size: 22px; border-bottom: 3px solid #e3350d; padding-bottom: 8px; }
  h2 { font-size: 17px; margin-top: 28px; }
  .meta { color: #777; font-size: 13px; }
  .curve { width: 100%; height: auto; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; }
  section { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 18px; margin-top: 12px; }
  .row { display: flex; align-items: center; margin: 3px 0; font-size: 13px; }
  .rlabel { width: 130px; }
</style></head>
<body>
<h1>🚀 PPO + 对手池报告（迷你游戏 · 阶段 E）</h1>
<p class="meta">训练 ${s.n} 局（ε=${s.clipEps} λ=${s.lambda} α=${s.alpha} β=${s.beta} K=${s.kEpochs}）｜ 池最终 ${s.poolSize} 成员（含 ${s.snapshots} 个快照）｜ 守恒违规 ${s.leaks} ｜ 卡死 ${s.stalls} ｜ 耗时 ${s.elapsed}s</p>

<section><h2>① 学习曲线：贪心 PPO vs 启发式（裁判）</h2>
${curveSvg}
</section>

<section><h2>② 一局样本（胜者：${esc(s.sampleGame.winner)}，${esc(s.sampleGame.final)}）</h2>
${trace}
</section>
</body></html>`;
}
