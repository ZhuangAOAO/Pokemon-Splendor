'use strict';
/* ==================== 策略核心：动作枚举 + 56 维特征 + greedy 决策 ====================
 * 从 ppo-agent.js 原样抽出（2026-09-17 重构），训练与冠军 AI 共用同一份代码，
 * 保证网口口径逐位一致——任何特征/枚举改动都会同时影响训练与线上，必须重新开练。
 *
 * 依赖约定（⚠️ 重要，勿改）：
 *   1. 不 require harness（它会把 global.setTimeout 打桩成空函数，进游戏服务器
 *      会炸掉 AI 思考/离线兜底等所有真定时器）；也不 require game-core。
 *   2. 只用裸全局名：S / COLORS / RULES / canAfford / allMarketCards / missingFor /
 *      globalNeed / totalBalls / bonusOf / totalCost。这些由 config.js + game-core.js
 *      挂到 window（Node 下 = global）：
 *        - RL 训练进程：ppo-agent require('./harness') 时由 harness 的 eval 挂上
 *        - 游戏服务器：server.js require('./config') + require('./game-core') 时挂上
 *      两个进程里这些名字指向同一份实现，行为逐位一致。
 *   3. S 用 Proxy 每次读实时值：游戏服务器把全局 S 暂时指向本房对局（ai-policy.js
 *      的 installHook），Proxy 保证策略读到的永远是"此刻该读的那局"。
 *   4. 特征归一化分母用 S.target（训练时 S.target === TARGET=18，与旧版逐位一致；
 *      网页局目标分 15/18/21 都能正确归一化）。
 *
 * 特征开关（多人局特征补强对照实验用，缺省全关 = 56 维基础特征）：
 *   configure({ opp2, oppRem, oppBonusPerColor }) 在首次使用前调用；
 *   新特征一律追加在 56 维基础特征末尾（不动已有索引），口径元数据写进权重文件。
 */

const N = require('./nn'); // 前向传播（Actor softmax 打分）—— 唯一允许的本地依赖

