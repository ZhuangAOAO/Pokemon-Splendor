'use strict';

/* ================================================================
   璀璨宝石·宝可梦 — 联机服务器
   零依赖，只需要 Node.js：node server.js
   ────────────────────────────────────────────────────────────────
   · 静态文件服务 + 房间/对局编排 + SSE 推送（服务器权威制）
   · 对局状态在服务器上，浏览器只发送操作、接收状态并渲染
   · 以后部署到公网服务器：把整个文件夹拷上去运行即可（可换端口）
   ================================================================ */

require('./config.js');            // 数据配置（挂到全局）
const core = require('./game-core.js'); // 游戏核心逻辑

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { HOOKS, newGame, curPlayer, advanceTurn, scheduleAI,
  canAfford, allMarketCards, COLORS, RULES, sameLoc,
  actTakeThree, actTakeTwo, actDiscardOne, actBuy, actBuyReserved, actReserve, actReturnBall, actTakeMaster,
  actEvolve, actSkipEvolve } = core;

const NET = global.NETWORK || { port: 3000, turnTimeoutSec: 30, maxPlayers: 4 };
const PORT = NET.port;
const TURN_TIMEOUT = NET.turnTimeoutSec * 1000;
const ROOT = __dirname;

/* ==================== 房间 ==================== */
const room = {
  phase: 'lobby',  // lobby | game
  ais: [],         // 电脑玩家 [{name, level}]
  target: RULES.defaultTarget,
};
// conns: cid -> {cid, name, seat, res, connected, isHost}
const conns = new Map();
let skipTimer = null; // 断线自动跳过计时器

function humansList() { return [...conns.values()]; }
function connectedHumans() { return humansList().filter((c) => c.connected); }
function promoteHostIfNeeded() {
  let host = null;
  for (const c of conns.values()) { if (c.isHost) host = c; }
  if (host && host.connected) return;
  for (const c of conns.values()) c.isHost = false;
  const next = connectedHumans()[0];
  if (next) next.isHost = true;
}

/* ==================== 推送 ==================== */
function sendSSE(conn, obj) {
  if (conn && conn.res) conn.res.write('data: ' + JSON.stringify(obj) + '\n\n');
}
function broadcast() {
  for (const c of conns.values()) {
    sendSSE(c, {
      type: 'state',
      room: {
        phase: room.phase,
        target: room.target,
        ais: room.ais,
        humans: humansList().map((h) => ({ name: h.name, seat: h.seat, connected: h.connected, isHost: h.isHost })),
      },
      game: core.S,
      you: { cid: c.cid, seat: c.seat, isHost: c.isHost, name: c.name },
    });
  }
}
function broadcastToast(msg) {
  for (const c of conns.values()) sendSSE(c, { type: 'toast', msg });
}

// 游戏核心的事件钩子：状态一变就广播给所有玩家
HOOKS.onStateChanged = broadcast;
HOOKS.onToast = broadcastToast;
HOOKS.onGameOver = broadcast;

/* ==================== 断线处理 ==================== */
function handleDisconnect(conn) {
  console.log(`[断开] ${conn.name}（大厅阶段=${room.phase === 'lobby'}）`);
  conn.connected = false;
  conn.res = null;
  if (room.phase === 'lobby') {
    conns.delete(conn.cid);
    promoteHostIfNeeded();
    broadcast();
    return;
  }
  broadcast();
  // 对局中：保留座位，轮到他（行动或进化阶段）时自动跳过
  const S = core.S;
  if (S && !S.over && (S.phase === 'normal' || S.phase === 'evolve') && S.current === conn.seat && !curPlayer().isAI) {
    if (skipTimer) clearTimeout(skipTimer);
    skipTimer = setTimeout(() => {
      skipTimer = null;
      const s2 = core.S;
      if (s2 && !s2.over && (s2.phase === 'normal' || s2.phase === 'evolve') && s2.current === conn.seat && !curPlayer().isAI) {
        broadcastToast(`${conn.name} 断线，自动跳过回合`);
        if (s2.phase === 'evolve') actSkipEvolve();
        else advanceTurn();
      }
    }, TURN_TIMEOUT);
  }
}

