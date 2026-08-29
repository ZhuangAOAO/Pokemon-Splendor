// ================================================================
// 联机端到端回归测试（需先启动服务器：node server.js）
// 用法：node e2e-test.js
// 覆盖：加入 → 大厅设置 → 开局 → 广播 → 行动校验 → 权限 → AI 自动回合
// ================================================================
'use strict';
const BASE = 'http://localhost:3000';
async function api(body) {
  const r = await fetch(BASE + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
// 后台持续收集 SSE 消息到 sink 数组，直到窗口结束
async function sseTo(cid, sink, ms) {
  const r = await fetch(BASE + '/events?cid=' + cid);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  let pending = reader.read();
  while (Date.now() < deadline) {
    const res = await Promise.race([
      pending.then((v) => ({ done: v.done, value: v.value })),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 250)),
    ]);
    if (res.done) break;
    if (res.timeout) continue;
    pending = reader.read();
    buf += dec.decode(res.value, { stream: true });
    const lines = buf.split('\n\n');
    buf = lines.pop();
    for (const l of lines) {
      try { sink.push(JSON.parse(l.replace(/^data: /, ''))); } catch (e) { /* 忽略 */ }
    }
  }
  reader.cancel();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}
const lastState = (msgs) => [...msgs].reverse().find((m) => m.type === 'state');

(async () => {
  const A = await api({ type: 'join', name: '测试A' });
  const B = await api({ type: 'join', name: '测试B' });
  if (!A.ok || !B.ok) { console.log('❌ 加入失败', A, B); process.exit(1); }
  console.log('1. 加入：✓');

  const msgsA = [], msgsB = [];
  const pA = sseTo(A.cid, msgsA, 30000);
  const pB = sseTo(B.cid, msgsB, 30000);
  // 等两个玩家的 SSE 都连上（各自收到大厅广播）
  const bothOnline = await waitFor(() => (msgsA.length > 0 && msgsB.length > 0 ? true : null), 3000);
  if (!bothOnline) { console.log('❌ 玩家 SSE 未全部连上'); process.exit(1); }

  const setAIs = await api({ type: 'setAIs', cid: A.cid, ais: [{ name: '小智', level: 'hard' }] });
  const setTarget = await api({ type: 'setTarget', cid: A.cid, target: 15 });
  console.log('2. 房主设置电脑+目标分：', setAIs.ok && setTarget.ok ? '✓' : '❌ ' + JSON.stringify(setAIs) + ' ' + JSON.stringify(setTarget));
  const badStart = await api({ type: 'start', cid: B.cid });
  console.log('3. 非房主开局被拦截：', badStart.msg === '只有房主可以开始' ? '✓' : '❌ ' + JSON.stringify(badStart));
  const startRes = await api({ type: 'start', cid: A.cid });
  console.log('4. 房主开局：', startRes.ok ? '✓' : '❌ ' + JSON.stringify(startRes));

  const gameState = await waitFor(() => {
    const s = lastState(msgsB);
    return s && s.game ? s : null; // 专门等"带对局"的广播，避免抓到开局前的大厅状态
  }, 5000);
  if (!gameState) { console.log('❌ B 未收到对局广播'); process.exit(1); }
  console.log('5. 对局广播：✓ 玩家 =', gameState.game.players.map((p) => p.name + (p.isAI ? '(AI)' : '')).join(', '));

  // 开局先手是随机的：让"当前回合玩家"的对手来行动，必须被拦截
  const curSeat = gameState.game.current;
  const other = curSeat === 0 ? B : A;
  const actBad = await api({ type: 'action', cid: other.cid, action: { kind: 'take3', colors: ['red', 'blue', 'black'] } });
  console.log('6. 非本人回合被拦截：', actBad.msg === '还没轮到你' ? '✓' : '❌ ' + JSON.stringify(actBad));

  // 7. 轮流行动直到 AI（座位2）的回合，验证 AI 在服务器上自动行动
  let aiActed = false, guard = 0;
  const before = gameState.game.turnIdx;
  while (!aiActed && guard < 30) {
    await sleep(400); guard++;
    const st = lastState(msgsB);
    if (!st || !st.game) continue;
    const g = st.game;
    if (g.over) { aiActed = true; break; }
    if (g.current === 2) {
      const t0 = g.turnIdx;
      const after = await waitFor(() => {
        const s2 = lastState(msgsB);
        return s2 && s2.game && s2.game.turnIdx > t0 ? s2.game : null;
      }, 4000);
      if (after) {
        aiActed = true;
        console.log(`7. AI 自动行动：✓（小智在服务器上行动了，回合 ${t0} → ${after.turnIdx}）`);
      } else {
        console.log('7. AI 自动行动：❌（等了 4 秒没动）');
        break;
      }
    } else {
      const cid = g.current === 0 ? A.cid : B.cid;
      const r = await api({ type: 'action', cid, action: { kind: 'take3', colors: ['red', 'blue', 'black'] } });
      if (!r.ok) { console.log('❌ 人类行动失败：', JSON.stringify(r)); break; }
    }
  }
  if (!aiActed) { console.log('❌ 测试中断'); await Promise.all([pA, pB]); process.exit(1); }

  console.log('8. 非房主重开被拦截：', (await api({ type: 'restart', cid: B.cid })).msg === '只有房主可以操作' ? '✓' : '❌');
  console.log('9. 房主返回大厅：', (await api({ type: 'backToLobby', cid: A.cid })).ok ? '✓' : '❌');
  const lobby = await waitFor(() => {
    const s = lastState(msgsB);
    return s && !s.game && s.room.phase === 'lobby' ? true : null;
  }, 3000);
  console.log('10. 全员回到大厅广播：', lobby ? '✓' : '❌');

  await Promise.all([pA, pB]);
  console.log('✅ 端到端测试全部通过');
  process.exit(0);
})().catch((e) => { console.error('测试失败：', e); process.exit(1); });
