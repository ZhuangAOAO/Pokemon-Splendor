'use strict';
/* ==================== ppo-agent：ppo-big-nn 的人数参数化版 ====================
 * 逻辑照搬 工具/rl/ppo-big-nn.js（目前唯一跑出正向学习的配方），只改人数相关部分：
 *   网络结构（Actor MLP 56→32→1 / Critic MLP 35→32→1）、56 维特征、GAE/PPO 更新、
 *   对手池（heuristic / random / 历史快照）全部保持原样。
 *
 * 多人数对手聚合策略（唯一语义改动，必须说明）：
 *   对手相关特征（对手球数 / 大师球 / 加成 / 预约数）对"所有对手"取 max。
 *   为什么选 max 而不是 sum：
 *   1. 胜负判定 = 终局分数超过所有对手——最强对手是绑定约束，max 捕捉的
 *      正是"最危险的对手"，与胜负口径一致；
 *   2. max 后每个特征的值域与单对手时完全相同（归一化常数 /3 /4 /12 不用
 *      随人数调整），同一套网络跨 2/3/4 人局直接复用；sum 需要再除以对手数
 *      才能保持尺度，对手数一变语义就漂移。
 *   （"对手领先"原脚本就取 max，保持不变。）
 *
 * 长跑支持（10 万局量级过夜训练用）：
 *   1. 定时检查点 weights/ppo-agent-p{N}-ckpt.json：每 --ckpt-every 局写一次，
 *      含权重 + Adam 动量缓冲（续跑不丢优化器状态）、对手池、评估曲线、守恒/卡死
 *      计数、历史最优；--resume 从它续跑。训练种子按局号续接（游戏对局与评估
 *      口径完全确定），动作采样 / 对手池选择 / 网络初始化走独立种子 RNG
 *      （mulberry32，--sample-seed 默认 777，按局号续接，与游戏 RNG 分离），
 *      轨迹逐位复现；批次边界最多丢 BATCH_EPS-1 局的未更新样本，影响可忽略。
 *   2. 中断兜底：SIGINT/SIGTERM 先写检查点 + 摘要再退出（主循环每 100 局让出
 *      事件循环，Ctrl+C 不会等到训练结束才生效）。
 *   3. 最优权重 weights/ppo-agent-p{N}-best.json：每次评估刷新历史最高胜率就落盘。
 *   4. 日志 data/ppo-agent-p{N}.log（本地时间戳）＋ 摘要 data/ppo-agent-p{N}.summary.json
 *      每次评估后即时刷新（含 running 标志），后台长跑时随时可看进度。
 *
 * 用法：node 工具/rl/ppo-agent.js [训练局数] [评估间隔] [--players 2|3|4] [--eval-games 200]
 *                    [--ckpt-every 5000] [--resume[=检查点路径]] [--hidden 32]
 *                    [--alpha 1e-3] [--beta 1e-3] [--alpha-front 3e-3] [--beta-front 1e-2]
 *                    [--lr-schedule decay10|front-zero] [--no-lr-decay] [--lr-decay-to 0.1]
 *                    [--ent-coef 0.01] [--shape-w 0.01]
 *                    [--target-kl 0.02] [--grad-clip 0.5] [--no-adv-norm]
 *                    [--sample-seed 777] [--rollback-stop 5] [--eval-only 权重文件]
 *                    [--eval-seats str,def,rand,...] [--str-weights 权重文件]
 *                    [--feat-opp2] [--feat-opp-rem] [--feat-opp-bonus-percolor]
 *                    [--eval-seed 21160917] [--tag 名字]
 *      续跑时"训练局数"= 在检查点基础上追加的局数。
 * 产出：weights/ppo-agent-p{N}[-tag]-{累计局数}.json（最终权重）＋ -ckpt/-best ＋ data/ 下摘要与日志
 *
 * 实验标签（并行跑多组对照实验防互相覆盖产物）：
 *   --tag <名>  拼进所有产出文件名（最终权重 / 检查点 / 最优 / 摘要 / 日志），
 *               --resume 不带路径时也读带 tag 的检查点；只允许字母/数字/下划线/短横线。
 *               缺省（不传）= 文件名与旧版完全一致。
 *
 * 特征开关（多人局特征补强对照实验用，缺省全关 = 行为与旧版逐位一致）：
 *   --feat-opp2               +1 维：对手总球数的次大值 /10（只有 1 个对手时该维恒为 0）
 *   --feat-opp-rem            +5 维：每色 max over 所有对手 max(0, need[c]−balls[c]) /5，
 *                             need 与启发式 globalNeed 同口径（可见卡最大缺口，不减已持有）
 *   --feat-opp-bonus-percolor +5 维：每色 max over 所有对手 永久加成数 /5
 *   --hidden <n>              Actor/Critic 隐层宽度（缺省 32）
 *   --eval-seed <base>        评测种子基（缺省 BASE_SEED+900000；与训练种子范围重叠会拒绝开跑，防泄题）
 *   新特征一律追加在 56 维基础特征末尾（不动已有索引）；口径元数据 meta（featFlags/
 *   nFeat/hidden/evalSeed/evalGames）写进所有权重文件与 summary；--resume 时逐项防呆，
 *   口径不一致直接报错退出，绝不静默继续。
 *
 * 评估座位（AI 对打评估，--eval-seats / --str-weights）：
 *   --eval-seats <座位列表>   逗号分隔，每个座位指定一个 AI：str = 策略 AI、def = 困难
 *                             启发式 AI、rand = 随机合法动作 AI（走游戏种子 RNG，可复现）；
 *                             列表长度 ≤ --players，不足的座位自动补 def
 *                             （"str" + --players 2 → [str,def]），超长报错。
 *                             缺省 ['str','def',...] = 旧行为（贪心 vs 启发式）。
 *   座位 0 的 str = 被测策略（--eval-only 的文件 / 训练中的当前模型）；座位 ≥1 的
 *   str = --str-weights 指定的文件（缺省 = 被测策略同一张网，即自对弈）——这样
 *   --eval-only A --eval-seats str,str,def --str-weights B 就是 A vs B vs 启发式对打。
 *   训练模式主指标 = 座位 0 的胜率（座位 0 非 str 时评估不测学习者，最优判定跳过）；
 *   --eval-only 模式另落档 weights/<权重名>.eval-<座位>[.vs-<对打权重>].json：
 *   分座位胜率/平均分/平均进化、逐局记录、被测与对打权重的 sha256 指纹。
 *
 * 可调超参（CLI 覆盖，缺省 = 2026-09-16 教训值；含调度生效值，全量写进 meta 与 summary）：
 *   --alpha / --beta / --ent-coef / --shape-w   学习率 / 熵系数 / 塑形权重
 *   --target-kl     每 epoch 后 KL≈mean(logp旧−logp新) 超阈值 → 跳过剩余 epoch（防一步迈太大）
 *   --grad-clip     Adam 前全局 L2 梯度裁剪；0 = 关
 *   --no-lr-decay   关学习率线性衰减（默认开：从 --alpha-front 随本段训练进度线性衰减到其
 *                       --lr-decay-to 倍，缺省 0.1 = 10%）
 *   --lr-decay-to <比例>   decay10 衰减底线：前端值的比例，0~1（缺省 0.1 = 衰减到 10%，
 *                       0 = 一路衰减到 0；--no-lr-decay 时无效果）
 *   --alpha-front / --beta-front   前端（起始）学习率，缺省 3e-3 / 1e-2；只显式传 --alpha/--beta 时
 *                      以前者为前端值（旧命令行行为不变）；都没传时前端 = 3e-3 / 1e-2
 *   --lr-schedule decay10|front-zero   调度模式：decay10（缺省）= 前端值衰减到 --lr-decay-to 倍；
 *                      front-zero = 前端值置 0（全程学习率 0 的无学习对照；与显式
 *                      --alpha-front/--beta-front 互斥，与 --alpha/--beta/--no-lr-decay 兼容）
 *   --no-adv-norm   关 advantage 批内归一化（默认开：(adv−mean)/(std+1e-8)）
 *   --sample-seed   采样 / 对手池 / 初始化 RNG 种子（按局号续接；与游戏 RNG 分离 → 轨迹逐位复现）
 *   --rollback-stop 评估连续 n 次跌破历史最优 → 回滚权重并提前停训；0 = 关
 *   --eval-only     只评估指定权重文件（-best / -ckpt / 最终权重均可），不训练不落盘
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // 权重 sha256 指纹（评估结果落档用）
const H = require('./harness');
const N = require('./nn');

/* ==================== 命令行参数 ==================== */
const nTrain = +process.argv[2] || 10000;
const EVAL_EVERY = +process.argv[3] || 1000;