/* ==================== 特征机器（ppo-agent / lqlearn / ppo-big 同款基础 56 维 + 可选新增维） ==================== */
const KIND_OF = { buy: 1, buyReserved: 2, reserve: 3, reserveBlind: 4, takeMaster: 5, take3: 6, take2: 7, return: 8 };
const BASE_FEAT_NAMES = [
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
// 颜色中文名（按 COLORS 顺序：red/blue/black/pink/yellow，与基础特征名一致）
const COLOR_ZH = ['普通', '超级', '高级', '治愈', '快速'];

// 状态特征索引（Critic 的 psi 输入）：动作无关的维度。缺省 = 旧版 STATE_IDX
let FEAT_NAMES = BASE_FEAT_NAMES.slice();
let N_FEAT = BASE_FEAT_NAMES.length;
let STATE_IDX = [0, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42];
let N_STATE = STATE_IDX.length;

// 可选新增特征一律追加在 56 维基础特征末尾（不动已有索引），按开关拼装。
// 调用前必须与训练该权重时的口径一致（权重文件 meta.featFlags 可查）。
let OPP2_IDX = -1, OPP_REM_IDX = -1, OPP_BONUS_IDX = -1;
function configure(featFlags) {
  const flags = {
    opp2: !!featFlags.opp2,                           // 对手总球数·次大值（+1 维）
    oppRem: !!featFlags.oppRem,                       // 对手按色剩余需求 max（+5 维）
    oppBonusPerColor: !!featFlags.oppBonusPerColor,   // 对手按色永久加成 max（+5 维）
  };
  FEAT_NAMES = BASE_FEAT_NAMES.slice();
  let featNext = BASE_FEAT_NAMES.length;
  OPP2_IDX = flags.opp2 ? featNext++ : -1;
  if (flags.opp2) FEAT_NAMES.push('对手球数·次大');
  OPP_REM_IDX = flags.oppRem ? featNext : -1;
  if (flags.oppRem) { COLOR_ZH.forEach((zh) => FEAT_NAMES.push('对手剩余需求·' + zh)); featNext += 5; }
  OPP_BONUS_IDX = flags.oppBonusPerColor ? featNext : -1;
  if (flags.oppBonusPerColor) { COLOR_ZH.forEach((zh) => FEAT_NAMES.push('对手永久加成·' + zh)); featNext += 5; }
  N_FEAT = FEAT_NAMES.length;
  STATE_IDX = [0, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42];
  // 新增的都是与动作无关的状态特征 → 同样进 Critic 的 psi（缺省时与旧版 STATE_IDX 相同）
  if (OPP2_IDX >= 0) STATE_IDX.push(OPP2_IDX);
  if (OPP_REM_IDX >= 0) for (let i = 0; i < COLOR_ZH.length; i++) STATE_IDX.push(OPP_REM_IDX + i);
  if (OPP_BONUS_IDX >= 0) for (let i = 0; i < COLOR_ZH.length; i++) STATE_IDX.push(OPP_BONUS_IDX + i);
  N_STATE = STATE_IDX.length;
  return { featFlags: flags, nFeat: N_FEAT, nState: N_STATE, stateIdx: STATE_IDX.slice(), featNames: FEAT_NAMES.slice() };
}

// 当前对局状态：每次访问实时取值（训练=harness 全局会话；服务器=被 installHook 指向的本房会话）
const S = new Proxy({}, { get: (_t, k) => globalThis.S[k] });

/* ==================== 动作枚举（与 ppo-agent 训练期完全一致） ==================== */
function enumerateMoves(p) {
  const moves = [];
  [1, 2, 3, 4, 5].forEach((t) => S.market[t].forEach((c, idx) => {
    if (c && canAfford(p, c)) moves.push({ type: 'buy', tier: t, idx, card: c });
  }));
  p.reserved.forEach((c, ridx) => {
    if (canAfford(p, c)) moves.push({ type: 'buyReserved', ridx, card: c });
  });
  if (p.reserved.length < RULES.reserveLimit) {
    [1, 2, 3].forEach((t) => S.market[t].forEach((c, idx) => {
      if (c) moves.push({ type: 'reserve', tier: t, idx, card: c });
    }));
    [1, 2, 3].forEach((t) => { if (S.decks[t].length > 0) moves.push({ type: 'reserveBlind', tier: t }); });
  }
  if (RULES.takeMasterAlone !== false && S.pool.master > 0) moves.push({ type: 'takeMaster' });
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
  COLORS.forEach((c) => { if (S.pool[c] >= RULES.takeTwoMin) moves.push({ type: 'take2', color: c }); });
  COLORS.forEach((c) => { if (p.balls[c] > 0) moves.push({ type: 'return', color: c }); });
  if (p.balls.master > 0) moves.push({ type: 'return', color: 'master' });
  return moves;
}

/* ==================== 特征：局面上下文 + 每动作特征向量 ==================== */
function buildCtx(p) {
  const cards = [];
  allMarketCards().concat(p.reserved).forEach((c) => {
    const m = missingFor(p, c);
    cards.push({ card: c, effTot: m.effTot, net: m.net });
  });
  let minEff = Infinity;
  cards.forEach((x) => { if (x.effTot < minEff) minEff = x.effTot; });
  const need = globalNeed(p);
  const opps = S.players.filter((x) => x !== p);
  const oppMax = Math.max(...opps.map((x) => x.points));
  // 多人数聚合：对手特征对"所有对手"取 max（理由见 ppo-agent 文件头注释），归一化常数与 3 人局一致
  const maxOf = (fn) => Math.max(...opps.map(fn));
  const bonus = bonusOf(p);
  const base = new Float64Array(N_FEAT);
  base[0] = 1;
  base[9] = p.points / S.target;
  base[10] = (oppMax - p.points) / S.target;
  base[11] = S.endTriggered ? 1 : 0;
  base[12] = p.balls.master / 3;
  base[13] = maxOf((x) => x.balls.master) / 3;
  base[14] = maxOf((x) => COLORS.reduce((s, c) => s + (bonusOf(x)[c] || 0), 0)) / 12;
  base[15] = p.reserved.length / 3;
  base[16] = p.reserved.reduce((s, c) => s + c.vp, 0) / 12;
  base[17] = maxOf((x) => x.reserved.length) / 3;
  const market = allMarketCards();
  base[18] = market.length / 14;
  base[19] = (market.length ? Math.max(...market.map((c) => c.vp)) : 0) / 5;
  base[20] = market.reduce((s, c) => s + c.vp, 0) / 40;
  base[21] = market.filter((c) => canAfford(p, c)).length / 6;
  base[22] = Math.min(1, S.turnIdx / 40);
  COLORS.forEach((c, i) => {
    base[23 + i] = p.balls[c] / 4;
    base[28 + i] = maxOf((x) => x.balls[c]) / 4;
    base[33 + i] = S.pool[c] / 5;
    base[38 + i] = bonus[c] / 5;
  });
  // ---- 可选新增特征（对照实验开关）：一律追加在基础 56 维之后 ----
  if (OPP2_IDX >= 0) {
    // 对手总球数的次大值 /10：捕捉"第二威胁"；只有 1 个对手时该维恒为 0
    const totals = opps.map((x) => totalBalls(x)).sort((a, b) => b - a);
    base[OPP2_IDX] = (totals.length >= 2 ? totals[1] : 0) / 10;
  }
  if (OPP_REM_IDX >= 0) {
    // 每色：max over 对手 max(0, need[c] − balls[c]) /5；
    // need 与启发式 globalNeed 同口径（可见卡最大缺口，不减已持有）
    COLORS.forEach((c, i) => {
      let mx = 0;
      opps.forEach((x) => { mx = Math.max(mx, Math.max(0, globalNeed(x)[c] - x.balls[c])); });
      base[OPP_REM_IDX + i] = mx / 5;
    });
  }
  if (OPP_BONUS_IDX >= 0) {
    // 每色：对手永久加成数的 max /5（威胁口径与"对手加成"总维度一致）
    COLORS.forEach((c, i) => { base[OPP_BONUS_IDX + i] = maxOf((x) => bonusOf(x)[c]) / 5; });
  }
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
    f[46] = totalCost(card) / 8;
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
    f[52] = totalBalls(p) + colors.length > RULES.handLimit ? -1 : 0;
  }
  if (m.type === 'takeMaster') f[53] = p.balls.master / 3;
  if (m.type === 'return') {
    f[54] = m.color === 'master' ? p.balls.master / 5 : (p.balls[m.color] - ctx.need[m.color]) / 5;
    f[55] = -0.5;
  }
  return f;
}

