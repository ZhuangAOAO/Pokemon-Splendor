'use strict';
/* ================================================================
   幽灵房回归测试：全员退出后，房间必须从公开列表消失，且同名可重进。
   场景 1：大厅阶段退出 → 房间消失
   场景 2：对局中全员离线 → 60 秒内可重连，超时后房间消失
   场景 3：同名玩家可重新创建房间（名字没被幽灵房占用）
   用法：先启动 node 测试/server-test.js（监听 3210），再运行 node 测试/test-ghostroom.js
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

(async () => {
  // 走统一入口：环境变量优先，其次 data/db.json（见 db-config.js）
const db = require(path.join(__dirname, '..', 'db-config.js'))();
  const pool = mysql.createPool(Object.assign({}, db, { waitForConnections: true }));
  const testName = '幽灵房测试' + Math.floor(Math.random() * 900 + 100);
  const testPass = crypto.randomBytes(8).toString('hex');

  const admin = await post({ type: 'login', name: ADMIN.name, password: ADMIN.password });
  ok(admin.ok, '管理员登录');
  if (!admin.ok) process.exit(1);
  await post({ type: 'backdoorRegister', token: admin.token, name: testName, password: testPass, remark: '幽灵房测试' });
  const login = await post({ type: 'login', name: testName, password: testPass });
  ok(login.ok, '测试账号登录');

  // 场景 1：大厅阶段直接退出 → 房间从列表消失
  const join1 = await post({ type: 'join', token: login.token, roomId: '', isPublic: true });
  ok(join1.ok, '创建公开房间（大厅）' + join1.roomId);
  const es1 = await fetch(BASE + '/events?cid=' + join1.cid);
  await sleep(400);
  await es1.body.cancel(); // 关页面 = 断开 SSE
  await sleep(900);
  let rooms = (await post({ type: 'listRooms' })).rooms;
  ok(!rooms.some((r) => r.id === join1.roomId), '场景1：大厅退出后房间从公开列表消失');

  // 场景 2：对局进行中全员离线 → 宽限期可重连，超时后房间消失
  const join2 = await post({ type: 'join', token: login.token, roomId: '', isPublic: true });
  const es2 = await fetch(BASE + '/events?cid=' + join2.cid);
  await sleep(300);
  await post({ type: 'setAIs', cid: join2.cid, ais: [{ name: '小智', level: 'easy' }] });
  const start = await post({ type: 'start', cid: join2.cid });
  ok(start.ok, '开始对局（' + join2.roomId + '）');
  await es2.body.cancel(); // 唯一的人类玩家离线
  await sleep(1500);
  const rejoin = await post({ type: 'join', token: login.token, roomId: join2.roomId, isPublic: true });
  ok(rejoin.ok, '场景2：宽限期内仍可重连原房间');
  if (rejoin.ok) {
    const es2b = await fetch(BASE + '/events?cid=' + rejoin.cid);
    await sleep(300);
    await es2b.body.cancel();
  }
  await sleep(61000);
  const expired = await post({ type: 'join', token: login.token, roomId: join2.roomId, isPublic: true });
  ok(!expired.ok, '场景2：全员离线超时后房间已解散');
  const [[statsCount]] = await pool.query('SELECT COUNT(*) AS n FROM stats WHERE account = ?', [testName]);
  ok(statsCount.n === 0, '场景2：未完成的离线对局不计入战绩');

  // 场景 3：同名玩家可重新创建房间
  const join3 = await post({ type: 'join', token: login.token, roomId: '', isPublic: true });
  ok(join3.ok, '场景3：同名玩家可重新创建房间（' + (join3.msg || '') + '）');
  if (join3.ok) {
    const es3 = await fetch(BASE + '/events?cid=' + join3.cid);
    await es3.body.cancel();
  }

  // 清理
  await pool.query('DELETE FROM stats WHERE account = ?', [testName]);
  await pool.query('DELETE FROM users WHERE name = ?', [testName]);
  console.log('已清理测试账号');
  await pool.end();
  console.log(fails.length ? '结果：' + fails.length + ' 项失败' : '结果：全部通过');
  process.exit(fails.length ? 1 : 0);
})();
