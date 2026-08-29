/* ════════════════════════════════════════════════════════════════
   卡牌表生成工具
   ────────────────────────────────────────────────────────────────
   用法：node 生成卡牌表.js
   它会根据下面的【费用模板】【名字池】【加成规则】随机生成
   80 张卡，并整体重写 config.js（⚠️ 会覆盖你在 config.js
   里手工改过的卡牌数值）。

   日常小调整 → 直接手改 config.js 的卡牌表；
   整体重新平衡 → 改本文件的模板后重新运行。
   ════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 费用模板 ----------
   每格 = [红, 蓝, 黑, 粉, 黄]，生成时会随机洗乱颜色顺序。
   定价参照官方：一阶0分2~4费(以2~3费为主)、一阶1分3~4费、
   二阶1分4~5费、二阶2分5~6费、二阶3分6~7费、三阶3~5分6~10费 */
const COST_PATTERNS = {
  1: {
    0: [
      [1,1,0,0,0],[2,0,0,0,0],[1,1,0,0,0],[2,0,0,0,0],
      [2,1,0,0,0],[1,1,1,0,0],[3,0,0,0,0],[2,1,0,0,0],
      [2,2,0,0,0],[3,1,0,0,0],[2,1,0,0,0],[1,1,1,0,0],
      [3,0,0,0,0],[2,1,1,0,0],[3,1,0,0,0],[2,2,0,0,0],
    ],
    1: [[3,0,0,0,0],[2,1,0,0,0],[1,1,1,0,0],[4,0,0,0,0],[2,2,0,0,0],[2,1,1,0,0]],
  },
  2: {
    1: [[4,0,0,0,0],[3,1,0,0,0],[2,2,0,0,0],[1,1,1,1,0],[3,1,1,0,0],[2,2,1,0,0],[4,1,0,0,0]],
    2: [[3,2,0,0,0],[4,1,0,0,0],[5,0,0,0,0],[2,2,1,0,0],[3,1,1,0,0],[2,2,2,0,0]],
    3: [[6,0,0,0,0],[4,2,0,0,0],[5,1,0,0,0],[3,3,0,0,0],[3,2,1,0,0],[4,2,1,0,0]],
  },
  3: {
    3: [[5,2,0,0,0],[6,0,0,0,0],[4,3,0,0,0],[3,3,1,0,0],[7,0,0,0,0]],
    4: [[6,2,0,0,0],[7,1,0,0,0],[5,3,0,0,0],[4,4,1,0,0],[5,4,0,0,0]],
    5: [[7,2,0,0,0],[6,3,0,0,0],[7,3,0,0,0],[5,4,1,0,0],[6,4,0,0,0],[8,1,0,0,0]],
  },
};
// 每阶牌堆的分数分布：{分数: 数量}（官方：40/30/10 张）
const DECK_PLAN = { 1: { 0: 32, 1: 8 }, 2: { 1: 10, 2: 10, 3: 10 }, 3: { 3: 3, 4: 4, 5: 3 } };
// 加成色避开费用色的概率（越接近 1，越要求跨色发展）
const BONUS_NOT_IN_COST = 0.85;

/* ---------- 宝可梦名字池（一阶40 / 二阶30 / 三阶10，与牌堆数量一致） ---------- */
const POKE_NAMES = {
  1: ['皮卡丘','伊布','波波','小拉达','走路草','鲤鱼王','可达鸭','六尾','喵喵','地鼠',
      '尼多兰','蚊香蝌蚪','大舌贝','超音蝠','卡蒂狗','小磁怪','凯西','鬼斯','腕力','妙蛙种子',
      '小火龙','杰尼龟','皮皮','胖丁','绿毛虫','独角虫','毛球','蛋蛋','墨海马','角金鱼',
      '海星星','大钳蟹','猴怪','穿山鼠','阿柏蛇','雷电球','臭泥','小拳石','尼多朗','小海狮'],
  2: ['雷丘','比雕','拉达','霸王花','暴鲤龙','哥达鸭','九尾','猫老大','三地鼠','尼多娜',
      '蚊香君','铁甲贝','大嘴蝠','风速狗','三合一磁怪','勇基拉','鬼斯通','豪力','妙蛙草','火恐龙',
      '卡咪龟','皮可西','胖可丁','水伊布','雷伊布','火伊布','大岩蛇','嘎啦嘎啦','哈克龙','飞天螳螂'],
  3: ['喷火龙','水箭龟','妙蛙花','快龙','耿鬼','胡地','怪力','沙奈朵','路卡利欧','甲贺忍蛙'],
};

