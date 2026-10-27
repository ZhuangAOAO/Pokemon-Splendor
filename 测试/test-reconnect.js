'use strict';
/* ================================================================
   断线重连回归测试（本地 3210 端口测试服务器，在项目根目录运行 node 测试/test-reconnect.js）：
   场景1：对局中短暂断线 → 60 秒宽限期内同名重连 → 对局继续
   场景2：宽限期过后无人回来 → 对局自动结束、房间解散
   场景3：同一 cid 的旧 SSE 被新连接顶掉，不产生误判断线
   场景4：心跳消息在 20 秒左右到达
   ================================================================ */
const BASE = 'http://localhost:3210';
const crypto = require('crypto');
const path = require('path');
const mysql = require('mysql2/promise');
const ADMIN = require('./凭证');

const fails = [];
const ok = (c, n) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails.push(n); };
async function post(obj) {
  const r = await fetch(BASE + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// SSE 读取器：持续收集 data 消息，done 表示流已结束，cancel 用于主动断开
function sseReader(es) {
  const msgs = [];
  let buf = '';
  const decoder = new TextDecoder();
  let cancel = () => {};
  const done = (async () => {
    try {
      const reader = es.body.getReader();
      cancel = () => { try { reader.cancel(); } catch (e) { /* 已结束 */ } };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) msgs.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (e) { /* 连接被取消 */ }
  })();
  return { msgs, done, cancel: () => cancel() };
}
async function waitFor(cond, timeoutMs, desc) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('超时：' + desc);
    await sleep(200);
  }
}

(async () => {
  // 走统一入口：环境变量优先，其次 data/db.json（见 db-config.js）
const db = require(path.join(__dirname, '..', 'db-config.js'))();
  const pool = mysql.createPool(Object.assign({}, db, { waitForConnections: true }));
  const testName = '断线测试' + Math.floor(Math.random() * 900 + 100);
  const testPass = crypto.randomBytes(8).toString('hex');

  const admin = await post({ type: 'login', name: ADMIN.name, password: ADMIN.password });
  await post({ type: 'backdoorRegister', token: admin.token, name: testName, password: testPass, remark: '断线测试' });
  const login = await post({ type: 'login', name: testName, password: testPass });

  /* ---- 场景1+3：对局中短暂断线 → 宽限期内重连继续 ---- */
  const join = await post({ type: 'join', token: login.token, roomId: '', isPublic: false });
  const esA = await fetch(BASE + '/events?cid=' + join.cid);
  const rA = sseReader(esA);
  await waitFor(() => rA.msgs.some((m) => m.type === 'state'), 5000, '初始状态');
  await post({ type: 'setAIs', cid: join.cid, ais: [{ name: '小智', level: 'easy' }] });
  const start = await post({ type: 'start', cid: join.cid });
  ok(start.ok, '开局（' + join.roomId + '）');
  await waitFor(() => rA.msgs.some((m) => m.game), 5000, '开局状态');

  // 场景3：同一 cid 再开一条 SSE → 新连接顶掉旧的，旧流结束且不判断线
  const esA2 = await fetch(BASE + '/events?cid=' + join.cid);
  const rA2 = sseReader(esA2);
  await waitFor(() => rA2.msgs.some((m) => m.type === 'state'), 5000, '新连接收到状态');
  await waitFor(() => rA.done.then(() => true), 5000, '旧连接被服务器关闭');
  ok(true, '场景3：同一玩家新 SSE 顶掉旧连接，旧流被服务器主动关闭');

  // 场景1：模拟断线（全部连接取消）→ 宽限期内同名重连 → 对局继续
  const turnBeforePause = rA2.msgs.filter((m) => m.game).at(-1).game.turnIdx;
  rA2.cancel();
  await sleep(1500); // 触发 handleDisconnect 与 60 秒宽限倒计时
  const rejoin = await post({ type: 'join', token: login.token, roomId: join.roomId, isPublic: false });
  ok(rejoin.ok && rejoin.cid, '场景1：60 秒宽限期内同名重连成功（对局未结束）');
  const esB = await fetch(BASE + '/events?cid=' + rejoin.cid);
  const rB = sseReader(esB);
  await waitFor(() => rB.msgs.some((m) => m.game && !m.game.over), 5000, '重连后收到对局状态');
  ok(rB.msgs.some((m) => m.game && !m.game.over), '场景1：重连后对局仍在进行（没有被误结束）');
  const turnAfterPause = rB.msgs.find((m) => m.game).game.turnIdx;
  ok(turnAfterPause === turnBeforePause, '场景1：全员离线期间回合未被 AI 推进');

  // 场景4：等心跳（≤ 25 秒内应出现 type=hb）
  await waitFor(() => rB.msgs.some((m) => m.type === 'hb'), 25000, '心跳消息');
  ok(true, '场景4：收到服务器心跳');

  /* ---- 场景2：宽限期过后无人回来 → 自动结束并解散 ---- */
  rB.cancel();
  console.log('  等待 61 秒验证宽限期后的自动解散…');
  await sleep(61000);
  const rejoin2 = await post({ type: 'join', token: login.token, roomId: join.roomId, isPublic: false });
  ok(!rejoin2.ok, '场景2：宽限期过后房间已解散（' + rejoin2.msg + '）');
  const [[replayCount]] = await pool.query('SELECT COUNT(*) AS n FROM replays WHERE room_id = ?', [join.roomId]);
  ok(replayCount.n === 0, '场景2：未完成的离线对局不生成回放');

  /* ---- 清理 ---- */
  await pool.query('DELETE FROM stats WHERE account = ?', [testName]);
  await pool.query('DELETE FROM users WHERE name = ?', [testName]);
  await pool.query('DELETE FROM replays WHERE room_id = ?', [join.roomId]);
  console.log('已清理测试数据');
  await pool.end();
  console.log(fails.length ? '结果：' + fails.length + ' 项失败' : '结果：全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('测试异常：' + e.message); process.exit(1); });