function flagVal(name, def) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] != null ? args[i + 1] : def;
    if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1);
  }
  return def;
}
const playersRaw = flagVal('--players', '3');
const N_PLAYERS = +playersRaw;
if (![2, 3, 4].includes(N_PLAYERS)) {
  console.error(`参数错误：--players 只接受 2/3/4（收到 "${playersRaw}"）`);
  process.exit(1);
}
const EVAL_GAMES = +flagVal('--eval-games', 200) || 200;
function hasFlag(name) {
  return process.argv.slice(2).some((a) => a === name || a.startsWith(name + '='));
}
const RESUME = hasFlag('--resume');
const CKPT_EVERY = Math.max(1, +flagVal('--ckpt-every', 5000) || 5000);
// 隐层宽度（Actor/Critic 共用）：改了必须重新开练，--resume 有口径防呆
const hiddenRaw = flagVal('--hidden', '32');
const HIDDEN = +hiddenRaw;
if (!Number.isInteger(HIDDEN) || HIDDEN < 1) {
  console.error(`参数错误：--hidden 需为正整数（收到 "${hiddenRaw}"）`);
  process.exit(1);
}
// 特征开关（多人局特征补强对照实验用）：缺省全关，特征数与旧版一致
const FEAT_FLAGS = {
  opp2: hasFlag('--feat-opp2'),                           // 对手总球数·次大值（+1 维）
  oppRem: hasFlag('--feat-opp-rem'),                      // 对手按色剩余需求 max（+5 维）
  oppBonusPerColor: hasFlag('--feat-opp-bonus-percolor'), // 对手按色永久加成 max（+5 维）
};

const GAMMA = 0.99, LAMBDA = 0.95, CLIP_EPS = 0.2;
// —— 可调超参（CLI 覆盖；全部写进 meta，改动时请用 --tag 区分产物）——
// 数值 flag 统一入口：传了非数字（含漏传值）直接报错退出，不静默吃默认
const numFlag = (name, def) => {
  const v = +flagVal(name, def);
  if (Number.isNaN(v)) {
    console.error(`参数错误：${name} 需为数字（收到 "${flagVal(name, def)}"）`);
    process.exit(1);
  }
  return v;
};
const ALPHA = numFlag('--alpha', 1e-3);        // Actor 学习率（旧值 3e-3）
const BETA = numFlag('--beta', 1e-3);          // Critic 学习率（旧值 1e-2）
const ENT_COEF = numFlag('--ent-coef', 0.01);  // 熵系数（保持旧值）
const SHAPE_W = numFlag('--shape-w', 0.01);    // 塑形权重（旧值 0.1）
const TARGET_KL = numFlag('--target-kl', 0.02);// PPO epoch 早停 KL 阈值
const GRAD_CLIP = numFlag('--grad-clip', 0.5); // 全局 L2 梯度裁剪；0 = 关
const LR_DECAY = !hasFlag('--no-lr-decay');    // 默认开：随训练进度线性衰减到前端值的 --lr-decay-to 倍（缺省 10%）
const ADV_NORM = !hasFlag('--no-adv-norm');    // 默认开：(adv−mean)/(std+1e-8)
// decay10 衰减底线 = 前端值的比例（A/B 对照参数）：0.1 = 衰减到 10%（旧行为），0 = 一路衰减到 0
const LR_DECAY_TO = numFlag('--lr-decay-to', 0.1);
if (!(LR_DECAY_TO >= 0 && LR_DECAY_TO <= 1)) {
  console.error(`参数错误：--lr-decay-to 需为 0~1 的比例（收到 ${LR_DECAY_TO}）`);
  process.exit(1);
}
// —— 学习率调度（A/B 对照参数，与"衰减到 10% 那套"对照）——
// 前端值 = 显式 --alpha-front/--beta-front > 显式 --alpha/--beta > 缺省 3e-3 / 1e-2（09-16 前的旧值）
//   decay10（缺省）：随本段训练进度从前端值线性衰减到前端值的 --lr-decay-to 倍（缺省 0.1 = 10%，后期小步走，不再来回震荡）
//   --no-lr-decay  ：恒为前端值
//   front-zero     ：前端值强制 0 → 全程学习率 0（无学习对照组，验证"学习/衰减"本身是否真的有用）
const SCHED_MODE = flagVal('--lr-schedule', 'decay10');
if (!['decay10', 'front-zero'].includes(SCHED_MODE)) {
  console.error(`参数错误：--lr-schedule 只接受 decay10/front-zero（收到 "${SCHED_MODE}"）`);
  process.exit(1);
}
let ALPHA_FRONT, BETA_FRONT;   // 前端（起始）学习率
if (SCHED_MODE === 'front-zero') {
  if (hasFlag('--alpha-front') || hasFlag('--beta-front')) {
    console.error('参数错误：--lr-schedule front-zero 已把前端学习率置 0，与 --alpha-front/--beta-front 互斥。');
    process.exit(1);
  }
  ALPHA_FRONT = 0;
  BETA_FRONT = 0;
} else {
  ALPHA_FRONT = hasFlag('--alpha-front') ? numFlag('--alpha-front', 3e-3)
    : (hasFlag('--alpha') ? ALPHA : 3e-3);
  BETA_FRONT = hasFlag('--beta-front') ? numFlag('--beta-front', 1e-2)
    : (hasFlag('--beta') ? BETA : 1e-2);
}
// 衰减终点 = 前端值 × LR_DECAY_TO（不衰减时 = 前端值）；生效值写进 meta/summary 与启动日志
// cleanNum 抹掉 0.1*0.003 之类的浮点尾数（0.00030000000000000003 → 0.0003），落档才好看
const cleanNum = (x) => (Number.isInteger(x) ? x : +x.toPrecision(12));
const ALPHA_END = LR_DECAY ? cleanNum(LR_DECAY_TO * ALPHA_FRONT) : ALPHA_FRONT;
const BETA_END = LR_DECAY ? cleanNum(LR_DECAY_TO * BETA_FRONT) : BETA_FRONT;
const SAMPLE_SEED = numFlag('--sample-seed', 777);   // 采样/对手池/初始化 RNG 种子
const ROLLBACK_STOP = Math.floor(numFlag('--rollback-stop', 5)); // 回滚早停（语义见主循环）
for (const [nm, v] of [['--alpha', ALPHA], ['--beta', BETA], ['--ent-coef', ENT_COEF],
  ['--shape-w', SHAPE_W], ['--target-kl', TARGET_KL], ['--grad-clip', GRAD_CLIP],
  ['--sample-seed', SAMPLE_SEED], ['--rollback-stop', ROLLBACK_STOP]]) {
  if (!(v >= 0)) {
    console.error(`参数错误：${nm} 需为非负数字（收到 ${v}）`);
    process.exit(1);
  }
}
const K_EPOCHS = 2, BATCH_EPS = 8;
const SNAPSHOT_EVERY = 2000;
const MAX_TURNS = 800;
// 每 N 局让出一次事件循环：否则整段训练是同步循环，SIGINT 要等训练全部结束才会触发
const YIELD_EVERY = 100;
const TARGET = 18;
// 训练与评估种子分离（同 ppo-big-nn.js）：训练 BASE_SEED+n，评估 BASE_SEED+900000
const BASE_SEED = 20260917;
// 评估种子基：缺省 BASE_SEED+900000（与训练种子错开 90 万，防泄题），--eval-seed 可显式指定
// （换评测口径用；开跑前校验与训练种子范围 [BASE_SEED, BASE_SEED+训练局数) 不重叠，重叠拒绝开跑）
const EVAL_SEED = numFlag('--eval-seed', BASE_SEED + 900000);
for (const [nm, v] of [['--eval-seed', EVAL_SEED], ['--alpha-front', ALPHA_FRONT], ['--beta-front', BETA_FRONT]]) {
  if (!(v >= 0)) {
    console.error(`参数错误：${nm} 需为非负数字（收到 ${v}）`);
    process.exit(1);
  }
}
// 实验标签：拼进所有产出文件名（并行多组对照实验互不覆盖），缺省空 = 文件名与旧版完全一致
const TAG = flagVal('--tag', '');
if (TAG && !/^[A-Za-z0-9_-]+$/.test(TAG)) {
  console.error(`参数错误：--tag 只允许字母/数字/下划线/短横线（收到 "${TAG}"）`);
  process.exit(1);
}
const tagSuffix = TAG ? '-' + TAG : '';

