'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'card-preload.js'), 'utf8');

function makeContext(connection) {
  const requests = [];
  const status = { hidden: true, textContent: '' };
  const root = {
    CARD_TABLE: [['一号', 2], ['二号', 1], ['三号', 3], ['二号', 1]],
    navigator: { connection },
    document: { getElementById: () => status },
    requestIdleCallback: (fn) => fn(),
    setTimeout: (fn) => fn(),
    Image: class {
      set src(value) { this.url = value; requests.push(this); }
    },
  };
  vm.runInNewContext(source, { window: root });
  return { root, requests, status };
}

const { root, requests, status } = makeContext({ saveData: false, effectiveType: '4g' });
assert.strictEqual(requests.length, 0, '登录前不应加载卡图');
root.CardImagePreloader.start();
assert.strictEqual(status.hidden, false);
assert.strictEqual(requests.length, 2, '最多并发两张卡图');
assert.match(decodeURIComponent(requests[0].url), /二号/);
root.CardImagePreloader.start();
assert.strictEqual(requests.length, 2, '重复进入大厅不应重启队列');
root.CardImagePreloader.pause();
requests[0].onload();
assert.strictEqual(requests.length, 2, '对局中不再启动后台请求');
root.CardImagePreloader.resume();
assert.strictEqual(requests.length, 3);
requests[1].onerror();
requests[2].onload();
assert.match(status.textContent, /2\/3 张，1 张未能加载/);

const saver = makeContext({ saveData: true, effectiveType: '4g' });
saver.root.CardImagePreloader.start();
assert.strictEqual(saver.requests.length, 0);
assert.match(saver.status.textContent, /省流量模式/);

const slow = makeContext({ saveData: false, effectiveType: '2g' });
slow.root.CardImagePreloader.start();
assert.strictEqual(slow.requests.length, 0);

console.log('登录后卡图预载正常（限并发、暂停恢复、省流量）');
