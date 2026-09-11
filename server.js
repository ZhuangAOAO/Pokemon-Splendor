'use strict';

/* ================================================================
   璀璨宝石·宝可梦 — 联机服务器（多房间版）
   零依赖，只需要 Node.js：node server.js
   · 静态文件服务 + 多房间编排 + SSE 推送（服务器权威制）
   · 每个房间独立会话（game-core 的 createSession）
   ================================================================ */

require('./config.js');            // 数据配置（挂到全局）
const core = require('./game-core.js'); // 游戏核心逻辑（工厂）
const { COLORS, RULES, sameLoc } = core;

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

const NET = global.NETWORK || { port: 3000, turnTimeoutSec: 30, maxPlayers: 4 };
const PORT = NET.port;
const TURN_TIMEOUT = NET.turnTimeoutSec * 1000;
const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');

/* ==================== 日志 ==================== */
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 三个日志文件各管一摊，互不混杂：
//   server.log  —— 服务器级事件（启动/停止、数据库、房间创建/解散）
//   account.log —— 账号系统全部操作（注册/登录/登出/昵称/改密/审核/后门注册），供管理员审计
//   games.log   —— 房间内事件（加入/断开/对局/投票/踢人/战绩，带房间号前缀）
function writeLog(file, tag, msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
    fs.appendFileSync(path.join(LOG_DIR, file), `[${localStamp()}] [${tag}] ${msg}\n`, 'utf8');
  } catch (e) { /* 日志写失败不影响游戏 */ }
}
// 账号系统日志：单独落 account.log；控制台照常打印
function logAccount(tag, msg) {
  console.log(`[账号] [${tag}] ${msg}`);
  writeLog('account.log', tag, msg);
}
// 服务器/对局事件：控制台 + 落盘（服务器级与房间内分档）+ 房间内记录（游戏内「记录」面板可见）
function logEvent(room, tag, msg) {
  console.log(`[房${room ? room.id : '-'}] [${tag}] ${msg}`);
  writeLog(room ? 'games.log' : 'server.log', tag, `${room ? '[房' + room.id + '] ' : ''}${msg}`);
  if (room && room.phase === 'game') {
    room.log.push({ time: new Date().toTimeString().slice(0, 8), text: msg });
    if (room.log.length > 100) room.log.shift();
  }
}
// 三个日志文件（与 writeLog 分档对应），供管理员后台翻看
const LOG_FILES = ['server.log', 'account.log', 'games.log'];
// 截尾读日志：只读文件末尾最多 maxBytes 字节，取最近 maxLines 行（首行可能被截断，直接丢弃避免乱码）
function readLogTail(file, maxLines) {
  const p = path.join(LOG_DIR, file);
  const maxBytes = 256 * 1024;
  try {
    const st = fs.statSync(p);
    if (!st.size) return { text: '', bytes: 0, updatedAt: null };
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (st.size > buf.length) lines.shift(); // 从文件中间开始读：首行不完整
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { text: lines.slice(-maxLines).join('\n'), bytes: st.size, updatedAt: st.mtime };
  } catch (e) {
    return { text: '', bytes: 0, updatedAt: null }; // 文件还不存在 = 暂无日志
  }
}
// 管理员翻日志：返回三个日志文件的最近部分
async function handleAdminLogs(body) {
  const u = await authUser(body.token);
  if (!u || u.role !== 'admin') return { ok: false, msg: '需要管理员权限' };
  const fmt = (d) => {
    if (!d) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  return {
    ok: true,
    logs: LOG_FILES.map((f) => {
      const t = readLogTail(f, 500);
      return { name: f, text: t.text, bytes: t.bytes, updatedAt: t.updatedAt ? fmt(t.updatedAt) : '—' };
    }),
  };
}

/* ==================== 房间 ==================== */
// rooms: roomId -> {id, isPublic, phase, ais, target, log, conns:Map, vote, skipTimer, session}
const rooms = new Map();
// connIndex: cid -> {room, conn}（快速定位连接所属房间）
const connIndex = new Map();
// sessions: token -> {name, role}（登录会话，内存态，重启后需重新登录）
const sessions = new Map();

function newRoomId() {
  let id;
  do { id = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(id));
  return id;
}
function createRoom(isPublic) {
  const session = core.createSession();
  const room = {
    id: newRoomId(),
    isPublic: !!isPublic,
    phase: 'lobby',   // lobby | game
    ais: [],          // 电脑玩家 [{name, level}]
    target: RULES.defaultTarget,
    log: [],
    conns: new Map(), // cid -> conn
    vote: null,
    skipTimer: null,
    offlineTimer: null, // 全员离线兜底倒计时（给断线重连留 60 秒宽限）
    session,
    rec: null,        // 本局回放记录（beginRecording 创建，终局时写库）
  };
  // 会话事件钩子：状态一变就广播给本房所有玩家
  session.HOOKS.onStateChanged = () => broadcastRoom(room);
  session.HOOKS.onToast = (m) => { broadcastToast(room, m); logEvent(room, '事件', m); };
  session.HOOKS.onGameOver = () => { recordGameStats(room); saveReplay(room); broadcastRoom(room); };
  // 每一步真实行动都记进回放（人类与电脑的行动都在这里流过；自动退球/自动进化不记）
  session.HOOKS.onAction = (kind, params) => {
    if (!room.rec) return;
    const S = room.session.S;
    room.rec.actions.push({ k: kind, p: JSON.parse(JSON.stringify(params)), seat: S ? S.current : -1, t: S ? S.turnIdx : -1 });
  };
  rooms.set(room.id, room);
  logEvent(null, '房间', `创建房间 ${room.id}（${room.isPublic ? '公开' : '私有'}）`);
  return room;
}
function deleteRoomIfEmpty(room) {
  if (room.phase === 'lobby' && room.conns.size === 0 && rooms.has(room.id)) {
    rooms.delete(room.id);
    logEvent(null, '房间', `房间 ${room.id} 已解散`);
  }
}

/* ---- 房间内连接辅助 ---- */
function humansList(room) { return [...room.conns.values()]; }
function connectedHumans(room) { return humansList(room).filter((c) => c.connected); }
function promoteHostIfNeeded(room) {
  let host = null;
  for (const c of room.conns.values()) { if (c.isHost) host = c; }
  if (host && host.connected) return;
  for (const c of room.conns.values()) c.isHost = false;
  const next = connectedHumans(room)[0];
  if (next) next.isHost = true;
}

/* ==================== 推送 ==================== */
function sendSSE(conn, obj) {
  if (conn && conn.res) {
    try { conn.res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
    catch (e) { /* 连接半死：心跳/看门狗会发现，close 事件会清理 */ }
  }
}
// 按接收人打码：其他玩家的盲抽卡替换为牌背占位，只有本人可见
function gameFor(room, conn) {
  const S = room.session.S;
  if (!S) return null;
  const copy = JSON.parse(JSON.stringify(S));
  copy.players.forEach((p, i) => {
    if (i === conn.seat) return;
    p.reserved = (p.reserved || []).map((c) => c.blind
      ? { id: c.id, name: '???', blind: true, tier: 0, vp: 0, cost: {}, masterCost: 0, bonus: 'yellow', evoTo: null, evoNeed: null }
      : c);
  });
  return copy;
}
function broadcastRoom(room) {
  for (const c of room.conns.values()) {
    sendSSE(c, {
      type: 'state',
      room: {
        id: room.id,
        isPublic: room.isPublic,
        phase: room.phase,
        target: room.target,
        ais: room.ais,
        humans: humansList(room).map((h) => ({ cid: h.cid, name: h.name, seat: h.seat, connected: h.connected, isHost: h.isHost })),
        log: room.log,
        vote: room.vote ? { by: room.vote.by, yes: room.vote.yes.length, total: connectedHumans(room).length } : null,
      },
      game: gameFor(room, c),
      you: { cid: c.cid, seat: c.seat, isHost: c.isHost, name: c.name, voted: !!(room.vote && room.vote.yes.includes(c.cid)) },
    });
  }
}
function broadcastToast(room, msg) {
  for (const c of room.conns.values()) sendSSE(c, { type: 'toast', msg });
}
// SSE 心跳：每 20 秒给所有连接发一条消息。
// TCP 半死（假活）时服务器和浏览器都察觉不到断线，心跳让客户端的看门狗能发现"很久没动静"并重建连接
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.conns.values()) {
      if (c.connected && c.res) {
        try { c.res.write('data: {"type":"hb"}\n\n'); } catch (e) { /* 半死连接：等 close 清理 */ }
      }
    }
  }
}, 20000);

