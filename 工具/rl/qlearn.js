'use strict';
/* ==================== 阶段 C：迷你版游戏 + 表格 Q-Learning（自对弈） ====================
 * 给"拿球"决策加上状态——在能枚举的迷你游戏上跑第 06 课的表格 Q-Learning，
 * 亲眼看 Q 表收敛。自对弈：双座共享同一张 Q；终局奖励赢 +1 / 输 −1。
 *
 * 用法（在项目根目录运行）：
 *   node 工具/rl/qlearn.js [训练局数] [评估间隔]
 * 例：node 工具/rl/qlearn.js 100000
 *
 * 产出：
 *   控制台摘要（胜率、残差、Q 表规模、最值钱的局面）
 *   工具/rl/data/qlearn-report.html（学习曲线 / Q 表切片热图 / 一局对局打印）
 *   工具/rl/data/episodes/qlearn-*.summary.json（参数 + 残差曲线 + 评估曲线 + 最终 Q 表）
 */

const fs = require('fs');
const path = require('path');
const E = require('./mini-env');

const nTrain = +process.argv[2] || 100000;
const EVAL_EVERY = +process.argv[3] || 1000;
const EVAL_GAMES = 200;
const BASE_SEED = 20260916;
const ALPHA = 0.1, GAMMA = 0.99, EPS = 0.1;
const Q_INIT = 0.5; // ⭐ 乐观初始化（第 04 课）：未试过的动作先假设"还行"，
                    //    逼代理把每个动作都试一遍——否则 Q 全 0 开局 + 平局
                    //    永远选列表第一个动作，ε-greedy 会锁死（Q15 的锁死故事）
const MAX_TURNS = 200;

const [C1, C2] = E.COLORS;
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const PATTERNS = [];
E.CARD_TABLE.forEach((row) => {
  const key = row[3] + '-' + row[4] + '-' + row[8]; // 红费-蓝费-加成色
  if (!PATTERNS.includes(key)) PATTERNS.push(key);
});
const NULL_PAT = PATTERNS.length; // 牌堆抽干、市场为空

/* ==================== 状态编码（混合进制 → 整数） ==================== */
function encodeState(o) {
  let i = o.meR;
  i = i * 5 + o.meB;
  i = i * 5 + o.oppR;
  i = i * 5 + o.oppB;
  i = i * 4 + Math.min(3, o.myPts);
  i = i * 4 + Math.min(3, o.oppPts);
  i = i * (PATTERNS.length + 1) + o.cardPat;
  return i;
}
function decodeState(i) {
  const cardPat = i % (PATTERNS.length + 1); i = Math.floor(i / (PATTERNS.length + 1));
  const oppPts = i % 4; i = Math.floor(i / 4);
  const myPts = i % 4; i = Math.floor(i / 4);
  const oppB = i % 5; i = Math.floor(i / 5);
  const oppR = i % 5; i = Math.floor(i / 5);
  const meB = i % 5; i = Math.floor(i / 5);
  const meR = i % 5;
  return { meR, meB, oppR, oppB, myPts, oppPts, cardPat };
}

/* ==================== 观测与合法动作 ==================== */
// 观测（动作执行前调用）：自己的球/分、对手的球/分、市场卡模式、池、可负担性
function observe(p) {
  const opp = E.S.players[1 - p.id];
  const card = E.S.market[1][0];
  const o = {
    meR: p.balls[C1], meB: p.balls[C2],
    oppR: opp.balls[C1], oppB: opp.balls[C2],
    myPts: p.points, oppPts: opp.points,
    cardPat: card ? PATTERNS.indexOf(card.cost[C1] + '-' + card.cost[C2] + '-' + card.bonus) : NULL_PAT,
    affordable: !!card && E.canAfford(p, card),
    poolR: E.S.pool[C1], poolB: E.S.pool[C2],
  };
  o.idx = encodeState(o);
  return o;
}

// 动作编号：0 拿红 / 1 拿蓝 / 2 拿红+蓝 / 3 买 / 4 退红 / 5 退蓝 / 6 跳过
const N_ACT = 7;
function legalActions(o) {
  const acts = [];
  const balls = o.meR + o.meB;
  if (o.poolR > 0 && balls < 4) acts.push(0);
  if (o.poolB > 0 && balls < 4) acts.push(1);
  if (o.poolR > 0 && o.poolB > 0 && balls <= 2) acts.push(2);
  if (o.affordable) acts.push(3);
  if (o.meR > 0) acts.push(4);
  if (o.meB > 0) acts.push(5);
  acts.push(6); // 跳过永远合法（防死锁兜底；Q 会学到它很糟）
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
    default: return null; // 跳过：aiTurn 对 null 走 skip 分支
  }
}

