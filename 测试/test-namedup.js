'use strict';
/* ================================================================
   姓名重复审核提醒测试（本地 3210 端口测试服务器，在项目根目录运行 node 测试/test-namedup.js）：
   1. 用同一个真实姓名注册两个不同账号
   2. adminList 应给两个账号都返回 dupWith（互相指向）
   3. account.log 应有提醒行
   4. 清理两个待审核账号
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
  const db = require(path.join(__dirname, '..', 'data', 'db.json'));
  const pool = mysql.createPool(Object.assign({}, db, { waitForConnections: true }));
  const dupName = '同名测试' + Math.floor(Math.random() * 9000 + 1000);
  const acc1 = '同名甲' + Math.floor(Math.random() * 900 + 100);
  const acc2 = '同名乙' + Math.floor(Math.random() * 900 + 100);
  const pass = crypto.randomBytes(8).toString('hex');

  // 1. 两个账号用同一个真实姓名注册
  const r1 = await post({ type: 'register', name: acc1, password: pass, realName: dupName, gradYear: '2023' });
  ok(r1.ok, '账号1 注册（' + acc1 + ' / ' + dupName + '）');
  const r2 = await post({ type: 'register', name: acc2, password: pass, realName: dupName, gradYear: '2023' });
  ok(r2.ok, '账号2 注册（' + acc2 + ' / ' + dupName + '）');

  // 2. 管理员列表应互相标记 dupWith
  const admin = await post({ type: 'login', name: ADMIN.name, password: ADMIN.password });
  const list = await post({ type: 'adminList', token: admin.token });
  ok(list.ok, '拉取审核列表');
  const u1 = (list.users || []).find((u) => u.name === acc1);
  const u2 = (list.users || []).find((u) => u.name === acc2);
  ok(!!u1 && u1.dupWith.includes(acc2), '账号1 标记姓名重复（指向 ' + ((u1 && u1.dupWith) || '无') + '）');
  ok(!!u2 && u2.dupWith.includes(acc1), '账号2 标记姓名重复（指向 ' + ((u2 && u2.dupWith) || '无') + '）');
  // 没有同名者的账号不应误标（接口只返回非管理员账号，用普通账号验证）
  const normal = (list.users || []).find((u) => u.name === '17825677147');
  ok(normal && !normal.dupWith, '无同名者的账号不误标');

  // 3. account.log 有提醒行
  try {
    const fs = require('fs');
    const logText = fs.readFileSync(path.join(__dirname, '..', 'logs', 'account.log'), 'utf8').split('\n').slice(-5).join('\n');
    ok(logText.includes('注意：姓名 ' + dupName), 'account.log 含姓名重复提醒行');
  } catch (e) { ok(false, 'account.log 检查失败：' + e.message); }

  // 4. 清理
  await pool.query('DELETE FROM users WHERE name IN (?, ?)', [acc1, acc2]);
  console.log('已清理测试账号');
  await pool.end();
  console.log(fails.length ? '结果：' + fails.length + ' 项失败' : '结果：全部通过');
  process.exit(fails.length ? 1 : 0);
})();
