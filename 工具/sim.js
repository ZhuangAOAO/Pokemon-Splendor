/* ================================================================
   AI 模拟测试：无需浏览器，用 node 无头运行多局电脑对战
   用法：node 工具/sim.js [局数] [人数] [目标分]（在项目根目录运行）
   例：node 工具/sim.js 30 3 18
   ================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

// 读取配置 + 游戏核心（node 中没有 document，核心不碰 DOM）
global.window = global;
// 打桩 setTimeout：模拟是同步循环驱动 AI 的，不需要真实定时器。
// 否则每局会积压上千个 AI 定时器，脚本跑完后事件循环里会形成无限的 AI 自战链条。
global.setTimeout = () => 0;
// 默认用项目根目录的 game-core.js；SIM_GAMECORE=<路径> 可指定别的版本做「改前/改后」对照（不用替换正在用的文件）
const gcPath = process.env.SIM_GAMECORE
  ? path.resolve(process.env.SIM_GAMECORE)
  : path.join(__dirname, '..', 'game-core.js');
const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
const src = fs.readFileSync(gcPath, 'utf8');
if (process.env.SIM_GAMECORE) console.log('⚠️ 本次用替代 game-core：' + gcPath);

const nGames = +process.argv[2] || 20;
const nPlayers = +process.argv[3] || 3;
const target = +process.argv[4] || 18;
// --note "说明" 给这次跑法打标记；--no-ledger 只跑不落档（冒烟用，免得刷台账）
const noteIdx = process.argv.indexOf('--note');
const note = noteIdx > 0 ? (process.argv[noteIdx + 1] || '') : '';
const noLedger = process.argv.includes('--no-ledger');

// game.js 以 'use strict' 开头，直接 eval 时声明不会泄漏到调用作用域，
// 因此把测试代码拼接在源码后面，放进同一个 eval 作用域里执行。
const test = `
;(function __runSim() {
  const nGames = ${JSON.stringify(nGames)};
  const nPlayers = ${JSON.stringify(nPlayers)};
  const target = ${JSON.stringify(target)};
  const names = ['A', 'B', 'C', 'D'];
  const note = ${JSON.stringify(note)};
  const wins = {};
  let turns = 0, finished = 0, guardHits = 0, leaks = 0, evos = 0;
  const avgPoints = [], maxPoints = [];

  for (let g = 0; g < nGames; g++) {
    const types = ['hard', 'hard', 'hard', 'hard'].slice(0, nPlayers);
    // 让首位玩家轮流使用简单/困难 AI，检验两种 AI 都会正常行动
    types[0] = g % 2 === 0 ? 'hard' : 'easy';
    const cfg = { target, players: types.map((t, i) => ({ name: names[i], type: t })) };
    newGame(cfg);
    const turnsTaken = new Array(nPlayers).fill(0); // 公平轮校验：每人行动次数

    let guard = 0;
    while (!S.over && guard < 800) {
      const cur = S.current;
      aiTurn(curPlayer());
      turnsTaken[cur]++;
      guard++;
      if (S.phase === 'discard') { console.error('第' + g + '局：出现未处理的弃球阶段！'); break; }
    }
    // ---- 公平轮校验：终局时每名玩家行动次数必须完全相同 ----
    if (S.over) {
      const mx = Math.max(...turnsTaken), mn = Math.min(...turnsTaken);
      if (mx !== mn) { leaks++; console.error('第' + g + '局：公平轮违规！行动次数 ' + turnsTaken.join('/')); }
    }
    if (!S.over) {
      guardHits++;
      console.log('第' + g + '局：800 回合内未结束 —— 诊断信息：');
      console.log('  供应区:', JSON.stringify(S.pool));
      S.players.forEach((pp) => {
        console.log('  ' + pp.name + ' 球:', JSON.stringify(pp.balls), '预约:', pp.reserved.map((c) => c.name + '(' + c.vp + '分)').join(','), '分:', pp.points);
      });
      [1, 2, 3, 4, 5].forEach((t) => {
        console.log('  场上' + t + '阶:', S.market[t].map((c) => c ? c.name + '(需' + JSON.stringify(c.cost) + ',' + c.vp + '分)' : '空').join(' | '));
      });
      continue;
    }
    finished++;

    const rank = S.players.slice().sort((a, b) => (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
    const w = rank[0].name;
    wins[w] = (wins[w] || 0) + 1;
    turns += S.turnIdx;
    evos += S.players.reduce((s, p) => s + p.evolutions, 0);
    avgPoints.push(S.players.reduce((s, p) => s + p.points, 0) / nPlayers);
    maxPoints.push(rank[0].points);

    // ---- 守恒校验：精灵球总数不变 ----
    const per = RULES.poolPerPlayer[nPlayers];
    let poolSum = 0, heldSum = 0;
    COLORS.forEach((c) => {
      poolSum += S.pool[c];
      S.players.forEach((p) => { heldSum += p.balls[c]; });
    });
    if (poolSum + heldSum !== per * 5) { leaks++; console.error('第' + g + '局：基础球不守恒！池' + poolSum + '+持有' + heldSum + '≠' + per * 5); }
    // 大师球单独校验
    let masterSum = S.pool.master;
    S.players.forEach((p) => { masterSum += p.balls.master; });
    if (masterSum !== RULES.masterCount) { leaks++; console.error('第' + g + '局：大师球不守恒！共 ' + masterSum + ' 个≠' + RULES.masterCount); }

    // ---- 守恒校验：卡牌总数不变（持有 = 已收服 + 已预约 + 图鉴；期望值从卡牌表统计）----
    const totals = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    CARD_TABLE.forEach((row) => { totals[row[1]]++; });
    [1, 2, 3, 4, 5].forEach((t) => {
      const held = S.players.reduce((s, p) => s
        + p.cards.filter((c) => c.tier === t).length
        + p.reserved.filter((c) => c.tier === t).length
        + p.dex.filter((c) => c.tier === t).length, 0);
      const inM = S.market[t].filter(Boolean).length;
      if (S.decks[t].length + held + inM !== totals[t]) {
        leaks++;
        console.error('第' + g + '局：' + t + '阶卡不守恒！牌堆' + S.decks[t].length + '+持有' + held + '+场上' + inM + '≠' + totals[t]);
      }
    });

    // ---- 校验：所有玩家精灵球 ≤ 10 ----
    S.players.forEach((p) => {
      if (totalBalls(p) > 10) { leaks++; console.error('第' + g + '局：' + p.name + ' 持有 ' + totalBalls(p) + ' 个球超出上限！'); }
    });
  }

  console.log('==============================================');
  console.log('完成局数：' + finished + '/' + nGames + '（未结束 ' + guardHits + '，守恒违规 ' + leaks + '）');
  if (finished === 0) {
    console.log('⚠️ 所有对局都无法结束：通常是卡牌数值还没填好（比如全是 0 分没人能达到目标分），');
    console.log('   也可能是数值失衡导致全桌谁也买不起卡。请检查 config.js 的卡牌表。');
  } else {
    console.log('获胜分布（A 轮流简单/困难，其余困难）：', wins);
    console.log('平均总回合数（人次）：' + Math.round(turns / finished));
    console.log('平均轮数：' + (turns / finished / nPlayers).toFixed(1));
    console.log('平均每局进化次数：' + (evos / finished).toFixed(1));
    console.log('平均最终分数：' + (avgPoints.reduce((a, b) => a + b, 0) / avgPoints.length).toFixed(1));
    console.log('胜者平均分数：' + (maxPoints.reduce((a, b) => a + b, 0) / maxPoints.length).toFixed(1));
  }

  // ---- 把本次指标交给外层落档（原来跑完即弃，没法当基线）----
  global.__SIM_RESULT__ = {
    // 本地时间（教训：toISOString() 是 UTC，比本地慢 8 小时 —— 见项目踩坑库 B2）
    at: (function () {
      const d = new Date(), p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
        + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    })(),
    games: nGames, players: nPlayers, target, note,
    finished, guardHits, leaks,
    avgTurns: finished ? Math.round(turns / finished) : null,
    avgRounds: finished ? +(turns / finished / nPlayers).toFixed(2) : null,
    avgEvolutions: finished ? +(evos / finished).toFixed(2) : null,
    avgFinalPoints: avgPoints.length ? +(avgPoints.reduce((a, b) => a + b, 0) / avgPoints.length).toFixed(2) : null,
    avgWinnerPoints: maxPoints.length ? +(maxPoints.reduce((a, b) => a + b, 0) / maxPoints.length).toFixed(2) : null,
    winnerDist: wins,
  };
})();
`;

eval(cfgSrc + '\n' + src + '\n' + test);

/* ================================================================
   实验台账：把这次跑的指标落档（原来只打控制台、跑完即弃）
   - 原始指标 → 工具/sim-runs/<时间>.json（已 gitignore）
   - 一行摘要 → 根目录 实验台账.md（进版本库，这才是复利的资产）
   关键：记下 game-core 的 sha256 前 8 位 —— **版本号可能忘了提，哈希一定变**，
   它是「这次跑的是哪版 AI」的唯一可靠标识。
   ================================================================ */
