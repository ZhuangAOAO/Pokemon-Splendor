'use strict';
/* ================================================================
   human-bench.js —— 「真人挑战局」这把尺子（只读，可重复）
   ----------------------------------------------------------------
   用途：把线上/本地 `replays` 表里 mode='challenge' 的对局拉出来，
        逐局算「人数 / 人类分 / AI 分 / 谁赢」，再按人数分档汇总人类胜率。
        换尺子的目的：镜像线、打启发式线都是**自家人打自家人**，
        只有真人挑战局能回答「人对这版 AI 到底赢几成」。

   三条硬纪律（写死在代码里，不靠人记）：
     1) 只读：只 SELECT；连上后立刻 `SET SESSION TRANSACTION READ ONLY`
        （MySQL 自己挡住写，不是靠"我保证不写"）。`--readonly-selftest`
        会**当场试一条写**（`WHERE 1=0`，一行都碰不到）并核对是否被拒。
     2) 默认连本地库；**只有显式 `--db prod` / `--remote`** 才连线上。
        连库前打印 host / 库名（密码永不回显）。
     3) 判赢口径**与 server.js 同源**：不抄第二份 —— 运行时从 server.js
        原文抠出 rankEndgame / seatIsHuman / hasHumanWinner 三个函数再执行，
        抠不到就直接报错退出（宁可不跑，也不要跑出一份"看着像"的口径）。

   用法：
     node 工具/rl/human-bench.js                    # 本地库（默认）
     node 工具/rl/human-bench.js --from-snapshot    # 离线：只吃 data/human-games.json 复算
     node 工具/rl/human-bench.js --from-snapshot 别的路径.json
     node 工具/rl/human-bench.js --db prod --db-host 127.0.0.1 --db-port 13306 \
          --db-user root --db-name splendor        # 线上库（只读）
     node 工具/rl/human-bench.js --readonly-selftest      # 额外验一次"写真的被挡"
     node 工具/rl/human-bench.js --no-write               # 不写快照
     node 工具/rl/human-bench.js --report out.json        # 落一份机器可读报告

   快照：默认重新写 `工具/rl/data/human-games.json`（字段与线上快照一致，便于日后比对）。
         **防误伤**：新快照局数少于盘上旧快照时默认拒绝写（本地库只有 1 局挑战局，
         一跑就会把线上 9 局的参照快照冲掉）——确需覆盖用 `--force`。
   ================================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 读文本一律去 BOM（PS 5.1 写 UTF-8 带 BOM，JSON.parse 会当场炸）
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

const RL_DIR = __dirname;                          // 工具/rl
const ROOT = path.resolve(RL_DIR, '..', '..');     // 项目根
const DATA_DIR = path.join(RL_DIR, 'data');
const SNAPSHOT_DEFAULT = path.join(DATA_DIR, 'human-games.json');

/* ==================== 参数 ==================== */
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
function flagVal(f, dflt) {
  const i = argv.indexOf(f);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? dflt : v;
}
// --from-snapshot 可以不带值（用默认快照路径）
const FROM_SNAPSHOT = hasFlag('--from-snapshot');
const SNAPSHOT_IN = path.resolve(ROOT, flagVal('--from-snapshot', SNAPSHOT_DEFAULT));
const DB_TARGET = String(flagVal('--db', 'local')).toLowerCase();
const REMOTE = DB_TARGET === 'prod' || DB_TARGET === 'remote' || hasFlag('--remote');
const OUT_PATH = path.resolve(ROOT, flagVal('--out', SNAPSHOT_DEFAULT));
const REPORT_PATH = flagVal('--report', '');
const NO_WRITE = hasFlag('--no-write');
const FORCE = hasFlag('--force');
const SELFTEST = hasFlag('--readonly-selftest');
const LIMIT = Number(flagVal('--limit', 0)) || 0;
const MODE_TAG = FROM_SNAPSHOT ? '快照' : (REMOTE ? '线上库' : '本地库');

