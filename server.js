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

const NET = global.NETWORK || { port: 3000, turnTimeoutSec: 30, maxPlayers: 4 };
const PORT = NET.port;
const TURN_TIMEOUT = NET.turnTimeoutSec * 1000;
const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');

/* ==================== 日志 ==================== */
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fileLog(tag, msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
    fs.appendFileSync(path.join(LOG_DIR, 'server.log'), `[${localStamp()}] [${tag}] ${msg}\n`, 'utf8');
  } catch (e) { /* 日志写失败不影响游戏 */ }
}
// 统一日志：控制台 + 落盘 + 房间内记录（游戏内「记录」面板可见）
function logEvent(room, tag, msg) {
  console.log(`[房${room ? room.id : '-'}] [${tag}] ${msg}`);
  fileLog(tag, `${room ? '[房' + room.id + '] ' : ''}${msg}`);
  if (room && room.phase === 'game') {
    room.log.push({ time: new Date().toTimeString().slice(0, 8), text: msg });
    if (room.log.length > 100) room.log.shift();
  }
}

/* ==================== 房间 ==================== */
// rooms: roomId -> {id, isPublic, phase, ais, target, log, conns:Map, vote, skipTimer, session}
const rooms = new Map();
// connIndex: cid -> {room, conn}（快速定位连接所属房间）
const connIndex = new Map();

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
    session,
  };
  // 会话事件钩子：状态一变就广播给本房所有玩家
  session.HOOKS.onStateChanged = () => broadcastRoom(room);
  session.HOOKS.onToast = (m) => { broadcastToast(room, m); logEvent(room, '事件', m); };
  session.HOOKS.onGameOver = () => broadcastRoom(room);
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
  if (conn && conn.res) conn.res.write('data: ' + JSON.stringify(obj) + '\n\n');
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