// —— 评估座位（AI 对打评估）：每个座位指定用哪个 AI ——
// str = 策略 AI（座位 0 = 被测策略；座位 ≥1 = --str-weights，缺省与被测同网）
// def = 困难启发式 AI；rand = 随机合法动作 AI（走游戏种子 RNG，逐位可复现）
// 列表长度 ≤ --players，不足自动补 def；缺省 ['str','def',...] = 旧行为（贪心 vs 启发式）
const EVAL_SEATS = (() => {
  const raw = flagVal('--eval-seats', '');
  if (!raw) return ['str', ...new Array(N_PLAYERS - 1).fill('def')];
  const seats = raw.split(',').map((s) => s.trim());
  if (seats.length > N_PLAYERS) {
    console.error(`参数错误：--eval-seats 座位数（${seats.length}）超过 --players ${N_PLAYERS}（收到 "${raw}"）`);
    process.exit(1);
  }
  for (const s of seats) {
    if (!['str', 'def', 'rand'].includes(s)) {
      console.error(`参数错误：--eval-seats 每个座位只能是 str/def/rand（收到 "${s}"）`);
      process.exit(1);
    }
  }
  while (seats.length < N_PLAYERS) seats.push('def'); // 座位不足按 def 补齐
  return seats;
})();
// 对打方权重（座位 ≥1 的 str 用）：缺省 = 被测策略同一张网（自对弈）
const STR_WEIGHTS = flagVal('--str-weights', '');

const COLORS = H.COLORS;
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const S = new Proxy({}, { get: (_t, k) => H.S[k] });

// 人数参数化：seat0 = 学习者（由钩子接管），其余座位全是困难 AI（再由钩子换成对手池成员）
function makePlayers(n) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ name: 'P' + i, type: 'hard' });
  return players;
}

/* ==================== 特征机器（lqlearn/ppo-big 同款基础 56 维 + 可选新增维） ==================== */
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
// 可选新增特征一律追加在 56 维基础特征末尾（不动已有索引），按开关拼装
const FEAT_NAMES = BASE_FEAT_NAMES.slice();
let featNext = BASE_FEAT_NAMES.length;
const OPP2_IDX = FEAT_FLAGS.opp2 ? featNext++ : -1;
if (FEAT_FLAGS.opp2) FEAT_NAMES.push('对手球数·次大');
const OPP_REM_IDX = FEAT_FLAGS.oppRem ? featNext : -1;
if (FEAT_FLAGS.oppRem) { COLOR_ZH.forEach((zh) => FEAT_NAMES.push('对手剩余需求·' + zh)); featNext += 5; }
const OPP_BONUS_IDX = FEAT_FLAGS.oppBonusPerColor ? featNext : -1;
if (FEAT_FLAGS.oppBonusPerColor) { COLOR_ZH.forEach((zh) => FEAT_NAMES.push('对手永久加成·' + zh)); featNext += 5; }
const N_FEAT = FEAT_NAMES.length;
const STATE_IDX = [0, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42];
// 新增的都是与动作无关的状态特征 → 同样进 Critic 的 psi（缺省时与旧版 STATE_IDX 相同）
if (OPP2_IDX >= 0) STATE_IDX.push(OPP2_IDX);
if (OPP_REM_IDX >= 0) for (let i = 0; i < COLOR_ZH.length; i++) STATE_IDX.push(OPP_REM_IDX + i);
if (OPP_BONUS_IDX >= 0) for (let i = 0; i < COLOR_ZH.length; i++) STATE_IDX.push(OPP_BONUS_IDX + i);
const N_STATE = STATE_IDX.length;
// 口径元数据：写进所有权重文件与 summary；--resume 防呆比对用的就是它
const META = {
  featFlags: { opp2: FEAT_FLAGS.opp2, oppRem: FEAT_FLAGS.oppRem, oppBonusPerColor: FEAT_FLAGS.oppBonusPerColor },
  nFeat: N_FEAT,
  hidden: HIDDEN,
  evalSeed: EVAL_SEED,
  evalGames: EVAL_GAMES,
  evalSeats: EVAL_SEATS.slice(),
  strWeights: STR_WEIGHTS || null,
  // 可调超参全量记录（新字段；旧检查点没有这些 = 按当时硬编码值跑出来的）
  alpha: ALPHA, beta: BETA, entCoef: ENT_COEF, shapeW: SHAPE_W,
  targetKl: TARGET_KL, gradClip: GRAD_CLIP, lrDecay: LR_DECAY, advNorm: ADV_NORM,
  sampleSeed: SAMPLE_SEED, rollbackStop: ROLLBACK_STOP,
  // 学习率调度生效参数（A/B 对照落档用）
  lrSchedule: SCHED_MODE, alphaFront: ALPHA_FRONT, betaFront: BETA_FRONT,
  alphaEnd: ALPHA_END, betaEnd: BETA_END, lrDecayTo: LR_DECAY_TO,
};
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
  // 多人数聚合：对手特征对"所有对手"取 max（理由见文件头注释），归一化常数与 3 人局一致
  const maxOf = (fn) => Math.max(...opps.map(fn));
  const bonus = H.bonusOf(p);
  const base = new Float64Array(N_FEAT);
  base[0] = 1;
  base[9] = p.points / TARGET;
  base[10] = (oppMax - p.points) / TARGET;
  base[11] = S.endTriggered ? 1 : 0;
  base[12] = p.balls.master / 3;
  base[13] = maxOf((x) => x.balls.master) / 3;
  base[14] = maxOf((x) => COLORS.reduce((s, c) => s + (H.bonusOf(x)[c] || 0), 0)) / 12;
  base[15] = p.reserved.length / 3;
  base[16] = p.reserved.reduce((s, c) => s + c.vp, 0) / 12;
  base[17] = maxOf((x) => x.reserved.length) / 3;
  const market = H.allMarketCards();
  base[18] = market.length / 14;
  base[19] = (market.length ? Math.max(...market.map((c) => c.vp)) : 0) / 5;
  base[20] = market.reduce((s, c) => s + c.vp, 0) / 40;
  base[21] = market.filter((c) => H.canAfford(p, c)).length / 6;
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
    const totals = opps.map((x) => H.totalBalls(x)).sort((a, b) => b - a);
    base[OPP2_IDX] = (totals.length >= 2 ? totals[1] : 0) / 10;
  }
  if (OPP_REM_IDX >= 0) {
    // 每色：max over 对手 max(0, need[c] − balls[c]) /5；
    // need 与启发式 globalNeed 同口径（可见卡最大缺口，不减已持有）
    COLORS.forEach((c, i) => {
      let mx = 0;
      opps.forEach((x) => { mx = Math.max(mx, Math.max(0, H.globalNeed(x)[c] - x.balls[c])); });
      base[OPP_REM_IDX + i] = mx / 5;
    });
  }
  if (OPP_BONUS_IDX >= 0) {
    // 每色：对手永久加成数的 max /5（威胁口径与"对手加成"总维度一致）
    COLORS.forEach((c, i) => { base[OPP_BONUS_IDX + i] = maxOf((x) => H.bonusOf(x)[c]) / 5; });
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
    if (r < cum) return { sc, pick: sc.moves[j], logp: sc.zs[j] - sc.lse, phi: sc.phis[j], pickIdx: j };
  }
  const j = sc.moves.length - 1;
  return { sc, pick: sc.moves[j], logp: sc.zs[j] - sc.lse, phi: sc.phis[j], pickIdx: j };
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
const poolPick = (rng) => pool[Math.floor(rng() * pool.length)];
function poolMove(p, def, member, rng) {
  if (member.kind === 'def') return def(p);
  if (member.kind === 'rand') {
    const moves = enumerateMoves(p);
    return moves.length ? moves[Math.floor(rng() * moves.length)] : null;
  }
  return greedyMove(member.actor, p);
}

