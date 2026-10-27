'use strict';

const assert = require('assert');
global.window = global;
require('../config.js');
const core = require('../game-core.js');

const s = core.createSession();
s.newGame({ target: 18, players: [{ name: '人类', type: 'human' }, { name: '小智', type: 'easy' }] });
s.S.current = 1; // 固定测试电脑回合，不受随机先手影响

const realSet = global.setTimeout;
const realClear = global.clearTimeout;
const timers = new Map();
let nextId = 1;
let online = true;
s.HOOKS.canRunAI = () => online;
s.HOOKS.chooseAIMove = () => ({ type: 'take3', colors: ['red', 'blue', 'black'] });
global.setTimeout = (fn) => { const id = nextId++; timers.set(id, fn); return id; };
global.clearTimeout = (id) => { timers.delete(id); };

try {
  s.scheduleAI();
  s.scheduleAI();
  assert.strictEqual(timers.size, 1, '同一电脑回合只安排一次行动');
  const oldCallback = [...timers.values()][0];
  const before = s.S.turnIdx;
  online = false;
  s.cancelAI();
  assert.strictEqual(timers.size, 0, '全员离线时取消待执行的电脑行动');
  oldCallback(); // 即使取消前的回调意外到达，也必须再检查在线状态
  assert.strictEqual(s.S.turnIdx, before);
  s.scheduleAI();
  assert.strictEqual(timers.size, 0, '离线期间不能重新安排电脑行动');

  online = true;
  s.scheduleAI();
  assert.strictEqual(timers.size, 1, '有人重连后恢复当前电脑回合');
  [...timers.values()][0]();
  assert.ok(s.S.turnIdx > before, '重连后电脑能正常行动');
  assert.strictEqual(s.S.players[1].balls.red, 1);
} finally {
  global.setTimeout = realSet;
  global.clearTimeout = realClear;
}

console.log('全员离线时电脑暂停，重连后恢复');
