'use strict';
/* ================================================================
   数据库连接信息「唯一入口」——server.js / 工具 / 测试 都用它，
   不要再各自去读 data/db.json（那样密钥会跟着文件夹到处跑）。

   优先级（后面的覆盖前面的）：
     默认值  <  data/db.json  <  环境变量（推荐）
   环境变量：SPLENDOR_DB_HOST / SPLENDOR_DB_PORT / SPLENDOR_DB_USER /
             SPLENDOR_DB_PASSWORD / SPLENDOR_DB_NAME

   为什么优先环境变量：**只要一个文件会跟着项目走，里面就不能有明文密钥**。
   放在环境变量里，整个文件夹拷给别人也不会泄露。
   示例见根目录 db.example.json 与 README 的「密钥管理」。
   ================================================================ */
const fs = require('fs');
const path = require('path');

const DEFAULTS = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'splendor' };

function fromEnv(env) {
  const c = {};
  if (env.SPLENDOR_DB_HOST) c.host = env.SPLENDOR_DB_HOST;
  if (env.SPLENDOR_DB_PORT) c.port = Number(env.SPLENDOR_DB_PORT);
  if (env.SPLENDOR_DB_USER) c.user = env.SPLENDOR_DB_USER;
  // 空串视为「没设」，避免把空密码误当成真实密码
  if (env.SPLENDOR_DB_PASSWORD) c.password = env.SPLENDOR_DB_PASSWORD;
  if (env.SPLENDOR_DB_NAME) c.database = env.SPLENDOR_DB_NAME;
  return c;
}

function fromFile(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));
  } catch (e) { return {}; }
}

function loadDbConfig(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const root = o.root || __dirname;
  return Object.assign({}, DEFAULTS, fromFile(root), fromEnv(env), o.extra || {});
}

module.exports = loadDbConfig;
module.exports.loadDbConfig = loadDbConfig;
