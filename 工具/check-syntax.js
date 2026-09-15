'use strict';
/* 语法检查：对项目里所有 .js 跑 node --check。
   用法：npm run check（或 node 工具/check-syntax.js）
   注：抄自 工程资产库/50 模板/项目模板/工具/check-syntax.js */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'pictures', '素材', '日志', 'logs', '数据', 'data', '.claude']);

let total = 0, bad = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p);
    } else if (e.name.endsWith('.js')) {
      total++;
      try {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe', encoding: 'utf8' });
      } catch (err) {
        bad++;
        console.log('✗ ' + path.relative(ROOT, p));
        console.log('    ' + String(err.stderr || '').trim());
      }
    }
  }
})(ROOT);

console.log(bad ? `${bad} / ${total} 个文件有语法错误` : `语法正常（${total} 个文件）`);
process.exit(bad ? 1 : 0);