/* ==================== Actor（NN softmax）：扫描所有动作打分 ==================== */
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

/* ==================== 贪心决策：logits 最大（并列取枚举顺序第一个，与训练期一致） ==================== */
function greedyMove(actor, p) {
  const sc = scanActor(actor, p);
  if (!sc.moves.length) return null;
  let best = 0;
  for (let j = 1; j < sc.moves.length; j++) if (sc.zs[j] > sc.zs[best]) best = j;
  return sc.moves[best];
}

/* ==================== 基础 AI 变体（--pool-variants / --eval-seats var1..varN） ==================== */
// 困难启发式 AI（game-core.chooseAIMoveDefault，aiLevel==='hard'）的变体。
// 2026-09-18 改版：噪声从"动作层均匀随机"改为"评估层噪声"。
//   旧版 = 以 noiseX 概率走均匀随机合法动作：noiseX=0.2 实测 def vs var1 = 74.6/25.4，
//   随机动作会把局面搅崩，变体弱得没法当对手。
//   新版 = 完整复刻 def 的决策骨架（能买就买 → 预约 → 攒球 → 兜底，结构规则逐条一致），
//   只在"选哪张 / 选哪个色"的评估值上注入噪声：
//     · 收服      "最高 vp"是硬规则（与 def 一致，噪声不许把高分卡换成低分卡——实测零均值
//       噪声在 buy 上净赚：def 太刚性，噪声偶尔换到更便宜的卡反而赚节奏，会系统性抬高
//       变体强度）。噪声只作用在同 vp 并列卡的 tier·0.5 − cost·0.05 偏好上（σ=0 时与
//       def 的 (vp 降, tier 降, cost 升) 并列规则一致）
//     · 预约打分  vp·4 − effTot·1.1 + tier·0.5 − cost·0.05 + jitter(σ)（def 同款公式；
//       engineCards 前期不追三阶的结构规则保留）
//     · 拿球      缺口 rem[c] 的排序键加 jitter(σ)：只打乱"先拿哪个缺色"，结构不变
//     · 随机点    （盲抽 30% 硬币、并列 pick、补齐色 pick）全走变体 RNG
//   噪声只换选择、不破坏结构 → 强度贴着 def 小幅波动，不会把必赢局打输。
//   每个变体 = 一份内置噪声档案（VARIANT_DEFS：var1..var4 四种风格；var5+ 循环复用档案，
//   种子不同行为仍不同）；--pool-variant-noise 是叠加的全局额外 σ（缺省 0 = 只用内置档位）。
//   rng 为变体专用种子 RNG（mulberry32，按 局种子+座位+变体号×65536 派生，与游戏/采样 RNG
//   分离）：同 (局种子, 座位, 变体号) 逐位可复现。训练对手池与 --eval-only 评估共用这一份逻辑。
const VARIANT_DEFS = [
  { key: 'var1', label: '轻噪·全局', scoreSigma: 1.0, needSigma: 1.0, phase: 'all', style: null, fumble: 0.015 },
  { key: 'var2', label: '中噪·中盘', scoreSigma: 2.5, needSigma: 2.5, phase: 'mid', style: null, fumble: 0.025 },
  { key: 'var3', label: '噪·终局',   scoreSigma: 2.5, needSigma: 2.5, phase: 'end', style: null, fumble: 0.015 },
  { key: 'var4', label: '中噪·囤高阶', scoreSigma: 1.0, needSigma: 1.0, phase: 'all', style: 'hoard', fumble: 0 },
];
// varIdx（1 基）→ 生效档案：内置 σ 档案 + 调用方叠加的全局额外 σ（extra，缺省 0）
function variantProfile(varIdx, extraNoise) {
  const base = VARIANT_DEFS[(varIdx - 1) % VARIANT_DEFS.length];
  return {
    key: 'var' + varIdx, label: base.label,
    scoreSigma: base.scoreSigma, needSigma: base.needSigma,
    phase: base.phase, style: base.style, fumble: base.fumble,
    extra: extraNoise || 0,
  };
}
// 噪声相位缩放：all = 全程 1；mid = 中盘（8 ≤ 回合 < 28 且未进终局）1、其余 0.25；
// end = 终局（已触发终局或回合 ≥ 28）1、其余 0（= 与 def 无差别）
function phaseScaleOf(phase) {
  if (phase === 'mid') return (S.turnIdx >= 8 && S.turnIdx < 28 && !S.endTriggered) ? 1 : 0.25;
  if (phase === 'end') return (S.endTriggered || S.turnIdx >= 28) ? 1 : 0;
  return 1;
}
// def 决策骨架 + 评估层噪声。prof 由 variantProfile 组装（内置 σ + 全局额外 σ）
function variantMove(p, rng, prof) {
  // fumble（手滑）：以极小概率走均匀随机合法动作。为什么需要它：零均值评估噪声实测
  // 净赚（def 的预约/拿球启发式粗糙，随机扰动平均反而更优），纯噪声压不回 def 强度；
  // fumble 是只往下的强度旋钮，把变体校准回"贴 def 或略弱"（≈10% 远小于旧版的 20%
  // 全随机，且其余动作仍是 def 骨架 → 局面不会被搅崩）
  if (rng() < prof.fumble) {
    const moves = enumerateMoves(p);
    if (moves.length) return moves[Math.floor(rng() * moves.length)];
  }
  const scale = phaseScaleOf(prof.phase);
  const jit = (sigma) => (rng() * 2 - 1) * sigma * scale; // 均匀 [−σ, σ] × 相位
  const pickRng = (arr) => arr[Math.floor(rng() * arr.length)];
  const sSigma = prof.scoreSigma + prof.extra;   // 收服/预约打分噪声 σ
  const nSigma = prof.needSigma + prof.extra;    // 拿球缺口排序噪声 σ
  const engineCards = (typeof AI_CONFIG !== 'undefined' && AI_CONFIG) ? AI_CONFIG.engineCards : 5;

  // 1) 能收服就收服：def 只挑 vp 最高的可收服卡（并列比阶、再比成本）。这里的"最高 vp"
  //    是硬规则、不加噪声——实测零均值评估噪声在 buy 上净赚（def 太刚性，噪声偶尔换到
  //    更便宜的卡反而赚节奏），会系统性抬高变体强度。噪声只作用在同 vp 并列卡的阶/成本
  //    偏好上（tier·0.5 − cost·0.05 + jitter，σ=0 时与 def 的并列规则一致）：
  //    风格差异 = "同为最高分，选哪张"的口味，强度不漂移
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
    let maxVp = -Infinity;
    list.forEach((a) => { if (a.card.vp > maxVp) maxVp = a.card.vp; });
    const top = list.filter((a) => a.card.vp === maxVp);
    let best = null, bestScore = -Infinity;
    top.forEach((a) => {
      const score = a.card.tier * 0.5 - totalCost(a.card) * 0.05 + jit(sSigma);
      if (score > bestScore) { bestScore = score; best = a; }
    });
    return best.kind === 'buy' ? { type: 'buy', tier: best.tier, idx: best.idx }
                               : { type: 'buyReserved', ridx: best.ridx };
  }

  // 2) 收不起 → 预约场上最有价值的卡（def 同款公式 + 噪声；engine 前期不追三阶的结构规则保留）
  const engine = p.cards.length < engineCards;
  let rt = null, rtScore = -1e9;
  [1, 2, 3].forEach((t) => S.market[t].forEach((c, idx) => {
    if (!c) return;
    if (engine && c.tier === 3 && prof.style !== 'hoard') return;              // def 结构规则
    if (engine && c.tier === 3 && prof.style === 'hoard' && rng() >= 0.35) return; // 囤高阶风格：35% 破例
    const m = missingFor(p, c);
    let score = c.vp * 4 - m.effTot * 1.1 + c.tier * 0.5 - totalCost(c) * 0.05 + jit(sSigma);
    if (prof.style === 'hoard' && c.tier === 3) score += 2;                    // 囤高阶风格：三阶卡加分
    if (score > rtScore) { rtScore = score; rt = { tier: t, idx, card: c }; }
  }));
  if (rt && p.reserved.length < RULES.reserveLimit && (S.pool.master > 0 || rt.card.vp >= 2)) {
    return { type: 'reserve', tier: rt.tier, idx: rt.idx };
  }
  // 3) 开启"只拿大师球"行动时：预约没得约了，就攒大师球当万能球用
  if (RULES.takeMasterAlone !== false && S.pool.master > 0 && p.balls.master < 3) {
    return { type: 'takeMaster' };
  }
  // 4) 偶尔从牌堆盲抽（同样拿大师球），尤其是没有好明牌时（硬币走变体 RNG）
  if (p.reserved.length < RULES.reserveLimit && S.pool.master > 0) {
    const tiers = [1, 2, 3].filter((t) => S.decks[t].length > 0);
    if (tiers.length && rng() < 0.3) return { type: 'reserveBlind', tier: pickRng(tiers) };
  }

  // 5) 收集资源：按"全场需求 − 已持有"的缺口拿球；缺色够 3 种就优先拿满 3 色
  //    （排序键加噪声：只打乱缺色的先后，不改变"只拿缺色"的结构）
  const need = globalNeed(p);
  const rem = {};
  COLORS.forEach((c) => { rem[c] = Math.max(0, need[c] - p.balls[c]); });
  const noisyRem = {};
  COLORS.forEach((c) => { noisyRem[c] = rem[c] + jit(nSigma); });
  const avail = COLORS.filter((c) => S.pool[c] > 0);
  const wanted = avail.filter((c) => rem[c] > 0).sort((a, b) => noisyRem[b] - noisyRem[a]);
  const surplus = COLORS.filter((c) => p.balls[c] > 0 && p.balls[c] > need[c]);
  // 池子里没有自己还缺的球 → 退还富余的球周转供应区（防止全桌卡死）
  if (!wanted.length) {
    if (surplus.length) {
      return { type: 'return', color: surplus.sort((a, b) => (p.balls[b] - need[b]) - (p.balls[a] - need[a]))[0] };
    }
    if (avail.length) return { type: 'take3', colors: [pickRng(avail)] };
    const held = COLORS.filter((c) => p.balls[c] > 0);
    if (held.length) return { type: 'return', color: pickRng(held) };
    if (p.balls.master > 0) return { type: 'return', color: 'master' };
    return null;
  }
  // 还缺至少 3 种颜色 → 一次拿满 3 色（过度偏好 take2 会拖慢节奏）
  if (wanted.length >= 3) return { type: 'take3', colors: wanted.slice(0, 3) };
  // 只缺 1~2 种颜色：某色还缺至少 2 个且供应足 → 拿 2 个同色（取缺口最大者）；否则用别的颜色补满 3 色
  const twoOpt = wanted.find((c) => S.pool[c] >= RULES.takeTwoMin && rem[c] >= 2);
  if (twoOpt) return { type: 'take2', color: twoOpt };
  const chosen = wanted.slice();
  while (chosen.length < Math.min(3, avail.length)) {
    chosen.push(pickRng(avail.filter((x) => !chosen.includes(x))));
  }
  return { type: 'take3', colors: chosen };
}

module.exports = {
  configure,
  KIND_OF, BASE_FEAT_NAMES, COLOR_ZH,
  get FEAT_NAMES() { return FEAT_NAMES; },
  get N_FEAT() { return N_FEAT; },
  get STATE_IDX() { return STATE_IDX; },
  get N_STATE() { return N_STATE; },
  enumerateMoves, buildCtx, featuresFor, scanActor, greedyMove, variantMove,
  VARIANT_DEFS, variantProfile,
};