/* ==================== Q 表与更新 ==================== */
const qKey = (sIdx, a) => sIdx * N_ACT + a;
function qGet(q, sIdx, a) { const v = q.get(qKey(sIdx, a)); return v === undefined ? Q_INIT : v; }
function qUpdate(q, sIdx, a, target, stats) {
  const key = qKey(sIdx, a);
  const old = qGet(q, sIdx, a);
  const d = ALPHA * (target - old);
  q.set(key, old + d);
  stats.sumD += Math.abs(d); stats.cntD++; // 残差用每局平均 |ΔQ|（max 会被终局 ±1 奖励钉死）
}
// s' 的最大 Q（只在合法动作上取，避免非法动作的 0 值污染）
function maxQAt(q, o) {
  const leg = legalActions(o);
  let m = -Infinity;
  for (const a of leg) { const v = qGet(q, o.idx, a); if (v > m) m = v; }
  return m === -Infinity ? 0 : m;
}

/* ==================== 代理：ε-greedy / 贪心（供钩子调用） ==================== */
function makeAgent(q, eps, seat, pending) {
  return (p) => {
    const o = observe(p);
    const leg = legalActions(o);
    let a;
    if (Math.random() < eps) {
      a = leg[Math.floor(Math.random() * leg.length)];
    } else {
      // 贪心：平局时在所有并列最优里随机挑（配合乐观初始化，初始化阶段天然轮转试遍所有动作）
      let best = -Infinity, cands = [];
      for (const x of leg) {
        const v = qGet(q, o.idx, x);
        if (v > best) { best = v; cands = [x]; }
        else if (v === best) cands.push(x);
      }
      a = cands[Math.floor(Math.random() * cands.length)];
    }
    if (pending) pending[seat] = { sIdx: o.idx, a };
    return moveFor(a);
  };
}

