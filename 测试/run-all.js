'use strict';
/* ================================================================
   一键回归：npm test
   ── 设计原则：**不需要服务器的自检永远跑**；需要服务器的回归**先探测服务器**，
      探测不到就明确跳过（算跳过，不算失败）——否则换台机器没起服务器就一片红，人会开始忽略测试。
   ── 约定：每个脚本独立可运行，退出码 0 = 通过，非 0 = 失败。
   ── 新增联机测试时，把文件名加进下面的 ONLINE（别靠命名魔法，写清楚更好读）。
   ================================================================ */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const DIR = __dirname;
const ONLINE = new Set([
  'e2e-test.js', 'test-replay.js', 'test-reconnect.js',
  'test-ghostroom.js', 'test-namedup.js', 'test-leaderboard.js',
  'test-app-info.js',
]);

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

function run(relFile, args, label) {
  process.stdout.write('▶ ' + label + ' … ');
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, relFile), ...(args || [])], {
      cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 20 * 60 * 1000,
    });
    console.log('通过');
    return { ok: true, out };
  } catch (e) {
    console.log('失败');
    const text = String(e.stdout || '') + String(e.stderr || '');
    if (text.trim()) console.log(text.trim().split('\n').map((l) => '    ' + l).join('\n'));
    return { ok: false, out: text };
  }
}

// 端口从 config.js 里读，避免和 config 漂移（正则读，不 eval）
function configuredPort() {
  try {
    const m = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8').match(/port\s*:\s*(\d+)/);
    return m ? +m[1] : 3000;
  } catch (e) { return 3000; }
}

// 各联机测试有两种运行方式：日常服务器走 3000，隔离测试服务器走 3210。
// 从脚本自己的 BASE 读取端口，逐项探测；不能因为 3000 在线，就误把未启动的 3210 测试跑成失败。
function testPort(file, fallback) {
  try {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    const m = text.match(/localhost:(\d+)/);
    return m ? +m[1] : fallback;
  } catch (e) { return fallback; }
}

(async () => {
  let pass = 0, fail = 0, skip = 0;

  console.log('— 离线自检（不需要服务器）—');
  const OFFLINE = [
    ['测试/test-tutorial.js', [], '新手教程状态机（三步、AI 回合、退出重进）'],
    ['工具/rl/seed-demo.js', ['42'], '工具/rl/seed-demo.js 42（种子可复现性）'],
    // 冒烟跑：显式 --no-ledger，免得每次 npm test 都往 实验台账.md 刷一行
    ['工具/sim.js', ['30', '3', '18', '--no-ledger'], '工具/sim.js 30 3 18（规则守恒 + 平衡性冒烟）'],
  ];
  for (const [file, args, label] of OFFLINE) {
    if (!fs.existsSync(path.join(ROOT, file))) { console.log('▶ ' + label + ' … 跳过（文件不存在）'); skip++; continue; }
    run(file, args, label).ok ? pass++ : fail++;
  }

  console.log('');
  console.log('— 联机回归（需要本地 server.js）—');
  const port = configuredPort();
  const onlineFiles = fs.readdirSync(DIR).filter((f) => ONLINE.has(f)).sort();
  const portStates = new Map();
  for (const f of onlineFiles) {
    const p = testPort(f, port);
    if (!portStates.has(p)) portStates.set(p, await portOpen(p));
    if (!portStates.get(p)) {
      console.log('▶ ' + f + ' … 跳过（未检测到 127.0.0.1:' + p + '）');
      skip++;
      continue;
    }
    run('测试/' + f, [], f).ok ? pass++ : fail++;
  }
  if ([...portStates.values()].every((v) => !v))
    console.log('要跑日常联机测试：另开一个终端 `node server.js`，再重新 `npm test`。');

  console.log('');
  console.log(fail
    ? fail + ' 个失败（通过 ' + pass + '，跳过 ' + skip + '）'
    : '全部通过（' + pass + ' 个，跳过 ' + skip + '）');
  process.exit(fail ? 1 : 0);
})();
