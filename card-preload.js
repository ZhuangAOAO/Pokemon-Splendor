'use strict';

// 登录后利用大厅停留时间预热卡图的浏览器缓存；进入对局时让场上卡图优先占用带宽。
(function (root) {
  const cards = Array.isArray(root.CARD_TABLE) ? root.CARD_TABLE : [];
  const names = [...new Set(cards.slice().sort((a, b) => a[1] - b[1]).map((row) => row[0]))];
  const pending = new Set();
  const maxParallel = 2;
  let started = false;
  let paused = false;
  let skipped = false;
  let next = 0;
  let completed = 0;
  let failed = 0;

  function updateStatus() {
    const el = root.document.getElementById('card-preload-status');
    if (!el) return;
    el.hidden = !started;
    if (skipped) el.textContent = '已开启省流量模式，卡图将在需要时加载';
    else if (completed === names.length) el.textContent = failed
      ? `卡图已准备 ${completed - failed}/${names.length} 张，${failed} 张未能加载`
      : `卡图已准备完成 · ${names.length}/${names.length}`;
    else el.textContent = `后台准备卡图 · ${completed}/${names.length}（首次加载会使用较多流量）`;
  }

  function pump() {
    if (!started || paused || skipped) return;
    while (pending.size < maxParallel && next < names.length) {
      const name = names[next++];
      const img = new root.Image();
      pending.add(img); // 保留引用，直到请求结束
      img.fetchPriority = 'low';
      let settled = false;
      function finish(ok) {
        if (settled) return;
        settled = true;
        img.onload = img.onerror = null;
        pending.delete(img);
        completed++;
        if (!ok) failed++;
        updateStatus();
        pump();
      }
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = 'pictures/' + encodeURIComponent(name) + '.jpg';
    }
  }

  function start() {
    if (started) return;
    started = true;
    const connection = root.navigator && root.navigator.connection;
    skipped = !!(connection && (connection.saveData || /^(slow-)?2g$/.test(connection.effectiveType || '')));
    updateStatus();
    if (skipped) return;
    if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(pump, { timeout: 1500 });
    else root.setTimeout(pump, 0);
  }

  root.CardImagePreloader = {
    start,
    pause() { paused = true; },
    resume() { paused = false; pump(); },
  };
})(window);