/* ==================== 用法：--help ==================== */
const HELP = `
human-bench.js —— 真人挑战局这把尺子（只读，可重复）

用法：
  node 工具/rl/human-bench.js                    # 本地库（默认）
  node 工具/rl/human-bench.js --from-snapshot    # 离线复算 data/human-games.json（不连库）
  node 工具/rl/human-bench.js --from-snapshot 别的路径.json
  node 工具/rl/human-bench.js --readonly-selftest  # 额外验一次「写真的被挡」（UPDATE ... WHERE 1=0）
  node 工具/rl/human-bench.js --no-write         # 不写本地快照
  node 工具/rl/human-bench.js --print-judge      # 打印从 server.js 抽出的判赢口径原文
  node 工具/rl/human-bench.js --out <路径>       # 快照落盘位置（缺省 工具/rl/data/human-games.json）
  node 工具/rl/human-bench.js --report <路径>    # 另落一份机器可读汇总 JSON

线上只读怎么走隧道（三段式，用完必回收）：

  1) 建隧道：本机 <本地端口> → <跳板/主机> 上的 MySQL 3306
       ssh -N -L <本地端口>:127.0.0.1:3306 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -o ConnectTimeout=10 <跳板/主机>
     密钥不进命令行：靠 ~/.ssh/config 的 Host 别名，或环境变量指定的私钥文件。
     -N = 不执行远端命令（服务器上不落文件、不留脚本）。

  2) 另开一个终端跑尺子（连的是本地端口；连线上必须显式 --db prod）
       node 工具/rl/human-bench.js --db prod --db-host 127.0.0.1 --db-port <本地端口> \\
            --db-name <库名> --report 工具/rl/data/human-report.json
     用户/口令不进命令行：走环境变量 SPLENDOR_DB_USER / SPLENDOR_DB_PASSWORD（或 data/db.json）；
     命令行只传 --db-host/--db-port/--db-name 这类非敏感项。

  3) 用完回收隧道（别让它在后台挂着）
       前台跑的：Ctrl+C
       后台跑的：taskkill /PID <ssh 的 PID> /F   （Windows）｜ kill <ssh 的 PID>   （Linux/macOS）

纪律（写死在代码里，不靠人记）：
  · 只读：只发 SELECT，连上立刻 SET SESSION TRANSACTION READ ONLY（写由 MySQL 拦，不靠自觉）。
  · 服务器不落文件：全程不写远端磁盘，快照只写本机（缺省 工具/rl/data/human-games.json）。
  · 默认连本地库；只有显式 --db prod / --remote 才连线上。
  · 判赢口径从 server.js 原文抠出（rankEndgame / seatIsHuman / hasHumanWinner），抠不到就报错退出。
  · 小样本一律带 n：3 人局人类样本可能只有个位数局，报数写 n=?，别把 n=3 说成定论。
`;
if (hasFlag('--help') || hasFlag('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (FROM_SNAPSHOT && (REMOTE || DB_TARGET !== 'local')) {
  console.error('参数错误：--from-snapshot 是离线复算，不能和 --db prod / --remote 一起用。');
  process.exit(2);
}

/* ==================== 判赢口径：从 server.js 原文抠函数（同源，不写第二份） ==================== */
// 扫到函数头后做括号配对；跳过字符串与注释，避免被函数体里的字符串/注释里的括号骗了。
function sliceBalanced(src, fromIdx, what) {
  let i = src.indexOf('{', fromIdx);
  if (i < 0) throw new Error(`${what}：找不到函数体起始 '{'`);
  let depth = 0, mode = null;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === '//') { if (c === '\n') mode = null; continue; }
    if (mode === '/*') { if (c === '*' && n === '/') { mode = null; i++; } continue; }
    if (mode) { if (c === '\\') { i++; continue; } if (c === mode) mode = null; continue; }
    if (c === '/' && n === '/') { mode = '//'; i++; continue; }
    if (c === '/' && n === '*') { mode = '/*'; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { mode = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(fromIdx, i + 1); }
  }
  throw new Error(`${what}：括号没配平`);
}
const JUDGE_NAMES = ['rankEndgame', 'seatIsHuman', 'hasHumanWinner'];
const judgeSrc = (() => {
  const serverPath = path.join(ROOT, 'server.js');
  let src;
  try {
    src = readText(serverPath);
  } catch (e) {
    throw new Error(`读不到 server.js（${serverPath}）：${e.message}`);
  }
  return JUDGE_NAMES.map((n) => {
    const at = src.indexOf('function ' + n + '(');
    if (at < 0) throw new Error(`server.js 里找不到 function ${n}() —— 口径源变了，停止跑数（别用近似口径凑）`);
    return sliceBalanced(src, at, 'function ' + n);
  }).join('\n');
})();
const JUDGE_SHA = crypto.createHash('sha256').update(judgeSrc).digest('hex').slice(0, 12);
const judge = new Function(judgeSrc + '\nreturn { rankEndgame, seatIsHuman, hasHumanWinner };')();
const { rankEndgame, seatIsHuman, hasHumanWinner } = judge;
if (hasFlag('--print-judge')) {
  console.log('--- 从 server.js 抽取的判赢口径原文（BEGIN）---');
  console.log(judgeSrc);
  console.log('--- 从 server.js 抽取的判赢口径原文（END）---');
}

