'use strict';
/* ================================================================
   测试用管理员凭据加载器（本文件不含密码，可以进版本库）
   密码放在同目录的「凭证.json」里，该文件已被 .gitignore 排除，不会提交。

   首次使用请新建 测试/凭证.json，内容：
     { "name": "管理员用户名", "password": "管理员密码" }
   ================================================================ */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '凭证.json');
if (!fs.existsSync(FILE)) {
  console.error('缺少「测试/凭证.json」——请在 测试/ 目录下新建它，内容：');
  console.error('  { "name": "管理员用户名", "password": "管理员密码" }');
  process.exit(1);
}
let c = {};
try { c = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  console.error('「测试/凭证.json」格式不对（应为 JSON）：' + e.message);
  process.exit(1);
}
if (!c.name || !c.password) {
  console.error('「测试/凭证.json」里必须同时有 name 和 password 两个字段');
  process.exit(1);
}
module.exports = { name: String(c.name), password: String(c.password) };
