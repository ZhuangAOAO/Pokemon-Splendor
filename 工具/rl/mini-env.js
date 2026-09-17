'use strict';
/* ==================== 迷你环境加载器（阶段 C 专用） ====================
 * eval 加载 mini-config.js + game-core.js，提供种子 RNG / 记录 / 守恒校验。
 *
 * ⚠️ 与 harness.js **不共进程**：两者都往 window 写全局（COLORS / S / newGame …），
 *    同一进程 require 会互相覆盖。每个脚本只 require 其中一份：
 *    - 真实游戏实验 → harness.js（seed-demo / bandit-battle）
 *    - 迷你游戏实验 → mini-env.js（qlearn）
 *
 * 结构注意事项与 harness.js 相同：自己的导出必须写在 eval 之后（config 的
 * Node 导出会污染 module.exports）；全程用 window 路径的裸名。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

global.window = global;
global.setTimeout = () => 0; // 打桩（注意：思考延时表达式仍会消耗 1 次随机数）

eval(
  fs.readFileSync(path.join(__dirname, 'mini-config.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(ROOT, 'game-core.js'), 'utf8')
);

/* ==================== 种子 RNG（与 harness 同款 mulberry32） ==================== */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedRNG(seed) { Math.random = mulberry32(seed); }

/* ==================== 对局记录（格式同 server 回放） ==================== */
function makeRecorder() {
  const rec = [];
  HOOKS.onAction = (kind, params) => {
    rec.push({ k: kind, p: JSON.parse(JSON.stringify(params)), seat: S.current, t: S.turnIdx });
  };
  return rec;
}

/* ==================== 守恒校验（防非法动作污染状态） ==================== */
function checkConservation() {
  let cards = 0;
  [1, 2, 3, 4, 5].forEach((t) => {
    cards += S.decks[t].length;
    S.market[t].forEach((c) => { if (c) cards++; });
  });
  S.players.forEach((p) => { cards += p.cards.length + p.reserved.length + p.dex.length; });
  if (cards !== CARD_TABLE.length) return '卡牌守恒：' + cards + ' ≠ ' + CARD_TABLE.length;
  const n = S.players.length;
  for (const c of COLORS) {
    let balls = S.pool[c];
    S.players.forEach((p) => { balls += p.balls[c]; });
    if (balls !== RULES.poolPerPlayer[n]) return '球守恒(' + c + ')：' + balls + ' ≠ ' + RULES.poolPerPlayer[n];
  }
  let master = S.pool.master;
  S.players.forEach((p) => { master += p.balls.master; });
  if (master !== RULES.masterCount) return '大师球守恒：' + master + ' ≠ ' + RULES.masterCount;
  return null;
}

/* ==================== 导出（必须在 eval 之后） ==================== */
module.exports = {
  mulberry32, seedRNG, makeRecorder, checkConservation,
  ROOT,
  COLORS, BALLS, RULES, CARD_TABLE, // mini-config 数据
  // game-core 会话 API（window 路径 = B 会话）
  newGame, aiTurn, curPlayer, totalBalls, canAfford, HOOKS,
  get S() { return S; },
};