/* ==================== 逐局分析 ==================== */
const asJson = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
};
const fmtPts = (v) => (v == null ? '?' : String(v));

// 返回一条「局」的判定结果；无法判定的局单独成桶（不计入分档）
function analyzeGame(g) {
  const cols = Array.isArray(g.players) ? g.players : [];
  const fin = g.final;
  const seats = (fin && Array.isArray(fin.players)) ? fin.players : null;
  if (!seats || !seats.length) {
    return { ...g, ok: false, reason: '终局快照缺失（final.players 空）' };
  }
  const { winners } = rankEndgame(seats);
  const winSet = new Set(winners);
  const humanWon = hasHumanWinner(cols, fin);   // ← server.js 同一份实现
  const isHumanSeat = (p, i) => seatIsHuman(p, cols[i]);

  const humanSeats = [], aiSeats = [];
  seats.forEach((p, i) => (isHumanSeat(p, i) ? humanSeats : aiSeats).push(p));
  const maxOf = (arr) => (arr.length ? Math.max(...arr.map((p) => Number(p.points) || 0)) : null);
  const humanMax = maxOf(humanSeats), aiMax = maxOf(aiSeats);
  // 简化规则（任务口径的直述）：人类最高分 ≥ AI 最高分（平局算人类）
  const humanWonSimple = (humanMax != null && aiMax != null) ? humanMax >= aiMax : null;
  const disagree = (humanWonSimple != null) && (humanWonSimple !== humanWon);

  return {
    ...g,
    ok: true,
    n: seats.length,
    winnerNames: winners,
    humanWon,
    humanWonSimple,
    disagree,
    humanMax, aiMax,
    humanSeats: humanSeats.map((p) => `${p.name} ${fmtPts(p.points)}`).join('/'),
    aiSeats: aiSeats.map((p) => `${p.name} ${fmtPts(p.points)}`).join('/'),
    pts: seats.map((p) => p.points),   // 快照字段：与线上 JSON_EXTRACT(final,'$.players[*].points') 同序
  };
}

/* ==================== 汇总 ==================== */
function summarize(games) {
  const ok = games.filter((g) => g.ok);
  const bad = games.filter((g) => !g.ok);
  const byN = new Map();
  ok.forEach((g) => {
    if (!byN.has(g.n)) byN.set(g.n, { n: g.n, games: 0, wins: 0 });
    const b = byN.get(g.n);
    b.games++; if (g.humanWon) b.wins++;
  });
  const rows = [...byN.values()].sort((a, b) => a.n - b.n);
  const total = { games: ok.length, wins: ok.filter((g) => g.humanWon).length };
  const pct = (w, g) => (g ? (w / g * 100).toFixed(1) + '%' : 'n/a');
  return { rows, total, pct, bad, disagreeCount: ok.filter((g) => g.disagree).length };
}