/* ==================== 结束对局（投票 / 全员离线 / 房主） ==================== */
function endGameToLobby(room, reason) {
  room.vote = null;
  room.session.S = null;
  if (room.skipTimer) { clearTimeout(room.skipTimer); room.skipTimer = null; }
  if (room.offlineTimer) { clearTimeout(room.offlineTimer); room.offlineTimer = null; }
  room.phase = 'lobby';
  // 已断线的玩家席位作废：名字不再被占用（允许重新加入），
  // 也避免全员离线后留下"幽灵房"一直挂在公开房间列表
  for (const [cid, c] of room.conns) {
    if (!c.connected) { room.conns.delete(cid); connIndex.delete(cid); }
  }
  humansList(room).forEach((h) => { h.seat = -1; });
  logEvent(room, '对局', reason);
  broadcastRoom(room);
}
function checkVoteComplete(room) {
  if (!room.vote) return;
  const req = connectedHumans(room).map((h) => h.cid);
  if (req.every((cid) => room.vote.yes.includes(cid))) {
    endGameToLobby(room, `结束投票全员通过（${room.vote.by} 发起），对局结束`);
  }
}

/* ==================== 断线处理 ==================== */
function handleDisconnect(room, conn) {
  logEvent(room, '断开', `${conn.name} 离开（大厅阶段=${room.phase === 'lobby'}）`);
  conn.connected = false;
  conn.res = null;
  if (room.phase === 'lobby') {
    room.conns.delete(conn.cid);
    connIndex.delete(conn.cid);
    promoteHostIfNeeded(room);
    broadcastRoom(room);
    deleteRoomIfEmpty(room);
    return;
  }
  // 对局中：所有人类玩家都离线 → 先等 60 秒（断线重连很常见，弱网抖动不能直接毁局），
  // 宽限期内有人连回来就继续对局；真没人回来才自动结束并解散房间
  if (connectedHumans(room).length === 0) {
    if (room.offlineTimer) return; // 已进入倒计时
    room.offlineTimer = setTimeout(() => {
      room.offlineTimer = null;
      if (connectedHumans(room).length === 0) {
        endGameToLobby(room, '所有玩家离线超过 60 秒，对局自动结束');
        deleteRoomIfEmpty(room); // 没人还连着：房间解散，不留幽灵房
      }
    }, 60000);
    return;
  }
  // 投票进行中：断线的人不再需要表态
  if (room.vote) checkVoteComplete(room);
  broadcastRoom(room);
  // 对局中：保留座位，轮到他（行动或进化阶段）时自动跳过
  const S = room.session.S;
  if (S && !S.over && (S.phase === 'normal' || S.phase === 'evolve') && S.current === conn.seat && !room.session.curPlayer().isAI) {
    if (room.skipTimer) clearTimeout(room.skipTimer);
    room.skipTimer = setTimeout(() => {
      room.skipTimer = null;
      const s2 = room.session.S;
      if (s2 && !s2.over && (s2.phase === 'normal' || s2.phase === 'evolve') && s2.current === conn.seat && !room.session.curPlayer().isAI) {
        broadcastToast(room, `${conn.name} 断线，自动跳过回合`);
        if (s2.phase === 'evolve') room.session.actSkipEvolve();
        else room.session.advanceTurn();
      }
    }, TURN_TIMEOUT);
  }
}

/* ==================== 数据库（MySQL） ==================== */
// 连接信息默认在 data/db.json（已被 .gitignore 忽略），格式：
// { "host": "127.0.0.1", "port": 3306, "user": "root", "password": "密码", "database": "splendor" }
let dbConfig = Object.assign({}, global.MYSQL || {});
try {
  const localDb = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
  dbConfig = Object.assign(dbConfig, localDb);
} catch (e) { /* 没有本地配置就用默认 */ }
const mysql = require('mysql2/promise');
let pool = null;

