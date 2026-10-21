'use strict';

// 只验证教学状态机；游戏规则与渲染由各自测试覆盖。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const elements = new Map();
function element() {
  const classes = new Set();
  const el = {
    id: '', hidden: false, className: '', innerHTML: '', textContent: '', style: {},
    children: [], isConnected: true,
    classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, contains(c) { return classes.has(c); } },
    addEventListener() {},
    querySelector(selector) {
      if (selector === 'main') return main;
      if (selector === '.tut-title') return this.titleNode || (this.titleNode = { textContent: '' });
      if (selector === '.tut-text') return this.textNode || (this.textNode = { textContent: '' });
      if (selector === '.tut-spotlight-rim') return this.children.find((child) => child.className === 'tut-spotlight-rim');
      return null;
    },
    querySelectorAll(selector) { return selector === '.tut-shade' ? this.children.filter((child) => child.className === 'tut-shade') : []; },
    getBoundingClientRect() { return { left: 300, top: 300, right: 430, bottom: 340, width: 130, height: 40 }; },
    scrollIntoView() {},
    setAttribute() {},
    appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
    insertBefore(child) { if (child.id) elements.set(child.id, child); },
  };
  return el;
}
const main = element();
const game = element();
elements.set('screen-game', game);
const start = element();
start.parentNode = element();
elements.set('btn-start', start);
const take3 = element();
take3.id = 'act-take3';
elements.set('act-take3', take3);

const colors = ['red', 'blue', 'black', 'pink', 'yellow'];
const card = { id: 1, name: '绿毛虫', cost: { red: 1 } };
const blindCard = { id: 2, name: '波波', cost: { red: 1 }, blind: true };
const ctx = {
  console,
  setTimeout: () => 0,
  addEventListener() {},
  requestAnimationFrame(fn) { fn(); return 0; },
  innerWidth: 1200,
  innerHeight: 800,
  COLORS: colors,
  BALLS: Object.fromEntries(colors.map((c) => [c, { name: c }])),
  RULES: { targets: [15, 18], handLimit: 10, takeTwoMin: 4 },
  S: null,
  HOOKS: { onGameOver: null },
  ONLINE: false,
  lastCfg: null,
  overShown: false,
  document: {
    body: element(),
    getElementById: (id) => elements.get(id) || null,
    createElement: element,
    querySelectorAll: (selector) => selector === '#act-take3' || selector === '.tut-hl' && take3.classList.contains('tut-hl') ? [take3] : [],
    querySelector: (selector) => selector === '.btn.tut-hl' && take3.classList.contains('tut-hl') ? take3 : null,
    addEventListener() {},
  },
  render() {},
  showScreen() {},
  backToSetup() {},
  hideModals() {},
  scheduleAI() {},
  toast() {},
  curPlayer() { return ctx.S.players[ctx.S.current]; },
  totalBalls(p) { return colors.reduce((n, c) => n + p.balls[c], p.balls.master); },
  canAfford(p, c) { return p.balls.red >= c.cost.red; },
  missingFor(p, c) {
    const red = Math.max(0, c.cost.red - p.balls.red);
    return { net: { red }, effTot: red };
  },
  newGame() {
    const balls = () => ({ red: 0, blue: 0, black: 0, pink: 0, yellow: 0, master: 0 });
    ctx.S = {
      players: [
        { name: '玩家', isAI: false, balls: balls(), cards: [], reserved: [] },
        { name: '小智', isAI: true, balls: balls(), cards: [], reserved: [] },
      ],
      current: 0, market: { 1: [card], 2: [], 3: [], 4: [], 5: [] },
      decks: { 1: [blindCard], 2: [], 3: [], 4: [], 5: [] },
      pool: { red: 4, blue: 4, black: 4, pink: 4, yellow: 4, master: 5 },
      mode: null, phase: 'normal', selColors: [], over: false,
    };
  },
};
ctx.window = ctx;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'tutorial.js'), 'utf8'), ctx);

async function run() {
  await ctx.startTutorial();
  const bar = elements.get('tut-bar');
  assert.match(bar.innerHTML, /第 1 个任务，共 3 个/);
  assert.strictEqual(bar.titleNode.textContent, '拿取精灵球');
  const spotlight = elements.get('tut-spotlight');
  assert.strictEqual(spotlight.hidden, false);
  assert.match(spotlight.querySelector('.tut-spotlight-rim').style.cssText, /left:293px/);

  // 拿球后，先让电脑走一回合，再继续引导收服。
  ctx.S.players[0].balls.blue = 1;
  ctx.S.current = 1;
  ctx.render();
  assert.match(bar.innerHTML, /第 2 个任务，共 3 个/);
  assert.strictEqual(spotlight.hidden, true);
  ctx.S.current = 0;
  ctx.render();
  assert.match(bar.textNode.textContent, /还没有付得起的卡/);
  ctx.S.players[0].balls.red = 1;
  ctx.render();
  assert.match(bar.textNode.textContent, /收服/);

  ctx.S.players[0].cards.push(card);
  ctx.S.current = 1;
  ctx.render();
  assert.match(bar.innerHTML, /第 3 个任务，共 3 个/);
  ctx.S.current = 0;
  ctx.render();
  assert.match(bar.textNode.textContent, /预约/);
  ctx.S.players[0].reserved.push(card);
  ctx.render();
  assert.match(bar.innerHTML, /三个任务已完成/);
  assert.match(bar.innerHTML, /想了解进阶玩法/);

  // 离开教学局应清理状态，并允许重新开始。
  ctx.showScreen('lobby');
  assert.strictEqual(bar.hidden, true);
  await ctx.startTutorial();
  assert.strictEqual(bar.titleNode.textContent, '拿取精灵球');
  ctx.showScreen('lobby');

  // 进阶训练：盲抽预约 → 拿两个同色球 → 收服刚盲抽的卡。
  await ctx.startAdvancedTutorial();
  assert.strictEqual(bar.titleNode.textContent, '盲抽预约');
  ctx.S.players[0].reserved.push(blindCard);
  ctx.S.players[0].balls.master = 1;
  ctx.S.current = 1;
  ctx.render();
  assert.match(bar.innerHTML, /第 2 个任务，共 3 个/);
  ctx.S.current = 0;
  ctx.render();
  assert.strictEqual(bar.titleNode.textContent, '同色双球');
  ctx.S.players[0].balls.red = 2;
  ctx.S.current = 1;
  ctx.render();
  assert.match(bar.innerHTML, /第 3 个任务，共 3 个/);
  ctx.S.current = 0;
  ctx.render();
  assert.match(bar.textNode.textContent, /波波/);
  ctx.S.players[0].reserved.pop();
  ctx.S.players[0].cards.push(blindCard);
  ctx.render();
  assert.match(bar.innerHTML, /三个任务已完成/);
  console.log('教程状态机正常（三步、AI 回合、退出重进）');
}
run().catch((err) => { console.error(err); process.exitCode = 1; });