/* ==================== 输出 ==================== */
const pad = (s, w) => {
  let out = String(s); let len = 0;
  for (const ch of out) len += (ch.charCodeAt(0) > 0x2e80 ? 2 : 1);   // 中日韩字符按 2 格宽算
  while (len < w) { out += ' '; len++; }
  return out;
};
function printGames(games) {
  console.log('');
  console.log('逐局表（判赢 = server.js hasHumanWinner：rankEndgame「分→进化→手牌少者」平局共享）：');
  console.log('  ' + pad('id', 6) + pad('房号', 7) + pad('时间', 21) + pad('人数', 5)
    + pad('人类', 16) + pad('AI', 22) + pad('判赢', 5) + '简化规则');
  console.log('  ' + '-'.repeat(88));
  games.forEach((g) => {
    if (!g.ok) {
      console.log('  ' + pad(g.id, 6) + pad(g.room || '', 7) + pad(g.at || '', 21) + pad('?', 5)
        + pad('-', 16) + pad('-', 22) + pad('?', 5) + g.reason);
      return;
    }
    console.log('  ' + pad(g.id, 6) + pad(g.room || '', 7) + pad(g.at || '', 21) + pad(g.n, 5)
      + pad(g.humanSeats, 16) + pad(g.aiSeats, 22) + pad(g.humanWon ? '人类' : 'AI', 5)
      + (g.humanWonSimple ? '人类' : 'AI') + (g.disagree ? '  <- 两条判据分歧' : ''));
  });
}
function printSummary(s) {
  console.log('');
  console.log('【汇总】真人挑战局 · 人类胜率（按人数分档）');
  s.rows.forEach((r) => {
    console.log(`  ${r.n} 人：${r.wins}/${r.games} = ${s.pct(r.wins, r.games)}`);
  });
  [2, 3, 4].forEach((n) => {
    if (!s.rows.some((r) => r.n === n)) console.log(`  ${n} 人：0/0 = n/a`);
  });
  console.log(`  合计：${s.total.wins}/${s.total.games} = ${s.pct(s.total.wins, s.total.games)}`);
  if (s.bad.length) {
    console.log(`  [WARN] 无法判定（不计入分档）：${s.bad.length} 局 -> id ${s.bad.map((g) => g.id).join(',')}`);
  }
  if (s.disagreeCount) {
    console.log(`  [WARN] rankEndgame 与「人类最高分 ≥ AI 最高分」分歧：${s.disagreeCount} 局（上面逐局已标）`
      + ' —— 分歧只会出现在「分相同但进化/手牌不同」的边界局。');
  } else {
    console.log('  两条判据在本次样本上完全一致（分歧 0 局）[OK]');
  }
}

/* ==================== 快照读写 ==================== */
// 线上快照的字段形状（与工具/rl/data/human-games.json 一致）：
//   {id, room, at, n, ver, names, types, pts}
function toSnapshotRow(g) {
  return {
    id: g.id, room: g.room, at: g.at, n: g.n, ver: g.ver,
    names: g.names, types: g.types, pts: g.pts,
  };
}
function writeSnapshot(rows) {
  if (NO_WRITE) { console.log(`\n[snapshot] --no-write：未写 ${path.relative(ROOT, OUT_PATH)}`); return; }
  if (fs.existsSync(OUT_PATH) && !FORCE) {
    let old = null;
    try { old = JSON.parse(readText(OUT_PATH)); } catch (e) { old = null; }
    if (Array.isArray(old) && old.length > rows.length) {
      console.log(`\n[snapshot] 拒绝写 ${path.relative(ROOT, OUT_PATH)}：盘上旧快照 ${old.length} 局 > 本次 ${rows.length} 局。`);
      console.log('            （默认连本地库，本地库可能只有少量挑战局——别把线上参照快照冲掉；确需覆盖加 --force）');
      return;
    }
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(rows));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(OUT_PATH)).digest('hex').slice(0, 12);
  console.log(`\n[snapshot] 已写 ${path.relative(ROOT, OUT_PATH)}（${rows.length} 局，sha256 ${sha}…）`);
}