async function initDb() {
  // 先连服务器（不指定库）确保数据库存在；只创建自己的库，不碰其他数据
  const bare = mysql.createPool(Object.assign({}, dbConfig, { database: undefined, waitForConnections: true, connectionLimit: 5 }));
  await bare.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await bare.end();
  pool = mysql.createPool(Object.assign({}, dbConfig, { waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' }));
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(16) NOT NULL UNIQUE,
    salt VARCHAR(64) NOT NULL,
    hash VARCHAR(128) NOT NULL,
    role VARCHAR(8) NOT NULL DEFAULT 'user',
    status VARCHAR(10) NOT NULL DEFAULT 'pending',
    real_name VARCHAR(20) NOT NULL DEFAULT '',
    grad_year INT NOT NULL DEFAULT 0,
    nickname VARCHAR(20) NOT NULL DEFAULT '',
    remark VARCHAR(40) NOT NULL DEFAULT '',
    source VARCHAR(10) NOT NULL DEFAULT 'public',
    welcomed TINYINT(1) NOT NULL DEFAULT 0,
    created_at VARCHAR(20) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 兼容旧库：补 source 列（账号来源标记，排行榜按它过滤后门账号）
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN source VARCHAR(10) NOT NULL DEFAULT 'public'`);
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') logEvent(null, '数据库', '补 source 列失败：' + e.message);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS stats (
    account VARCHAR(16) NOT NULL PRIMARY KEY,
    nickname VARCHAR(20) NOT NULL DEFAULT '',
    wins INT NOT NULL DEFAULT 0,
    games INT NOT NULL DEFAULT 0,
    points INT NOT NULL DEFAULT 0,
    evolutions INT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 对局回放：开局快照 + 每一步行动 + 终局快照（JSON 原文，浏览器端逐步重放）
  await pool.query(`CREATE TABLE IF NOT EXISTS replays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id VARCHAR(8) NOT NULL DEFAULT '',
    target INT NOT NULL DEFAULT 0,
    players MEDIUMTEXT NOT NULL,
    initial MEDIUMTEXT NOT NULL,
    actions MEDIUMTEXT NOT NULL,
    final MEDIUMTEXT NOT NULL,
    created_at VARCHAR(20) NOT NULL DEFAULT ''
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  logEvent(null, '数据库', `MySQL 连接成功（数据库 ${dbConfig.database}）`);
}
async function findUserDb(name) {
  const [rows] = await pool.query('SELECT * FROM users WHERE name = ? LIMIT 1', [name]);
  return rows[0] || null;
}
// 终局记录战绩：胜场（平局共享）、场次、总分、进化次数
async function recordGameStats(room) {
  const S = room.session.S;
  if (!S || !S.over) return;
  if (room.tutorial) { logEvent(room, '战绩', '教程局不计入战绩'); return; }
  const rank = S.players.slice().sort((a, b) =>
    (b.points - a.points) || (b.evolutions - a.evolutions) || (a.cards.length - b.cards.length));
  const top = rank[0];
  const winners = rank.filter((p) => p.points === top.points && p.evolutions === top.evolutions && p.cards.length === top.cards.length)
    .map((p) => p.name);
  for (let i = 0; i < S.players.length; i++) {
    const p = S.players[i];
    if (p.isAI) continue;
    const conn = [...room.conns.values()].find((c) => c.seat === i);
    const account = conn ? conn.accountName : null;
    if (!account) continue;
    const win = winners.includes(p.name) ? 1 : 0;
    try {
      await pool.query(`INSERT INTO stats (account, nickname, wins, games, points, evolutions) VALUES (?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE nickname=VALUES(nickname), wins=wins+VALUES(wins), games=games+VALUES(games),
        points=points+VALUES(points), evolutions=evolutions+VALUES(evolutions)`,
        [account, p.name, win, 1, p.points, p.evolutions]);
    } catch (e) { logEvent(room, '战绩', '写入失败：' + e.message); }
  }
  logEvent(room, '战绩', '本局战绩已记录');
}
// 排行榜：胜场 → 胜率 → 场次排序（显示真实姓名，没有时回退昵称/账号）
async function handleLeaderboard(body) {
  const u = await authUser(body.token);
  if (!u) return { ok: false, msg: '请先登录' };
  // 后门注册的账号（管理员代建的场外账号）不进排行榜
  const [rows] = await pool.query(
    'SELECT s.*, u.real_name FROM stats s LEFT JOIN users u ON u.name = s.account ' +
    "WHERE u.source IS NULL OR u.source <> 'backdoor'");
  const list = rows.map((s) => ({
    account: s.account,
    nickname: s.nickname || s.account,
    realName: s.real_name || '',
    wins: s.wins,
    games: s.games,
    winRate: s.games ? Math.round((s.wins / s.games) * 100) : 0,
    avgPoints: s.games ? Number((s.points / s.games).toFixed(1)) : 0,
    evolutions: s.evolutions,
  }));
  list.sort((a, b) => (b.wins - a.wins) || (b.winRate - a.winRate) || (b.games - a.games));
  return { ok: true, list: list.slice(0, 50) };
}
function safeJson(text, fallback) {
  try { return JSON.parse(text || ''); } catch (e) { return fallback; }
}
// 回放列表：最近的对局（登录后可见）
async function handleReplayList(body) {
  const u = await authUser(body.token);
  if (!u) return { ok: false, msg: '请先登录' };
  const [rows] = await pool.query(
    'SELECT id, room_id, target, players, actions, created_at FROM replays ORDER BY id DESC LIMIT 50');
  return {
    ok: true,
    list: rows.map((r) => ({
      id: r.id,
      roomId: r.room_id,
      target: r.target,
      steps: safeJson(r.actions, []).length,
      createdAt: r.created_at,
      players: safeJson(r.players, []),
    })),
  };
}
// 单局回放数据：开局快照 + 行动序列 + 终局快照
async function handleReplay(body) {
  const u = await authUser(body.token);
  if (!u) return { ok: false, msg: '请先登录' };
  const id = Number(body.id);
  if (!id) return { ok: false, msg: '参数错误' };
  const [rows] = await pool.query('SELECT * FROM replays WHERE id = ?', [id]);
  if (!rows.length) return { ok: false, msg: '回放不存在' };
  const r = rows[0];
  return {
    ok: true,
    replay: {
      id: r.id, roomId: r.room_id, target: r.target, createdAt: r.created_at,
      players: safeJson(r.players, []),
      initial: safeJson(r.initial, null),
      actions: safeJson(r.actions, []),
      final: safeJson(r.final, null),
    },
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function handleLogout(body) {
  const token = String(body.token || '');
  const s = token ? sessions.get(token) : null;
  if (token) sessions.delete(token);
  logAccount('登出', s ? s.name + ' 退出登录' : '退出登录（无有效会话）');
  return { ok: true };
}
async function authUser(token) {
  const s = sessions.get(token);
  if (!s) return null;
  const rec = await findUserDb(s.name);
  return rec ? { name: rec.name, role: rec.role, status: rec.status } : null;
}
async function handleRegister(body) {
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const realName = String(body.realName || '').trim();
  const gradYear = String(body.gradYear || '').trim();
  if (name.length < 2 || name.length > 12) return { ok: false, msg: '用户名需 2~12 个字符' };
  if (password.length < 6) return { ok: false, msg: '密码至少 6 位' };
  if (realName.length < 2 || realName.length > 12) return { ok: false, msg: '请填写真实姓名（2~12 字）' };
  if (!/^\d{4}$/.test(gradYear) || +gradYear < 1990 || +gradYear > 2030) return { ok: false, msg: '届数请填写 4 位高中毕业年份（如 2023）' };
  if (await findUserDb(name)) {
    logAccount('注册', '注册被拒：' + name + '（名字已被注册）');
    return { ok: false, msg: '这个名字已被注册' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    await pool.query(
      'INSERT INTO users (name, salt, hash, role, status, real_name, grad_year, welcomed, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [name, salt, hashPassword(password, salt), 'user', 'pending', realName, +gradYear, 0, 'public', localStamp()]);
  } catch (e) { logAccount('注册', '注册写入失败：' + e.message); return { ok: false, msg: '注册失败，请稍后再试' }; }
  // 姓名重复检测：提醒管理员审核时注意（不阻止注册，同名同姓也可能真实存在）
  const [dupRows] = await pool.query(
    "SELECT name FROM users WHERE real_name = ? AND name <> ?", [realName, name]);
  logAccount('注册', name + '（' + realName + ' · ' + gradYear + '届）提交注册申请，等待审核' +
    (dupRows.length ? ' —— 注意：姓名 ' + realName + ' 已有账号 ' + dupRows.map((r) => r.name).join('、') + ' 注册过' : ''));
  return { ok: true, msg: '申请已提交，请等待管理员审核' };
}
/* ==================== 登录限速（防暴力破解） ==================== */
// 同一账号/同一 IP 在窗口内失败太多次就暂停受理，窗口过后自动恢复（纯内存，重启即清）
const loginFails = new Map(); // key → { n, first }
const LOGIN_WIN = 10 * 60 * 1000; // 计数窗口 10 分钟
function loginBlocked(key, max) {
  const e = loginFails.get(key);
  const now = Date.now();
  if (!e || now - e.first > LOGIN_WIN) return false;
  return e.n >= max;
}
function loginFail(key, max) { // 记录一次失败；返回是否刚达到封禁线
  const now = Date.now();
  let e = loginFails.get(key);
  if (!e || now - e.first > LOGIN_WIN) { e = { n: 0, first: now }; loginFails.set(key, e); }
  e.n++;
  if (loginFails.size > 2000) { // 顺手清掉过期条目，防止地图无限增长
    for (const [k, v] of loginFails) if (now - v.first > LOGIN_WIN) loginFails.delete(k);
  }
  return e.n >= max;
}
function loginClear(key) { loginFails.delete(key); }

async function handleLogin(body, ip) {
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  // 限速：账号 10 分钟最多 10 次失败、同一 IP 最多 30 次，超出暂停受理
  if (loginBlocked('u:' + name, 10) || loginBlocked('ip:' + ip, 30)) {
    logAccount('登录', '登录被限速：' + (name || '匿名') + '（IP ' + ip + ' 尝试过多）');
    return { ok: false, msg: '尝试次数过多，请 10 分钟后再试' };
  }
  const u = await findUserDb(name);
  if (!u || u.hash !== hashPassword(password, u.salt)) {
    loginFail('u:' + name, 10);
    loginFail('ip:' + ip, 30);
    logAccount('登录', '登录失败：' + (name || '匿名') + '（用户名或密码错误）');
    return { ok: false, msg: '用户名或密码错误' };
  }
  if (u.status === 'pending') {
    loginFail('u:' + name, 10);
    loginFail('ip:' + ip, 30);
    logAccount('登录', '登录失败：' + name + '（申请还在审核中）');
    return { ok: false, msg: '你的申请还在审核中，请等待管理员通过' };
  }
  if (u.status === 'denied') {
    loginFail('u:' + name, 10);
    loginFail('ip:' + ip, 30);
    logAccount('登录', '登录失败：' + name + '（申请未通过审核）');
    return { ok: false, msg: '你的申请未通过审核' };
  }
  loginClear('u:' + name);
  const token = crypto.randomUUID();
  sessions.set(token, { name: u.name, role: u.role });
  let welcome = false;
  if (!u.welcomed) {
    welcome = true;
    await pool.query('UPDATE users SET welcomed = 1 WHERE name = ?', [u.name]);
  }
  logAccount('登录', name + ' 登录成功' + (u.role === 'admin' ? '（管理员）' : ''));
  return { ok: true, token, name: u.name, role: u.role, nickname: u.nickname || u.real_name || u.name, welcome };
}
async function handleWhoami(body) {
  const u = await authUser(body.token);
  if (!u) return { ok: false, msg: '登录已过期' };
  const rec = await findUserDb(u.name);
  return { ok: true, name: u.name, role: u.role, nickname: (rec && (rec.nickname || rec.real_name)) || u.name };
}
// 设置游戏内昵称（默认是真实姓名）
async function handleSetNickname(body) {
  const u = await authUser(body.token);
  if (!u) return { ok: false, msg: '登录已过期' };
  const nickname = String(body.nickname || '').trim();
  if (nickname.length < 2 || nickname.length > 12) return { ok: false, msg: '昵称需 2~12 个字符' };
  await pool.query('UPDATE users SET nickname = ? WHERE name = ?', [nickname, u.name]);
  logAccount('昵称', u.name + ' 设置昵称为 ' + nickname);
  return { ok: true, nickname };
}
async function handleAdminList(body) {
  const u = await authUser(body.token);
  if (!u || u.role !== 'admin') return { ok: false, msg: '需要管理员权限' };
  // dup_with：与其他账号重名的账号列表（审核时提醒管理员注意）
  const [rows] = await pool.query(
    `SELECT u.*,
       (SELECT GROUP_CONCAT(u2.name SEPARATOR '、') FROM users u2
        WHERE u2.id <> u.id AND u2.real_name <> '' AND u2.real_name = u.real_name) AS dup_with
     FROM users u WHERE u.role != ? ORDER BY u.name`, ['admin']);
  const users = rows.map((x) => ({
    name: x.name,
    realName: x.real_name || '—',
    gradYear: x.grad_year || 0,
    remark: x.remark || '',
    source: x.source || 'public',
    status: x.status,
    createdAt: x.created_at,
    dupWith: x.dup_with || '',
  })).sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1) || a.name.localeCompare(b.name));
  const stats = {
    pending: users.filter((x) => x.status === 'pending').length,
    approved: users.filter((x) => x.status === 'approved').length,
    denied: users.filter((x) => x.status === 'denied').length,
  };
  return { ok: true, users, stats };
}
// 修改密码（登录用户自助）
async function handleChangePassword(body) {
  const u = await authUser(body.token);
  if (!u) return { ok: false, msg: '登录已过期' };
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6) return { ok: false, msg: '新密码至少 6 位' };
  const rec = await findUserDb(u.name);
  if (!rec) return { ok: false, msg: '账号不存在' };
  if (rec.hash !== hashPassword(oldPassword, rec.salt)) {
    logAccount('改密', '改密失败：' + u.name + '（原密码不正确）');
    return { ok: false, msg: '原密码不正确' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE users SET salt = ?, hash = ? WHERE name = ?', [salt, hashPassword(newPassword, salt), u.name]);
  logAccount('改密', u.name + ' 修改了密码');
  return { ok: true, msg: '密码已修改' };
}
// 后门注册：管理员为非一中用户直接创建账号（即时通过，可填身份备注）
async function handleBackdoorRegister(body) {
  const u = await authUser(body.token);
  if (!u || u.role !== 'admin') return { ok: false, msg: '需要管理员权限' };
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const remark = String(body.remark || '').trim().slice(0, 30);
  if (name.length < 2 || name.length > 12) return { ok: false, msg: '用户名需 2~12 个字符' };
  if (password.length < 6) return { ok: false, msg: '密码至少 6 位' };
  if (await findUserDb(name)) return { ok: false, msg: '这个名字已被注册' };
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    await pool.query(
      'INSERT INTO users (name, salt, hash, role, status, welcomed, source, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, salt, hashPassword(password, salt), 'user', 'approved', 0, 'backdoor', remark, localStamp()]);
  } catch (e) { logAccount('后门注册', '写入失败：' + e.message); return { ok: false, msg: '创建失败，请稍后再试' }; }
  logAccount('后门注册', '管理员 ' + u.name + ' 创建了账号 ' + name + (remark ? '（' + remark + '）' : ''));
  return { ok: true, msg: '账号 ' + name + ' 已创建并直接通过' };
}
// 添加管理员：现有管理员直接创建新管理员账号（即时生效）
async function handleCreateAdmin(body) {
  const u = await authUser(body.token);
  if (!u || u.role !== 'admin') return { ok: false, msg: '需要管理员权限' };
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  if (name.length < 2 || name.length > 12) return { ok: false, msg: '用户名需 2~12 个字符' };
  if (password.length < 6) return { ok: false, msg: '密码至少 6 位' };
  if (await findUserDb(name)) return { ok: false, msg: '这个名字已被注册' };
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    await pool.query(
      'INSERT INTO users (name, salt, hash, role, status, welcomed, source, remark, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, salt, hashPassword(password, salt), 'admin', 'approved', 1, 'admin', '管理员创建', localStamp()]);
  } catch (e) { logAccount('管理员创建', '写入失败：' + e.message); return { ok: false, msg: '创建失败，请稍后再试' }; }
  logAccount('管理员创建', '管理员 ' + u.name + ' 创建了新管理员 ' + name);
  return { ok: true, msg: '管理员 ' + name + ' 已创建，可以用它登录了' };
}
async function handleAdminReview(body) {
  const u = await authUser(body.token);
  if (!u || u.role !== 'admin') return { ok: false, msg: '需要管理员权限' };
  if (!['approve', 'deny'].includes(body.action)) return { ok: false, msg: '参数错误' };
  const target = await findUserDb(String(body.name || ''));
  if (!target) return { ok: false, msg: '没有这个用户' };
  if (target.role === 'admin') return { ok: false, msg: '不能操作管理员账号' };
  const newStatus = body.action === 'approve' ? 'approved' : 'denied';
  if (target.status === newStatus) return { ok: false, msg: '该用户已经是这个状态' };
  await pool.query('UPDATE users SET status = ?, welcomed = 0 WHERE name = ?', [newStatus, target.name]);
  logAccount('审核', '管理员 ' + u.name + ' 把 ' + target.name + ' 改为' + (newStatus === 'approved' ? '通过' : '拒绝'));
  return { ok: true };
}
/* ==================== 请求处理 ==================== */
async function handleJoin(body) {
  // 联机必须先登录：显示名 = 昵称（未设置时用真实姓名/账号名）
  const u = await authUser(body.token);
  if (!u) return { ok: false, msg: '请先登录' };
  const rec = await findUserDb(u.name);
  const name = (rec && (rec.nickname || rec.real_name)) || u.name;
  if (!name) return { ok: false, msg: '名字不能为空' };
  let room = body.roomId ? rooms.get(String(body.roomId)) : null;
  // 没有房间号：创建新房间（isPublic 由客户端指定）
  if (!room) {
    if (body.roomId) return { ok: false, msg: '房间不存在，请检查房间号' };
    room = createRoom(body.isPublic === true);
  }
  if (room.phase === 'lobby') {
    if (connectedHumans(room).length >= NET.maxPlayers) return { ok: false, msg: '房间已满（最多 ' + NET.maxPlayers + ' 人）' };
    if (humansList(room).some((c) => c.name === name)) return { ok: false, msg: '这个名字已被使用' };
    const cid = crypto.randomUUID();
    const conn = { cid, name, accountName: u.name, seat: -1, res: null, connected: false, isHost: humansList(room).length === 0, room };
    room.conns.set(cid, conn);
    connIndex.set(cid, { room, conn });
    logEvent(room, '加入', `${name}${conn.isHost ? '（房主）' : ''}，当前 ${room.conns.size} 人`);
    return { ok: true, cid, roomId: room.id };
  }
  // 对局中：允许断线玩家用原名字重连
  const old = humansList(room).find((c) => c.name === name && !c.connected);
  if (!old) return { ok: false, msg: '对局进行中，暂时不能加入' };
  logEvent(room, '重连', `${name} 回到座位 ${old.seat}`);
  if (room.skipTimer) { clearTimeout(room.skipTimer); room.skipTimer = null; }
  if (room.offlineTimer) { clearTimeout(room.offlineTimer); room.offlineTimer = null; }
  const cid = crypto.randomUUID();
  const conn = { cid, name, accountName: u.name, seat: old.seat, res: null, connected: false, isHost: old.isHost, room };
  room.conns.delete(old.cid);
  connIndex.delete(old.cid);
  room.conns.set(cid, conn);
  connIndex.set(cid, { room, conn });
  return { ok: true, cid, roomId: room.id };
}
// 开始对局（房主开始与教程一键开局共用）：humans 为要分配座位的真人连接列表
function startGame(room, humans) {
  if (room.phase !== 'lobby') return { ok: false, msg: '对局已开始' };
  const total = humans.length + room.ais.length;
  if (total < 2) return { ok: false, msg: '至少需要 2 名玩家' };
  if (total > 4) return { ok: false, msg: '最多 4 名玩家' };
  humans.forEach((h, i) => { h.seat = i; });
  const cfg = {
    target: room.target,
    players: humans.map((h) => ({ name: h.name, type: 'human' }))
      .concat(room.ais.map((a) => ({ name: a.name, type: a.level }))),
  };
  room.session.lastCfg = cfg;
  room.session.newGame(cfg);
  beginRecording(room);
  room.phase = 'game';
  room.log = [];
  room.vote = null;
  if (room.offlineTimer) { clearTimeout(room.offlineTimer); room.offlineTimer = null; }
  logEvent(room, '对局', `对局开始：${cfg.players.map((p) => p.name + (p.type !== 'human' ? '(电脑)' : '')).join('、')}，目标 ${room.target} 分`);
  broadcastRoom(room);
  room.session.scheduleAI();
  return { ok: true };
}
function handleStart(conn) {
  if (!conn.isHost) return { ok: false, msg: '只有房主可以开始' };
  return startGame(conn.room, connectedHumans(conn.room));
}
// 开始记录本局回放：玩家名单 + 开局状态快照（此后每步行动由 HOOKS.onAction 追加）
function beginRecording(room) {
  const S = room.session.S;
  const seatOf = {};
  for (const c of room.conns.values()) { if (c.seat >= 0) seatOf[c.seat] = c; }
  room.rec = {
    roomId: room.id,
    target: room.target,
    startedAt: localStamp(),
    players: S.players.map((p, i) => ({
      name: p.name, seat: i, isAI: p.isAI,
      account: !p.isAI && seatOf[i] ? seatOf[i].accountName : '',
    })),
    initial: JSON.stringify(S),
    actions: [],
    final: '',
  };
}
// 终局：把回放记录写入数据库（教程局不存，与战绩口径一致）
async function saveReplay(room) {
  const rec = room.rec;
  if (!rec) return;
  room.rec = null; // 防重复写入（onGameOver 只触发一次，这里双保险）
  if (room.tutorial) return;
  try {
    await pool.query(
      'INSERT INTO replays (room_id, target, players, initial, actions, final, created_at) VALUES (?,?,?,?,?,?,?)',
      [rec.roomId, rec.target, JSON.stringify(rec.players), rec.initial,
        JSON.stringify(rec.actions), JSON.stringify(room.session.S), rec.startedAt]);
    logEvent(room, '回放', `对局回放已保存（${rec.actions.length} 步）`);
  } catch (e) { logEvent(room, '回放', '回放保存失败：' + e.message); }
}
// 新手教程：一键创建私有房间（本人 + 电脑小智）并直接开局；引导由客户端 tutorial.js 负责
async function handleTutorial(body) {
  const u = await authUser(body.token);
  if (!u) return { ok: false, msg: '请先登录' };
  const rec = await findUserDb(u.name);
  const name = (rec && (rec.nickname || rec.real_name)) || u.name;
  if (!name) return { ok: false, msg: '名字不能为空' };
  const room = createRoom(false); // 私有房间，别人搜不到
  room.tutorial = true;           // 教程局不计入战绩（recordGameStats 跳过）
  const cid = crypto.randomUUID();
  const conn = { cid, name, accountName: u.name, seat: 0, res: null, connected: false, isHost: true, room };
  room.conns.set(cid, conn);
  connIndex.set(cid, { room, conn });
  room.ais = [{ name: '小智', level: 'easy' }];
  room.target = RULES.targets.includes(15) ? 15 : RULES.targets[0];
  logEvent(room, '教程', `${name} 开始新手教程`);
  // SSE 还没连也能开局：客户端连上 SSE 时 handleSSE 会补发当前状态
  const r = startGame(room, [conn]);
  if (!r.ok) { rooms.delete(room.id); connIndex.delete(cid); }
  return { ok: r.ok, msg: r.msg, cid: r.ok ? cid : undefined, roomId: room.id, target: room.target };
}
function handleSetAIs(conn, ais) {
  const room = conn.room;
  if (!conn.isHost || room.phase !== 'lobby') return { ok: false, msg: '只有房主在大厅时可以设置' };
  const list = (Array.isArray(ais) ? ais : []).slice(0, 4).map((a) => ({
    name: String((a && a.name) || '电脑').trim().slice(0, 8) || '电脑',
    level: a && a.level === 'hard' ? 'hard' : 'easy',
  }));
  if (connectedHumans(room).length + list.length > 4) return { ok: false, msg: '总共最多 4 名玩家' };
  room.ais = list;
  broadcastRoom(room);
  return { ok: true };
}
function handleSetTarget(conn, target) {
  const room = conn.room;
  if (!conn.isHost || room.phase !== 'lobby') return { ok: false, msg: '只有房主在大厅时可以设置' };
  if (!RULES.targets.includes(target)) return { ok: false, msg: '无效的目标分数' };
  room.target = target;
  broadcastRoom(room);
  return { ok: true };
}
function handleRestart(conn) {
  const room = conn.room;
  if (!conn.isHost) return { ok: false, msg: '只有房主可以操作' };
  if (!room.session.lastCfg) return { ok: false, msg: '没有可重开的对局' };
  if (room.session.S && !room.session.S.over) return { ok: false, msg: '对局还在进行中' };
  room.session.newGame(room.session.lastCfg);
  beginRecording(room);
  room.phase = 'game';
  room.log = [];
  room.vote = null;
  logEvent(room, '对局', '对局重新开始');
  broadcastRoom(room);
  room.session.scheduleAI();
  return { ok: true };
}
function handleBackToLobby(conn) {
  const room = conn.room;
  if (!conn.isHost) return { ok: false, msg: '只有房主可以操作' };
  endGameToLobby(room, '房主结束对局，返回大厅');
  return { ok: true };
}
// 结束对局投票：任何人可发起，所有人类玩家同意才生效；有人反对则取消
// 公开房间列表（大厅、公开的房间可被搜索）
function handleListRooms() {
  const list = [];
  for (const r of rooms.values()) {
    if (r.phase === 'lobby' && r.isPublic) {
      const host = connectedHumans(r)[0] || humansList(r)[0];
      list.push({ id: r.id, host: host ? host.name : '—', count: connectedHumans(r).length, ais: r.ais.length });
    }
  }
  list.sort((a, b) => Number(a.id) - Number(b.id));
  return { ok: true, rooms: list };
}
// 房主踢人（仅大厅阶段）
function handleKick(conn, targetCid) {
  const room = conn.room;
  if (!conn.isHost || room.phase !== 'lobby') return { ok: false, msg: '只有房主在大厅时可以踢人' };
  const target = room.conns.get(targetCid);
  if (!target) return { ok: false, msg: '没有这个玩家' };
  if (target.cid === conn.cid) return { ok: false, msg: '不能踢自己' };
  logEvent(room, '踢人', `${target.name} 被房主移出房间`);
  room.conns.delete(target.cid);
  connIndex.delete(target.cid);
  promoteHostIfNeeded(room);
  broadcastRoom(room);
  if (target.res) {
    sendSSE(target, { type: 'kicked', msg: '你被房主移出了房间' });
    try { target.res.end(); } catch (e) { /* 已断开 */ }
  }
  return { ok: true };
}
function handleVoteEnd(conn) {
  const room = conn.room;
  if (room.phase !== 'game' || !room.session.S) return { ok: false, msg: '对局未在进行' };
  if (room.session.S.over) return { ok: false, msg: '对局已经结束' };
  if (room.vote) return { ok: false, msg: '已有人在发起结束投票' };
  room.vote = { by: conn.name, yes: [conn.cid] };
  logEvent(room, '投票', `${conn.name} 发起结束对局投票`);
  broadcastRoom(room);
  checkVoteComplete(room);
  return { ok: true };
}
function handleVoteAnswer(conn, ans) {
  const room = conn.room;
  if (!room.vote) return { ok: false, msg: '没有进行中的投票' };
  if (ans === 'no') {
    logEvent(room, '投票', `${conn.name} 反对，结束投票已取消`);
    room.vote = null;
    broadcastRoom(room);
    return { ok: true };
  }
  if (!room.vote.yes.includes(conn.cid)) room.vote.yes.push(conn.cid);
  logEvent(room, '投票', `${conn.name} 同意结束（${room.vote.yes.length}/${connectedHumans(room).length}）`);
  broadcastRoom(room);
  checkVoteComplete(room);
  return { ok: true };
}
// 校验玩家的行动是否合法（服务器权威：不信任客户端）
function validAction(conn, a) {
  const room = conn.room;
  const S = room.session.S;
  if (room.phase !== 'game' || !S || S.over) return '对局尚未开始';
  if (S.current !== conn.seat) return '还没轮到你';
  if (room.session.curPlayer().isAI) return '现在是电脑的回合';
  const p = room.session.curPlayer();
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
    case 'reserveBlind': {
      if (S.phase !== 'normal') return '现在不能预约';
      const t = a.tier;
      if (![1, 2, 3].includes(t)) return '只能盲抽一/二/三阶牌堆';
      if (!S.decks[t].length) return '该牌堆已经抽完了';
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
      if (!room.session.canAfford(p, card)) return '精灵球不够';
      return null;
    }
    default: return '未知行动';
  }
}
function handleAction(conn, a) {
  const room = conn.room;
  const err = validAction(conn, a || {});
  if (err) return { ok: false, msg: err };
  const s = room.session;
  if (a.kind === 'take3') s.actTakeThree(a.colors);
  else if (a.kind === 'take2') s.actTakeTwo(a.color);
  else if (a.kind === 'return') s.actReturnBall(a.color);
  else if (a.kind === 'discard') s.actDiscardOne(a.color);
  else if (a.kind === 'takeMaster') s.actTakeMaster();
  else if (a.kind === 'evolve') s.actEvolve(a.loc);
  else if (a.kind === 'skipEvolve') s.actSkipEvolve();
  else if (a.kind === 'reserve') s.actReserve(a.tier, a.idx);
  else if (a.kind === 'reserveBlind') s.actReserveBlind(a.tier);
  else if (a.kind === 'buy') { if (a.reserved) s.actBuyReserved(a.ridx); else s.actBuy(a.tier, a.idx); }
  return { ok: true };
}

/* ==================== HTTP 服务 ==================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// 可 gzip 压缩的文本类静态资源（图片已是压缩格式，跳过）；带宽小的服务器省流量
const GZIP_EXT = ['.html', '.css', '.js', '.json', '.txt', '.svg'];
function handleSSE(req, res, u) {
  const cid = u.searchParams.get('cid');
  const entry = connIndex.get(cid);
  const conn = entry && entry.conn;
  if (!conn) { res.writeHead(400); return res.end(); }
  // 同一玩家带着旧连接再来（页面刷新 / 看门狗重建）：新连接顶掉旧的，
  // 旧的 destroy 后其 close 事件被下方 `conn.res === res` 守卫拦住，不会误判断线
  if (conn.res) { try { conn.res.destroy(); } catch (e) { /* 旧连接已死 */ } conn.res = null; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  conn.res = res;
  conn.connected = true;
  const room = entry.room;
  if (room.skipTimer) { clearTimeout(room.skipTimer); room.skipTimer = null; } // 玩家重连回来了
  if (room.offlineTimer) { clearTimeout(room.offlineTimer); room.offlineTimer = null; } // 宽限倒计时取消
  logEvent(room, '在线', `${conn.name} 已连接（座位 ${conn.seat}）`);
  broadcastRoom(room);
  // 半死的连接 write 时会抛错：吞掉等 close 事件来清理，别让进程崩溃
  res.on('error', () => {});
  // 用响应流的 close 检测客户端断开（req 的 close 在请求读完就会触发，会误判）
  res.on('close', () => { if (conn.res === res) handleDisconnect(room, conn); });
}
function handleApi(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 10000) req.destroy(); });
  req.on('end', async () => {
    let obj;
    try { obj = JSON.parse(body || '{}'); } catch (e) { obj = {}; }
    const entry = connIndex.get(obj.cid);
    const conn = entry && entry.conn;
    let result;
    if (obj.type === 'register') result = await handleRegister(obj);
    else if (obj.type === 'login') result = await handleLogin(obj, (req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
    else if (obj.type === 'whoami') result = await handleWhoami(obj);
    else if (obj.type === 'setNickname') result = await handleSetNickname(obj);
    else if (obj.type === 'changePassword') result = await handleChangePassword(obj);
    else if (obj.type === 'leaderboard') result = await handleLeaderboard(obj);
    else if (obj.type === 'replayList') result = await handleReplayList(obj);
    else if (obj.type === 'replay') result = await handleReplay(obj);
    else if (obj.type === 'logout') result = handleLogout(obj);
    else if (obj.type === 'adminList') result = await handleAdminList(obj);
    else if (obj.type === 'adminReview') result = await handleAdminReview(obj);
    else if (obj.type === 'adminLogs') result = await handleAdminLogs(obj);
    else if (obj.type === 'backdoorRegister') result = await handleBackdoorRegister(obj);
    else if (obj.type === 'createAdmin') result = await handleCreateAdmin(obj);
    else if (obj.type === 'join') result = await handleJoin(obj);
    else if (obj.type === 'tutorial') result = await handleTutorial(obj);
    else if (obj.type === 'listRooms') result = handleListRooms();
    else if (!obj.type) result = { ok: false, msg: '参数错误' };
    else if (!conn || !conn.connected) result = { ok: false, msg: '连接已失效，请刷新页面重新加入' };
    else if (obj.type === 'start') result = handleStart(conn);
    else if (obj.type === 'setAIs') result = handleSetAIs(conn, obj.ais);
    else if (obj.type === 'setTarget') result = handleSetTarget(conn, obj.target);
    else if (obj.type === 'restart') result = handleRestart(conn);
    else if (obj.type === 'backToLobby') result = handleBackToLobby(conn);
    else if (obj.type === 'voteEnd') result = handleVoteEnd(conn);
    else if (obj.type === 'voteEndAnswer') result = handleVoteAnswer(conn, obj.answer);
    else if (obj.type === 'kick') result = handleKick(conn, obj.targetCid);
    else if (obj.type === 'action') result = handleAction(conn, obj.action);
    else result = { ok: false, msg: '未知请求' };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  });
}
const handler = (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/events') return handleSSE(req, res, u);
  if (u.pathname === '/api') return handleApi(req, res);
  // 静态文件（先解码 URL，中文文件名才能对得上磁盘）
  let file;
  try { file = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname); }
  catch (e) { res.writeHead(400); return res.end(); }
  // 后台看板：/admin 直达；老地址 /admin.html 永久跳转过去
  if (file === '/admin') file = '/admin.html';
  else if (file === '/admin.html') { res.writeHead(301, { Location: '/admin' }); return res.end(); }
  // 对局回放：/replay 直达
  else if (file === '/replay') file = '/replay.html';
  const full = path.join(ROOT, path.normalize('/' + file));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  // 敏感路径禁止通过 HTTP 外发：数据库配置、日志、依赖、版本库、服务端源码只留在磁盘上
  // test-*.js 测试脚本含管理员凭据，同样禁止外发（生产环境永远用不到它们）
  if (full !== ROOT) {
    const rel = path.relative(ROOT, full);
    const top = rel.split(path.sep)[0];
    if (['data', 'logs', 'node_modules', '.git', '工具', '测试'].includes(top) || rel.endsWith('.log') || rel === 'server.js'
      || (rel.startsWith('test-') && rel.endsWith('.js'))) {
      res.writeHead(403); return res.end();
    }
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 文件不存在'); }
    const ext = path.extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // 缓存：图片 7 天（几乎不变），文本类 1 分钟（更新代码后玩家几乎立刻拿到新版，不用手动强刷）
    const cache = ext === '.jpg' || ext === '.png' ? 'public, max-age=604800' : 'public, max-age=60';
    const accept = String(req.headers['accept-encoding'] || '');
    if (GZIP_EXT.includes(ext) && accept.includes('gzip') && data.length > 1024) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Cache-Control': cache });
      res.end(zlib.gzipSync(data));
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(data);
  });
};
const server = http.createServer(handler);

// 先连数据库（建库建表），失败则给出清晰提示后退出
initDb().then(() => {
  startServer();
}).catch((e) => {
  console.error('[数据库] MySQL 连接失败：' + e.message);
  writeLog('server.log', '数据库', 'MySQL 连接失败：' + e.message);
  console.error('[数据库] 请在 data/db.json 里配置正确的连接信息：');
  console.error('[数据库] { "host": "127.0.0.1", "port": 3306, "user": "root", "password": "你的密码", "database": "splendor" }');
  process.exit(1);
});
function startServer() {
  // 80 端口：公网短链接用；3000 保留不动，已发出去的旧链接继续有效
  const server80 = http.createServer(handler);
  server80.on('error', (e) => { console.error('[服务器] 80 端口监听失败：' + e.message); });
  server80.listen(80);
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
  logEvent(null, '服务器', '服务器启动（端口 ' + PORT + '）');
});

// Ctrl+C 停止：先落日志再退出
process.on('SIGINT', () => {
  logEvent(null, '服务器', '服务器停止');
  process.exit(0);
});

}
