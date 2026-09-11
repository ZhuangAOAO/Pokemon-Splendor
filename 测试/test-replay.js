'use strict';
/* ================================================================
   回放功能端到端测试（本地）：
   1. 管理员登录 → 后门注册一次性测试账号
   2. 测试账号开房（+1 个简单电脑，15 分）→ 机器人代打自己的回合
   3. 对局结束 → 服务器把回放写入 replays 表
   4. 拉取回放 → Node 无头重放全部行动 → 终局状态与存档完全一致
   5. 清理测试账号 / 战绩 / 回放记录
   用法：在项目根目录运行 node 测试/test-replay.js（需先启动 node server.js）
   ================================================================ */
const BASE = 'http://localhost:3000';
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const ADMIN = require('./凭证');

global.window = global;
require(path.join(__dirname, '..', 'config.js'));
const core = require(path.join(__dirname, '..', 'game-core.js'));

const fails = [];
const ok = (c, n) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n); if (!c) fails.push(n); };
async function post(obj) {
  const r = await fetch(BASE + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = require(path.join(__dirname, '..', 'data', 'db.json'));
  const pool = mysql.createPool(Object.assign({}, db, { waitForConnections: true }));
  const testName = '回放测试' + Math.floor(Math.random() * 900 + 100);
  const testPass = crypto.randomBytes(8).toString('hex');

  // 1. 管理员登录
  const admin = await post({ type: 'login', name: ADMIN.name, password: ADMIN.password });
  ok(admin.ok && admin.role === 'admin', '管理员登录');
  if (!admin.ok) { console.log('  登录失败：' + (admin.msg || '')); process.exit(1); }

  // 2. 创建一次性测试账号
  const bk = await post({ type: 'backdoorRegister', token: admin.token, name: testName, password: testPass, remark: '回放测试' });
  ok(bk.ok, '后门注册测试账号');
  const login = await post({ type: 'login', name: testName, password: testPass });
  ok(login.ok, '测试账号登录');

  // 3. 开房：测试账号 + 1 个简单电脑，15 分
  const join = await post({ type: 'join', token: login.token, roomId: '', isPublic: false });
  ok(join.ok, '创建房间（' + join.roomId + '）');

  // 4. 先连 SSE（服务器要求连接就绪后才受理房间指令），再设电脑并开局
  let state = null, over = false, inFlight = false, botActs = 0;
  const es = await fetch(BASE + '/events?cid=' + join.cid);
  const reader = es.body.getReader();
  const setAis = await post({ type: 'setAIs', cid: join.cid, ais: [{ name: '小智', level: 'easy' }] });
  ok(setAis.ok, '添加电脑小智（' + (setAis.msg || '') + '）');
  await post({ type: 'setTarget', cid: join.cid, target: 15 });
  const start = await post({ type: 'start', cid: join.cid });
  ok(start.ok, '开始对局（' + (start.msg || '') + '）');
  let buf = '';
  const decoder = new TextDecoder();
  (async () => {
    while (!over) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const m = JSON.parse(line.slice(6));
        if (m.type === 'state') { state = m; onState(); }
      }
    }
  })();

  // 单一驱动：广播与响应只负责"调度"，实际行动由去抖的 tick 串行发起，杜绝双发
  let pendingTick = false;
  function scheduleTick() {
    if (pendingTick) return;
    pendingTick = true;
    setTimeout(() => { pendingTick = false; botStep(); }, 150);
  }
  function onState() {
    const g = state && state.game;
    if (!g) return;
    if (g.over) { over = true; return; }
    if (g.current === state.you.seat) scheduleTick();
    else inFlight = false; // 回合已推进：行动成功
  }
  function botStep() {
    const g = state.game;
    if (!g || g.over || g.current !== state.you.seat || inFlight) return;
    inFlight = true;
    const action = buildAction(g);
    post({ type: 'action', cid: join.cid, action }).then((j) => {
      if (j.ok) {
        botActs++;
        inFlight = false;
        scheduleTick(); // 退球链等同回合连续行动；广播到达也会调度，这里去抖兜底
      } else {
        console.log('  机器人行动被拒：' + j.msg);
        inFlight = false;
        setTimeout(botStep, 1200);
      }
    });
  }
  function buildAction(g) {
    const sess = core.createSession();
    sess.S = JSON.parse(JSON.stringify(g));
    const p = sess.S.players[sess.S.current];
    if (g.phase === 'discard') {
      const c = ['red', 'blue', 'black', 'pink', 'yellow'].find((x) => p.balls[x] > 0) || 'master';
      return { kind: 'discard', color: c };
    }
    if (g.phase === 'evolve') return { kind: 'skipEvolve' };
    const buyable = [];
    [1, 2, 3, 4, 5].forEach((t) => g.market[t].forEach((c, idx) => {
      if (c && sess.canAfford(p, c)) buyable.push({ tier: t, idx, vp: c.vp });
    }));
    if (buyable.length) {
      const b = buyable.sort((x, y) => y.vp - x.vp)[0];
      return { kind: 'buy', tier: b.tier, idx: b.idx };
    }
    if (p.reserved.length < 3) {
      for (const t of [3, 2, 1]) {
        for (let idx = 0; idx < g.market[t].length; idx++) {
          if (g.market[t][idx]) return { kind: 'reserve', tier: t, idx };
        }
      }
    }
    const avail = ['red', 'blue', 'black', 'pink', 'yellow'].filter((c) => g.pool[c] > 0);
    if (avail.length) return { kind: 'take3', colors: avail.slice(0, Math.min(3, avail.length)) };
    return { kind: 'return', color: 'master' };
  }

  // 5. 等待终局落库（最多 2 分钟）
  let replayId = null;
  for (let i = 0; i < 80 && !over && !replayId; i++) {
    await sleep(1500);
    if (!over) continue; // 对局还没结束
    const j = await post({ type: 'replayList', token: login.token });
    const hit = (j.list || []).find((r) => r.roomId === join.roomId);
    if (hit) replayId = hit.id;
  }
  ok(over, '对局正常结束（机器人行动 ' + botActs + ' 次）');
  ok(!!replayId, '回放已入库（id=' + (replayId || '未找到') + '）');

  // 6. 拉取回放 + 无头重放比对
  if (replayId) {
    const j = await post({ type: 'replay', token: login.token, id: replayId });
    ok(j.ok, '拉取回放数据');
    const rp = j.replay;
    ok(rp.actions.length > 0, '行动记录 ' + rp.actions.length + ' 步');
    const sess = core.createSession();
    sess.S = JSON.parse(JSON.stringify(rp.initial)); // 深拷贝：重放会改动状态，别污染原快照
    sess.S.replay = true; // 禁用电脑定时器（重放由记录驱动）
    const APPLY = {
      take3: (p) => sess.actTakeThree(p.colors), take2: (p) => sess.actTakeTwo(p.color),
      return: (p) => sess.actReturnBall(p.color), discard: (p) => sess.actDiscardOne(p.color),
      takeMaster: () => sess.actTakeMaster(), reserve: (p) => sess.actReserve(p.tier, p.idx),
      reserveBlind: (p) => sess.actReserveBlind(p.tier), buy: (p) => sess.actBuy(p.tier, p.idx),
      buyReserved: (p) => sess.actBuyReserved(p.ridx), evolve: (p) => sess.actEvolve(p.loc),
      skipEvolve: () => sess.actSkipEvolve(), skip: () => sess.afterActionDone(),
    };
    let crash = null;
    try { for (const a of rp.actions) APPLY[a.k](a.p); } catch (e) { crash = e; }
    ok(!crash, '无头重放无异常' + (crash ? '：' + crash.message : ''));
    ok(sess.S.over === true, '重放结束对局完成');
    const rank = sess.S.players.slice().sort((a, b) => (b.points - a.points) || (b.evolutions - a.evolutions));
    ok(rank[0].points >= 15, '胜者达到目标分（' + rank[0].points + ' 分）');
    delete sess.S.replay;
    const same = JSON.stringify(sess.S) === JSON.stringify(rp.final);
    ok(same, '重放终局状态与存档完全一致');
    if (!same) {
      const sa = JSON.stringify(sess.S), sb = JSON.stringify(rp.final);
      let i = 0;
      while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
      console.log('  首个差异位置 ' + i + '：A=…' + sa.slice(Math.max(0, i - 50), i + 50) + '…  B=…' + sb.slice(Math.max(0, i - 50), i + 50) + '…');
    }
  }

  // 7. 清理测试数据
  const [rows] = await pool.query('SELECT id FROM replays WHERE room_id = ?', [join.roomId]);
  for (const r of rows) await pool.query('DELETE FROM replays WHERE id = ?', [r.id]);
  await pool.query('DELETE FROM stats WHERE account = ?', [testName]);
  await pool.query('DELETE FROM users WHERE name = ?', [testName]);
  console.log('已清理测试数据（账号 / 战绩 / 回放 ' + rows.length + ' 条）');
  await pool.end();
  console.log(fails.length ? '结果：' + fails.length + ' 项失败' : '结果：全部通过');
  process.exit(fails.length ? 1 : 0);
})();