const R = global.__SIM_RESULT__;
if (R && !noLedger) {
  const crypto = require('crypto');
  const APP = path.join(__dirname, '..');
  const gcHash = crypto.createHash('sha256')
    .update(fs.readFileSync(gcPath)).digest('hex').slice(0, 8);
  let ver = '?';
  try { ver = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version || '?'; } catch (e) { /* 读不到就算了 */ }

  const outDir = path.join(__dirname, 'sim-runs');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'sim-' + R.at.replace(/[: ]/g, '-') + '.json');
  fs.writeFileSync(jsonPath, JSON.stringify(Object.assign({ version: ver, gameCore: gcHash }, R), null, 2));

  const ledger = path.join(APP, '实验台账.md');
  if (!fs.existsSync(ledger)) {
    fs.writeFileSync(ledger,
      '# 实验台账\n\n' +
      '> `工具/sim.js` 每次跑完自动追加一行（`--note "说明"` 可加备注）。\n' +
      '> **`game-core` 那一列是「这次跑的是哪版 AI」的真正标识**（sha256 前 8 位）：版本号可能忘了提，哈希一定变。\n' +
      '> ⚠️ sim.js **不固定种子**，小样本有噪声（对比请先看样本量）；要严格同种子对照用 `工具/rl/bandit-battle.js`，把结论补进本表。\n\n' +
      '| 时间 | 版本 | game-core | 参数 | 完成 | 守恒违规 | 胜者均分 | 平均轮数 | 备注 |\n' +
      '|---|---|---|---|---|---|---|---|---|\n');
  }
  fs.appendFileSync(ledger, '| ' + R.at.slice(0, 16) + ' | v' + ver + ' | `' + gcHash + '` | '
    + R.games + '局 ' + R.players + '人 目标' + R.target + ' | '
    + R.finished + '/' + R.games + ' | ' + R.leaks + ' | ' + R.avgWinnerPoints + ' | ' + R.avgRounds + ' | '
    + (R.note || '-') + ' |\n');

  console.log('');
  console.log('📒 原始指标：' + path.relative(APP, jsonPath));
  console.log('📒 台账已追加一行：实验台账.md　（v' + ver + ' · game-core ' + gcHash + '）');
}