/* ==================== 请求处理 ==================== */
function handleJoin(body) {
  const name = String(body.name || '').trim().slice(0, 8);
  if (!name) return { ok: false, msg: '名字不能为空' };
  if (room.phase === 'lobby') {
    if (connectedHumans().length >= NET.maxPlayers) return { ok: false, msg: '房间已满（最多 ' + NET.maxPlayers + ' 人）' };
    if (humansList().some((c) => c.name === name)) return { ok: false, msg: '这个名字已被使用' };
    const cid = crypto.randomUUID();
    conns.set(cid, { cid, name, seat: -1, res: null, connected: false, isHost: humansList().length === 0 });
    console.log(`[加入] ${name}${humansList().length === 1 ? '（房主）' : ''}，当前 ${conns.size} 人`);
    return { ok: true, cid };
  }
  // 对局中：允许断线玩家用原名字重连
  const old = humansList().find((c) => c.name === name && !c.connected);
  if (!old) return { ok: false, msg: '对局进行中，暂时不能加入' };
  console.log(`[重连] ${name} 回到座位 ${old.seat}`);
  if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
  const cid = crypto.randomUUID();
  const entry = { cid, name, seat: old.seat, res: null, connected: false, isHost: old.isHost };
  conns.delete(old.cid);
  conns.set(cid, entry);
  return { ok: true, cid };
}
function handleStart(conn) {
  if (!conn.isHost) return { ok: false, msg: '只有房主可以开始' };
  if (room.phase !== 'lobby') return { ok: false, msg: '对局已开始' };
  const humans = connectedHumans();
  const total = humans.length + room.ais.length;
  if (total < 2) return { ok: false, msg: '至少需要 2 名玩家' };
  if (total > 4) return { ok: false, msg: '最多 4 名玩家' };
  humans.forEach((h, i) => { h.seat = i; });
  const cfg = {
    target: room.target,
    players: humans.map((h) => ({ name: h.name, type: 'human' }))
      .concat(room.ais.map((a) => ({ name: a.name, type: a.level }))),
  };
  core.lastCfg = cfg;
  newGame(cfg);
  room.phase = 'game';
  broadcast();
  scheduleAI();
  return { ok: true };
}
function handleSetAIs(conn, ais) {
  if (!conn.isHost || room.phase !== 'lobby') return { ok: false, msg: '只有房主在大厅时可以设置' };
  const list = (Array.isArray(ais) ? ais : []).slice(0, 4).map((a) => ({
    name: String((a && a.name) || '电脑').trim().slice(0, 8) || '电脑',
    level: a && a.level === 'hard' ? 'hard' : 'easy',
  }));
  if (connectedHumans().length + list.length > 4) return { ok: false, msg: '总共最多 4 名玩家' };
  room.ais = list;
  broadcast();
  return { ok: true };
}
function handleSetTarget(conn, target) {
  if (!conn.isHost || room.phase !== 'lobby') return { ok: false, msg: '只有房主在大厅时可以设置' };
  if (!RULES.targets.includes(target)) return { ok: false, msg: '无效的目标分数' };
  room.target = target;
  broadcast();
  return { ok: true };
}
function handleRestart(conn) {
  if (!conn.isHost) return { ok: false, msg: '只有房主可以操作' };
  if (!core.lastCfg) return { ok: false, msg: '没有可重开的对局' };
  if (core.S && !core.S.over) return { ok: false, msg: '对局还在进行中' };
  newGame(core.lastCfg);
  room.phase = 'game';
  broadcast();
  scheduleAI();
  return { ok: true };
}
function handleBackToLobby(conn) {
  if (!conn.isHost) return { ok: false, msg: '只有房主可以操作' };
  core.S = null;
  if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; }
  room.phase = 'lobby';
  humansList().forEach((h) => { h.seat = -1; });
  broadcast();
  return { ok: true };
}
// 校验玩家的行动是否合法（服务器权威：不信任客户端）
function validAction(conn, a) {
  const S = core.S;
  if (room.phase !== 'game' || !S || S.over) return '对局尚未开始';
  if (S.current !== conn.seat) return '还没轮到你';
  if (curPlayer().isAI) return '现在是电脑的回合';
  const p = curPlayer();
  switch (a.kind) {
    case 'take3': {
      if (S.phase !== 'normal') return '现在不能拿球';
      const keys = a.colors;
      if (!Array.isArray(keys) || !keys.length) return '参数错误';
      if (new Set(keys).size !== keys.length) return '颜色不能重复';
      const availCount = COLORS.filter((c) => S.pool[c] > 0).length;
      if (keys.length !== Math.min(3, availCount)) return '拿取数量不符合规则';
      if (keys.some((c) => !COLORS.includes(c) || S.pool[c] <= 0)) return '该颜色供应不足';
      return null;
    }
    case 'take2': {
      if (S.phase !== 'normal') return '现在不能拿球';
      const c = a.color;
      if (!COLORS.includes(c) || S.pool[c] < RULES.takeTwoMin) return '该颜色不足（需至少 ' + RULES.takeTwoMin + ' 个）';
      return null;
    }
    case 'return': {
      if (S.phase !== 'normal') return '现在不能退还';
      const c = a.color;
      if (c !== 'master' && !COLORS.includes(c)) return '参数错误';
      if (p.balls[c] <= 0) return '你没有这种球';
      return null;
    }
    case 'discard': {
      if (S.phase !== 'discard') return '现在不需要退还';
      const c = a.color;
      if ((c !== 'master' && !COLORS.includes(c)) || p.balls[c] <= 0) return '参数错误';
      return null;
    }
    case 'reserve': {
      if (S.phase !== 'normal') return '现在不能预约';
      const card = S.market[a.tier] && S.market[a.tier][a.idx];
      if (!card) return '没有这张卡';
      if (card.tier >= 4) return '稀有/传说宝可梦不能预约，只能直接收服';
      if (p.reserved.length >= RULES.reserveLimit) return '预约已满';
      return null;
    }
    case 'takeMaster': {
      if (S.phase !== 'normal') return '现在不能拿大师球';
      if (RULES.takeMasterAlone === false) return '本局未开放"只拿大师球"行动';
      if (S.pool.master <= 0) return '供应区没有大师球';
      return null;
    }
    case 'evolve': {
      if (S.phase !== 'evolve') return '现在没有进化机会';
      const op = (S.evoOptions || []).find((o) => sameLoc(o.loc, a.loc));
      if (!op) return '没有这个进化选项';
      if (!op.ok) return '进化条件不满足';
      return null;
    }
    case 'skipEvolve': {
      if (S.phase !== 'evolve') return '现在没有进化机会';
      return null;
    }
    case 'buy': {
      if (S.phase !== 'normal') return '现在不能收服';
      const card = a.reserved ? p.reserved[a.ridx] : (S.market[a.tier] && S.market[a.tier][a.idx]);
      if (!card) return '没有这张卡';
      if (!canAfford(p, card)) return '精灵球不够';
      return null;
    }
    default: return '未知行动';
  }
}
function handleAction(conn, a) {
  const err = validAction(conn, a || {});
  if (err) { console.log(`[行动被拒] ${conn.name} ${JSON.stringify(a)} → ${err}`); return { ok: false, msg: err }; }
  console.log(`[行动] ${conn.name} ${a.kind}`);
  if (a.kind === 'take3') actTakeThree(a.colors);
  else if (a.kind === 'take2') actTakeTwo(a.color);
  else if (a.kind === 'return') actReturnBall(a.color);
  else if (a.kind === 'discard') actDiscardOne(a.color);
  else if (a.kind === 'takeMaster') actTakeMaster();
  else if (a.kind === 'evolve') actEvolve(a.loc);
  else if (a.kind === 'skipEvolve') actSkipEvolve();
  else if (a.kind === 'reserve') actReserve(a.tier, a.idx);
  else if (a.kind === 'buy') { if (a.reserved) actBuyReserved(a.ridx); else actBuy(a.tier, a.idx); }
  return { ok: true };
}

