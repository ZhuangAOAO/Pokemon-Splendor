'use strict';
/* ==================== dashboard.js：RL 训练看板生成器 ====================
 * 把 工具/rl 下的训练产物合成一张零依赖单页看板 工具/rl/data/dashboard.html。
 *
 * 数据源（全部容错读取，缺哪个就跳过哪个，绝不中断）：
 *   1. data/ppo-agent-p{2,3,4}.summary.json —— 主线 PPO-NN 训练摘要（评估曲线）
 *   2. data/ppo-agent-p{2,3,4}.log        —— 训练日志（补评估点 / 判断"运行中"）
 *   3. weights/ppo-agent-*.json           —— 权重文件（存在性 / 试跑记录）
 *   4. data/parity-baseline.json          —— 对称基准（2/3/4 人局参照线）
 *   5. data/exp-rule*.json                —— 规则层变体实验（V1~V14）
 *   6. data/episodes/*.summary.json       —— 历史配方（线性 Q / 线性 PPO / PPO-NN）
 *   7. data/episodes/bandit-*-p3-t18-*.jsonl —— 阶段 B 对局记录（逐局下钻用）
 *   8. 训练日志.md                        —— 轮次时间线 + p3 收尾数据兜底
 *      （p3 的 3 万局摘要被后来的试跑覆盖，60.4% 只能从日志第 6/7 轮表格恢复）
 *
 * 用法：node 工具/rl/dashboard.js [--no-open]   （在项目根目录执行）
 * 产出：工具/rl/data/dashboard.html（生成后自动尝试浏览器打开）
 * 看板设计见 训练计划与评测协议.md §5；配色经 dataviz 校验（浅色 3 槽 + 深色 3 槽全 PASS）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RL = __dirname;
const DATA = path.join(RL, 'data');
const WEIGHTS = path.join(RL, 'weights');
const MD_LOG = path.join(RL, '训练日志.md');
const OUT = path.join(DATA, 'dashboard.html');

/* ==================== 小工具 ==================== */
// 本地时间戳（不用 toISOString：那是 UTC，见踩坑库 B2）
function ts() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const readJSON = (p) => { const t = readText(p); if (t == null) return null; try { return JSON.parse(t); } catch (e) { return null; } };
const pct = (x, d) => (x == null ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%');
const fmtDur = (sec) => {
  if (sec == null) return '—';
  if (sec < 60) return Math.round(sec) + ' 秒';
  if (sec < 3600) return Math.round(sec / 60) + ' 分';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
};
const fmtNum = (x) => String(x == null ? '' : x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
// 归一化评估曲线点（各脚本的曲线条目字段略有出入，防御性读）
const normCurve = (arr) => (Array.isArray(arr) ? arr.map((e) => ({
  ep: +e.ep || 0,
  rate: typeof e.rate === 'number' ? e.rate : null,
  wins: typeof e.wins === 'number' ? e.wins : null,
  leaks: typeof e.leaks === 'number' ? e.leaks : (e.leaks || 0),
})).filter((p) => p.rate != null) : []);
const curveFinal = (c) => (c.length ? c[c.length - 1].rate : null);
const curveBest = (c) => c.reduce((b, p) => (b == null || p.rate > b ? p.rate : b), null);
const curveLeaks = (c) => c.reduce((s, p) => s + p.leaks, 0);

const sources = { read: [], skipped: [] };
function loadJSON(p) {
  const d = readJSON(p);
  if (d) sources.read.push(p.replace(RL + path.sep, ''));
  else sources.skipped.push(p.replace(RL + path.sep, ''));
  return d;
}

/* ==================== 1. 对称基准（协议 §1 参照线） ==================== */
const baseline = { 2: null, 3: null, 4: null };
(function () {
  const d = loadJSON(path.join(DATA, 'parity-baseline.json'));
  if (d && Array.isArray(d.rows)) d.rows.forEach((r) => { if (baseline[r.players] != null) baseline[r.players] = r.winRate; });
})();
// 文件缺失时的兜底：协议文档里的实测常数（500 局 / seed 20260915）
if (baseline[2] == null) baseline[2] = 0.508;
if (baseline[3] == null) baseline[3] = 0.318;
if (baseline[4] == null) baseline[4] = 0.292;

/* ==================== 2. 规则层变体实验（exp-rule*.json） ==================== */
const ruleRows = [];
(function () {
  const files = fs.readdirSync(DATA).filter((f) => /^exp-rule\d*\.json$/.test(f)).sort();
  const byKey = {};
  for (const f of files) {
    const d = loadJSON(path.join(DATA, f));
    if (!d || !Array.isArray(d.rows)) continue;
    d.rows.forEach((r) => {
      const rates = {};
      let leaks = 0;
      for (const n of ['2', '3', '4']) {
        const cell = r.per && r.per[n];
        if (cell) {
          rates[n] = { rate: cell.rate, wins: typeof cell.wins === 'number' ? cell.wins : null, n: d.N || null };
          leaks += cell.leaks || 0;
        }
      }
      byKey[r.key] = {
        label: r.label || r.key, key: r.key, kind: '规则', train: (d.N || 0) + ' 局 ×3 档',
        rates, leaks, source: f, detail: null,
      };
    });
  }
  Object.keys(byKey).forEach((k) => ruleRows.push(byKey[k]));
})();

/* ==================== 3. 历史配方（data/episodes/*.summary.json） ==================== */
const histRuns = [];
const RECIPE_MIN_EP = 5000;   // 配方表的最低训练量（短试跑只留 ppo-agent 主线的）
(function () {
  const epDir = path.join(DATA, 'episodes');
  const files = fs.readdirSync(epDir).filter((f) => f.endsWith('.summary.json'));
  for (const f of files) {
    // 注意捕获组编号：组 1 是整个外层交替（永远有值），分支数据在组 2~6
    const m = f.match(/^(train-agent-(\d)p-(\d+)|lqlearn-(\d+)|ppo-big-(\d+)|ppo-big-nn-(\d+))\.summary\.json$/);
    if (!m) continue; // qlearn/ppo-mini（迷你游戏）与 bandit 摘要不属于真实游戏配方
    const d = loadJSON(path.join(epDir, f));
    if (!d) continue;
    let players = 3, kind = '';
    if (m[2]) { players = +m[2]; kind = '线性 Q'; }
    else if (m[4]) { kind = '线性 Q'; }
    else if (m[5]) { kind = '线性 PPO'; }
    else if (m[6]) { kind = 'PPO-NN'; }
    const n = +d.n || 0;
    if (n < RECIPE_MIN_EP) continue;
    const curve = normCurve(d.evalCurve);
    const sample = d.sampleGame && Array.isArray(d.sampleGame.actions)
      ? { winner: d.sampleGame.winner, final: d.sampleGame.final, actions: d.sampleGame.actions.slice(0, 30) }
      : null;
    histRuns.push({
      label: f.replace(/\.summary\.json$/, ''),
      kind, players, train: n + ' 局', n,
      rates: { [players]: { rate: curveFinal(curve), wins: null, n: null } },
      final: curveFinal(curve), best: curveBest(curve),
      curve, leaks: curveLeaks(curve) + (d.leaks || 0),
      elapsed: d.elapsed != null ? +d.elapsed : null, source: 'data/episodes/' + f,
      sample,
    });
  }
  // 同家族保留训练量最大的两个（ppo-big 2万/10万、lqlearn 10万/30万、ppo-big-nn 5千/1万）
  const fam = {};
  histRuns.forEach((r) => {
    const k = r.label.replace(/-\d+$/, '');
    (fam[k] = fam[k] || []).push(r);
  });
  histRuns.length = 0;
  Object.keys(fam).forEach((k) => {
    fam[k].sort((a, b) => b.n - a.n);
    histRuns.push(...fam[k].slice(0, 2));
  });
})();

/* ==================== 4. 训练日志.md 解析（轮次时间线 + p3 兜底数据） ==================== */
const stripMd = (s) => String(s || '').replace(/\*\*/g, '').replace(/`/g, '').trim();
function parseMd(text) {
  if (!text) return { rounds: [], meta: {}, ppoPts: { 2: [], 3: [], 4: [] }, ppoElapsed: { 2: null, 3: null, 4: null } };
  const lines = text.split(/\r?\n/);
  const rounds = [];
  const meta = {};
  let cur = null, curTable = null;
  const pushTable = () => {
    if (curTable && curTable.rows.length && cur) cur.tables.push(curTable);
    curTable = null;
  };
  for (const raw of lines) {
    const h = raw.match(/^##\s*第\s*(\d+)\s*轮\s*(.*)$/);
    if (h) {
      pushTable();
      if (cur) rounds.push(cur);
      cur = { n: +h[1], title: stripMd(h[2]), changed: null, rateLine: null, vsPrev: null, concl: null, tables: [] };
      continue;
    }
    if (/^###\s/.test(raw)) { pushTable(); continue; } // 子节（如 Step 0 附）不解析
    if (!cur) {
      const m1 = raw.match(/^\*\*目标\*\*[：:]\s*(.+)$/); if (m1) meta.goal = stripMd(m1[1]);
      const m2 = raw.match(/^\*\*口径\*\*[：:]\s*(.+)$/); if (m2) meta.spec = stripMd(m2[1]);
      continue;
    }
    if (/^\s*\|/.test(raw)) {
      const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(stripMd);
      if (cells.every((c) => /^-+$/.test(c))) continue; // 分隔行
      if (!curTable) curTable = { head: cells, rows: [] };
      else curTable.rows.push(cells);
      continue;
    }
    if (curTable) pushTable();
    const m1 = raw.match(/^-\s*改了什么[：:]\s*(.*)$/); if (m1) { cur.changed = cur.changed || stripMd(m1[1]); continue; }
    const m2 = raw.match(/^-\s*三档胜率[：:]\s*(.*)$/); if (m2) { cur.rateLine = cur.rateLine || stripMd(m2[1]); continue; }
    const m3 = raw.match(/^-\s*对比上一轮[：:]\s*(.*)$/); if (m3) { cur.vsPrev = cur.vsPrev || stripMd(m3[1]); continue; }
    const m4 = raw.match(/^-\s*(结论|观察)[：:]\s*(.*)$/); if (m4) { cur.concl = cur.concl || stripMd(m4[2]); continue; }
  }
  pushTable();
  if (cur) rounds.push(cur);

  // PPO 轮次里带"人数"列的表格 → 主线评估曲线（p3 摘要被试跑覆盖，全靠这里恢复）
  const ppoPts = { 2: [], 3: [], 4: [] };
  const ppoElapsed = { 2: null, 3: null, 4: null };
  for (const r of rounds) {
    if (!/PPO/.test(r.title)) continue;
    for (const tb of r.tables) {
      if (!tb.head.some((h) => /人数/.test(h))) continue;
      const colEp = tb.head.map((h) => { const m = h.match(/(\d{4,})/); return m ? +m[1] : null; });
      const colSec = tb.head.map((h) => /耗时/.test(h));
      for (const row of tb.rows) {
        const rm0 = row[0] && row[0].match(/(\d)\s*人/); if (!rm0) continue;
        const n = +rm0[1];
        row.forEach((cell, j) => {
          if (j === 0 || !cell) return;
          const rm = cell.match(/(\d+(?:\.\d+)?)\s*%/);
          if (rm && colEp[j]) ppoPts[n].push({ ep: colEp[j], rate: +rm[1] / 100 });
          if (colSec[j] && ppoElapsed[n] == null) { const sm = cell.match(/(\d+(?:\.\d+)?)s/); if (sm) ppoElapsed[n] = +sm[1]; }
        });
      }
    }
  }
  for (const n of [2, 3, 4]) {
    const seen = {};
    ppoPts[n] = ppoPts[n].filter((p) => (seen[p.ep] ? false : (seen[p.ep] = true)));
    ppoPts[n].sort((a, b) => a.ep - b.ep);
  }
  return { rounds, meta, ppoPts, ppoElapsed };
}
const md = parseMd(readText(MD_LOG));

/* ==================== 5. 主线 ppo-agent（摘要 + 日志 + 权重） ==================== */
function parseRunLog(text) {
  const segs = [];
  let cur = null;
  if (!text) return segs;
  for (const line of text.split(/\r?\n/)) {
    const st = line.match(/^\[([\d\- :]+)\]\s+启动：/);
    if (st) {
      const ck = line.match(/检查点每\s*(\d+)\s*局/);
      cur = { startedAt: st[1], ckptEvery: ck ? +ck[1] : null, resumed: /恢复自/.test(line), done: false, evals: [] };
      segs.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/训练完成/.test(line)) {
      cur.done = true;
      const fm = line.match(/耗时\s*([\d.]+)s/); if (fm) cur.elapsed = +fm[1];
      continue;
    }
    const em = line.match(/\[\s*(\d+)\/(\d+)\]\s*p(\d)人局.*?(\d+(?:\.\d+)?)%/);
    if (em) cur.evals.push({ ep: +em[1], total: +em[2], rate: +em[4] / 100 });
  }
  return segs;
}
const main = { 2: null, 3: null, 4: null };
const running = {};
let paramCount = null, netShape = null, totalMainSec = 0;
[2, 3, 4].forEach((n) => {
  const s = loadJSON(path.join(DATA, `ppo-agent-p${n}.summary.json`));
  const real = s && s.episodes >= 10000 ? s : null; // 摘要可能被更新的长跑覆盖；<1 万局（试跑）不当主线
  let curve = real ? normCurve(real.evalCurve) : [];
  const mdPtsAll = (md.ppoPts[n] || []).map((p) => ({ ep: p.ep, rate: p.rate, wins: null, leaks: 0 }));
  if (!curve.length) curve = mdPtsAll;

  // 日志：长跑段（目标 ≥1 万局）的评估点并入曲线；末段没有"训练完成"= 正在运行
  const segs = parseRunLog(readText(path.join(DATA, `ppo-agent-p${n}.log`)));
  for (const sg of segs) for (const e of sg.evals) {
    if (e.total >= 10000 && !curve.some((p) => p.ep === e.ep)) curve.push({ ep: e.ep, rate: e.rate, wins: null, leaks: 0 });
  }
  curve.sort((a, b) => a.ep - b.ep);
  const lastSeg = segs[segs.length - 1];
  if (lastSeg && !lastSeg.done) running[n] = { startedAt: lastSeg.startedAt, ckptEvery: lastSeg.ckptEvery, resumed: lastSeg.resumed };

  // 历史 3 万局（第一段主线）：摘要还是 3 万局时取摘要；已被长跑覆盖时从训练日志表格恢复
  const is3w = real && real.episodes === 30000;
  const md3w = mdPtsAll.filter((p) => p.ep <= 30000);
  const hist3w = {
    curve: is3w ? curve : md3w,
    final: is3w ? curveFinal(curve) : curveFinal(md3w),
    best: is3w ? curveBest(curve) : curveBest(md3w),
    elapsed: is3w ? (real ? real.elapsedSec : null) : md.ppoElapsed[n],
  };

  const weightFile = `weights/ppo-agent-p${n}-30000.json`;
  main[n] = {
    curve,
    final: curveFinal(curve),
    best: curveBest(curve),
    wins: curve.length && curve[curve.length - 1].wins != null ? curve[curve.length - 1].wins : (real ? real.wins : null),
    evalGames: real ? real.evalGames : null,
    elapsed: real ? real.elapsedSec : md.ppoElapsed[n],
    done: real ? (real.episodesDone || real.episodes) : null,
    targetEp: real ? real.episodes : null,
    weight: fs.existsSync(path.join(RL, weightFile)) ? weightFile : null,
    hist3w, hist3wDup: is3w,
  };
  if (paramCount == null && s && s.hidden && s.nFeat && s.nState) {
    paramCount = (s.nFeat * s.hidden + s.hidden) + (s.hidden * 1 + 1) + (s.nState * s.hidden + s.hidden) + (s.hidden * 1 + 1);
    netShape = `Actor ${s.nFeat}→${s.hidden}→1 · Critic ${s.nState}→${s.hidden}→1`;
  }
});
totalMainSec = 0;
[2, 3, 4].forEach((n) => { if (main[n].hist3w.elapsed != null) totalMainSec += main[n].hist3w.elapsed; });

/* ==================== 6. 配方对比表 ==================== */
const recipes = [];
recipes.push({
  label: '对称基准（全体困难 AI，不学）', kind: '对照', train: '500 局 ×3 档',
  rates: { 2: { rate: baseline[2], wins: null, n: 500 }, 3: { rate: baseline[3], wins: null, n: 500 }, 4: { rate: baseline[4], wins: null, n: 500 } },
  leaks: 0, source: 'data/parity-baseline.json', detail: null, current: false,
});
ruleRows.forEach((r) => recipes.push(r));
histRuns.forEach((r) => recipes.push({
  label: r.label, kind: r.kind, train: r.train, rates: r.rates, leaks: r.leaks,
  source: r.source,
  detail: { curve: r.curve, elapsed: r.elapsed, sample: r.sample, players: r.players },
  current: false,
}));
recipes.push({
  label: 'ppo-agent 3 万局收尾（第一段）', kind: 'PPO-NN', train: '3 万局 ×3 档',
  rates: {
    2: { rate: main[2].hist3w.final, wins: main[2].hist3wDup ? main[2].wins : null, n: main[2].evalGames },
    3: { rate: main[3].hist3w.final, wins: null, n: null },
    4: { rate: main[4].hist3w.final, wins: null, n: null },
  },
  leaks: 0, source: 'data/ppo-agent-p2.summary.json + 训练日志.md 第 6/7 轮',
  detail: {
    curves: { 2: main[2].hist3w.curve, 3: main[3].hist3w.curve, 4: main[4].hist3w.curve },
    mdNote: 'p3/p4 的摘要文件已被 10 万局长跑覆盖，此行的 p3/p4 数据从训练日志第 6/7 轮表格恢复。',
  },
  current: false,
});
recipes.push({
  label: 'ppo-agent 当前主线（长跑）', kind: 'PPO-NN', train: '10 万局 ×3 档（进行中）',
  rates: {
    2: { rate: main[2].final, wins: main[2].wins, n: main[2].evalGames },
    3: { rate: main[3].final, wins: main[3].wins, n: main[3].evalGames },
    4: { rate: main[4].final, wins: main[4].wins, n: main[4].evalGames },
  },
  leaks: 0, source: 'data/ppo-agent-p{2,3,4}.summary.json',
  detail: { curves: { 2: main[2].curve, 3: main[3].curve, 4: main[4].curve }, mdNote: null },
  current: true,
});
const rate3 = (r) => (r.rates[3] ? r.rates[3].rate : null);
recipes.sort((a, b) => {
  const x = rate3(a), y = rate3(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return y - x;
});

/* ==================== 7. 对局下钻数据（阶段 B 老虎机 jsonl） ==================== */
const drill = [];
(function () {
  const epDir = path.join(DATA, 'episodes');
  const files = fs.readdirSync(epDir).filter((f) => /^bandit-.+-p3-t18-20260915-\d+\.jsonl$/.test(f)).sort();
  for (const f of files) {
    const d = loadJSON(path.join(epDir, f.replace(/\.jsonl$/, '.summary.json')));
    const text = readText(path.join(epDir, f));
    if (!text) { sources.skipped.push('data/episodes/' + f); continue; }
    sources.read.push('data/episodes/' + f);
    const lines = text.trim().split(/\r?\n/);
    const eps = [];
    for (let i = 0; i < lines.length && eps.length < 6; i++) {
      try {
        const e = JSON.parse(lines[i]);
        eps.push({
          seed: e.seed, turns: e.turns, winner: e.winner, finished: e.finished,
          actions: (e.actions || []).slice(0, 40).map((a) => ({ k: a.k, p: a.p, seat: a.seat, t: a.t, r: a.r })),
        });
      } catch (e) { /* 坏行跳过 */ }
    }
    const wl = d && Array.isArray(d.winList) ? d.winList : null;
    const step = wl ? Math.max(1, Math.ceil(wl.length / 120)) : 1;
    drill.push({
      name: d ? d.name : f, n: d ? d.n : null, winRate: d ? d.winRate : null, wins: d ? d.wins : null,
      target: d ? d.target : null, players: d ? d.players : null,
      winList: wl ? wl.filter((_, i) => i % step === 0 || i === wl.length - 1) : null,
      eps,
    });
  }
})();

/* ==================== 8. 汇总 DB → 看板 ==================== */
const goal = 80;
const DB = {
  generatedAt: ts(),
  goal: { target: goal, targetScore: 18, evalGames: 500, spec: md.meta.spec || '', goalText: md.meta.goal || '' },
  baseline,
  main,
  running,
  rounds: md.rounds,
  recipes,
  drill,
  paramCount, netShape,
  totalMainSec,
  totalElapsed: totalMainSec,
  sources,
  lastRound: md.rounds.length ? md.rounds[md.rounds.length - 1] : null,
};
const DB_JSON = JSON.stringify(DB).replace(/</g, '\\u003c');

/* ==================== 9. 渲染 HTML ==================== */
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>宝可梦 RL 训练看板</title>
<style>
/* ===== 颜色槽位（dataviz 参考盘，浅/深各自选定并校验过） ===== */
.viz-root{
  color-scheme: light;
  --surface-1:#fcfcfb; --page:#f9f9f7;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7;
  --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a;
  --good:#0ca30c; --critical:#d03b3b; --warning:#fab219;
  --border:rgba(11,11,11,0.10);
}
@media (prefers-color-scheme: dark){
  :root:where(:not([data-theme="light"])) .viz-root{
    color-scheme: dark;
    --surface-1:#1a1a19; --page:#0d0d0d;
    --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#898781;
    --grid:#2c2c2a; --axis:#383835;
    --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70;
    --good:#0ca30c; --critical:#d03b3b; --warning:#fab219;
    --border:rgba(255,255,255,0.10);
  }
}
:root[data-theme="dark"] .viz-root{
  color-scheme: dark;
  --surface-1:#1a1a19; --page:#0d0d0d;
  --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#898781;
  --grid:#2c2c2a; --axis:#383835;
  --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70;
  --good:#0ca30c; --critical:#d03b3b; --warning:#fab219;
  --border:rgba(255,255,255,0.10);
}
/* ===== 基础 ===== */
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text-primary);
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.55}
.wrap{max-width:1080px;margin:0 auto;padding:28px 22px 60px}
header.top{border-bottom:1px solid var(--border);padding-bottom:14px;margin-bottom:26px}
.title-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:26px;font-weight:700}
.subtitle{color:var(--text-secondary);margin:8px 0 2px}
.meta{color:var(--text-muted);font-size:12px;margin:2px 0 0}
button.ctl{font:inherit;font-size:12px;color:var(--text-secondary);background:var(--surface-1);
  border:1px solid var(--border);border-radius:999px;padding:3px 12px;cursor:pointer}
button.ctl:hover{color:var(--text-primary);border-color:var(--axis)}
section{margin-top:34px}
h2{font-size:16px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
h2 .no{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;
  background:var(--grid);color:var(--text-secondary);font-size:12px;font-weight:700}
.sec-ctl{margin-left:auto;display:flex;gap:8px}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:14px}
.caption{color:var(--text-muted);font-size:12px;margin:8px 0 0}
/* ===== KPI / 进度条 ===== */
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.kpis.tiles{margin-top:14px}
.kpi{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
.kpi .lab{color:var(--text-secondary);font-size:12px;margin-bottom:4px}
.kpi .val{font-size:27px;font-weight:600;letter-spacing:-0.01em}
.kpi .sub{color:var(--text-muted);font-size:12px;margin-top:2px}
.meter-track{position:relative;height:8px;background:var(--grid);border-radius:4px;margin-top:12px}
.meter-fill{height:100%;border-radius:4px}
.meter-fill.ok{background:var(--good)}
.meter-fill.no{background:var(--critical)}
.meter-tick{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--axis);border-radius:1px}
.meter-note{display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:12px;color:var(--text-muted)}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px}
.chip.ok{color:var(--good);background:color-mix(in srgb,var(--good) 13%,transparent)}
.chip.no{color:var(--critical);background:color-mix(in srgb,var(--critical) 11%,transparent)}
.chip.warn{color:var(--warning);background:color-mix(in srgb,var(--warning) 14%,transparent)}
/* ===== 图 ===== */
.chart-fig{position:relative;margin-top:10px}
.chart-fig svg{width:100%;height:auto;display:block}
.legend-row{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);margin-top:10px}
.lkey{display:inline-flex;align-items:center;gap:6px}
.sw{width:16px;height:2px;display:inline-block;flex:none}
.sw.dash{height:0;border-top:1px dashed var(--text-muted)}
.tip{position:absolute;pointer-events:none;background:var(--surface-1);border:1px solid var(--border);
  border-radius:8px;padding:8px 11px;font-size:12px;box-shadow:0 3px 10px rgba(0,0,0,0.12);
  display:none;z-index:5;min-width:130px}
.tip .trow{display:flex;align-items:center;gap:7px;padding:1px 0}
.tip .tval{color:var(--text-primary);font-weight:600;font-variant-numeric:tabular-nums}
.tip .tname{color:var(--text-secondary);margin-left:auto;padding-left:10px}
.tip .thead{color:var(--text-muted);margin-bottom:2px}
.key{width:12px;height:2px;display:inline-block;flex:none}
/* 纹理 / 打印：序列线加虚线模式 + 数据点标记（CVD / 灰度打印的备用通道） */
.s-dot{display:none}
body.tex .s-line[data-dash="1"]{stroke-dasharray:6 4}
body.tex .s-line[data-dash="2"]{stroke-dasharray:2 4}
body.tex .s-line[data-dash="3"]{stroke-dasharray:1 4}
body.tex .s-dot{display:block}
@media print{
  .s-line[data-dash="1"]{stroke-dasharray:6 4}
  .s-line[data-dash="2"]{stroke-dasharray:2 4}
  .s-line[data-dash="3"]{stroke-dasharray:1 4}
  .s-dot{display:block}
  .no-print{display:none}
}
/* ===== 表格 ===== */
table.data{width:100%;border-collapse:collapse;font-size:13px}
table.data th{text-align:left;font-weight:600;color:var(--text-secondary);padding:6px 9px;border-bottom:1px solid var(--axis);white-space:nowrap}
table.data td{padding:6px 9px;border-bottom:1px solid var(--grid);vertical-align:top}
table.data .num{text-align:right;font-variant-numeric:tabular-nums}
table.data tr.clickable{cursor:pointer}
table.data tr.clickable:hover td{background:color-mix(in srgb,var(--grid) 45%,transparent)}
table.data tr.current td{background:color-mix(in srgb,var(--series-1) 8%,transparent)}
table.data tr.detail td{background:color-mix(in srgb,var(--grid) 30%,transparent)}
td .kind{color:var(--text-secondary);font-size:12px}
.mini{font-size:12px;color:var(--text-muted)}
/* ===== 轮次时间线 ===== */
.round{border-left:2px solid var(--grid);padding:2px 0 6px 16px;position:relative}
.round:before{content:"";position:absolute;left:-5px;top:9px;width:8px;height:8px;border-radius:50%;
  background:var(--surface-1);border:2px solid var(--axis)}
.round .rhead{font-weight:600;cursor:pointer;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.round .rtime{color:var(--text-muted);font-weight:400;font-size:12px}
.round .rbody{margin-top:8px}
.round .rline{color:var(--text-secondary);font-size:13px;margin:4px 0}
.round .rline b{color:var(--text-primary)}
/* ===== 筛选行 / 下钻 ===== */
.filters{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.filters label{font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:6px}
select{font:inherit;font-size:13px;color:var(--text-primary);background:var(--surface-1);
  border:1px solid var(--border);border-radius:8px;padding:5px 26px 5px 10px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.chip-m{font-size:12px;color:var(--text-secondary);background:var(--surface-1);
  border:1px solid var(--border);border-radius:999px;padding:2px 10px}
.spark{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:12px;color:var(--text-muted)}
/* ===== 页脚 ===== */
footer{margin-top:40px;border-top:1px solid var(--border);padding-top:14px;color:var(--text-muted);font-size:12px}
footer ul{margin:6px 0;padding-left:18px}
code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:color-mix(in srgb,var(--grid) 55%,transparent);
  border-radius:4px;padding:1px 5px}
@media (max-width:760px){.kpis{grid-template-columns:1fr}}
</style>
</head>
<body class="viz-root">
<div class="wrap">
<header class="top">
  <div class="title-row">
    <h1>宝可梦 RL 训练看板</h1>
    <div class="no-print" style="display:flex;gap:8px">
      <button class="ctl" id="theme-btn">主题：自动</button>
      <button class="ctl" id="tex-btn">纹理：关</button>
    </div>
  </div>
  <p class="subtitle" id="goal-line"></p>
  <p class="meta" id="meta-line"></p>
</header>

<section>
  <h2><span class="no">1</span>达标进度</h2>
  <div class="kpis" id="meters"></div>
  <div class="kpis tiles" id="tiles"></div>
</section>

<section>
  <h2><span class="no">2</span>学习曲线
    <span class="sec-ctl no-print"><button class="ctl" id="curve-toggle">表格视图</button></span>
  </h2>
  <div id="curves"></div>
  <p class="caption">口径：座位 A = 学习策略，对手 = 困难启发式 AI，每档 500 局评测；虚线 = 对称基准（不学）与 80% 目标线；灰色曲线 = 已淘汰配方的对照。</p>
</section>

<section>
  <h2><span class="no">3</span>配方对比（按 3 人局成绩排序，点击展开细节）</h2>
  <div id="recipes"></div>
</section>

<section>
  <h2><span class="no">4</span>对局下钻（阶段 B 老虎机 jsonl）</h2>
  <div class="filters" id="drill-filters"></div>
  <div id="drill"></div>
  <p class="caption">当前 ppo-agent 训练不落逐局 jsonl，这里复用阶段 B 的 3 人局 / 18 分对局记录演示下钻；每局截取前 40 手。</p>
</section>

<section>
  <h2><span class="no">5</span>训练轮次（来自 训练日志.md）</h2>
  <div id="rounds"></div>
</section>

<section>
  <h2><span class="no">6</span>训练状态</h2>
  <div id="status"></div>
</section>

<footer id="foot"></footer>
</div>
<script>
/*PAGEJS*/
window.DB = __DB_JSON__;
(function () {
'use strict';
var DB = window.DB;
var GOAL = DB.goal.target;
var PL = ['2', '3', '4'];
var PL_CN = { '2': '2 人局', '3': '3 人局', '4': '4 人局' };
// SVG 呈现属性不认 var()，这里直接解析成当前主题下的十六进制（切主题会重建曲线）
function hueOf(n) { return cv('--series-' + (1 + PL.indexOf(n))); }
var ACT_CN = { take3: '拿取 3 色', take2: '拿取 2×', reserve: '预约', reserveBlind: '盲抽',
  buy: '购买', buyReserved: '购买预约卡', takeMaster: '拿取大师球', return: '退回' };
var COLOR_CN = { red: '普通球', blue: '超级球', black: '高级球', pink: '治愈球', yellow: '快速球', master: '大师球' };
var NS = 'http://www.w3.org/2000/svg';
function cv(name) { return getComputedStyle(document.querySelector('.viz-root')).getPropertyValue(name).trim(); }
function el(tag, cls, parent) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}
function svgEl(tag, attrs) {
  var e = document.createElementNS(NS, tag);
  for (var k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function text(e, s) { e.textContent = s == null ? '' : String(s); return e; }
function pct(x, d) { return x == null ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
function epFmt(v) { return v === 0 ? '0' : (v / 10000) + '万'; }
function fmtDur(sec) {
  if (sec == null) return '—';
  if (sec < 60) return Math.round(sec) + ' 秒';
  if (sec < 3600) return Math.round(sec / 60) + ' 分';
  var h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
}
function fmtNum(x) { return String(x == null ? '' : x).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }
function rateCell(r, n) {
  var s = r == null ? '—' : pct(r);
  if (r != null && n != null) s += '（' + n + ' 局）';
  return s;
}

/* ==================== 折线图（SVG 手绘） ==================== */
function lineChart(container, cfg) {
  var W = 660, H = 236;
  var m = { l: 46, r: 14, t: 12, b: 26 };
  var pw = W - m.l - m.r, ph = H - m.t - m.b;
  var x0 = cfg.xDomain[0], x1 = cfg.xDomain[1], y0 = cfg.yDomain[0], y1 = cfg.yDomain[1];
  var X = function (v) { return m.l + (v - x0) / (x1 - x0) * pw; };
  var Y = function (v) { return m.t + (y1 - v) / (y1 - y0) * ph; };
  var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': cfg.title });
  // 网格 + 刻度
  cfg.yTicks.forEach(function (v) {
    svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: cv('--grid'), 'stroke-width': 1 }));
    var t = svgEl('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', 'font-size': 10.5, fill: cv('--text-muted') });
    t.textContent = cfg.yTickFmt(v);
    svg.appendChild(t);
  });
  cfg.xTicks.forEach(function (v) {
    if (v === x0) return;
    var t = svgEl('text', { x: X(v), y: H - 7, 'text-anchor': 'middle', 'font-size': 10.5, fill: cv('--text-muted') });
    t.textContent = cfg.xTickFmt(v);
    svg.appendChild(t);
  });
  // 轴
  svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(y0), y2: Y(y0), stroke: cv('--axis'), 'stroke-width': 1 }));
  svg.appendChild(svgEl('line', { x1: m.l, x2: m.l, y1: m.t, y2: Y(y0), stroke: cv('--axis'), 'stroke-width': 1 }));
  // 参照线（对称基准 / 目标）
  cfg.refs.forEach(function (r) {
    svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(r.y), y2: Y(r.y),
      stroke: r.color, 'stroke-width': 1, 'stroke-dasharray': '3 4' }));
    var t = svgEl('text', { x: W - m.r - 2, y: Y(r.y) - 4, 'text-anchor': 'end', 'font-size': 10.5, fill: r.color });
    t.textContent = r.label;
    svg.appendChild(t);
  });
  // 数据线
  var allPts = [];
  var placed = [];
  cfg.series.forEach(function (s, si) {
    var d = 'M' + s.points.map(function (p) { return X(p[0]) + ' ' + Y(p[1]); }).join('L');
    svg.appendChild(svgEl('path', { d: d, fill: 'none', stroke: s.color,
      'stroke-width': s.deemph ? 1.5 : 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'class': 's-line', 'data-dash': (si % 4), opacity: s.deemph ? 0.55 : 1 }));
    s.points.forEach(function (p) {
      svg.appendChild(svgEl('circle', { cx: X(p[0]), cy: Y(p[1]), r: 3, fill: s.color,
        stroke: cv('--surface-1'), 'stroke-width': 2, 'class': 's-dot' }));
      allPts.push({ x: p[0], px: X(p[0]) });
    });
    var last = s.points[s.points.length - 1];
    svg.appendChild(svgEl('circle', { cx: X(last[0]), cy: Y(last[1]), r: 4.5, fill: s.color,
      stroke: cv('--surface-1'), 'stroke-width': 2 }));
    if (s.endLabel) {
      var tx = X(last[0]) + 9, anchor = 'start';
      if (tx > W - m.r - 74) { tx = X(last[0]) - 9; anchor = 'end'; }
      // 端标签防碰撞：和已放置的标签太近就朝远离它的方向挪一行（最多挪 2 行）
      var ly = Y(last[1]) + 3.5, guard = 0;
      while (guard < 2) {
        var hit = null;
        for (var pi = 0; pi < placed.length; pi++) {
          if (Math.abs(placed[pi].x - tx) < 34 && Math.abs(placed[pi].y - ly) < 15) { hit = placed[pi]; break; }
        }
        if (!hit) break;
        ly += hit.y <= ly ? 13 : -13;
        guard++;
      }
      placed.push({ x: tx, y: ly });
      var lb = svgEl('text', { x: tx, y: ly, 'text-anchor': anchor, 'font-size': 11,
        fill: s.deemph ? cv('--text-muted') : cv('--text-primary'), 'font-weight': s.deemph ? 400 : 600 });
      lb.textContent = s.endLabel;
      svg.appendChild(lb);
    }
  });
  // 悬停：十字线 + 单工具提示（所有系列同 X 的值）
  var tip = el('div', 'tip', container);
  var cross = svgEl('line', { y1: m.t, y2: Y(y0), stroke: cv('--text-muted'), 'stroke-width': 1 });
  cross.style.display = 'none';
  svg.appendChild(cross);
  var ov = svgEl('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
  var uniq = [];
  allPts.forEach(function (p) { if (uniq.indexOf(p.x) < 0) uniq.push(p.x); });
  uniq.sort(function (a, b) { return a - b; });
  ov.addEventListener('pointermove', function (ev) {
    var r = svg.getBoundingClientRect();
    var sx = (ev.clientX - r.left) / r.width * W;
    var best = null, bd = Infinity;
    uniq.forEach(function (x) { var d = Math.abs(X(x) - sx); if (d < bd) { bd = d; best = x; } });
    if (best == null) return;
    cross.setAttribute('x1', X(best)); cross.setAttribute('x2', X(best));
    cross.style.display = '';
    tip.textContent = '';
    text(el('div', 'thead', tip), cfg.xTipFmt ? cfg.xTipFmt(best) : epFmt(best) + ' 局');
    cfg.series.forEach(function (s) {
      var hit = null;
      s.points.forEach(function (p) { if (p[0] === best) hit = p; });
      if (!hit) return;
      var row = el('div', 'trow', tip);
      el('span', 'key', row).style.background = s.color;
      text(el('span', 'tval', row), pct(hit[1]));
      text(el('span', 'tname', row), s.name);
    });
    tip.style.display = '';
    var px = Math.min(r.width - 150, Math.max(6, ev.clientX - r.left + 14));
    var py = ev.clientY - r.top - tip.offsetHeight - 10;
    if (py < 0) py = ev.clientY - r.top + 14;
    tip.style.left = px + 'px';
    tip.style.top = py + 'px';
  });
  ov.addEventListener('pointerleave', function () { cross.style.display = 'none'; tip.style.display = 'none'; });
  svg.appendChild(ov);
  container.appendChild(svg);
}

/* ==================== 1. 达标进度 ==================== */
function renderMeters() {
  var box = document.getElementById('meters');
  box.innerHTML = '';
  PL.forEach(function (n) {
    var m = DB.main[n];
    var card = el('div', 'kpi', box);
    var head = el('div', '', card);
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
    text(el('div', 'lab', head), PL_CN[n]);
    var ok = m.final != null && m.final * 100 >= GOAL;
    var diff = GOAL - (m.final == null ? 0 : m.final * 100);
    var chip = el('span', 'chip ' + (ok ? 'ok' : 'no'), head);
    text(chip, ok ? '✓ 已达标' : '✗ 差 ' + diff.toFixed(1) + ' 个百分点');
    var val = el('div', 'val', card);
    text(val, pct(m.final));
    var sub = el('div', 'sub', card);
    var winsTxt = m.wins != null && m.evalGames ? m.wins + '/' + m.evalGames : '';
    var subTxt = (winsTxt ? winsTxt + ' · ' : '') + '对称基准 ' + pct(DB.baseline[n]);
    if (!m.hist3wDup && m.hist3w && m.hist3w.final != null) subTxt += ' · 3 万局收尾 ' + pct(m.hist3w.final);
    text(sub, subTxt);
    var track = el('div', 'meter-track', card);
    var fill = el('div', 'meter-fill ' + (ok ? 'ok' : 'no'), track);
    var ratio = m.final == null ? 0 : Math.min(1, m.final / (GOAL / 100));
    fill.style.width = (ratio * 100).toFixed(1) + '%';
    var tick = el('div', 'meter-tick', track);
    tick.style.left = GOAL + '%';
    tick.title = '目标 ' + GOAL + '%';
    var note = el('div', 'meter-note', card);
    text(el('span', '', note), '当前 ' + pct(m.final));
    text(el('span', '', note), '目标 ' + GOAL + '%');
  });
}
function renderTiles() {
  var box = document.getElementById('tiles');
  box.innerHTML = '';
  var tile = function (lab, val, sub) {
    var c = el('div', 'kpi', box);
    text(el('div', 'lab', c), lab);
    text(el('div', 'val', c), val);
    if (sub) text(el('div', 'sub', c), sub);
  };
  var lr = DB.lastRound;
  tile('当前轮次', lr ? '第 ' + lr.n + ' 轮' : '—', lr ? lr.title : '');
  tile('主线累计耗时', DB.totalMainSec != null ? fmtDur(DB.totalMainSec) : '—', '2/3/4 人局 3 万局训练');
  tile('网络参数量', DB.paramCount != null ? fmtNum(DB.paramCount) : '—', DB.netShape || '');
}

/* ==================== 2. 学习曲线（小倍图 ×3） ==================== */
var curveSeries = null; // 缓存，供表格视图共用
function buildCurveSeries() {
  if (curveSeries) return curveSeries;
  curveSeries = {};
  var ctxDefs = {
    '2': [['train-agent 2p（线性 Q）', 'train-agent-2p-']],
    '3': [['lqlearn（线性 Q）', 'lqlearn-'], ['train-agent 3p（线性 Q）', 'train-agent-3p-'],
          ['ppo-big（线性 PPO）', 'ppo-big-'], ['ppo-big-nn（PPO-NN 前身）', 'ppo-big-nn-']],
    '4': [['train-agent 4p（线性 Q）', 'train-agent-4p-']],
  };
  PL.forEach(function (n) {
    var list = [];
    list.push({ name: 'PPO-NN 主线', color: hueOf(n), deemph: false,
      points: DB.main[n].curve.map(function (p) { return [p.ep, p.rate * 100]; }),
      endLabel: pct(DB.main[n].final) });
    ctxDefs[n].forEach(function (def) {
      var prefixRe = new RegExp('^' + def[1] + '\\\\d+$');
      var cands = [];
      DB.recipes.forEach(function (r) {
        var c = r.detail && r.detail.curve;
        if (c && c.length > 1 && prefixRe.test(r.label)) cands.push(r);
      });
      if (!cands.length) return;
      // 灰色对照线：优先曲线终点 ≤ 6 万局（别把横轴拉爆）；都没有就取终点最小的
      var run = null;
      cands.forEach(function (r) {
        var c = r.detail.curve;
        if (!run && c[c.length - 1].ep <= 60000) run = r;
      });
      if (!run) cands.forEach(function (r) {
        var c = r.detail.curve;
        if (!run || c[c.length - 1].ep < run.detail.curve[run.detail.curve.length - 1].ep) run = r;
      });
      list.push({ name: def[0], color: cv('--text-muted'), deemph: true,
        points: run.detail.curve.map(function (p) { return [p.ep, p.rate * 100]; }),
        endLabel: pct(curveLast(run.detail.curve)) });
    });
    // 3 万局收尾段：摘要已被长跑覆盖时，作为灰色历史线保留在图上
    var h = DB.main[n].hist3w;
    if (h && h.curve && h.curve.length && !DB.main[n].hist3wDup) {
      list.push({ name: 'ppo-agent 3 万局收尾', color: cv('--text-muted'), deemph: true,
        points: h.curve.map(function (p) { return [p.ep, p.rate * 100]; }),
        endLabel: pct(h.final) });
    }
    curveSeries[n] = list;
  });
  return curveSeries;
}
function curveLast(c) { return c.length ? c[c.length - 1].rate : null; }
function renderCurves() {
  var box = document.getElementById('curves');
  box.innerHTML = '';
  var ss = buildCurveSeries();
  PL.forEach(function (n) {
    var card = el('div', 'card', box);
    var h = el('div', '', card);
    h.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap';
    text(el('strong', '', h), PL_CN[n] + ' · 夺冠率随训练局数');
    text(el('span', 'mini', h), '当前 ' + pct(DB.main[n].final) + ' · 历史最优 ' + pct(DB.main[n].best));
    var fig = el('div', 'chart-fig', card);
    var xMax = 0;
    ss[n].forEach(function (s) { s.points.forEach(function (p) { if (p[0] > xMax) xMax = p[0]; }); });
    xMax = Math.max(30000, Math.ceil(xMax / 10000) * 10000);
    var xTicks = [];
    for (var x = 0; x <= xMax; x += 10000) xTicks.push(x);
    lineChart(fig, {
      title: PL_CN[n] + ' 学习曲线',
      xDomain: [0, xMax], yDomain: [0, 100],
      xTicks: xTicks, yTicks: [0, 20, 40, 60, 80, 100],
      xTickFmt: epFmt, yTickFmt: function (v) { return v + '%'; },
      xTipFmt: function (v) { return v + ' 局'; },
      refs: [
        { y: DB.baseline[n] * 100, label: '对称基准 ' + pct(DB.baseline[n]), color: cv('--text-muted') },
        { y: GOAL, label: '目标 ' + GOAL + '%', color: cv('--good') },
      ],
      series: ss[n],
    });
    // 图例（≥2 条序列必须有；参照线直接标在线上）
    var lg = el('div', 'legend-row', card);
    ss[n].forEach(function (s) {
      var k = el('span', 'lkey', lg);
      var sw = el('span', 'sw', k);
      sw.style.background = s.color;
      if (s.deemph) sw.style.opacity = '0.55';
      text(el('span', '', k), s.name + (s.deemph ? '' : '（ppo-agent 3 万局）'));
    });
    var kr = el('span', 'lkey', lg);
    el('span', 'sw dash', kr);
    text(el('span', '', kr), '对称基准 / 目标线');
  });
}
function renderCurveTable() {
  var box = document.getElementById('curves');
  box.innerHTML = '';
  var ss = buildCurveSeries();
  PL.forEach(function (n) {
    var card = el('div', 'card', box);
    text(el('strong', '', card), PL_CN[n] + ' · 评估明细（胜率%）');
    var tb = el('table', 'data', card);
    var thead = el('thead', '', tb);
    var tr = el('tr', '', thead);
    text(el('th', '', tr), '训练局数');
    ss[n].forEach(function (s) { text(el('th', 'num', tr), s.name); });
    var tbody = el('tbody', '', tb);
    var rows = {};
    ss[n].forEach(function (s) { s.points.forEach(function (p) { (rows[p[0]] = rows[p[0]] || {})[s.name] = p[1]; }); });
    Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (ep) {
      var r = el('tr', '', tbody);
      var td0 = el('td', 'num', r);
      td0.style.fontVariantNumeric = 'tabular-nums';
      text(td0, ep);
      ss[n].forEach(function (s) {
        var v = rows[ep][s.name];
        text(el('td', 'num', r), v == null ? '—' : pct(v));
      });
    });
  });
}

/* ==================== 3. 配方对比表 ==================== */
function renderRecipes() {
  var box = document.getElementById('recipes');
  box.innerHTML = '';
  var tb = el('table', 'data', box);
  var thead = el('thead', '', tb);
  var tr = el('tr', '', thead);
  ['配方', '类别', '训练量', '2 人局', '3 人局', '4 人局', '守恒违规', '数据来源'].forEach(function (h, i) {
    text(el('th', i >= 3 && i <= 5 ? 'num' : '', tr), h);
  });
  var tbody = el('tbody', '', tb);
  DB.recipes.forEach(function (r) {
    var tr2 = el('tr', 'clickable' + (r.current ? ' current' : ''), tbody);
    text(el('td', '', tr2), r.label + (r.current ? '  ★' : ''));
    text(el('td', '', tr2), r.kind);
    text(el('td', '', tr2), r.train);
    PL.forEach(function (n) {
      var c = r.rates[n];
      var td = el('td', 'num', tr2);
      text(td, c && c.rate != null ? pct(c.rate) + (c.wins != null && c.n != null ? '（' + c.wins + '/' + c.n + '）' : '') : '—');
    });
    text(el('td', 'num', tr2), r.leaks == null ? '—' : r.leaks);
    text(el('td', 'mini', tr2), r.source || '');
    if (!r.detail) return;
    var det = el('tr', 'detail', tbody);
    det.style.display = 'none';
    var td = el('td', '', det);
    td.setAttribute('colspan', '8');
    tr2.addEventListener('click', function () {
      det.style.display = det.style.display === 'none' ? '' : 'none';
      tr2.setAttribute('aria-expanded', det.style.display !== 'none' ? 'true' : 'false');
    });
    renderRecipeDetail(td, r);
  });
}
function renderRecipeDetail(td, r) {
  var d = r.detail;
  if (d.curves) {
    var tbl = el('table', 'data', td);
    var thead = el('thead', '', tbl);
    var tr = el('tr', '', thead);
    text(el('th', '', tr), '人数');
    ['训练局数', '胜率', '胜负', '守恒违规'].forEach(function (h) { text(el('th', 'num', tr), h); });
    var tbody = el('tbody', '', tbl);
    PL.forEach(function (n) {
      var c = d.curves[n];
      if (!c || !c.length) return;
      c.forEach(function (p, pi) {
        var row2 = el('tr', '', tbody);
        text(el('td', '', row2), pi === 0 ? PL_CN[n] : '');
        var t1 = el('td', 'num', row2); text(t1, p.ep);
        var t2 = el('td', 'num', row2); text(t2, pct(p.rate));
        var t3 = el('td', 'num', row2); text(t3, p.wins != null ? p.wins + ' 胜' : '—');
        var t4 = el('td', 'num', row2); text(t4, p.leaks || 0);
      });
    });
    if (d.mdNote) text(el('p', 'mini', td), d.mdNote);
    return;
  }
  if (d.curve && d.curve.length) {
    var p = el('p', '', td);
    text(p, '评估轨迹：' + d.curve.map(function (q) { return q.ep + ' 局 ' + pct(q.rate); }).join(' → '));
    if (d.elapsed != null) text(el('p', 'mini', td), '耗时 ' + fmtDur(d.elapsed));
  }
  if (d.sample && d.sample.actions.length) {
    text(el('p', 'mini', td), '样例一局（前 30 手，冠军座位 ' + seatName(d.sample.winner) + '）：');
    renderActions(el('table', 'data', td), d.sample.actions);
  }
}

/* ==================== 4. 对局下钻 ==================== */
var drillSel = { e: 0, g: 0 };
function renderDrillFilters() {
  var box = document.getElementById('drill-filters');
  box.innerHTML = '';
  if (drillSel.e >= DB.drill.length) drillSel.e = 0;
  var lab1 = el('label', '', box);
  text(el('span', '', lab1), '实验');
  var selExp = el('select', '', lab1);
  selExp.id = 'exp-sel';
  DB.drill.forEach(function (e, i) {
    var o = el('option', '', selExp);
    o.value = String(i);
    text(o, e.name + '（' + e.n + ' 局 · ' + pct(e.winRate) + '）');
  });
  var lab2 = el('label', '', box);
  text(el('span', '', lab2), '对局（前 ' + (DB.drill[0] ? DB.drill[0].eps.length : 0) + ' 局）');
  var selEp = el('select', '', lab2);
  selEp.id = 'ep-sel';
  var refresh = function () {
    var e = DB.drill[+selExp.value];
    drillSel.e = +selExp.value;
    if (drillSel.g >= e.eps.length) drillSel.g = 0;
    selEp.textContent = '';
    e.eps.forEach(function (ep, i) {
      var o = el('option', '', selEp);
      o.value = String(i);
      text(o, 'seed ' + ep.seed + ' · ' + ep.turns + ' 手 · 冠军 ' + seatName(ep.winner));
    });
    selEp.value = String(drillSel.g);
    renderDrill(drillSel.e, drillSel.g);
  };
  selExp.addEventListener('change', refresh);
  selEp.addEventListener('change', function () { drillSel.g = +selEp.value; renderDrill(drillSel.e, drillSel.g); });
  selExp.value = String(drillSel.e);
  refresh();
}
function renderDrill(ei, gi) {
  var box = document.getElementById('drill');
  box.innerHTML = '';
  var e = DB.drill[ei];
  var ep = e.eps[gi];
  var card = el('div', 'card', box);
  var chips = el('div', 'chips', card);
  [['胜率', pct(e.winRate) + '（' + e.wins + '/' + e.n + '）'], ['人数', e.players ? e.players.length + ' 人' : '—'],
   ['目标分', e.target || '—'], ['本局手数', ep.turns], ['冠军', seatName(ep.winner)],
   ['完成', ep.finished ? '是' : '否']].forEach(function (c) {
    var m = el('span', 'chip-m', chips);
    m.appendChild(text(el('b', '', null), c[0] + ' '));
    m.appendChild(document.createTextNode(String(c[1])));
  });
  if (e.winList && e.winList.length > 1) {
    var sp = el('div', 'spark', card);
    text(el('span', '', sp), '累计胜率曲线');
    var svg = svgEl('svg', { width: 200, height: 30, viewBox: '0 0 200 30', role: 'img', 'aria-label': '累计胜率曲线' });
    var pts = e.winList;
    var d = 'M' + pts.map(function (v, i) {
      return (i / (pts.length - 1) * 200).toFixed(1) + ' ' + (30 - v * 28 - 1).toFixed(1);
    }).join('L');
    svg.appendChild(svgEl('path', { d: d, fill: 'none', stroke: cv('--text-muted'), 'stroke-width': 1.5 }));
    sp.appendChild(svg);
    text(el('span', '', sp), pct(pts[0]) + ' → ' + pct(pts[pts.length - 1]));
  }
  var h = el('p', '', card);
  text(el('b', '', h), '行动序列（前 40 手）');
  renderActions(el('table', 'data', card), ep.actions);
}
function seatName(s) { return s == null ? '—' : '座位 ' + String.fromCharCode(65 + s); }
function actText(a) {
  var p = a.p || {};
  if (a.k === 'take3' && p.colors) return '拿取 ' + p.colors.map(function (c) { return COLOR_CN[c] || c; }).join(' + ');
  if (a.k === 'take2') return '拿取 2×' + (COLOR_CN[p.color] || p.color || '—');
  if (a.k === 'buy') return '购买 ' + p.tier + ' 阶 #' + p.idx;
  if (a.k === 'buyReserved') return '购买预约卡 #' + p.ridx;
  if (a.k === 'reserve') return '预约 ' + p.tier + ' 阶 #' + p.idx;
  if (a.k === 'reserveBlind') return '盲抽 ' + p.tier + ' 阶';
  if (a.k === 'return') return '退回 ' + (COLOR_CN[p.color] || p.color || '—');
  return ACT_CN[a.k] || a.k || '—';
}
function renderActions(tb, actions) {
  var thead = el('thead', '', tb);
  var tr = el('tr', '', thead);
  ['手数', '座位', '动作', '参数', '奖励 r'].forEach(function (h) { text(el('th', '', tr), h); });
  var tbody = el('tbody', '', tb);
  actions.forEach(function (a) {
    var r = el('tr', '', tbody);
    text(el('td', 'num', r), a.t == null ? '—' : a.t);
    text(el('td', '', r), seatName(a.seat));
    text(el('td', '', r), actText(a));
    text(el('td', 'mini', r), actParam(a));
    text(el('td', 'num', r), a.r == null ? '' : a.r);
  });
}
function actParam(a) {
  var p = a.p || {};
  if (a.k === 'take3') return (p.colors || []).join('、');
  if (a.k === 'take2') return '×2';
  return '';
}

/* ==================== 5. 训练轮次 ==================== */
function renderRounds() {
  var box = document.getElementById('rounds');
  box.innerHTML = '';
  var last = DB.rounds.length - 1;
  DB.rounds.forEach(function (r, i) {
    var div = el('div', 'round', box);
    var head = el('div', 'rhead', div);
    text(el('span', '', head), '第 ' + r.n + ' 轮 · ' + r.title);
    var body = el('div', 'rbody', div);
    if (i !== last) body.style.display = 'none'; // 默认只展开最后一轮
    if (r.changed) line(body, '改了什么', r.changed);
    if (r.rateLine) line(body, '三档胜率', r.rateLine);
    if (r.vsPrev) line(body, '对比上一轮', r.vsPrev);
    if (r.concl) line(body, '结论', r.concl);
    r.tables.forEach(function (tb) {
      var tbl = el('table', 'data', body);
      var thead = el('thead', '', tbl);
      var tr = el('tr', '', thead);
      tb.head.forEach(function (c) { text(el('th', '', tr), c); });
      var tbody = el('tbody', '', tbl);
      tb.rows.forEach(function (row) {
        var tr2 = el('tr', '', tbody);
        row.forEach(function (c, j) { text(el('td', j === 0 ? '' : 'num', tr2), c); });
      });
    });
    if (r.changed || r.rateLine || r.vsPrev || r.concl || r.tables.length) {
      head.addEventListener('click', function () {
        var show = body.style.display === 'none';
        body.style.display = show ? '' : 'none';
      });
    }
  });
  function line(body, lab, txt) {
    var p = el('div', 'rline', body);
    text(el('b', '', p), lab + '：');
    p.appendChild(document.createTextNode(' ' + txt));
  }
}

/* ==================== 6. 训练状态 ==================== */
function renderStatus() {
  var box = document.getElementById('status');
  box.innerHTML = '';
  var card = el('div', 'card', box);
  var tb = el('table', 'data', card);
  var thead = el('thead', '', tb);
  var tr = el('tr', '', thead);
  ['人数', '当前状态', '主线训练量', '最新评估', '历史最优', '评测/档', '耗时', '权重文件'].forEach(function (h, i) {
    text(el('th', i >= 5 ? 'num' : '', tr), h);
  });
  var tbody = el('tbody', '', tb);
  PL.forEach(function (n) {
    var m = DB.main[n];
    var r = el('tr', '', tbody);
    text(el('td', '', r), PL_CN[n]);
    var st = el('td', '', r);
    var run = DB.running[n];
    if (run) {
      var chip = el('span', 'chip warn', st);
      text(chip, '● 长跑进行中');
      text(el('div', 'mini', st), '启动 ' + run.startedAt + ' · 已 ' + epFmt(m.done || 0) + ' 局 · 每 ' + run.ckptEvery + ' 局检查点');
    } else {
      var chip2 = el('span', 'chip ok', st);
      text(chip2, '✓ 3 万局已完成');
    }
    var last = m.curve.length ? m.curve[m.curve.length - 1] : null;
    var bestEp = null;
    m.curve.forEach(function (p) { if (p.rate === m.best) bestEp = p.ep; });
    text(el('td', 'num', r), m.targetEp && m.targetEp > 30000 ? epFmt(m.done || 0) + ' / ' + epFmt(m.targetEp) : '3 万');
    text(el('td', 'num', r), last ? pct(last.rate) + ' @' + last.ep + ' 局' : '—');
    text(el('td', 'num', r), pct(m.best) + (bestEp != null && last && bestEp !== last.ep ? ' @' + bestEp + ' 局' : ''));
    text(el('td', 'num', r), m.evalGames || '—');
    text(el('td', 'num', r), fmtDur(m.elapsed));
    text(el('td', 'mini', r), m.weight || '—');
  });
  var note = el('p', 'caption', card);
  text(note, '评测口径：目标分 18、每档 ' + DB.goal.evalGames + ' 局、守恒违规必须为 0；独立种子集 500 局复核尚未开跑。' +
    (DB.goal.spec ? ' 日志口径：' + DB.goal.spec.slice(0, 80) + '…' : ''));
}

/* ==================== 页脚 ==================== */
function renderFoot() {
  var f = document.getElementById('foot');
  var p = el('p', '', f);
  text(p, '生成于 ' + DB.generatedAt + ' · 数据来源 ' + DB.sources.read.length + ' 个文件' +
    (DB.sources.skipped.length ? '（' + DB.sources.skipped.length + ' 个缺失/跳过）' : ''));
  var ul = el('ul', '', f);
  DB.sources.read.forEach(function (s) { text(el('li', '', ul), s); });
  var p2 = el('p', '', f);
  text(p2, '重新生成：项目根目录执行 node 工具/rl/dashboard.js —— 新训练落盘后重跑即可刷新。');
}

/* ==================== 主题 / 纹理开关 ==================== */
function bindToggles() {
  var tb = document.getElementById('theme-btn');
  var modes = ['自动', '浅', '深'];
  var i = 0;
  tb.addEventListener('click', function () {
    i = (i + 1) % 3;
    text(tb, '主题：' + modes[i]);
    var rootEl = document.documentElement;
    if (modes[i] === '浅') rootEl.setAttribute('data-theme', 'light');
    else if (modes[i] === '深') rootEl.setAttribute('data-theme', 'dark');
    else rootEl.removeAttribute('data-theme');
    curveSeries = null; // 颜色变了，重建曲线（曲线颜色来自 CSS 变量）
    if (curveTableMode) renderCurveTable(); else renderCurves();
    renderDrillFilters();
  });
  var tx = document.getElementById('tex-btn');
  tx.addEventListener('click', function () {
    var on = document.body.classList.toggle('tex');
    text(tx, '纹理：' + (on ? '开' : '关'));
  });
}
var curveTableMode = false;
function bindCurveToggle() {
  var btn = document.getElementById('curve-toggle');
  btn.addEventListener('click', function () {
    curveTableMode = !curveTableMode;
    text(btn, curveTableMode ? '图表视图' : '表格视图');
    if (curveTableMode) renderCurveTable(); else renderCurves();
  });
}

/* ==================== 入口 ==================== */
function init() {
  text(document.getElementById('goal-line'),
    (DB.goal.goalText || '对困难启发式 AI 的夺冠率 2/3/4 人局均 ≥ ' + GOAL + '%'));
  text(document.getElementById('meta-line'),
    '目标分 ' + DB.goal.targetScore + ' · 每档 ' + DB.goal.evalGames + ' 局评测 · 生成于 ' + DB.generatedAt);
  renderMeters();
  renderTiles();
  renderCurves();
  renderRecipes();
  renderDrillFilters();
  renderRounds();
  renderStatus();
  renderFoot();
  bindToggles();
  bindCurveToggle();
}
init();
})();
/*ENDPAGEJS*/
</script>
</body>
</html>
`;

const html = HTML.replace('/*PAGEJS*/', '').replace('/*ENDPAGEJS*/', '').replace('__DB_JSON__', DB_JSON);
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');

/* ==================== 10. 汇报 ==================== */
console.log('dashboard.js：训练看板已生成');
console.log(`  输出：${path.relative(process.cwd(), OUT)}（${(html.length / 1024).toFixed(0)} KB）`);
console.log(`  主线：2 人 ${pct(main[2].final)} / 3 人 ${pct(main[3].final)} / 4 人 ${pct(main[4].final)}（目标 ${goal}%）`);
console.log(`  配方 ${recipes.length} 条 · 训练轮次 ${md.rounds.length} 轮 · 下钻实验 ${drill.length} 组 · 数据文件 ${sources.read.length} 个`);
const runningN = Object.keys(running).map((n) => `${n} 人`);
if (runningN.length) console.log(`  运行中：${runningN.join(' / ')}（新一轮长跑）`);
if (sources.skipped.length) console.log(`  跳过/缺失：${sources.skipped.length} 个（容错，不影响生成）`);

if (!process.argv.includes('--no-open')) {
  try {
    spawn('cmd', ['/c', 'start', '', OUT], { detached: true, stdio: 'ignore' }).unref();
    console.log('  已尝试在浏览器中打开（打不开就手动双击）');
  } catch (e) { /* 打不开不致命 */ }
}
