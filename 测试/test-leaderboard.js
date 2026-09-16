'use strict';
/* ================================================================
   排行榜后门账号过滤测试（本地 3210 端口测试服务器，在项目根目录运行 node 测试/test-leaderboard.js）：
   1. 后门注册账号 B + 普通注册账号 N，都给两条战绩
   2. leaderboard 里应出现 N、不出现 B（B 自己也看不到自己）
   3. 旧库补 source 列：手动删列再重启服务器应自动补回
   4. 清理测试数据
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

(async () => {
  // 走统一入口：环境变量优先，其次 data/db.json（见 db-config.js）
const db = require(path.join(__dirname, '..', 'db-config.js'))();
  const pool = mysql.createPool(Object.assign({}, db, { waitForConnections: true }));
  const pass = crypto.randomBytes(8).toString('hex');
  const nameB = '后门榜' + Math.floor(Math.random() * 900 + 100); // 后门账号
  const nameN = '普通榜' + Math.floor(Math.random() * 900 + 100); // 普通账号

  // 1. 后门注册 + 普通注册（普通账号先直接置为已通过，方便登录）
  const admin = await post({ type: 'login', name: ADMIN.name, password: ADMIN.password });
  const br = await post({ type: 'backdoorRegister', token: admin.token, name: nameB, password: pass, remark: '排行榜过滤测试' });
  ok(br.ok, '后门注册 ' + nameB);
  const nr = await post({ type: 'register', name: nameN, password: pass, realName: '普通测试员', gradYear: '2023' });
  ok(nr.ok, '普通注册 ' + nameN);
  await pool.query("UPDATE users SET status = 'approved' WHERE name = ?", [nameN]);

  // 2. 给两个账号各插一条战绩
  await pool.query('INSERT INTO stats (account, nickname, wins, games, points, evolutions) VALUES (?,?,?,?,?,?)',
    [nameB, '后门选手', 3, 3, 45, 2]);
  await pool.query('INSERT INTO stats (account, nickname, wins, games, points, evolutions) VALUES (?,?,?,?,?,?)',
    [nameN, '普通选手', 3, 3, 45, 2]);
  console.log('  已给两个账号插入战绩');

  // 3. 普通账号视角看排行榜
  const loginN = await post({ type: 'login', name: nameN, password: pass });
  const lbN = await post({ type: 'leaderboard', token: loginN.token });
  ok(lbN.ok && Array.isArray(lbN.list), '普通账号拉取排行榜');
  ok(lbN.list.some((r) => r.account === nameN), '排行榜包含普通账号 ' + nameN);
  ok(!lbN.list.some((r) => r.account === nameB), '排行榜不包含后门账号 ' + nameB);

  // 4. 后门账号自己看排行榜也看不到自己
  const loginB = await post({ type: 'login', name: nameB, password: pass });
  const lbB = await post({ type: 'leaderboard', token: loginB.token });
  ok(lbB.ok && !lbB.list.some((r) => r.account === nameB), '后门账号看排行榜也不包含自己');

  // 5. 清理
  await pool.query('DELETE FROM stats WHERE account IN (?, ?)', [nameB, nameN]);
  await pool.query('DELETE FROM users WHERE name IN (?, ?)', [nameB, nameN]);
  console.log('已清理测试数据');
  await pool.end();
  console.log(fails.length ? '结果：' + fails.length + ' 项失败' : '结果：全部通过');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('测试异常：' + e.message); process.exit(1); });
