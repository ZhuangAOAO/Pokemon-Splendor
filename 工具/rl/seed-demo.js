'use strict';
/* ==================== 阶段 A：种子 RNG + 逐步打印一局 ====================
 * 用法（在项目根目录运行）：
 *   node 工具/rl/seed-demo.js [seed]          同 seed 跑两局，验证行动序列逐字节一致
 *   node 工具/rl/seed-demo.js [seed] --print  额外逐步打印第一局
 * 例：node 工具/rl/seed-demo.js 42 --print
 */

const H = require('./harness');

const seed = Number(process.argv[2]) || 42;
const doPrint = process.argv.includes('--print');

// 跑一局：记录动作序列 + 每手后行动玩家的状态摘要
function runOnce() {
  const rec = H.makeRecorder();
  const players = [
    { name: 'A', type: 'hard' }, { name: 'B', type: 'hard' }, { name: 'C', type: 'hard' },
  ];
  H.newGame({ target: 18, players });
  const initial = JSON.parse(JSON.stringify(H.S));
  const steps = [];
  let guard = 0;
  while (!H.S.over && guard < 800) {
    const p = H.curPlayer();
    H.aiTurn(p);
    steps.push({ t: H.S.turnIdx, seat: p.id, name: p.name, pts: p.points, balls: H.totalBalls(p), act: rec[rec.length - 1] });
    guard++;
  }
  return { initial, actions: rec, final: JSON.parse(JSON.stringify(H.S)), steps };
}

H.seedRNG(seed);
const r1 = runOnce();
H.seedRNG(seed);
const r2 = runOnce();

const same = JSON.stringify(r1.actions) === JSON.stringify(r2.actions)
          && JSON.stringify(r1.final) === JSON.stringify(r2.final);

console.log(same
  ? `✓ 一致：seed=${seed} 两局行动序列与终局状态逐字节相同（${r1.actions.length} 手）`
  : '✗ 不一致！存在非确定性来源，请排查。');
const rank0 = r1.final.players.slice().sort((a, b) => (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
console.log('  终局名次：' + rank0.map((p, i) => `${i + 1}.${p.name}(${p.points}分)`).join(' '));

if (doPrint) {
  console.log('\n===== 逐手打印（seed=' + seed + '）=====');
  const COLORS_CN = {};
  H.COLORS.forEach((c) => { COLORS_CN[c] = H.BALLS[c].name; });
  r1.steps.forEach((s) => {
    const a = s.act;
    const desc = describeAct(a, COLORS_CN);
    console.log(
      `第${String(s.t).padStart(3)}手 | 座位${s.seat}(${s.name}) | ${desc.padEnd(22)} | 分${String(s.pts).padStart(2)} 球${String(s.balls).padStart(2)}`
    );
  });
  const f = r1.final;
  const rank = f.players.slice().sort((a, b) => (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
  console.log('\n终局名次：' + rank.map((p, i) => `${i + 1}.${p.name}(${p.points}分)`).join(' '));
}

function describeAct(a, cn) {
  if (!a) return '（无动作）';
  switch (a.k) {
    case 'take3': return '拿取 ' + a.p.colors.map((c) => cn[c]).join('、');
    case 'take2': return '拿取 2×' + cn[a.p.color];
    case 'buy': return '收服 市场' + a.p.tier + '阶#' + a.p.idx;
    case 'buyReserved': return '收服 预约#' + a.p.ridx;
    case 'reserve': return '预约 市场' + a.p.tier + '阶#' + a.p.idx;
    case 'reserveBlind': return '盲抽预约 ' + a.p.tier + '阶';
    case 'return': return '退还 1×' + cn[a.p.color];
    case 'takeMaster': return '拿取大师球';
    case 'evolve': return '进化';
    case 'skipEvolve': return '跳过进化';
    case 'skip': return '跳过';
    default: return a.k + ' ' + JSON.stringify(a.p);
  }
}
