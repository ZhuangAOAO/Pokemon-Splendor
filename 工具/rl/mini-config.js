/* ==================== 迷你版璀璨宝石配置（阶段 C 专用） ====================
 * 把游戏砍到"状态能枚举"：2 种颜色、市场 1 格、无大师球/进化/预约、目标 3 分。
 * 复用真实 game-core.js 引擎，只换这一份 config。
 * ⚠️ 与真实 config.js 二选一加载（mini-env.js vs harness.js），勿同进程混用。
 *
 * 设计要点（对应第 06 课 Q26 / 第 07 课 §8 的"迷你版"方案）：
 * - COLORS 砍到 2 色 → 每人球状态 (0-4)×(0-4) = 25 种，可枚举
 * - masterCount 0 → 启发式 AI 的预约/盲抽分支因 pool.master=0 永不触发
 * - EVO_LINES [] → 无进化
 * - marketSizes {1:1} → 市场只放 1 张卡（⚠️ 2~5 阶不能写 0——game-core 的
 *   `RULES.marketSizes[t] || 默认值` 会把 0 当缺省；靠"牌堆为空"实现空市场）
 * - takeTwoMin 99 → 禁用 take2
 * - 12 张 1 阶卡、全 1 分、5 种成本 + 加成色组合（加成 = 真游戏里的"引擎经济"）
 */

window.BALLS = {
  red:    { name: '红球', top: '#e3350d', light: '#fde9e4', band: '#24303d' },
  blue:   { name: '蓝球', top: '#2f6fdb', light: '#e4edfd', band: '#24303d' },
  master: { name: '大师球', top: '#8e44c7', light: '#f1e8fb', band: '#e84393' },
};
window.COLORS = ['red', 'blue'];

window.RULES = {
  handLimit: 4,               // 手牌上限：最多 2+2 个球，永不触发弃球
  poolPerPlayer: [0, 0, 3, 5, 7], // 下标=人数：2 人局每色供应 3 个（2 个会允许单人囤光池子锁死对手，见 qlearn 卡死教训）
  masterCount: 0,             // 无大师球
  reserveLimit: 3,
  takeMasterAlone: false,
  marketSizes: { 1: 1 },      // 市场只放 1 张 1 阶卡
  takeTwoMin: 99,             // 禁用 take2
  targets: [3],
  defaultTarget: 3,
};

window.AI_CONFIG = { thinkMin: 0, thinkMax: 0, easyRandomRate: 0.45, engineCards: 5 };

// 行格式：[名字, 阶数, 分, 红费, 蓝费, 黑费, 粉费, 黄费, 加成色, 大师球费]
// 成本模式（红费-蓝费-加成色）共 8 种：
window.CARD_TABLE = [
  ['迷你卡01', 1, 1, 1, 0, 0, 0, 0, 'red', 0],
  ['迷你卡02', 1, 1, 1, 0, 0, 0, 0, 'red', 0],
  ['迷你卡03', 1, 1, 0, 1, 0, 0, 0, 'blue', 0],
  ['迷你卡04', 1, 1, 0, 1, 0, 0, 0, 'blue', 0],
  ['迷你卡05', 1, 1, 2, 0, 0, 0, 0, 'red', 0],
  ['迷你卡06', 1, 1, 2, 0, 0, 0, 0, 'red', 0],
  ['迷你卡07', 1, 1, 0, 2, 0, 0, 0, 'blue', 0],
  ['迷你卡08', 1, 1, 0, 2, 0, 0, 0, 'blue', 0],
  ['迷你卡09', 1, 1, 1, 1, 0, 0, 0, 'red', 0],
  ['迷你卡10', 1, 1, 1, 1, 0, 0, 0, 'blue', 0],
  ['迷你卡11', 1, 1, 1, 0, 0, 0, 0, 'blue', 0],
  ['迷你卡12', 1, 1, 0, 1, 0, 0, 0, 'red', 0],
];

window.EVOLUTION_LINES = [];
window.EVOLUTION_NEEDS = {};
