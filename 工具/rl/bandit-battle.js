'use strict';
/* ==================== 阶段 B：拿球老虎机对战 ====================
 * 用 ε-greedy 决定"这一手拿哪几个球"，对照：均匀随机基线 / 乐观初始化 /
 * 手写规则参考线。座位 A 用被测变体，其余座位走原困难 AI 逻辑。
 *
 * 用法（在项目根目录运行）：
 *   node 工具/rl/bandit-battle.js [局数] [人数] [目标分]
 * 例：node 工具/rl/bandit-battle.js 500 3 18
 *
 * 产出：
 *   控制台 ASCII 摘要
 *   工具/rl/data/report.html —— 自包含可视化报告（胜率对比/学习曲线/Q 表）
 *   工具/rl/data/episodes/*.jsonl —— 每局完整对局数据（回放表格式 + 奖励），供后续离线学习用
 */

const fs = require('fs');
const path = require('path');
const H = require('./harness');

const nGames = +process.argv[2] || 500;
const nPlayers = +process.argv[3] || 3;
const target = +process.argv[4] || 18;
const BASE_SEED = 20260915;
const K = Math.max(1, Math.round(nGames / 40)); // 学习曲线采样间隔

const arms = H.makeArms();

const variants = [
  { key: 'uniform', label: '均匀随机（基线）',  bandit: () => H.makeBandit(arms, { eps: 1 }) },
  { key: 'eps01',   label: 'ε-greedy  ε=0.1',  bandit: () => H.makeBandit(arms, { eps: 0.1 }) },
  { key: 'opt3',    label: '乐观初始化 Q₀=3',  bandit: () => H.makeBandit(arms, { eps: 0.1, qInit: 3 }) },
  { key: 'def',     label: '手写规则（参考线）', bandit: () => null },
];

// （历史：2026-09-15 曾有"恒 take3"诊断变体，证实旧 AI 的 take2 偏见是弱点；
//  启发式 AI 已按此修复（rem = need − 已持球 + take3 优先），该变体使命完成已移除。）

const names = [];
for (let i = 0; i < nPlayers; i++) names.push(String.fromCharCode(65 + i));

console.log(`拿球老虎机对战：${nGames} 局 / ${nPlayers} 人 / 目标 ${target} 分 / 随机水平线 ${(100 / nPlayers).toFixed(1)}%`);
console.log('（各变体共用同一 seed 序列 20260915+i，座位 A 为被测变体，其余座位走原困难 AI）\n');

const results = [];
for (const v of variants) {
  const bandit = v.bandit ? v.bandit() : null;
  H.installBanditHook(bandit, 0); // 座位 0 的拿球决策交给变体，其余行动与座位走原逻辑
  const players = names.map((nm, i) => ({ name: nm, type: i === 0 ? 'hard' : 'hard' }));
  const res = H.runSeries({ name: `bandit-${v.key}-p${nPlayers}-t${target}`, seed: BASE_SEED, n: nGames, players, target, bandit });
  H.clearBanditHook();
  results.push({ key: v.key, label: v.label, res });
  const leakNote = res.leaks.length ? `　⚠️守恒违规 ${res.leaks.length} 局` : '';
  console.log(`  ${v.label.padEnd(14)}　胜率 ${(res.winRate * 100).toFixed(1)}%　（${res.wins}/${res.n}）${leakNote}`);
}

/* ---------- 控制台：各 bandit 变体的 top 臂 ---------- */
console.log('\n各变体学到的 top-5 臂（Q / 尝试次数）：');
for (const { key, label, res } of results) {
  if (!res.q) continue;
  const top = res.q.slice().sort((a, b) => b.Q - a.Q).slice(0, 5);
  console.log(`  ${label}：` + top.map((a) => `${armName(a)} ${a.Q.toFixed(2)}×${a.N}`).join('  '));
}

/* ---------- 生成可视化报告 ---------- */
const reportPath = path.join(H.DATA_DIR, 'report.html');
fs.mkdirSync(H.DATA_DIR, { recursive: true });
fs.writeFileSync(reportPath, buildReport(results, { nGames, nPlayers, target, BASE_SEED, K }));
console.log(`\n📊 报告已生成：${reportPath}`);
try {
  const { spawn } = require('child_process');
  spawn('cmd', ['/c', 'start', '', reportPath], { detached: true, stdio: 'ignore' }).unref();
  console.log('  已尝试在浏览器中打开（打不开就手动双击）');
} catch (e) { /* 打不开不阻塞 */ }