/* ==================== 收集一局 ==================== */
function collectEpisode(seed, actor, rng) {
  H.seedRNG(seed); // 游戏 RNG：局面生成 / 对手 AI 全部走它（每局一个种子）
  const members = [];
  for (let i = 1; i < N_PLAYERS; i++) members.push(poolPick(rng)); // 对手池选择走采样 RNG
  let chosen = null;
  H.HOOKS.chooseAIMove = (p, def) => {
    if (p.id === 0) return chosen;
    return poolMove(p, def, members[p.id - 1], rng);
  };
  H.newGame({ target: TARGET, players: makePlayers(N_PLAYERS) });
  const traj = [];
  let pending = null;
  let guard = 0, finished = false, winnerSeat = -1;
  while (!S.over && guard < MAX_TURNS) {
    const p = H.curPlayer();
    if (p.id === 0) {
      const smp = sampleMove(actor, p, rng);
      chosen = smp.pick;
      if (pending) {
        pending.r = SHAPE_W * (p.points - pending.prevPts);
        traj.push(pending);
      }
      pending = smp.pick
        ? { phi: smp.phi, a: smp.pick, logp: smp.logp, aIdx: smp.pickIdx, ep: seed - BASE_SEED,
            prevPts: p.points, r: 0, movesPhi: smp.sc.phis }
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
// 全局 L2 梯度裁剪：两层网络的梯度拼成一个大向量，总长度（L2 范数）> maxNorm 时
// 全体按比例缩小。防单个异常批次的梯度把权重打飞（NaN 的前奏）；0 = 不调用
function clipGrads(net, maxNorm) {
  let sq = 0;
  net.dW.forEach((g) => { for (let i = 0; i < g.length; i++) sq += g[i] * g[i]; });
  net.db.forEach((g) => { for (let i = 0; i < g.length; i++) sq += g[i] * g[i]; });
  const norm = Math.sqrt(sq);
  if (!(norm > 0) || norm <= maxNorm) return;
  const s = maxNorm / norm;
  net.dW.forEach((g) => { for (let i = 0; i < g.length; i++) g[i] *= s; });
  net.db.forEach((g) => { for (let i = 0; i < g.length; i++) g[i] *= s; });
}
function ppoUpdate(actor, critic, batch, lrA, lrC) {
  // advantage 批内归一化（默认开）：(adv − mean) / (std + 1e-8)。
  // 只改整批的尺度、不改方向；防某一局的极端优势（赢局 +1 / 输局 −1 且整局很长时
  // GAE 会滚出大数）主导整批梯度（--no-adv-norm 关 = 旧行为）
  if (ADV_NORM) {
    let m = 0;
    for (const tr of batch) m += tr.adv;
    m /= batch.length;
    let v = 0;
    for (const tr of batch) { const d = tr.adv - m; v += d * d; }
    const den = Math.sqrt(v / batch.length) + 1e-8;
    for (const tr of batch) tr.adv = (tr.adv - m) / den;
  }
  let klStops = 0;
  for (let epoch = 0; epoch < K_EPOCHS; epoch++) {
    N.zeroGrads(actor); N.zeroGrads(critic);
    let klSum = 0;
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
      // 动作下标在 rollout 时就记进轨迹（tr.aIdx）——不能用 movesPhi.indexOf(tr.phi)：
      // Float64Array 按引用比较，任何重建/拷贝都会失配返回 -1 → logp=NaN → 梯度全 NaN
      const aIdx = tr.aIdx;
      const logpNew = zs[aIdx] - lse;
      const ratio = Math.exp(logpNew - tr.logp);
      // NaN 防御：logp/advantage/ratio 任何一个 NaN 说明权重已坏，直接抛错退出，
      // 绝不带着 NaN 静默继续训练（会无声污染后续所有检查点与最优权重）
      if (Number.isNaN(logpNew) || Number.isNaN(tr.logp) || Number.isNaN(tr.adv) || Number.isNaN(ratio)) {
        throw new Error(`NaN 防御触发：第 ${tr.ep} 局轨迹 logp旧=${tr.logp} logp新=${logpNew} adv=${tr.adv} ratio=${ratio}（动作 ${aIdx}/${zs.length}）。权重已坏，训练终止。`);
      }
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
      klSum += tr.logp - logpNew;
    }
    if (GRAD_CLIP > 0) { clipGrads(actor, GRAD_CLIP); clipGrads(critic, GRAD_CLIP); }
    N.adamStep(actor, lrA);
    N.adamStep(critic, lrC);
    // target-KL 早停：epoch 结束 KL≈mean(logp旧−logp新) 超阈值 = 这一步更新迈太大，
    // 跳过剩余 epoch（K_EPOCHS=2 时即不再跑第二个 epoch，多跑只会漂得更远）
    if (klSum / batch.length > TARGET_KL) { klStops++; break; }
  }
  return klStops;
}

/* ==================== 评估（按 --eval-seats 座位配置跑 AI 对打） ==================== */
// seatNets[i] = { kind: 'str'|'def'|'rand', net }（net 仅 str 座位需要）。
// 返回：seatWins/seatRates 分座位统计；winRate = 座位 0 str 的胜率（座位 0 非 str 时取
// 第一个 str 座位；一个 str 都没有 = null）；games = 逐局记录（--eval-only 落档用）。
function evalVs(seats, seatNets, seed0, nGames) {
  const n = N_PLAYERS;
  const seatWins = new Array(n).fill(0);
  const seatPts = new Array(n).fill(0);
  const seatEvo = new Array(n).fill(0);
  let finished = 0, leaks = 0, turnsSum = 0;
  const games = [];
  H.HOOKS.chooseAIMove = (p, def) => {
    const r = seatNets[p.id];
    if (r.kind === 'str') return greedyMove(r.net, p);
    if (r.kind === 'rand') { // 随机合法动作：走游戏种子 RNG（Math.random），同 seed 逐位复现
      const moves = enumerateMoves(p);
      return moves.length ? moves[Math.floor(Math.random() * moves.length)] : null;
    }
    return def(p);
  };
  for (let i = 0; i < nGames; i++) {
    const seed = seed0 + i;
    H.seedRNG(seed);
    H.newGame({ target: TARGET, players: makePlayers(N_PLAYERS) });
    let guard = 0;
    while (!S.over && guard < MAX_TURNS) { H.aiTurn(H.curPlayer()); guard++; }
    const ok = !!S.over;
    const leak = H.checkConservation();
    const pts = [], evo = [];
    S.players.forEach((p) => {
      pts.push(p.points); evo.push(p.evolutions);
      seatPts[p.id] += p.points; seatEvo[p.id] += p.evolutions;
    });
    let winnerSeat = -1;
    if (ok) { // 卡死局没有冠军：只计完成局的胜场，口径与旧版一致
      finished++;
      const rank = S.players.slice().sort((a, b) =>
        (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
      winnerSeat = rank[0].id;
      seatWins[winnerSeat]++;
    }
    if (leak) leaks++;
    turnsSum += S.turnIdx;
    games.push({ i, seed, winnerSeat, pts, evo, turns: S.turnIdx, finished: ok, leak: leak || null });
  }
  H.HOOKS.chooseAIMove = null;
  const strIdx = seats.indexOf('str');
  const primaryIdx = seats[0] === 'str' ? 0 : strIdx; // 主指标座位：优先座位 0，其次第一个 str，-1 = 无 str
  return {
    seats: seats.slice(),
    seatWins, finished, leaks, turnsSum, games,
    seatRates: seatWins.map((w) => (finished ? w / finished : 0)),
    avgPoints: seatPts.map((s) => s / nGames),
    avgEvolutions: seatEvo.map((s) => s / nGames),
    avgTurns: turnsSum / nGames,
    primaryIdx,
    winRate: primaryIdx >= 0 ? (finished ? seatWins[primaryIdx] / finished : 0) : null,
    wins: primaryIdx >= 0 ? seatWins[primaryIdx] : 0,
  };
}

// 读取权重文件里的 Actor 网（-best / -ckpt / 最终权重三种产物通用），口径不符直接退出
function loadActorNet(file, what) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`无法读取${what} ${file}：${e.message}`);
    process.exit(1);
  }
  if (!data.actor || data.actor.sizes.join(',') !== [N_FEAT, HIDDEN, 1].join(',')) {
    console.error(`${what}与当前脚本不一致（需 Actor MLP ${N_FEAT}→${HIDDEN}→1），不能评估。`);
    process.exit(1);
  }
  return { net: N.deserialize(data.actor), data };
}
// 权重文件 sha256 指纹（评估结果落档：换权重重评时靠它核对"评的到底是不是这份"）
const sha256Hex = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// 组装座位配置：座位 0 的 str = 被测策略，座位 ≥1 的 str = strNet（缺省传被测同网 = 自对弈）
const seatNetsOf = (primaryNet, strNet) =>
  EVAL_SEATS.map((s, i) => ({ kind: s, net: s === 'str' ? (i === 0 ? primaryNet : strNet) : null }));

/* ==================== 长跑基础设施：检查点 / 最优权重 / 日志 / 摘要 ==================== */
const weightsDir = path.join(__dirname, 'weights');
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(weightsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const ckptFile = path.join(weightsDir, `ppo-agent-p${N_PLAYERS}${tagSuffix}-ckpt.json`);
const bestFile = path.join(weightsDir, `ppo-agent-p${N_PLAYERS}${tagSuffix}-best.json`);
const logFile = path.join(dataDir, `ppo-agent-p${N_PLAYERS}${tagSuffix}.log`);
const summaryFile = path.join(dataDir, `ppo-agent-p${N_PLAYERS}${tagSuffix}.summary.json`);

// 本地时间戳（不用 toISOString：那是 UTC，日志要对得上人看的表，见踩坑库 B2）
function ts() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 屏幕 + 日志文件双写（日志写失败不中断训练）
function log(msg) {
  console.log(msg);
  try {
    fs.appendFileSync(logFile, `[${ts()}] ${msg}\n`);
  } catch (e) {
    console.error('（日志写入失败：' + e.message + '）');
  }
}

// 权重 + Adam 动量缓冲一起打包（N.serialize 只存 W/b，续跑会丢优化器状态）
function packNet(net) {
  return {
    sizes: net.sizes,
    W: net.W.map((a) => Array.from(a)),
    b: net.b.map((a) => Array.from(a)),
    mW: net.mW.map((a) => Array.from(a)),
    vW: net.vW.map((a) => Array.from(a)),
    mb: net.mb.map((a) => Array.from(a)),
    vb: net.vb.map((a) => Array.from(a)),
  };
}
function unpackNet(data) {
  const net = N.deserialize(data);
  for (let l = 0; l < net.W.length; l++) {
    net.mW[l].set(Float64Array.from(data.mW[l]));
    net.vW[l].set(Float64Array.from(data.vW[l]));
    net.mb[l].set(Float64Array.from(data.mb[l]));
    net.vb[l].set(Float64Array.from(data.vb[l]));
  }
  return net;
}

/* ==================== 只评估模式（--eval-only <权重文件>）：不训练，落档评估 JSON ==================== */
// 供备份恢复后的快检 / 多份权重横向对比 / AI 对打：直接读文件里的 actor 按 --eval-seats
// 跑评估。兼容三种产物：-best.json（actor/critic）、-ckpt.json（packNet 格式）、-N.json（最终权重）。
// 座位规则：座位 0 的 str = 本文件（被测）；座位 ≥1 的 str = --str-weights（缺省同被测网）。
// 产出 weights/<权重名>.eval-<座位>[.vs-<对打权重>].json：逐局记录 + 权重 sha256 指纹。
const EVAL_ONLY = flagVal('--eval-only', '');
if (hasFlag('--eval-only') && (!EVAL_ONLY || EVAL_ONLY.startsWith('--'))) {
  console.error(`参数错误：--eval-only 后面要跟权重文件路径（收到 "${EVAL_ONLY || '(缺值)'}"）`);
  process.exit(1);
}
if (EVAL_ONLY) {
  const file = path.resolve(__dirname, EVAL_ONLY);
  const { net: primaryNet, data } = loadActorNet(file, '权重文件');
  const strWeightsPath = STR_WEIGHTS ? path.resolve(__dirname, STR_WEIGHTS) : null;
  let strNet = primaryNet;
  if (strWeightsPath) {
    strNet = loadActorNet(strWeightsPath, '--str-weights 权重文件').net;
    if (!EVAL_SEATS.slice(1).includes('str')) {
      console.log(`提示：--str-weights 已指定但座位 ≥1 没有 str，该文件不参与对局（座位 0 的 str 恒用 --eval-only 文件）。`);
    }
  }
  const r = evalVs(EVAL_SEATS, seatNetsOf(primaryNet, strNet), EVAL_SEED, EVAL_GAMES);
  // —— 人类可读表格 → stdout ——
  const trained = data.players ? `（权重文件为 p${data.players} 人局训练）` : '';
  console.log(`评估 ${path.basename(file)}${trained}：${EVAL_GAMES} 局（p${N_PLAYERS} 人局，seed ${EVAL_SEED}）座位 [${EVAL_SEATS.join(', ')}]`);
  EVAL_SEATS.forEach((s, i) => {
    const src = s === 'str' ? (i === 0 ? '被测' : (strWeightsPath ? path.basename(strWeightsPath) : '与被测同网')) : '';
    console.log(`  座位 ${i} ${s}${src ? '（' + src + '）' : ''}：胜 ${String(r.seatWins[i]).padStart(3)} 局 ${(r.seatRates[i] * 100).toFixed(1)}% ｜ 平均分 ${r.avgPoints[i].toFixed(1)} ｜ 平均进化 ${r.avgEvolutions[i].toFixed(2)}`);
  });
  if (!EVAL_SEATS.includes('str')) console.log('  （无 str 座位：权重文件不参与对局，仅校验口径 + 指纹落档）');
  console.log(`  完成 ${r.finished}/${EVAL_GAMES} ｜ 平均回合 ${r.avgTurns.toFixed(1)} ｜ 守恒违规 ${r.leaks}`);
  // —— 评估结果 JSON → weights/ ——
  const evalSha = sha256Hex(file);
  // 对打权重与被测是同一份文件时不拼后缀（文件名不冗余；JSON 里仍记录两份指纹）
  const vsSuffix = (strWeightsPath && strWeightsPath !== file) ? '-vs-' + path.basename(strWeightsPath, '.json') : '';
  const evalOutFile = path.join(weightsDir, `${path.basename(file, '.json')}.eval-${EVAL_SEATS.join('-')}${vsSuffix}.json`);
  fs.writeFileSync(evalOutFile, JSON.stringify({
    name: path.basename(evalOutFile, '.json'),
    evalFile: path.basename(file),
    evalFileSha256: evalSha,
    strWeightsFile: strWeightsPath ? path.basename(strWeightsPath) : null,
    strWeightsSha256: strWeightsPath ? sha256Hex(strWeightsPath) : null,
    players: N_PLAYERS, target: TARGET,
    seats: r.seats, evalGames: EVAL_GAMES, evalSeed: EVAL_SEED,
    winRate: r.winRate, wins: r.wins, primarySeat: r.primaryIdx,
    finished: r.finished, leaks: r.leaks,
    seatRates: r.seatRates, seatWins: r.seatWins,
    avgPoints: r.avgPoints, avgEvolutions: r.avgEvolutions, avgTurns: r.avgTurns,
    fileBest: data.best ? { rate: data.best.rate, ep: data.best.ep }
      : (data.winRate != null ? { rate: data.winRate, ep: data.episodes } : null),
    games: r.games,
    createdAt: ts(),
  }, null, 2));
  console.log(`→ 已落档 ${path.basename(evalOutFile)}（被测权重 sha256 ${evalSha.slice(0, 12)}…）`);
  if (data.best) console.log(`文件内记录：best ${(data.best.rate * 100).toFixed(1)}%@${data.best.ep} 局`);
  else if (data.winRate != null) console.log(`文件内记录：winRate ${(data.winRate * 100).toFixed(1)}%@${data.episodes} 局`);
  process.exit(0);
}

/* ==================== 主循环 ==================== */
(async () => {
  let actor, critic, resumeFile = null;
  let startEp = 0, lastLeak = 0, lastStall = 0, klStops = 0, best = null;
  let evalCurve = [];
  if (RESUME) {
    const v = flagVal('--resume', ckptFile);
    resumeFile = (v && !String(v).startsWith('--')) ? path.resolve(__dirname, v) : ckptFile;
    let ckpt;
    try {
      ckpt = JSON.parse(fs.readFileSync(resumeFile, 'utf8'));
    } catch (e) {
      console.error(`无法读取检查点 ${resumeFile}：${e.message}`);
      process.exit(1);
    }
    if (ckpt.players !== N_PLAYERS) {
      console.error(`检查点人数不符：检查点是 ${ckpt.players} 人局，本次 --players ${N_PLAYERS}。换回原人数，或删掉检查点重新开练。`);
      process.exit(1);
    }
    // 断点续训防呆：meta 存在时逐项比对口径（特征开关/特征数/隐层宽），不一致直接报错退出
    if (ckpt.meta) {
      const diffs = [];
      if (ckpt.meta.hidden !== HIDDEN) diffs.push(`hidden：检查点 ${ckpt.meta.hidden}，本次 ${HIDDEN}`);
      if (ckpt.meta.nFeat !== N_FEAT) diffs.push(`nFeat：检查点 ${ckpt.meta.nFeat}，本次 ${N_FEAT}`);
      if (ckpt.meta.featFlags) {
        Object.keys(FEAT_FLAGS).forEach((k) => {
          if (!!ckpt.meta.featFlags[k] !== !!FEAT_FLAGS[k]) {
            diffs.push(`featFlags.${k}：检查点 ${!!ckpt.meta.featFlags[k]}，本次 ${!!FEAT_FLAGS[k]}`);
          }
        });
      }
      if (diffs.length) {
        console.error(`检查点与本次运行口径不一致，不能续跑：\n  - ${diffs.join('\n  - ')}`);
        process.exit(1);
      }
    }
    // 兜底：网络尺寸必须对得上（兼容没有 meta 的旧格式检查点）
    if (!ckpt.actor || !ckpt.critic
        || ckpt.actor.sizes.join(',') !== [N_FEAT, HIDDEN, 1].join(',')
        || ckpt.critic.sizes.join(',') !== [N_STATE, HIDDEN, 1].join(',')) {
      console.error('检查点网络结构与当前脚本不一致（特征数或隐层宽度变了），不能续跑。');
      process.exit(1);
    }
    actor = unpackNet(ckpt.actor);
    critic = unpackNet(ckpt.critic);
    startEp = ckpt.episodes || 0;
    lastLeak = (ckpt.counters && ckpt.counters.leaks) || 0;
    lastStall = (ckpt.counters && ckpt.counters.stalls) || 0;
    klStops = (ckpt.counters && ckpt.counters.klStops) || 0;
    if (Array.isArray(ckpt.evalCurve)) evalCurve = ckpt.evalCurve;
    // 评估曲线座位口径提示：检查点曲线与本次 --eval-seats 不同时提醒（曲线前后对比口径不同）
    const lastCurve = evalCurve[evalCurve.length - 1];
    if (lastCurve && Array.isArray(lastCurve.seats)
        && JSON.stringify(lastCurve.seats) !== JSON.stringify(EVAL_SEATS)) {
      console.log(`注意：检查点评估曲线座位口径 [${lastCurve.seats.join(',')}]，本次 [${EVAL_SEATS.join(',')}] —— 曲线前后对比口径不同，报数时请注明。`);
    }
    if (Array.isArray(ckpt.pool) && ckpt.pool.length) {
      pool.splice(0, pool.length, ...ckpt.pool.map((m) =>
        (m.kind === 'net'
          ? { name: m.name, kind: 'net', actor: N.deserialize(m.actor) }
          : { name: m.name, kind: m.kind })));
    }
    snapshots = pool.filter((m) => m.kind === 'net').length;
    if (ckpt.best && typeof ckpt.best.rate === 'number') {
      best = { rate: ckpt.best.rate, ep: ckpt.best.ep, actor: ckpt.best.actor, critic: ckpt.best.critic };
    }
  } else {
    // 初始化也走种子 RNG（两个网络种子分开，防止首层参数完全相同）
    actor = N.makeMLP([N_FEAT, HIDDEN, 1], H.mulberry32(SAMPLE_SEED));
    critic = N.makeMLP([N_STATE, HIDDEN, 1], H.mulberry32(SAMPLE_SEED + 1));
  }
  // 对打方权重（座位 ≥1 的 str）：缺省 = 当前模型（自对弈，评估时即时用最新 actor）
  let strNet = null, strWeightsPath = null;
  if (STR_WEIGHTS) {
    strWeightsPath = path.resolve(__dirname, STR_WEIGHTS);
    strNet = loadActorNet(strWeightsPath, '--str-weights 权重文件').net;
  }
  const totalEpisodes = startEp + nTrain;
  // —— 训练/评估种子范围校验（防泄题）——
  // 训练局种子 = [BASE_SEED, BASE_SEED+totalEpisodes)，评估局 = [EVAL_SEED, EVAL_SEED+EVAL_GAMES)。
  // 两区间重叠 = 评估局复用训练局的种子（背过的题再考），评测结果无效 → 拒绝开跑。
  // 用 totalEpisodes 而非本段 nTrain：续跑时历史局的种子也算"训练过"，同样不许评估复用。
  const TRAIN_LO = BASE_SEED;
  const TRAIN_HI = BASE_SEED + totalEpisodes;
  const EVAL_LO = EVAL_SEED;
  const EVAL_HI = EVAL_SEED + EVAL_GAMES;
  if (EVAL_LO < TRAIN_HI && EVAL_HI > TRAIN_LO) {
    console.error(`种子范围重叠，拒绝开跑：训练 [${TRAIN_LO}, ${TRAIN_HI}) 与评估 [${EVAL_LO}, ${EVAL_HI}) 有交集（${Math.max(TRAIN_LO, EVAL_LO)} ~ ${Math.min(TRAIN_HI, EVAL_HI)}）。\n  评估局会复用训练局的种子 = 泄题，评测结果无效。请换 --eval-seed（缺省 EVAL_SEED = BASE_SEED + 900000 = ${BASE_SEED + 900000}），或缩小 --eval-games 至不重叠。`);
    process.exit(1);
  }
  const thetaFile = `weights/ppo-agent-p${N_PLAYERS}${tagSuffix}-${totalEpisodes}.json`;
  const runStartedAt = new Date().toISOString();
  const t0 = Date.now();
  let batch = [], batchEps = 0;
  let ep = startEp, epDone = startEp;

  const newFeats = FEAT_NAMES.slice(BASE_FEAT_NAMES.length);
  const featDesc = newFeats.length ? `｜ 新增特征 ${newFeats.join('、')}（nFeat ${N_FEAT}）` : '';
  console.log(`ppo-agent（ppo-big-nn 人数参数化版）：p${N_PLAYERS}人局 ${RESUME ? `从检查点续跑 ${nTrain} 局（已完成 ${startEp}，累计目标 ${totalEpisodes}）` : `训练 ${nTrain} 局`}（Actor MLP ${N_FEAT}→${HIDDEN}→1 / Critic MLP ${N_STATE}→${HIDDEN}→1，批 ${BATCH_EPS} × ${K_EPOCHS} epoch）${featDesc}`);
  console.log('基准线：线性 PPO 峰值 60.5%（3 人局）｜ 对称基线 33.3%（3 人局）');
  let schedDesc;
  if (SCHED_MODE === 'front-zero') schedDesc = 'front-zero（α/β 全程 0，无学习对照）';
  else if (LR_DECAY) schedDesc = `decay10（α ${ALPHA_FRONT}→${ALPHA_END} ｜ β ${BETA_FRONT}→${BETA_END}，底线 ×${LR_DECAY_TO}，随本段进度线性）`;
  else schedDesc = `恒定（α ${ALPHA_FRONT} ｜ β ${BETA_FRONT}，--no-lr-decay）`;
  log(`种子：训练 [${TRAIN_LO}, ${TRAIN_HI}) ｜ 评估 [${EVAL_LO}, ${EVAL_HI})${EVAL_SEED === BASE_SEED + 900000 ? '（EVAL_SEED = BASE_SEED + 900000）' : '（--eval-seed 显式指定）'} ｜ 无重叠`);
  log(`调度：${schedDesc} ｜ 超参：α ${ALPHA} / β ${BETA} / ent ${ENT_COEF} / shapeW ${SHAPE_W} / targetKL ${TARGET_KL} / gradClip ${GRAD_CLIP} / advNorm ${ADV_NORM ? '开' : '关'} / sampleSeed ${SAMPLE_SEED} / rollbackStop ${ROLLBACK_STOP}`);
  log(`启动：${RESUME ? `恢复自 ${path.basename(resumeFile)}（守恒违规 ${lastLeak} ｜ 卡死 ${lastStall} ｜ 池 ${pool.length}）` : '全新开始'}；检查点每 ${CKPT_EVERY} 局 → ${path.basename(ckptFile)}；最优 → ${path.basename(bestFile)}；日志 → ${path.basename(logFile)}${evalCurve.length ? `；历史评估 ${evalCurve.length} 次，最新 ${(evalCurve[evalCurve.length - 1].rate * 100).toFixed(1)}%@${evalCurve[evalCurve.length - 1].ep} 局` : ''}${best ? `；历史最优 ${(best.rate * 100).toFixed(1)}%@${best.ep} 局` : ''}${newFeats.length || HIDDEN !== 32 ? `；口径 hidden ${HIDDEN} / nFeat ${N_FEAT}` : ''}`);
  log(`评估座位：[${EVAL_SEATS.join(',')}]（座位0=被测策略${STR_WEIGHTS ? `；座位≥1 str=${path.basename(strWeightsPath)}` : '；其余 str 与被测同网'}）${EVAL_SEATS[0] !== 'str' ? ' ⚠️ 座位0非str：评估不测学习者，最优判定跳过' : ''}`);

  /* ---------- 落盘工具（检查点 / 最优权重 / 摘要） ---------- */
  function buildCheckpoint(episodesDone) {
    return {
      name: `ppo-agent-p${N_PLAYERS}-ckpt`,
      players: N_PLAYERS,
      episodes: episodesDone,
      target: TARGET,
      meta: META,
      actor: packNet(actor),
      critic: packNet(critic),
      pool: pool.map((m) => (m.kind === 'net'
        ? { name: m.name, kind: m.kind, actor: N.serialize(m.actor) }
        : { name: m.name, kind: m.kind })),
      snapshots,
      evalCurve,
      counters: { leaks: lastLeak, stalls: lastStall, klStops },
      best: best ? { rate: best.rate, ep: best.ep, actor: best.actor, critic: best.critic } : null,
      createdAt: runStartedAt,
      updatedAt: new Date().toISOString(),
    };
  }
  function writeCkpt(episodesDone, reason) {
    fs.writeFileSync(ckptFile, JSON.stringify(buildCheckpoint(episodesDone)));
    log(`检查点已写：${episodesDone} 局（${reason}）→ ${path.basename(ckptFile)}`);
  }
  function writeBest() {
    fs.writeFileSync(bestFile, JSON.stringify({
      name: `ppo-agent-p${N_PLAYERS}-best`,
      players: N_PLAYERS, episodes: best.ep, target: TARGET, winRate: best.rate,
      meta: META,
      actor: best.actor, critic: best.critic,
      createdAt: runStartedAt, updatedAt: new Date().toISOString(),
    }));
    log(`新最优已落盘：第 ${best.ep} 局胜率 ${(best.rate * 100).toFixed(1)}% → ${path.basename(bestFile)}`);
  }
  function writeSummary(episodesDone, running) {
    const lastEval = evalCurve[evalCurve.length - 1] || null;
    fs.writeFileSync(summaryFile, JSON.stringify({
      name: `ppo-agent-p${N_PLAYERS}-${totalEpisodes}`,
      players: N_PLAYERS,
      episodes: totalEpisodes,
      episodesDone,
      running,
      resumedFrom: startEp,
      evalGames: EVAL_GAMES,
      winRate: lastEval ? lastEval.rate : null,
      wins: lastEval ? lastEval.wins : null,
      lastEval,
      best: best ? { rate: best.rate, ep: best.ep, file: path.basename(bestFile) } : null,
      evalCurve,
      poolSize: pool.length,
      leaks: lastLeak,
      stalls: lastStall,
      klStops,
      elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
      thetaFile,
      ckptFile: path.basename(ckptFile),
      seed: BASE_SEED, evalSeed: EVAL_SEED, evalSeats: EVAL_SEATS, strWeights: STR_WEIGHTS || null,
      meta: META,
      gamma: GAMMA, lambda: LAMBDA, clipEps: CLIP_EPS, alpha: ALPHA, beta: BETA,
      entCoef: ENT_COEF, shapeW: SHAPE_W, kEpochs: K_EPOCHS, batchEps: BATCH_EPS,
      targetKl: TARGET_KL, gradClip: GRAD_CLIP, lrDecay: LR_DECAY, advNorm: ADV_NORM,
      sampleSeed: SAMPLE_SEED, rollbackStop: ROLLBACK_STOP,
      lrSchedule: SCHED_MODE, alphaFront: ALPHA_FRONT, betaFront: BETA_FRONT,
      alphaEnd: ALPHA_END, betaEnd: BETA_END, lrDecayTo: LR_DECAY_TO,
      hidden: HIDDEN, nFeat: N_FEAT, nState: N_STATE, featNames: FEAT_NAMES,
      snapshots,
      createdAt: runStartedAt,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  /* ---------- 中断处理（Ctrl+C / kill）：先落盘再退 ---------- */
  let interrupted = false;
  const shutdown = (sig) => {
    if (interrupted) process.exit(1); // 连按两次：放弃落盘直接退
    interrupted = true;
    console.log(`\n收到 ${sig}：正在落盘（已完成 ${epDone} 局）...`);
    try {
      writeCkpt(epDone, sig);
      writeSummary(epDone, true);
      console.log(`检查点已保存。续跑：node 工具/rl/ppo-agent.js ${nTrain} ${EVAL_EVERY} --players ${N_PLAYERS}${TAG ? ` --tag ${TAG}` : ''} --resume`);
      process.exit(0);
    } catch (e) {
      console.error('中断落盘失败：' + e.message);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  /* ---------- 训练循环 ---------- */
  for (; ep < totalEpisodes; ep++) {
    epDone = ep + 1;
    const res = collectEpisode(BASE_SEED + ep, actor, H.mulberry32(SAMPLE_SEED + ep));
    if (res.leak) lastLeak++;
    if (!res.finished) lastStall++;
    const { adv, vTarget } = computeGAE(res.traj, critic);
    res.traj.forEach((tr, i) => { tr.adv = adv[i]; tr.vTarget = vTarget[i]; });
    batch.push(...res.traj);
    batchEps++;
    if (batchEps >= BATCH_EPS) {
      // 学习率调度生效值：decay10 = 前端值 → 前端值 × LR_DECAY_TO（随本段训练进度线性）；
      // --no-lr-decay 恒为前端值；front-zero 前端已置 0 → 恒 0（无学习对照）。每批更新前算一次
      const frac = (ep + 1 - startEp) / nTrain;
      const k = LR_DECAY ? 1 - (1 - LR_DECAY_TO) * frac : 1;
      klStops += ppoUpdate(actor, critic, batch, ALPHA_FRONT * k, BETA_FRONT * k);
      batch = []; batchEps = 0;
    }
    if ((ep + 1) % SNAPSHOT_EVERY === 0 && pool.length < 14) {
      pool.push({ name: 'snap' + (++snapshots), kind: 'net', actor: N.deserialize(N.serialize(actor)) });
    }
    if ((ep + 1) % CKPT_EVERY === 0) writeCkpt(ep + 1, '定时');
    if ((ep + 1) % EVAL_EVERY === 0) {
      // TODO(待确认语义后实现)：--rollback-stop 回滚 + 提前停训
      const r = evalVs(EVAL_SEATS, seatNetsOf(actor, strNet || actor), EVAL_SEED, EVAL_GAMES);
      evalCurve.push({ ep: ep + 1, rate: r.winRate, wins: r.wins, leaks: r.leaks, seats: r.seats, seatRates: r.seatRates, seatWins: r.seatWins });
      const label = `[${String(ep + 1).padStart(6)}/${totalEpisodes}]`;
      const tail = ` ｜ 池 ${pool.length}${r.leaks ? ' ⚠️违规' + r.leaks : ''}`;
      // 缺省座位保持旧日志文案（训练日志对比不断档）；自定义座位显示逐座位胜率
      const isDefaultSeats = EVAL_SEATS.every((s, i) => (i === 0 ? s === 'str' : s === 'def'));
      if (isDefaultSeats) {
        log(`  ${label} p${N_PLAYERS}人局 贪心 vs 启发式 ${(r.winRate * 100).toFixed(1)}%${tail}`);
      } else {
        log(`  ${label} p${N_PLAYERS}人局 [${EVAL_SEATS.join(',')}] 座位胜率 ${r.seatRates.map((x) => (x * 100).toFixed(1)).join('/')}${r.primaryIdx !== 0 ? '（座位0非str，不参与最优判定）' : ''}${tail}`);
      }
      // 最优判定只看座位 0 的被测策略（座位 0 非 str 时本轮与历史曲线不可比，跳过）
      if (r.primaryIdx === 0 && r.finished > 0 && r.winRate > (best ? best.rate : -Infinity)) {
        best = { rate: r.winRate, ep: ep + 1, actor: N.serialize(actor), critic: N.serialize(critic) };
        writeBest();
      }
      writeSummary(ep + 1, true);
    }
    if ((ep + 1) % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r)); // 让出事件循环，SIGINT 才有机会进来
  }

  /* ==================== 落盘 ==================== */
  // 若训练局数不足以触发任何一次评估，补跑一次（保证摘要里有胜率字段）
  let last = evalCurve[evalCurve.length - 1];
  if (!last) {
    const r = evalVs(EVAL_SEATS, seatNetsOf(actor, strNet || actor), EVAL_SEED, EVAL_GAMES);
    last = { ep: totalEpisodes, rate: r.winRate, wins: r.wins, leaks: r.leaks, seats: r.seats, seatRates: r.seatRates, seatWins: r.seatWins };
    evalCurve.push(last);
    if (r.primaryIdx === 0 && r.finished > 0 && r.winRate > (best ? best.rate : -Infinity)) {
      best = { rate: r.winRate, ep: totalEpisodes, actor: N.serialize(actor), critic: N.serialize(critic) };
      writeBest();
    }
  }

  const theta = {
    name: `ppo-agent-p${N_PLAYERS}-${totalEpisodes}`,
    players: N_PLAYERS, episodes: totalEpisodes, target: TARGET,
    meta: META,
    actor: N.serialize(actor), critic: N.serialize(critic),
    createdAt: runStartedAt, updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(weightsDir, `ppo-agent-p${N_PLAYERS}${tagSuffix}-${totalEpisodes}.json`), JSON.stringify(theta));
  writeCkpt(totalEpisodes, '训练完成'); // 完成后检查点保留：想继续加练时 --resume 还能接着跑
  writeSummary(totalEpisodes, false);
  const elapsed = Math.round((Date.now() - t0) / 100) / 10;

  log(`训练完成：p${N_PLAYERS}人局 守恒违规 ${lastLeak} ｜ 卡死 ${lastStall} ｜ KL 早停 ${klStops} ｜ 池 ${pool.length} ｜ 耗时 ${elapsed}s`);
  log(`最终胜率：${last.rate != null ? (last.rate * 100).toFixed(1) + '%' : '（无 str 座位，未测策略）'}（守恒违规 ${lastLeak}）｜ 权重 ${thetaFile}`);
  if (best) log(`历史最优：${(best.rate * 100).toFixed(1)}%（第 ${best.ep} 局）→ ${path.basename(bestFile)}`);
})().catch((e) => {
  console.error('训练异常退出：', e);
  process.exit(1);
});
