'use strict';

/* ================================================================
   初始化管理员账号
   用法：node 初始化管理员.js 用户名 密码
   例：  node 初始化管理员.js admin mypass123
   账号数据保存在 data/users.json（密码加密存储，不保存明文）
   ================================================================ */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const name = (args[0] || '').trim();
const password = args[1];

if (name.length < 2 || name.length > 12) {
  console.log('用户名需 2~12 个字符。用法: node 初始化管理员.js 用户名 密码');
  process.exit(1);
}
if (!password || password.length < 6) {
  console.log('密码至少 6 位。用法: node 初始化管理员.js 用户名 密码');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'users.json');

let db = { users: [] };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* 首次运行 */ }

if (db.users.some((u) => u.name === name)) {
  console.log('该用户名已存在。如需重置密码，请手动编辑 data/users.json。');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
db.users.push({
  name,
  salt,
  hash: crypto.scryptSync(password, salt, 64).toString('hex'),
  role: 'admin',
  status: 'approved',
  welcomed: true,
  createdAt: new Date().toISOString().slice(0, 10),
});

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
console.log('管理员账号已创建：' + name);
console.log('现在可以启动服务器，用这个账号登录 ' + __dirname + '/admin.html 进行审核。');