/* ==================== 数据来源 ==================== */
function loadFromSnapshot() {
  let raw;
  try { raw = readText(SNAPSHOT_IN); }
  catch (e) { console.error(`读不到快照 ${SNAPSHOT_IN}：${e.message}`); process.exit(1); }
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { console.error(`快照不是合法 JSON：${e.message}`); process.exit(1); }
  if (!Array.isArray(arr)) { console.error('快照顶层应为数组。'); process.exit(1); }
  console.log(`[source] 离线快照 ${path.relative(ROOT, SNAPSHOT_IN)}（${arr.length} 局）`);
  console.log(`[source] 注意：快照只有分数、没有进化/手牌 → 判赢退化为「人类最高分 ≥ AI 最高分」（平局算人类）。`);
  return arr.map((r) => ({
    id: r.id, room: r.room, at: r.at, ver: r.ver,
    players: (r.names || []).map((n, i) => ({ name: n, type: (r.types || [])[i] })),
    final: { n: r.n, players: (r.pts || []).map((p, i) => ({ name: (r.names || [])[i], points: p })) },
    names: r.names, types: r.types,
  }));
}
async function loadFromDb() {
  const loadDbConfig = require(path.join(ROOT, 'db-config.js'));
  const cfg = loadDbConfig({
    root: ROOT,
    extra: {
      ...(flagVal('--db-host', '') ? { host: flagVal('--db-host', '') } : {}),
      ...(flagVal('--db-port', '') ? { port: Number(flagVal('--db-port', '')) } : {}),
      ...(flagVal('--db-user', '') ? { user: flagVal('--db-user', '') } : {}),
      ...(flagVal('--db-password', '') ? { password: flagVal('--db-password', '') } : {}),
      ...(flagVal('--db-name', '') ? { database: flagVal('--db-name', '') } : {}),
    },
  });
  console.log(`[db] 目标连接 host=${cfg.host}:${cfg.port} database=${cfg.database} user=${cfg.user} password=${cfg.password ? '***（不回显）' : '(空)'}`);
  if (REMOTE) {
    console.log('[db] [WARN][WARN] 线上库 —— 只读模式：只发 SELECT，连上后立刻 SET SESSION TRANSACTION READ ONLY（写会被 MySQL 拒绝）');
  } else {
    console.log('[db] 本地库 —— 同样只读；要连线上必须显式传 --db prod / --remote');
  }
  const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, charset: 'utf8mb4', connectTimeout: 8000,
  });
  let roOk = false;
  try { await conn.query('SET SESSION TRANSACTION READ ONLY'); roOk = true; }
  catch (e) { console.log(`[db] [WARN] 未能开启只读会话（${e.message}）—— 继续跑，但请人工确认没在写库。`); }
  if (roOk) console.log('[db] 只读会话已开启 [OK]');
  if (SELFTEST) {
    // 写闸实测：WHERE 1=0，一行都碰不到；只用来证明"写真的被挡"
    try {
      await conn.query('UPDATE replays SET mode = mode WHERE 1 = 0');
      console.log('[selftest] [WARN] 写竟然没被挡 —— 只读闸失效，先别信这次读数');
    } catch (e) {
      console.log(`[selftest] 写被拒 [OK]（${e.code || e.message}）`);
    }
  }
  const sql = "SELECT id, room_id, players, final, created_at, ai_ver FROM replays "
    + "WHERE mode = 'challenge' ORDER BY id" + (LIMIT ? ` LIMIT ${LIMIT}` : '');
  const [rows] = await conn.query(sql);
  console.log(`[db] challenge 对局 ${rows.length} 条（ORDER BY id${LIMIT ? '，LIMIT ' + LIMIT : ''}）`);
  await conn.end();
  return rows.map((r) => ({
    id: r.id, room: r.room_id, at: r.created_at ? String(r.created_at) : '',
    ver: r.ai_ver || '',
    players: asJson(r.players) || [],
    final: asJson(r.final),
    names: (asJson(r.players) || []).map((p) => p.name),
    types: (asJson(r.players) || []).map((p) => p.type),
  }));
}

/* ==================== 主流程 ==================== */
(async () => {
  console.log('='.repeat(92));
  console.log(`human-bench：真人挑战局台（数据源：${MODE_TAG}，只读）`);
  console.log(`判赢口径：server.js 原文抽取的 rankEndgame / seatIsHuman / hasHumanWinner（sha256 ${JUDGE_SHA}…，${judgeSrc.length} 字节）`);
  console.log('='.repeat(92));

  const raw = FROM_SNAPSHOT ? loadFromSnapshot() : await loadFromDb();
  const games = raw.map(analyzeGame);
  printGames(games);
  const s = summarize(games);
  printSummary(s);
  writeSnapshot(games.filter((g) => g.ok).map(toSnapshotRow));

  if (REPORT_PATH) {
    const out = path.resolve(ROOT, REPORT_PATH);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: MODE_TAG,
      judge: { functions: JUDGE_NAMES, sha256_12: JUDGE_SHA, bytes: judgeSrc.length },
      counts: { games: games.length, countable: s.total.games, unjudgeable: s.bad.length },
      summary: {
        byN: s.rows.map((r) => ({ n: r.n, wins: r.wins, games: r.games, rate: r.games ? r.wins / r.games : null })),
        total: { wins: s.total.wins, games: s.total.games, rate: s.total.games ? s.total.wins / s.total.games : null },
        judgeDisagreements: s.disagreeCount,
      },
      games: games.map((g) => ({
        id: g.id, room: g.room, at: g.at, ver: g.ver, n: g.n, ok: g.ok,
        humanWon: g.humanWon, humanWonSimple: g.humanWonSimple, disagree: !!g.disagree,
        humanMax: g.humanMax, aiMax: g.aiMax, pts: g.pts,
        names: g.names, types: g.types,
      })),
    }, null, 2));
    console.log(`\n[report] 已写 ${path.relative(ROOT, out)}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('human-bench 失败：' + (e && e.stack || e));
  process.exit(1);
});