/* ==================== HTTP 服务 ==================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};
function handleSSE(req, res, u) {
  const cid = u.searchParams.get('cid');
  const conn = conns.get(cid);
  if (!conn || conn.res) { res.writeHead(400); return res.end(); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  conn.res = res;
  conn.connected = true;
  console.log(`[在线] ${conn.name} 已连接（座位 ${conn.seat}）`);
  if (skipTimer) { clearTimeout(skipTimer); skipTimer = null; } // 玩家重连回来了
  broadcast();
  // 用响应流的 close 检测客户端断开（req 的 close 在请求读完就会触发，会误判）
  res.on('close', () => { if (conn.res === res) handleDisconnect(conn); });
}
function handleApi(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 10000) req.destroy(); });
  req.on('end', () => {
    let obj;
    try { obj = JSON.parse(body || '{}'); } catch (e) { obj = {}; }
    const conn = conns.get(obj.cid);
    let result;
    if (obj.type === 'join') result = handleJoin(obj);
    else if (!obj.type) result = { ok: false, msg: '参数错误' };
    else if (!conn || !conn.connected) result = { ok: false, msg: '连接已失效，请刷新页面重新加入' };
    else if (obj.type === 'start') result = handleStart(conn);
    else if (obj.type === 'setAIs') result = handleSetAIs(conn, obj.ais);
    else if (obj.type === 'setTarget') result = handleSetTarget(conn, obj.target);
    else if (obj.type === 'restart') result = handleRestart(conn);
    else if (obj.type === 'backToLobby') result = handleBackToLobby(conn);
    else if (obj.type === 'action') result = handleAction(conn, obj.action);
    else result = { ok: false, msg: '未知请求' };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  });
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/events') return handleSSE(req, res, u);
  if (u.pathname === '/api') return handleApi(req, res);
  // 静态文件（先解码 URL，中文文件名才能对得上磁盘）
  let file;
  try { file = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname); }
  catch (e) { res.writeHead(400); return res.end(); }
  const full = path.join(ROOT, path.normalize('/' + file));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 文件不存在'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('════════════════════════════════════════════');
  console.log('  璀璨宝石·宝可梦 联机服务器已启动！');
  console.log('  本机打开：http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) {
        console.log('  局域网：  http://' + n.address + ':' + PORT);
      }
    }
  }
  console.log('  把局域网地址发给朋友，大家一起加入！');
  console.log('  按 Ctrl+C 停止服务器');
  console.log('════════════════════════════════════════════');
});
