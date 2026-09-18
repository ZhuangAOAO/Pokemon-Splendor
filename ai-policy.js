'use strict';
/* ==================== 冠军 AI 接入层（联机服务器用） ====================
 * 把 RL 训练出的冠军权重接到联机对局里：
 *   1. 加载 工具/rl/weights/ppo-agent-p2-C1b-p2-best.json（贪心策略 Actor MLP 56→32→1），
 *      isReady() 只在权重加载成功且口径一致时为 true。
 *   2. installHook(session) 挂在每个房间会话的 HOOKS.chooseAIMove 上：
 *      座位是 champion 的电脑走策略网络（policy-core 的 greedyMove），
 *      其余电脑座位原样走内置启发式（def = chooseAIMoveDefault）。
 *
 * 依赖（只 require 工具/rl 下的纯模块，绝不 require harness —— 它会把
 * global.setTimeout 打桩成空函数，炸掉服务器的真定时器）：
 *   工具/rl/nn.js            前向传播
 *   工具/rl/policy-core.js   动作枚举 + 56 维特征 + greedy 决策（与训练同源）
 *
 * 全局状态约定（policy-core 文件头有完整说明）：
 *   策略代码读裸全局 S / canAfford 等（config.js + game-core.js 挂到 window 的
 *   那套）。服务器每个房间是独立的 createSession()，全局 S 是"默认会话"而不是
 *   本房对局 —— 所以 champion 决策期间把全局 S 临时指向本房对局，决策完还原。
 *   Node 单线程 + 决策函数同步执行，多个房间并发不会有交叉污染。
 */

const fs = require('fs');
const path = require('path');

const N = require('./工具/rl/nn');
const P = require('./工具/rl/policy-core');

// 冠军权重口径：56 维基础特征、隐藏层 32、Actor MLP 56→32→1（与权重文件 meta 防呆比对）
P.configure({ opp2: false, oppRem: false, oppBonusPerColor: false });

const WEIGHTS_FILE = path.join(__dirname, '工具', 'rl', 'weights', 'ppo-agent-p2-C1b-p2-best.json');
let actor = null;      // 贪心策略网络（就绪时非空）
let error = null;      // 加载失败原因（isReady() 为 false 时给提示用）
let meta = null;       // 权重文件的口径元数据（报数用）

try {
  const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
  if (!data.actor || !Array.isArray(data.actor.sizes)) throw new Error('文件里没有 actor 网络');
  if (data.actor.sizes.join(',') !== '56,32,1') {
    throw new Error(`Actor 结构是 [${data.actor.sizes.join(',')}]，与冠军口径 [56,32,1] 不符`);
  }
  if (data.meta) {
    const ff = data.meta.featFlags || {};
    if (data.meta.nFeat != null && data.meta.nFeat !== 56) throw new Error(`特征数 ${data.meta.nFeat} ≠ 56，口径不符`);
    if (ff.opp2 || ff.oppRem || ff.oppBonusPerColor) throw new Error('权重带扩展特征开关，与 56 维冠军口径不符');
  }
  actor = N.deserialize(data.actor);
  meta = {
    file: path.basename(WEIGHTS_FILE),
    players: data.players, episodes: data.episodes,
    winRate: data.winRate != null ? data.winRate : (data.best && data.best.rate),
    createdAt: data.createdAt,
  };
  console.log(`[冠军AI] 权重已加载：${meta.file}（p${meta.players} 人局训练，${meta.episodes} 局，历史胜率 ${(meta.winRate * 100).toFixed(1)}%）`);
} catch (e) {
  error = e;
  console.error(`[冠军AI] 权重加载失败（冠军座位将不可用）：${e.message}`);
}

function isReady() { return actor != null; }
function errorMessage() { return error ? error.message : null; }

// 直接决策（约定调用前全局 S 已指向 p 所在对局；服务器路径请用 installHook）
function chooseMove(p) { return P.greedyMove(actor, p); }

// 把冠军决策挂到房间会话：champion 座位走策略网络，其他 AI 座位走内置启发式。
// 权重没就绪时 champion 座位退回启发式兜底（正常流程在 startGame 已被拦截，这里是双保险）。
function installHook(session) {
  session.HOOKS.chooseAIMove = (p, def) => {
    if (!actor || p.aiLevel !== 'champion') return def(p);
    const prev = global.S;
    global.S = session.S; // 策略读全局 S：暂时指向本房对局（读完还原）
    try {
      return P.greedyMove(actor, p);
    } finally {
      global.S = prev;
    }
  };
}

module.exports = { isReady, errorMessage, chooseMove, installHook, meta, WEIGHTS_FILE };