/* ---------- 工具函数 ---------- */
const COLORS = ['red', 'blue', 'black', 'pink', 'yellow'];
function shuffle(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

/* ---------- 生成 80 张卡 ---------- */
function buildRows() {
  const rows = { 1: [], 2: [], 3: [] };
  [1, 2, 3].forEach((tier) => {
    const names = shuffle(POKE_NAMES[tier]);
    let k = 0;
    for (const vpKey of Object.keys(DECK_PLAN[tier])) {
      const vp = +vpKey, count = DECK_PLAN[tier][vp];
      const pats = shuffle(COST_PATTERNS[tier][vp]);
      for (let i = 0; i < count; i++) {
        const perm = shuffle([0, 1, 2, 3, 4]); // 随机洗乱费用颜色顺序
        const vals = [0, 0, 0, 0, 0];
        perm.forEach((ci, idx) => { vals[ci] = pats[i % pats.length][idx]; });
        const costCols = COLORS.filter((c, idx) => vals[idx] > 0);
        const bonus = (Math.random() < BONUS_NOT_IN_COST)
          ? pick(COLORS.filter((c) => !costCols.includes(c)))
          : pick(COLORS);
        rows[tier].push({ name: names[k], tier, vp, vals, bonus });
        k++;
      }
    }
  });
  return rows;
}

/* ---------- 拼出 config.js 全文 ---------- */
const CONFIG_HEADER = `/* ════════════════════════════════════════════════════════════════
   游戏数据配置（config.js）—— 想调整数值，改这个文件就够了！
   ────────────────────────────────────────────────────────────────
   · 游戏逻辑全部在 game-core.js，这里只放"数据"
   · 改完保存，刷新浏览器（Ctrl+F5）立即生效（服务器需重启）
   ⚠️ 本文件可以由「生成卡牌表.js」整体重新生成（会覆盖手工修改）
   ════════════════════════════════════════════════════════════════ */

// Node 环境（服务器）下用 global 充当 window，浏览器不受影响
if (typeof window === 'undefined') { global.window = global; }

/* ---------- 1. 精灵球 ----------
   key 是颜色代号（游戏逻辑使用，不要改），name 是显示名，
   top / band 是球的配色，light 是卡牌底色 */
window.BALLS = {
  red:    { name: '普通球', top: '#e3350d', light: '#fde9e4', band: '#24303d' },
  blue:   { name: '超级球', top: '#2f6fdb', light: '#e4edfd', band: '#24303d' },
  black:  { name: '高级球', top: '#2e2e36', light: '#e9e9ee', band: '#ffcb05' },
  pink:   { name: '治愈球', top: '#f58fb8', light: '#fdeaf3', band: '#24303d' },
  yellow: { name: '快速球', top: '#ffcb05', light: '#fdf6d8', band: '#24303d' },
  master: { name: '大师球', top: '#8e44c7', light: '#f1e8fb', band: '#e84393' },
};
// 五种基础球的颜色代号（不要改）
window.COLORS = ['red', 'blue', 'black', 'pink', 'yellow'];

/* ---------- 2. 基础规则 ---------- */
window.RULES = {
  handLimit: 10,             // 手牌上限：最多持有几个精灵球（含大师球）
  poolPerPlayer: [0, 0, 4, 5, 7], // 下标=玩家人数(2/3/4)：每种基础球开局放几个
  masterCount: 5,            // 大师球总数（万能球，只能通过预约获得）
  reserveLimit: 3,           // 每人最多预约几张卡
  takeMasterAlone: false,    // 允许"只拿大师球、不预约卡"的独立行动（官方规则=false；true=开放该行动）
  marketSize: 4,             // 每个阶层在场上翻开几张卡
  takeTwoMin: 4,             // 拿 2 个相同球时，供应区该色至少有几个
  targets: [15, 18],         // 设置界面可选的目标分数
  defaultTarget: 18,         // 默认目标分数
};

/* ---------- 3. 电脑 AI ---------- */
window.AI_CONFIG = {
  thinkMin: 750,             // 电脑思考最短时间（毫秒）
  thinkMax: 1400,            // 电脑思考最长时间（毫秒）
  easyRandomRate: 0.45,      // 简单电脑随机乱走的概率（0~1，越大越笨）
  engineCards: 5,            // 困难电脑前期先攒够几张卡，才去追三阶卡
};

/* ---------- 4. 联机设置 ---------- */
window.NETWORK = {
  port: 3000,                // 服务器端口（启动 node server.js 后访问 http://局域网IP:端口）
  turnTimeoutSec: 30,        // 玩家断线后，轮到他时多少秒自动跳过
  maxPlayers: 4,             // 最多几个人类玩家
};

`;

const CARD_HEADER = `/* ---------- 5. 卡牌表（80 张） ----------
   每一行 = 一张卡，格式：
   [名称, 阶(1/2/3), 分数, 红, 蓝, 黑, 粉, 黄, 加成色]
   · 费用五个数：需要几个 普通球/超级球/高级球/治愈球/快速球
   · 加成色：收服后永久减免哪种球的费用（red/blue/black/pink/yellow）
   · 想改某只宝可梦的强度 → 直接改它所在的行
   · 想加新宝可梦 → 复制一行，改名称和数值即可 */
window.CARD_TABLE = [
`;

function fmtRow(r) {
  const total = r.vals.reduce((a, b) => a + b, 0);
  return `  ['${r.name}', ${r.tier}, ${r.vp}, ${r.vals.join(', ')}, '${r.bonus}'], // ${r.vp}分·费${total}`;
}

const TIER_LABEL = { 1: '一阶（0~1分，前期打基础）', 2: '二阶（1~3分，中期攒分）', 3: '三阶（3~5分，后期冲刺）' };

const rows = buildRows();
let body = '';
[1, 2, 3].forEach((t) => {
  body += `  // —— ${TIER_LABEL[t]} ——\n`;
  rows[t].forEach((r) => { body += fmtRow(r) + '\n'; });
  body += '\n';
});
body += '];\n\n';
body += '/* Node 环境（服务器）用 require 加载本文件时，把数据导出 */\n';
body += "if (typeof module !== 'undefined' && module.exports) { module.exports = window; }\n";

const out = CONFIG_HEADER + CARD_HEADER + body;
const target = path.join(__dirname, 'config.js');
fs.writeFileSync(target, out, 'utf8');
console.log('✅ 已生成 config.js：');
[1, 2, 3].forEach((t) => {
  const byVp = {};
  rows[t].forEach((r) => { byVp[r.vp] = (byVp[r.vp] || 0) + 1; });
  const avg = (rows[t].reduce((s, r) => s + r.vals.reduce((a, b) => a + b, 0), 0) / rows[t].length).toFixed(1);
  console.log(`    ${t}阶 ${rows[t].length} 张（${JSON.stringify(byVp)}），平均费用 ${avg}`);
});