/* ==================== 辅助 ==================== */
function armName(a) {
  const cn = (c) => H.BALLS[c].name;
  return a.type === 'take2' ? `2×${cn(a.color)}` : a.colors.map(cn).join('');
}
function colorChip(c) {
  const b = H.BALLS[c];
  return `<span class="chip" style="background:${b.top}"></span>${b.name}`;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function buildReport(results, meta) {
  const wb = results.map(({ key, label, res }) => ({
    key, label, rate: res.winRate, w: res.winRate * 100, wins: res.wins, n: res.n,
    curve: res.winList.filter((_, i) => i % meta.K === 0 || i === res.n - 1),
    q: res.q,
  }));
  const maxQ = Math.max(...results.flatMap((r) => (r.res.q || []).map((a) => a.Q)), 0.01);
  const COLORS_PALETTE = ['#e74c3c', '#3498db', '#2c3e50', '#e91e63', '#f1c40f'];

  const winBars = wb.map((v, i) => `
    <div class="row">
      <div class="rlabel">${esc(v.label)}</div>
      <div class="rtrack"><div class="rbar" style="width:${Math.min(100, v.w)}%;background:${COLORS_PALETTE[i % 5]}"></div></div>
      <div class="rnum">${v.rate.toFixed(3)}</div>
    </div>`).join('');

  // 学习曲线 SVG
  const W = 760, Hgt = 240, P = { l: 46, r: 14, t: 16, b: 30 };
  const iw = W - P.l - P.r, ih = Hgt - P.t - P.b;
  const yOf = (v) => P.t + ih * (1 - v);
  const xOf = (i) => P.l + iw * (i / Math.max(1, meta.nGames - 1));
  let curvePaths = '';
  wb.forEach((v, vi) => {
    const pts = v.curve.map((r, i) => `${xOf(i * meta.K).toFixed(1)},${yOf(r).toFixed(1)}`).join(' ');
    curvePaths += `<polyline points="${pts}" fill="none" stroke="${COLORS_PALETTE[vi % 5]}" stroke-width="2"/>`;
  });
  const baselineY = yOf(1 / meta.nPlayers);
  const curveSvg = `
  <svg viewBox="0 0 ${W} ${Hgt}" class="curve">
    <line x1="${P.l}" y1="${baselineY}" x2="${W - P.r}" y2="${baselineY}" stroke="#999" stroke-dasharray="4 3"/>
    <text x="${W - P.r - 4}" y="${baselineY - 4}" text-anchor="end" font-size="10" fill="#999">随机水平线 ${(100 / meta.nPlayers).toFixed(0)}%</text>
    ${curvePaths}
    <line x1="${P.l}" y1="${P.t}" x2="${P.l}" y2="${P.t + ih}" stroke="#333"/>
    <line x1="${P.l}" y1="${P.t + ih}" x2="${W - P.r}" y2="${P.t + ih}" stroke="#333"/>
    <text x="${P.l - 6}" y="${P.t + 8}" text-anchor="end" font-size="10">100%</text>
    <text x="${P.l - 6}" y="${P.t + ih + 4}" text-anchor="end" font-size="10">0</text>
    <text x="${P.l}" y="${Hgt - 8}" font-size="10">局数 →（每 ${meta.K} 局采一点，累计胜率）</text>
  </svg>`;

  // Q 表条形图（每个 bandit 变体一块）
  const qSections = wb.filter((v) => v.q).map((v, vi) => `
    <h3>${esc(v.label)}</h3>
    <div class="qtable">
      ${v.q.map((a) => {
        const w = Math.max(2, (a.Q / maxQ) * 100);
        return `<div class="row">
          <div class="rlabel arm">${a.type === 'take2' ? colorChip(a.color) : a.colors.map(colorChip).join('')}</div>
          <div class="rtrack"><div class="rbar q" style="width:${w}%"></div></div>
          <div class="rnum">${a.Q.toFixed(2)}（${a.N}次）</div>
        </div>`;
      }).join('')}
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>拿球老虎机实验报告</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; max-width: 860px; margin: 24px auto; padding: 0 16px; color: #333; background: #fafafa; }
  h1 { font-size: 22px; border-bottom: 3px solid #e3350d; padding-bottom: 8px; }
  h2 { font-size: 17px; margin-top: 28px; }
  h3 { font-size: 14px; margin: 14px 0 6px; }
  .meta { color: #777; font-size: 13px; }
  .row { display: flex; align-items: center; margin: 3px 0; }
  .rlabel { width: 150px; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rlabel.arm { width: 190px; }
  .rtrack { flex: 1; height: 16px; background: #eee; border-radius: 3px; }
  .rbar { height: 100%; border-radius: 3px; min-width: 2px; background: linear-gradient(90deg, #f58fb8, #e3350d); }
  .rnum { width: 110px; text-align: right; font-size: 13px; color: #555; }
  .chip { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 3px; vertical-align: -1px; }
  .curve { width: 100%; height: auto; background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; }
  section { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 14px 18px; }
  .legend { font-size: 12px; color: #666; margin-top: 6px; }
  .legend span { display: inline-block; margin-right: 12px; }
  .legend i { display: inline-block; width: 14px; height: 3px; margin-right: 4px; vertical-align: middle; }
</style></head>
<body>
<h1>🎯 拿球老虎机实验报告</h1>
<p class="meta">生成时间：${new Date().toLocaleString('zh-CN')} ｜ 局数：${meta.nGames} ｜ 人数：${meta.nPlayers} ｜ 目标分：${meta.target} ｜ 基础 seed：${meta.BASE_SEED}</p>

<section><h2>① 胜率对比（座位 A 用该变体，其余座位为困难 AI）</h2>
${winBars}
<div class="legend">${wb.map((v, i) => `<span><i style="background:${COLORS_PALETTE[i % 5]}"></i>${esc(v.label)}</span>`).join('')}</div>
<p class="meta">基线说明：均匀随机是下限参照（随机线 = 1/人数），手写规则是当前启发式 AI。若手写规则低于随机线，说明拿球逻辑有漏洞（2026-09-15 曾发现 take2 偏好问题，已修复）。</p>
</section>

<section><h2>② 学习曲线（累计胜率）</h2>
${curveSvg}
</section>

<section><h2>③ 各臂 Q 值（"这一手拿哪些球"学到了什么）</h2>
${qSections}
</section>
</body></html>`;
}