/* ==================== 结束对局（投票 / 全员离线 / 房主） ==================== */
function endGameToLobby(room, reason) {
  room.vote = null;
  room.session.S = null;
  if (room.skipTimer) { clearTimeout(room.skipTimer); room.skipTimer = null; }
  room.phase = 'lobby';
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
  // 对局中：所有人类玩家都离线 → 自动终止对局
  if (connectedHumans(room).length === 0) { endGameToLobby(room, '所有玩家离线，对局自动结束'); return; }
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

/* ==================== 账号系统 ==================== */
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const sessions = new Map(); // token -> {name, role}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (e) { return { users: [] }; }
}
function saveUsers(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), 'utf8');
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function findUser(db, name) { return db.users.find((u) => u.name === name); }
function authUser(token) {
  const s = sessions.get(token);
  if (!s) return null;
  const db = loadUsers();
  const u = findUser(db, s.name);
  return u ? { name: u.name, role: u.role, status: u.status } : null;
}
function handleRegister(body) {
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const realName = String(body.realName || '').trim();
  const gradYear = String(body.gradYear || '').trim();
  if (name.length < 2 || name.length > 12) return { ok: false, msg: '用户名需 2~12 个字符' };
  if (password.length < 6) return { ok: false, msg: '密码至少 6 位' };
  if (realName.length < 2 || realName.length > 12) return { ok: false, msg: '请填写真实姓名（2~12 字）' };
  if (!/^\d{4}$/.test(gradYear) || +gradYear < 1990 || +gradYear > 2030) return { ok: false, msg: '届数请填写 4 位高中毕业年份（如 2023）' };
  const db = loadUsers();
  if (findUser(db, name)) return { ok: false, msg: '这个名字已被注册' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.users.push({ name, salt, hash: hashPassword(password, salt), role: 'user', status: 'pending', welcomed: false, realName, gradYear: +gradYear, createdAt: localStamp() });
  saveUsers(db);
  logEvent(null, '账号', `${name}（${realName} · ${gradYear}届）提交注册申请，等待审核`);
  return { ok: true, msg: '申请已提交，请等待管理员审核' };
}
function handleLogin(body) {
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const db = loadUsers();
  const u = findUser(db, name);
  if (!u || u.hash !== hashPassword(password, u.salt)) return { ok: false, msg: '用户名或密码错误' };
  if (u.status === 'pending') return { ok: false, msg: '你的申请还在审核中，请等待管理员通过' };
  if (u.status === 'denied') return { ok: false, msg: '你的申请未通过审核' };
  const token = crypto.randomUUID();
  sessions.set(token, { name: u.name, role: u.role });
  let welcome = false;
  if (!u.welcomed) { u.welcomed = true; saveUsers(db); welcome = true; }
  logEvent(null, '账号', `${name} 登录`);
  return { ok: true, token, name: u.name, role: u.role, welcome };
}
function handleWhoami(body) {
  const u = authUser(body.token);
  return u ? { ok: true, name: u.name, role: u.role } : { ok: false, msg: '登录已过期' };
}
function handleLogout(body) {
  sessions.delete(body.token);
  return { ok: true };
}
function handleAdminList(body) {
  const u = authUser(body.token);
  if (!u || u.role !== 'admin') return { ok: false, msg: '需要管理员权限' };
  const db = loadUsers();
  const pending = db.users.filter((x) => x.status === 'pending').map((x) => ({ name: x.name, realName: x.realName || '—', gradYear: x.gradYear || 0, createdAt: x.createdAt }));
  const stats = {
    pending: pending.length,
    approved: db.users.filter((x) => x.status === 'approved').length,
    denied: db.users.filter((x) => x.status === 'denied').length,
  };
  return { ok: true, pending, stats };
}
function handleAdminReview(body) {
  const u = authUser(body.token);
  if (!u || u.role !== 'admin') return { ok: false, msg: '需要管理员权限' };
  if (!['approve', 'deny'].includes(body.action)) return { ok: false, msg: '参数错误' };
  const db = loadUsers();
  const target = findUser(db, String(body.name || ''));
  if (!target) return { ok: false, msg: '没有这个申请' };
  if (target.status !== 'pending') return { ok: false, msg: '该申请已处理' };
  target.status = body.action === 'approve' ? 'approved' : 'denied';
  target.welcomed = false;
  saveUsers(db);
  logEvent(null, '账号', `${target.name} 的申请被管理员${body.action === 'approve' ? '通过' : '拒绝'}`);
  return { ok: true };
}

/* ==================== 请求处理 ==================== */
function handleJoin(body) {
  // 联机必须先登录：显示名 = 账号名
  const u = authUser(body.token);
  if (!u) return { ok: false, msg: '请先登录' };
  const name = u.name;
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
    const conn = { cid, name, seat: -1, res: null, connected: false, isHost: humansList(room).length === 0, room };
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
  const cid = crypto.randomUUID();
  const conn = { cid, name, seat: old.seat, res: null, connected: false, isHost: old.isHost, room };
  room.conns.delete(old.cid);
  connIndex.delete(old.cid);
  room.conns.set(cid, conn);
  connIndex.set(cid, { room, conn });
  return { ok: true, cid, roomId: room.id };
}
function handleStart(conn) {
  const room = conn.room;
  if (!conn.isHost) return { ok: false, msg: '只有房主可以开始' };
  if (room.phase !== 'lobby') return { ok: false, msg: '对局已开始' };
  const humans = connectedHumans(room);
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
  room.phase = 'game';
  room.log = [];
  room.vote = null;
  logEvent(room, '对局', `对局开始：${cfg.players.map((p) => p.name + (p.type !== 'human' ? '(电脑)' : '')).join('、')}，目标 ${room.target} 分`);
  broadcastRoom(room);
  room.session.scheduleAI();
  return { ok: true };
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
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function handleSSE(req, res, u) {
  const cid = u.searchParams.get('cid');
  const entry = connIndex.get(cid);
  const conn = entry && entry.conn;
  if (!conn || conn.res) { res.writeHead(400); return res.end(); }
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
  logEvent(room, '在线', `${conn.name} 已连接（座位 ${conn.seat}）`);
  broadcastRoom(room);
  // 用响应流的 close 检测客户端断开（req 的 close 在请求读完就会触发，会误判）
  res.on('close', () => { if (conn.res === res) handleDisconnect(room, conn); });
}
function handleApi(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 10000) req.destroy(); });
  req.on('end', () => {
    let obj;
    try { obj = JSON.parse(body || '{}'); } catch (e) { obj = {}; }
    const entry = connIndex.get(obj.cid);
    const conn = entry && entry.conn;
    let result;
    if (obj.type === 'register') result = handleRegister(obj);
    else if (obj.type === 'login') result = handleLogin(obj);
    else if (obj.type === 'whoami') result = handleWhoami(obj);
    else if (obj.type === 'logout') result = handleLogout(obj);
    else if (obj.type === 'adminList') result = handleAdminList(obj);
    else if (obj.type === 'adminReview') result = handleAdminReview(obj);
    else if (obj.type === 'join') result = handleJoin(obj);
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
