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

// 冠军权重：按房间人数分档（2026-09-18 交付口径）
//   2 人 → p2 83.5%（LEAGUE2 段 best）｜3 人 → p3 78.4%（LEAGUE4 段 best）｜4 人 → p4 77.3%（RANK 段 best）
//   权重缺失 / 口径不符 → 该档回退到 FALLBACKS（2 人档 → 旧 C1b 档），仍不行则 champion 座位退回内置启发式；
//   全程只打警告，绝不把异常抛到对局路径上。
const WEIGHTS_BY_PLAYERS = {
  2: ['ppo-agent-p2-LEAGUE2-p2-best.json'],
  3: ['ppo-agent-p3-LEAGUE4-p3-best.json'],
  4: ['ppo-agent-p4-RANK-p4-best.json'],
};
const FALLBACKS = ['ppo-agent-p2-LEAGUE2-p2-best.json', 'ppo-agent-p2-C1b-p2-best.json'];
const WEIGHTS_DIR = path.join(__dirname, '工具', 'rl', 'weights');
const WEIGHTS_FILE = path.join(WEIGHTS_DIR, WEIGHTS_BY_PLAYERS[2][0]); // 兼容导出（= 2 人档）

const cache = new Map();   // players → { actor, file, ... } | null
const errors = new Map();  // players → 失败原因（errorMessage 用）

function candidates(players) {
  const list = (WEIGHTS_BY_PLAYERS[players] || []).slice();
  FALLBACKS.forEach((f) => { if (!list.includes(f)) list.push(f); });
  return list.map((f) => path.join(WEIGHTS_DIR, f));
}

function loadFor(players) {
  if (cache.has(players)) return cache.get(players);
  let lastErr = null;
  for (const file of candidates(players)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data.actor || !Array.isArray(data.actor.sizes)) throw new Error('文件里没有 actor 网络');
      if (data.actor.sizes.join(',') !== '56,32,1') {
        throw new Error(`Actor 结构是 [${data.actor.sizes.join(',')}]，与冠军口径 [56,32,1] 不符`);
      }
      if (data.meta) {
        const ff = data.meta.featFlags || {};
        if (data.meta.nFeat != null && data.meta.nFeat !== 56) throw new Error(`特征数 ${data.meta.nFeat} ≠ 56，口径不符`);
        if (ff.opp2 || ff.oppRem || ff.oppBonusPerColor) throw new Error('权重带扩展特征开关，与 56 维冠军口径不符');
      }
      const info = {
        actor: N.deserialize(data.actor),
        file: path.basename(file),
        players: data.players, episodes: data.episodes,
        winRate: data.winRate != null ? data.winRate : (data.best && data.best.rate),
        createdAt: data.createdAt,
      };
      cache.set(players, info); errors.delete(players);
      const exact = (WEIGHTS_BY_PLAYERS[players] || [])[0] === info.file;
      console.log(`[冠军AI] ${players} 人局权重已加载（${exact ? '按人数分档' : '回退'}）：${info.file}`
        + `（p${info.players} 人局训练，${info.episodes} 局，历史胜率 ${(info.winRate * 100).toFixed(1)}%）`);
      return info;
    } catch (e) { lastErr = e; }
  }
  cache.set(players, null);
  errors.set(players, lastErr ? lastErr.message : '无候选权重文件');
  console.error(`[冠军AI] ${players} 人局权重加载失败（该档冠军座位退回启发式）：${errors.get(players)}`);
  return null;
}

// 启动时预加载 2 人档（服务日志能看到冠军是否就绪）；3/4 人档首次用到时懒加载
const defaultInfo = loadFor(2);

function isReady(players) { return (players == null ? defaultInfo : loadFor(players)) != null; }
function errorMessage(players) {
  const k = players == null ? 2 : players;
  return isReady(k) ? null : (errors.get(k) || '权重未就绪');
}
function metaOf(players) {
  const info = players == null ? defaultInfo : loadFor(players);
  return info ? { file: info.file, players: info.players, episodes: info.episodes, winRate: info.winRate, createdAt: info.createdAt } : null;
}

// 直接决策（约定调用前全局 S 已指向 p 所在对局；服务器路径请用 installHook）
function chooseMove(p) { return defaultInfo ? P.greedyMove(defaultInfo.actor, p) : null; }

// 把冠军决策挂到房间会话：champion 座位走策略网络（按本房人数选档），其他 AI 座位走内置启发式。
// 权重没就绪时 champion 座位退回启发式兜底（正常流程在 startGame 已被拦截，这里是双保险）。
function installHook(session) {
  session.HOOKS.chooseAIMove = (p, def) => {
    if (p.aiLevel !== 'champion') return def(p);
    // 按本房人数取对应档位（缺失则回退档 → 再不行退回启发式）
    const nPlayers = (session.S && Array.isArray(session.S.players)) ? session.S.players.length : 2;
    const info = loadFor(nPlayers) || defaultInfo;
    if (!info) return def(p);
    const prev = global.S;
    global.S = session.S; // 策略读全局 S：暂时指向本房对局（读完还原）
    try {
      return P.greedyMove(info.actor, p);
    } finally {
      global.S = prev;
    }
  };
}

module.exports = {
  isReady, isReadyFor: isReady, errorMessage, chooseMove, installHook,
  meta: metaOf(2), metaOf, WEIGHTS_BY_PLAYERS, WEIGHTS_DIR, WEIGHTS_FILE,
};
