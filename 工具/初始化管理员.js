'use strict';

/* ================================================================
   初始化管理员账号（写入 MySQL）
   用法：node 工具/初始化管理员.js 用户名 密码（在项目根目录运行）
   例：  node 工具/初始化管理员.js admin mypass123
   数据库连接信息读取 data/db.json（与 server.js 相同），
   格式：{ "host": "127.0.0.1", "port": 3306, "user": "root", "password": "密码", "database": "splendor" }
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

// 读取全局配置 + 连接信息（统一入口：环境变量 > data/db.json）
global.window = global;
require('../config.js');
const dbConfig = Object.assign({}, global.MYSQL || {}, require('../db-config.js')());

const mysql = require('mysql2/promise');

(async () => {
  let pool = null;
  try {
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
    const [rows] = await pool.query('SELECT id FROM users WHERE name = ? LIMIT 1', [name]);
    if (rows.length) {
      console.log('该用户名已存在。如需重置密码，请用管理员在数据库里操作或联系开发者。');
      await pool.end();
      process.exit(1);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query(
      'INSERT INTO users (name, salt, hash, role, status, welcomed, created_at) VALUES (?,?,?,?,?,?,?)',
      [name, salt, crypto.scryptSync(password, salt, 64).toString('hex'), 'admin', 'approved', 1, new Date().toISOString().slice(0, 10)]);
    console.log('管理员账号已创建：' + name);
    console.log('现在可以启动服务器，用这个账号访问 /admin 进行审核。');
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('MySQL 连接失败：' + e.message);
    console.error('请在 data/db.json 里配置正确的连接信息：');
    console.error('{ "host": "127.0.0.1", "port": 3306, "user": "root", "password": "你的密码", "database": "splendor" }');
    if (pool) await pool.end().catch(() => {});
    process.exit(1);
  }
})();