/* ==================== 训练一局（自对弈 + TD 更新） ==================== */
function trainEpisode(seed, q, stats) {
  E.seedRNG(seed);
  const pending = [null, null];
  E.HOOKS.chooseAIMove = (p, def) => makeAgent(q, EPS, p.id, pending)(p);
  E.newGame({ target: 3, players: [{ name: 'A', type: 'hard' }, { name: 'B', type: 'hard' }] });
  let guard = 0;
  while (!E.S.over && guard < MAX_TURNS) {
    const p = E.curPlayer();
    const seat = p.id;
    // 结算该座上一手：r=0，s' = 当前局面（本座的新回合开始）
    if (pending[seat]) {
      const sP = observe(p);
      qUpdate(q, pending[seat].sIdx, pending[seat].a, GAMMA * maxQAt(q, sP), stats);
      pending[seat] = null;
    }
    E.aiTurn(p); // 钩子执行本手并写入 pending[seat]
    guard++;
  }
  // 终局结算：双方未结算的 (s,a) 拿 ±1，s' = 终态（其 Q 视为 0）
  if (E.S.over) {
    const rank = E.S.players.slice().sort((a, b) =>
      (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
    const winSeat = rank[0].id;
    for (let seat = 0; seat < 2; seat++) {
      if (pending[seat]) {
        qUpdate(q, pending[seat].sIdx, pending[seat].a, seat === winSeat ? 1 : -1, stats);
        pending[seat] = null;
      }
    }
  } else {
    // ⭐ 卡死 = 平局 = 双方 −1（奖励工程的重要一课，Q13 的 reward hacking 活体）：
    // 若卡死不给信号，Q 会学到"死守不还球 → 游戏永不结束 → 永不输"的漏洞策略
    // （迷你游戏池小可被一人囤光，对方无球无行动只能 skip）。
    for (let seat = 0; seat < 2; seat++) {
      if (pending[seat]) {
        qUpdate(q, pending[seat].sIdx, pending[seat].a, -1, stats);
        pending[seat] = null;
      }
    }
  }
  E.HOOKS.chooseAIMove = null;
  return { leak: E.checkConservation(), finished: !!E.S.over };
}

/* ==================== 评估：贪心 Q（座位 0）对 随机 / 启发式（座位 1） ==================== */
function evalVs(q, mode, seed0, nGames) {
  let wins = 0, leaks = 0, finished = 0;
  E.HOOKS.chooseAIMove = (p, def) => {
    if (p.id === 0) return makeAgent(q, 0, 0, null)(p);
    return mode === 'random' ? makeAgent(q, 1, 1, null)(p) : def(p); // random 对手 = ε=1 同款代理
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

/* ==================== 主流程：训练 + 定期评估 ==================== */
console.log(`迷你游戏表格 Q-Learning：训练 ${nTrain} 局（自对弈 ε=${EPS} α=${ALPHA} γ=${GAMMA}），每 ${EVAL_EVERY} 局评估（${EVAL_GAMES} 局 × 随机/启发式）`);
const q = new Map();
const stats = { sumD: 0, cntD: 0 };
const residual = [];
const evalRand = [], evalHeur = [];
const t0 = Date.now();
let lastLeak = 0, lastStall = 0;

for (let ep = 0; ep < nTrain; ep++) {
  stats.sumD = 0; stats.cntD = 0;
  const res = trainEpisode(BASE_SEED + ep, q, stats);
  if (res.leak) lastLeak++;
  if (!res.finished) lastStall++;
  if (ep % Math.max(1, Math.round(nTrain / 500)) === 0) residual.push({ ep, d: stats.cntD ? stats.sumD / stats.cntD : 0 });
  if ((ep + 1) % EVAL_EVERY === 0) {
    const r = evalVs(q, 'random', BASE_SEED + 900000, EVAL_GAMES);
    const h = evalVs(q, 'heuristic', BASE_SEED + 900000, EVAL_GAMES);
    evalRand.push({ ep: ep + 1, rate: r.winRate, leaks: r.leaks });
    evalHeur.push({ ep: ep + 1, rate: h.winRate, leaks: h.leaks });
    console.log(`  [${String(ep + 1).padStart(6)}/${nTrain}] 贪心vs随机 ${(r.winRate * 100).toFixed(1)}% ｜ 贪心vs启发式 ${(h.winRate * 100).toFixed(1)}% ｜ 平均残差 ${residual[residual.length - 1].d.toFixed(4)}${r.leaks || h.leaks ? ' ⚠️违规' + r.leaks + '/' + h.leaks : ''}`);
  }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

/* ==================== 样本局：训练后的贪心策略怎么下棋 ==================== */
function sampleGame() {
  E.seedRNG(BASE_SEED + 777);
  const rec = E.makeRecorder();
  E.HOOKS.chooseAIMove = (p, def) => (p.id === 0 ? makeAgent(q, 0, 0, null)(p) : def(p));
  E.newGame({ target: 3, players: [{ name: 'A(贪心Q)', type: 'hard' }, { name: 'B(启发式)', type: 'hard' }] });
  let guard = 0;
  while (!E.S.over && guard < MAX_TURNS) { E.aiTurn(E.curPlayer()); guard++; }
  E.HOOKS.chooseAIMove = null;
  const rank = E.S.players.slice().sort((a, b) =>
    (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
  return { actions: rec, winner: rank[0].name, final: E.S.players.map((p) => `${p.name}:${p.points}分`).join(' ') };
}
const sample = sampleGame();

/* ==================== 落盘 summary ==================== */
const finalQ = {};
for (const [k, v] of q) finalQ[k] = v;
const summary = {
  name: `qlearn-${nTrain}`, seed: BASE_SEED, n: nTrain, alpha: ALPHA, gamma: GAMMA, eps: EPS,
  patterns: PATTERNS, nullPat: NULL_PAT,
  residual, evalRand, evalHeur, finalQ, qSize: q.size, leaks: lastLeak, stalls: lastStall,
  sampleGame: sample, elapsed,
  createdAt: new Date().toISOString(),
};
const epsDir = path.join(__dirname, 'data', 'episodes');
fs.mkdirSync(epsDir, { recursive: true });
const summaryFile = path.join(epsDir, `qlearn-${nTrain}.summary.json`);
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

/* ==================== 可视化报告 ==================== */
const reportPath = path.join(__dirname, 'data', 'qlearn-report.html');
fs.writeFileSync(reportPath, buildReport(summary));
console.log(`\n训练完成：Q 表 ${q.size} 项 ｜ 守恒违规 ${lastLeak} 局 ｜ 卡死 ${lastStall} 局 ｜ 耗时 ${elapsed}s`);
console.log(`📊 报告已生成：${reportPath}`);
try {
  const { spawn } = require('child_process');
  spawn('cmd', ['/c', 'start', '', reportPath], { detached: true, stdio: 'ignore' }).unref();
} catch (e) { /* 打不开不阻塞 */ }

/* ==================== 报告构建 ==================== */
function buildReport(s) {
  // 学习曲线：残差（对数轴）+ 两条评估曲线
  const W = 760, H = 260, P = { l: 46, r: 14, t: 14, b: 30 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const xOf = (ep) => P.l + iw * (ep / s.n);
  // 残差对数轴
  let dMin = Infinity, dMax = -Infinity;
  s.residual.forEach((r) => { const v = Math.log10(Math.max(1e-9, r.d)); if (v < dMin) dMin = v; if (v > dMax) dMax = v; });
  const yOfD = (v) => P.t + ih * (1 - (Math.log10(Math.max(1e-9, v)) - dMin) / Math.max(1e-9, dMax - dMin));
  const dPts = s.residual.map((r) => `${xOf(r.ep).toFixed(1)},${yOfD(r.d).toFixed(1)}`).join(' ');
  // 胜率轴 0..1
  const yOfW = (v) => P.t + ih * (1 - v);
  const randPts = s.evalRand.map((r) => `${xOf(r.ep).toFixed(1)},${yOfW(r.rate).toFixed(1)}`).join(' ');
  const heurPts = s.evalHeur.map((r) => `${xOf(r.ep).toFixed(1)},${yOfW(r.rate).toFixed(1)}`).join(' ');
  const curveSvg = `
  <svg viewBox="0 0 ${W} ${H}" class="curve">
    <line x1="${P.l}" y1="${yOfW(0.5)}" x2="${W - P.r}" y2="${yOfW(0.5)}" stroke="#999" stroke-dasharray="4 3"/>
    <text x="${W - P.r - 4}" y="${yOfW(0.5) - 4}" text-anchor="end" font-size="10" fill="#999">50% 线</text>
    <polyline points="${dPts}" fill="none" stroke="#c0392b" stroke-width="1.5" opacity="0.8"/>
    <polyline points="${heurPts}" fill="none" stroke="#8e44c7" stroke-width="2"/>
    <polyline points="${randPts}" fill="none" stroke="#16a085" stroke-width="2"/>
    <line x1="${P.l}" y1="${P.t}" x2="${P.l}" y2="${P.t + ih}" stroke="#333"/>
    <line x1="${P.l}" y1="${P.t + ih}" x2="${W - P.r}" y2="${P.t + ih}" stroke="#333"/>
    <text x="${P.l - 6}" y="${P.t + 10}" text-anchor="end" font-size="10">100%</text>
    <text x="${P.l - 6}" y="${P.t + ih + 4}" text-anchor="end" font-size="10">0</text>
    <text x="${P.l}" y="${H - 6}" font-size="10">训练局数 →
      <tspan fill="#c0392b">红=平均残差 |ΔQ|（对数轴）</tspan>
      <tspan fill="#16a085">绿=贪心vs随机</tspan>
      <tspan fill="#8e44c7">紫=贪心vs启发式</tspan></text>
  </svg>`;

  // Q 表切片热图：固定（市场模式、双方分数），网格 = 我的(红,蓝) × 对手(红,蓝)
  const slices = [
    { pat: 0, mp: 0, op: 0, label: `市场卡「${patName(0)}」，比分 0-0` },
    { pat: 0, mp: 1, op: 0, label: `市场卡「${patName(0)}」，比分 1-0` },
    { pat: 0, mp: 0, op: 1, label: `市场卡「${patName(0)}」，比分 0-1` },
    { pat: 4, mp: 0, op: 0, label: `市场卡「${patName(4)}」，比分 0-0` },
  ];
  const heatmaps = slices.map((sl) => heatmapSvg(q, sl)).join('');

  // 最值钱的局面 top 5
  const states = [];
  for (const [k, v] of q) { const a = k % N_ACT, sIdx = (k - a) / N_ACT; states.push({ sIdx, v }); }
  states.sort((x, y) => y.v - x.v);
  const topSeen = new Map();
  const topStates = [];
  for (const st of states) {
    if (!topSeen.has(st.sIdx)) { topSeen.set(st.sIdx, st.v); if (topSeen.size > 5) break; }
  }
  for (const [sIdx, v] of topSeen) {
    const d = decodeState(sIdx);
    topStates.push(`我(红${d.meR}蓝${d.meB}) 对手(红${d.oppR}蓝${d.oppB}) 分${d.myPts}-${d.oppPts} 卡[${patName(d.cardPat)}] → Q̂=${v.toFixed(3)}`);
  }

  // 样本局打印
  const cn = { red: '红', blue: '蓝' };
  const trace = s.sampleGame.actions.map((a) => {
    const desc = a.k === 'take3' ? '拿 ' + a.p.colors.map((c) => cn[c]).join('+')
      : a.k === 'buy' ? '买卡(+1分)' : a.k === 'return' ? '退 ' + cn[a.p.color] : a.k;
    return `<div class="row"><div class="rlabel">第${a.t}手 座位${a.seat}</div><div class="rtrack" style="background:none">${esc(desc)}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>Q-Learning 收敛报告（迷你游戏）</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; max-width: 880px; margin: 24px auto; padding: 0 16px; color: #333; background: #fafafa; }
  h1 { font-size: 22px; border-bottom: 3px solid #e3350d; padding-bottom: 8px; }
  h2 { font-size: 17px; margin-top: 28px; }
  .meta { color: #777; font-size: 13px; }
  .curve { width: 100%; height: auto; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; }
  section { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 18px; margin-top: 12px; }
  .row { display: flex; align-items: center; margin: 3px 0; font-size: 13px; }
  .rlabel { width: 130px; }
  .hm { margin: 6px 12px 6px 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 4px; }
  .hmwrap { display: flex; flex-wrap: wrap; }
  .toplist { font-family: Consolas, monospace; font-size: 13px; line-height: 1.7; }
</style></head>
<body>
<h1>🎓 表格 Q-Learning 收敛报告（迷你版游戏）</h1>
<p class="meta">训练 ${s.n} 局自对弈（ε=${s.eps} α=${s.alpha} γ=${s.gamma}）｜ Q 表 ${s.qSize} 项 ｜ 守恒违规 ${s.leaks} 局 ｜ 耗时 ${s.elapsed}s ｜ 生成 ${s.createdAt}</p>

<section><h2>① 学习曲线</h2>
${curveSvg}
</section>

<section><h2>② Q 表切片热图（色块 = 该局面的最大 Q 值）</h2>
<p class="meta">横轴 = 对手的(红,蓝)球组合，纵轴 = 我的(红,蓝)球组合；红=值钱，蓝=不值钱，灰=没访问过。</p>
<div class="hmwrap">${heatmaps}</div>
</section>

<section><h2>③ 最值钱的 5 个局面（Q 表里学到什么）</h2>
<div class="toplist">${topStates.map(esc).join('<br>')}</div>
</section>

<section><h2>④ 训练后的贪心策略 vs 启发式，一局（胜者：${esc(s.sampleGame.winner)}，${esc(s.sampleGame.final)}）</h2>
${trace}
</section>
</body></html>`;
}

// 模式显示名：成本（1红/2蓝…）+ 加成色
function patName(i) {
  if (i >= PATTERNS.length) return '市场空';
  const p = PATTERNS[i].split('-');
  const cn = { red: '红', blue: '蓝' };
  const cost = (p[0] !== '0' ? p[0] + cn[C1] : '') + (p[1] !== '0' ? p[1] + cn[C2] : '');
  return cost + '·' + cn[p[2]];
}
function heatmapSvg(q, sl) {
  const cell = 10, n = 25;
  const W = n * cell + 34, H = n * cell + 34;
  let rects = '';
  for (let m = 0; m < n; m++) {
    for (let o = 0; o < n; o++) {
      const sIdx = encodeState({ meR: m % 5, meB: Math.floor(m / 5), oppR: o % 5, oppB: Math.floor(o / 5), myPts: sl.mp, oppPts: sl.op, cardPat: sl.pat });
      let best = null;
      for (let a = 0; a < N_ACT; a++) { const v = q.get(qKey(sIdx, a)); if (v !== undefined && (best === null || v > best)) best = v; }
      const fill = best === null ? '#eee' : qColor(best);
      rects += `<rect x="${17 + (o % 5) * cell + Math.floor(o / 5) * (cell * 5 + 3)}" y="${17 + (m % 5) * cell + Math.floor(m / 5) * (cell * 5 + 3)}" width="${cell}" height="${cell}" fill="${fill}" stroke="#ddd" stroke-width="0.5"/>`;
    }
  }
  return `<div style="display:inline-block"><div class="meta" style="margin:4px 0">${esc(sl.label)}</div>
  <svg class="hm" width="${W}" height="${H}">${rects}
    <text x="6" y="26" font-size="9" transform="rotate(-90 10 150)" text-anchor="middle">我的(红,蓝) ↑</text>
    <text x="${W / 2}" y="${H - 8}" font-size="9" text-anchor="middle">对手的(红,蓝) →</text>
  </svg></div>`;
}
// Q 值 → 颜色：负=红，0=浅灰，正=绿（-1.2 ~ +1.2 截断）
function qColor(v) {
  const t = Math.max(-1.2, Math.min(1.2, v)) / 1.2;
  const hue = t >= 0 ? 120 : 0; // 正绿 负红
  const sat = Math.min(1, Math.abs(t));
  const lig = 85 - Math.abs(t) * 40;
  return `hsl(${hue}, ${Math.round(sat * 70)}%, ${Math.round(lig)}%)`;
}
