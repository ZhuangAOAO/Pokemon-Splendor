'use strict';

/* ================================================================
   卡牌数值录入工具服务器
   用法：node 录入工具.js
   然后浏览器打开 http://localhost:3100
   · 显示每张卡的大图 + 输入框（分 / 红蓝黑粉黄费用 / 加成色）
   · 「保存」把数值写回 config.js 的卡牌表（只改卡牌表，其余不动）
   · 「模拟验证」运行 AI 对战模拟，检查平衡性和死锁
   ================================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = 3100;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

/* ---------- 读取 / 写入 config.js 的卡牌表 ---------- */
function readTable() {
  delete require.cache[require.resolve('./config.js')];
  require('./config.js');
  return global.CARD_TABLE.map((r) => ({
    name: r[0], tier: r[1], vp: r[2],
    cost: { red: r[3], blue: r[4], black: r[5], pink: r[6], yellow: r[7] },
    bonus: r[8],
  }));
}
function writeTable(rows) {
  const src = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
  const start = src.indexOf('window.CARD_TABLE = [');
  const end = src.indexOf('];', start) + 2;
  if (start < 0 || end < 0) return { ok: false, msg: 'config.js 里找不到卡牌表' };
  const byTier = { 1: 0, 2: 0, 3: 0 };
  rows.forEach((r) => { byTier[r.tier] = (byTier[r.tier] || 0) + 1; });
  let body = `window.CARD_TABLE = [\n  // —— 已按名字拼音排序（一阶 ${byTier[1]} / 二阶 ${byTier[2]} / 三阶 ${byTier[3]}，共 ${rows.length} 张）——\n`;
  rows.forEach((r) => {
    const costTotal = r.cost.red + r.cost.blue + r.cost.black + r.cost.pink + r.cost.yellow;
    body += `  ['${r.name}', ${r.tier}, ${r.vp}, ${r.cost.red}, ${r.cost.blue}, ${r.cost.black}, ${r.cost.pink}, ${r.cost.yellow}, '${r.bonus}'], // ${r.vp}分·费${costTotal}\n`;
  });
  body += '];';
  fs.writeFileSync(path.join(ROOT, 'config.js'), src.slice(0, start) + body + src.slice(end), 'utf8');
  return { ok: true };
}
function validRows(rows, oldRows) {
  if (!Array.isArray(rows) || rows.length !== oldRows.length) return '卡牌数量不对（应为 ' + oldRows.length + ' 张）';
  const COLORS = ['red', 'blue', 'black', 'pink', 'yellow'];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], o = oldRows[i];
    if (!r || typeof r !== 'object') return `第 ${i + 1} 行格式错误`;
    if (r.name !== o.name) return `第 ${i + 1} 行（${o.name}）名字被改动，拒绝保存（名字和图片是一一对应的）`;
    if (![1, 2, 3].includes(r.tier)) return `第 ${i + 1} 行（${o.name}）阶层无效：只能是 1/2/3`;
    if (!Number.isInteger(r.vp) || r.vp < 0 || r.vp > 10) return `第 ${i + 1} 行（${o.name}）分数无效（0~10 的整数）`;
    for (const c of COLORS) {
      if (!Number.isInteger(r.cost[c]) || r.cost[c] < 0 || r.cost[c] > 10) return `第 ${i + 1} 行（${o.name}）${c} 费用无效（0~10 的整数）`;
    }
    if (!COLORS.includes(r.bonus)) return `第 ${i + 1} 行（${o.name}）加成色无效`;
  }
  return null;
}

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/load' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(readTable()));
  }
  if (u.pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 500000) req.destroy(); });
    req.on('end', () => {
      let obj = null;
      try { obj = JSON.parse(body || '{}'); } catch (e) { /* 忽略 */ }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (!obj || !Array.isArray(obj.rows)) return res.end(JSON.stringify({ ok: false, msg: '请求格式错误' }));
      const oldRows = readTable();
      const err = validRows(obj.rows, oldRows);
      if (err) return res.end(JSON.stringify({ ok: false, msg: err }));
      const w = writeTable(obj.rows);
      return res.end(JSON.stringify(w.ok ? { ok: true, count: obj.rows.length } : w));
    });
    return;
  }
  if (u.pathname === '/api/verify' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    execFile('node', [path.join(ROOT, 'sim.js'), '30', '3', '18'], { cwd: ROOT, timeout: 180000 }, (err, stdout, stderr) => {
      res.end(JSON.stringify({ ok: !err, output: (stdout || '') + (stderr || '') + (err ? '验证失败：' + err.message : '') }));
    });
    return;
  }
  // 静态文件（先解码 URL，中文文件名才能对得上磁盘）
  let file;
  try { file = u.pathname === '/' ? '/录入工具.html' : decodeURIComponent(u.pathname); }
  catch (e) { res.writeHead(400); return res.end(); }
  const full = path.join(ROOT, path.normalize('/' + file));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('════════════════════════════════════════');
  console.log('  卡牌数值录入工具已启动！');
  console.log('  浏览器打开：http://localhost:' + PORT);
  console.log('  填完点「保存」，再点「模拟验证」检查平衡');
  console.log('  按 Ctrl+C 停止');
  console.log('════════════════════════════════════════');
});
