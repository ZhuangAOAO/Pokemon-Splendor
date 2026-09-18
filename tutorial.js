'use strict';

/* ================================================================
   璀璨宝石·宝可梦 — 新手教程（交互式引导局）
   · 本地单机（file://）：直接在本页开教学局
   · 联机（http://）：点「新手教程」→ 服务器一键创建私有房间
     （本人 + 电脑小智，目标 15 分）并直接开局；引导逻辑两模式共用
   · 不修改 client.js/game-core.js：包装 window.render / backToSetup / HOOKS.onGameOver，
     用 document 捕获阶段监听拦截错误操作，样式全部内联注入
   · 流程：拿球 → 收服 → 预约 → 进化(知识卡) → 稀有/传说(知识卡) → 盲抽
   ================================================================ */

(function () {
  if (typeof window === 'undefined') return;

  const TUT = {
    active: false,      // 教程局进行中
    finished: false,    // 教程步骤已全部完成（拦截解除，游戏继续）
    stepIdx: -1,        // 当前步骤下标（STEPS）
    armed: false,       // 当前行动步骤已武装（已取快照）
    snap: null,         // 武装时的玩家状态快照（完成判定基准）
    knowledge: false,   // 正在展示知识卡（遮罩态）
    blockAll: false,    // 遮罩态：除提示条按钮外全部拦截
    evolveGuide: null,  // 动态进化引导状态：null | 'shown' | 'continued'
  };
  let bar = null, dim = null;
  let tutStarting = false; // 联机：防止连点「新手教程」重复开局

  /* ==================== 状态读取小工具 ==================== */
  function human() {
    return S.players.find((pl) => !pl.isAI) || S.players[0];
  }
  function coloredSum(p) {
    return COLORS.reduce((s, c) => s + p.balls[c], 0);
  }
  function takeSnap() {
    const p = human();
    return { colored: coloredSum(p), cards: p.cards.length, reserved: p.reserved.length };
  }
  // 场上（含预约区）当前付得起的第一张卡
  function pickAffordable() {
    const p = human();
    for (const t of [1, 2, 3, 4, 5]) {
      for (let idx = 0; idx < S.market[t].length; idx++) {
        const card = S.market[t][idx];
        if (card && canAfford(p, card)) return { card, tier: t, idx };
      }
    }
    for (let i = 0; i < p.reserved.length; i++) {
      if (canAfford(p, p.reserved[i])) return { card: p.reserved[i], reserved: i };
    }
    return null;
  }
  // 场上还差球最少的一/二/三阶卡（攒球引导的目标）
  function pickClosest() {
    const p = human();
    let best = null, bestMiss = Infinity;
    for (const t of [1, 2, 3]) {
      for (let idx = 0; idx < S.market[t].length; idx++) {
        const card = S.market[t][idx];
        if (!card) continue;
        const miss = missingFor(p, card).effTot;
        if (miss < bestMiss) { bestMiss = miss; best = { card, tier: t, idx }; }
      }
    }
    return best;
  }
  // 只高亮当前模式下实际可点的供应区颜色（拿2球时按 takeTwoMin 过滤）
  function hlPoolColored() {
    const ok = S.mode === 'take2'
      ? COLORS.filter((c) => S.pool[c] >= RULES.takeTwoMin)
      : COLORS.filter((c) => S.pool[c] > 0);
    hl(ok.map((c) => '.pool-group.c-' + c).join(','), true);
  }
  function missText(p, card) {
    const net = missingFor(p, card).net;
    const parts = COLORS.map((c) => (net[c] > 0 ? BALLS[c].name + '×' + net[c] : '')).filter(Boolean);
    return parts.length ? parts.join('、') : '一点点运气';
  }

  /* ==================== 六步定义 ==================== */
  // 每步公共字段：title(名称)、type(action|knowledge)、text(知识卡文案)、
  //   isDone(对 snap 差量判定完成)、skip(条件不满足自动跳过)、allowedModes、
  //   forceMode(强制 UI 模式)、onArm(武装时额外动作)、apply(每次渲染更新文案+高亮)、
  //   canClick(捕获层白名单，返回 false 表示拦截)
  const stepTitle = (i, name) => name + '（第 ' + (i + 1) + ' 步 / 共 ' + STEPS_LEN + ' 步）';
  // STEPS_LEN 先占位，定义完数组后重算（见下方）
  let STEPS_LEN = 6;

  const STEPS = [
    /* 1. 拿取精灵球 */
    {
      id: 'take3',
      title: stepTitle(0, '拿取精灵球'),
      type: 'action',
      allowedModes: ['take3'],
      isDone: (snap) => coloredSum(human()) > snap.colored,
      skip: () => COLORS.every((c) => S.pool[c] <= 0),
      apply() {
        const need = Math.min(3, COLORS.filter((c) => S.pool[c] > 0).length);
        if (S.mode === 'take3') {
          hlPoolColored();
          if (S.selColors.length === need) hl('#act-confirm', true);
          setBar({ title: this.title, text: '点击发光的精灵球，选 ' + need + ' 种不同颜色（已选 ' + S.selColors.length + '/' + need + '，再点一次可取消），选满后点「确认拿取」', mode: 'action' });
        } else {
          hl('#act-take3', true);
          setBar({ title: this.title, text: '先点「拿 3 个不同球」按钮，拿到精灵球，下一回合就能收服宝可梦啦！', mode: 'action' });
        }
      },
      canClick(e) {
        if (utilClick(e)) return true;
        const el = e.target;
        if (S.mode === 'take3') return !!el.closest('.pool-group,#act-confirm,#act-cancel,.card');
        if (el.closest('#act-take3')) return true;
        if (el.closest('.card,.pool-group,.tier-label,#act-take2,#act-buy,#act-reserve,#act-return,#act-master')) {
          toast('先点「拿 3 个不同球」按钮，再选 3 种颜色的精灵球');
          return false;
        }
        return true;
      },
    },
    /* 2. 收服宝可梦（含攒球子态） */
    {
      id: 'buy',
      title: stepTitle(1, '收服宝可梦'),
      type: 'action',
      allowedModes: ['buy', 'take3', 'take2', 'returnBalls', 'takeMaster'],
      isDone: (snap) => human().cards.length > snap.cards,
      apply() {
        const p = human();
        const aff = pickAffordable();
        if (!aff) {
          // 攒球子态：还没有付得起的卡，引导攒经济
          const tgt = pickClosest();
          if (S.mode === 'take3' || S.mode === 'take2') {
            hlPoolColored();
            const one = S.mode === 'take2' ? 1 : 3;
            if (S.selColors.length >= (S.mode === 'take2' ? 1 : Math.min(3, COLORS.filter((c) => S.pool[c] > 0).length))) hl('#act-confirm', true);
            setBar({ title: this.title, text: tgt ? '目标是「' + tgt.card.name + '」，还差：' + missText(p, tgt.card) + '。选好 ' + one + ' 种球点确认' : '先拿球攒一攒', mode: 'action' });
          } else if (S.mode === 'returnBalls') {
            hl('.pball.clickable', true);
            setBar({ title: this.title, text: '点自己面板里的球可以退还 1 个（周转用）。不过建议直接点「取消」，改拿球', mode: 'action' });
          } else if (S.mode === 'takeMaster') {
            hl('#act-confirm', true);
            setBar({ title: this.title, text: '大师球是万能球，可以代替任意颜色！点「确认拿取」', mode: 'action' });
          } else {
            hl('#act-take3', true);
            setBar({ title: this.title, text: tgt ? '现在还没有付得起的宝可梦。先点「拿 3 个不同球」攒一攒——目标是「' + tgt.card.name + '」，还差：' + missText(p, tgt.card) : '先拿球攒一攒，有付得起的卡时就能收服', mode: 'action' });
          }
          return;
        }
        // 正常收服子态
        if (S.mode === 'buy') {
          hl('.card.affordable', true);
          hl('.rchip.clickable', true);
          if (S.selCard) hl('#act-confirm', true);
          setBar({ title: this.title, text: S.selCard ? '点「确认收服」！收服后它就归你，永久提供精灵球加成' : '点击金色发光的「' + aff.card.name + '」——你的球够收服它！', mode: 'action' });
        } else {
          hl('.card.affordable', true);
          setBar({ title: this.title, text: '点击金色发光的「' + aff.card.name + '」直接收服它（也可以先点「收服宝可梦」按钮）', mode: 'action' });
        }
      },
      canClick(e) {
        if (utilClick(e)) return true;
        const el = e.target;
        const aff = pickAffordable();
        if (!aff) {
          // 攒球子态：只放行拿球/退球相关
          if (S.mode === 'take3' || S.mode === 'take2') return !!el.closest('.pool-group,#act-confirm,#act-cancel');
          if (S.mode === 'returnBalls') return !!el.closest('.pball,#act-confirm,#act-cancel');
          if (S.mode === 'takeMaster') return !!el.closest('#act-confirm,#act-cancel');
          if (el.closest('#act-take3,#act-take2,#act-return,#act-master')) return true;
          if (el.closest('.card,.rchip,.pcard')) return true; // 放大查看，无副作用
          if (el.closest('#act-buy,#act-reserve')) { toast('现在还没有付得起的宝可梦，先拿球攒一攒'); return false; }
          return true;
        }
        if (S.mode === 'buy') return !!el.closest('.card,.rchip,#act-confirm,#act-cancel');
        if (el.closest('#act-buy')) return true;
        if (el.closest('.card')) return true; // 发光的卡直接进收服；其他卡放大查看
        if (el.closest('.rchip,.pcard')) return true;
        if (el.closest('#act-take3,#act-take2,#act-return,#act-master,#act-reserve')) {
          toast('买得起「' + aff.card.name + '」啦，先收服它试试！');
          return false;
        }
        return true;
      },
    },
    /* 3. 预约宝可梦 */
    {
      id: 'reserve',
      title: stepTitle(2, '预约宝可梦'),
      type: 'action',
      allowedModes: ['reserve'],
      isDone: (snap) => human().reserved.length > snap.reserved,
      skip: () => ![1, 2, 3].some((t) => S.market[t].some(Boolean)),
      apply() {
        const masterInfo = S.pool.master > 0 ? '预约还送 1 个大师球（万能球）！' : '（大师球已领完，这次没有球可拿）';
        if (S.mode === 'reserve') {
          if (S.selCard) {
            hl('#act-confirm', true);
            setBar({ title: this.title, text: '点「确认预约」！之后任意回合都可以收服它', mode: 'action' });
          } else {
            hl('.tier-row .card[data-tier="1"],.tier-row .card[data-tier="2"],.tier-row .card[data-tier="3"]', true);
            setBar({ title: this.title, text: '点场上一只宝可梦（稀有/传说不能预约哦），' + masterInfo, mode: 'action' });
          }
        } else {
          hl('#act-reserve', true);
          setBar({ title: this.title, text: '点「预约宝可梦」按钮，把场上一只宝可梦收进预约区，' + masterInfo, mode: 'action' });
        }
      },
      canClick(e) {
        if (utilClick(e)) return true;
        const el = e.target;
        if (S.mode === 'reserve') {
          if (el.closest('.tier-label')) { toast('盲抽牌堆下一步再教你，先预约场上的宝可梦'); return false; }
          if (el.closest('.card,#act-confirm,#act-cancel')) return true; // 点稀有/传说卡由游戏自带提示拦截
          return true;
        }
        if (el.closest('#act-reserve')) return true;
        if (el.closest('.card')) { toast('先点「预约宝可梦」按钮'); return false; }
        if (el.closest('.pool-group,#act-take3,#act-take2,#act-return,#act-master,#act-buy')) {
          toast('这一步来学「预约」：点下方「预约宝可梦」按钮');
          return false;
        }
        return true;
      },
    },
    /* 4. 进化（知识卡） */
    {
      id: 'evolveK',
      title: stepTitle(3, '宝可梦进化'),
      type: 'knowledge',
      text: '每次行动结束后，游戏会检查一次「免费进化」：如果你的宝可梦（比如小火龙）的进化型（火恐龙）在场或你的预约区，而且加成足够，就能免费进化成更强、分数更高的形态！原来的卡收进「图鉴」收藏。什么时候看到绿色进化按钮，点它就免费进化（也可以选择跳过）。',
    },
    /* 5. 稀有与传说（知识卡） */
    {
      id: 'rlK',
      title: stepTitle(4, '稀有与传说'),
      type: 'knowledge',
      hlSel: '#rl-wrap',
      text: '看右边「稀有宝可梦」「传说宝可梦」：它们提供双倍加成、分数更高！但收服时必须额外支付大师球（稀有 1 个、传说 2 个），而且不能预约，只能直接收服。等球多了再来挑战它们吧！',
    },
    /* 6. 盲抽预约 */
    {
      id: 'blind',
      title: stepTitle(5, '盲抽预约'),
      type: 'action',
      allowedModes: ['reserve'],
      forceMode: 'reserve',
      isDone: (snap) => human().reserved.length > snap.reserved,
      onArm() {
        S.mode = 'reserve'; S.selCard = null; S.selBlind = null; S.selColors = [];
        return true;
      },
      apply() {
        const t = [1, 2, 3].find((x) => S.decks[x].length > 0) || 1;
        const masterInfo = S.pool.master > 0 ? '还能拿 1 个大师球！' : '（大师球已领完）';
        if (S.selBlind) {
          hl('#act-confirm', true);
          setBar({ title: this.title, text: '点「确认盲抽」！抽到的卡只有你能看到', mode: 'action' });
        } else {
          hl('.tier-label[data-tier="' + t + '"]', true);
          setBar({ title: this.title, text: '点左边「' + TIER_NAMES[t] + '宝可梦」牌堆，盲抽一张卡收进预约区（只有你知道），' + masterInfo, mode: 'action' });
        }
      },
      canClick(e) {
        if (utilClick(e)) return true;
        const el = e.target;
        if (el.closest('.tier-label,#act-confirm,#act-cancel')) return true;
        if (el.closest('.card')) { toast('点左边的牌堆盲抽，不是场上的卡'); return false; }
        if (el.closest('.rchip,.pool-group,#act-take3,#act-take2,#act-buy,#act-return,#act-reserve,#act-master')) {
          toast('点左边的牌堆，盲抽一张宝可梦');
          return false;
        }
        return true;
      },
    },
  ];
  STEPS_LEN = STEPS.length;

  /* ==================== 步骤机 ==================== */
  function advance() {
    TUT.armed = false;
    TUT.stepIdx++;
    if (TUT.stepIdx >= STEPS.length) { finishTutorial(); return; }
    render();
  }
  function finishTutorial() {
    TUT.finished = true;
    TUT.armed = false;
    clearHl();
    if (dim) dim.hidden = true;
    toast('教程完成！现在自由发挥，去赢得比赛吧！');
    setBar({ title: '教程完成', text: '你已经学会拿球、收服、预约、进化和盲抽啦。现在自由发挥，去赢得比赛吧！', mode: 'done' });
  }
  function end() {
    TUT.active = false; TUT.finished = false; TUT.armed = false; TUT.stepIdx = -1;
    TUT.knowledge = false; TUT.blockAll = false; TUT.evolveGuide = null; TUT.snap = null;
    clearHl();
    if (dim) dim.hidden = true;
    if (bar) bar.hidden = true;
  }
  function showKnowledge(step) {
    TUT.knowledge = true;
    TUT.blockAll = true;
    hideModals();
    const zoom = document.getElementById('zoom');
    if (zoom) zoom.hidden = true;
    if (dim) dim.hidden = false;
    if (step.hlSel) hl(step.hlSel, true);
    setBar({ title: step.title, text: step.text, mode: 'knowledge' });
  }
  function showEvolveGuide() {
    if (!TUT.evolveGuide) {
      TUT.evolveGuide = 'shown';
      TUT.blockAll = true;
      if (dim) dim.hidden = false;
      hl('#my-panel', true);
      setBar({ title: '免费进化机会！', text: '快看！你刚才的行动结束后，出现了免费进化机会！点「继续」，然后点绿色的进化按钮（也可以点「跳过进化」）', mode: 'knowledge' });
    } else {
      hl('.btn.evolve', true);
      hl('#act-skip-evo', true);
      setBar({ title: '免费进化机会！', text: '点绿色「进化」按钮完成进化（每回合最多 1 次），或点「跳过进化」', mode: 'action' });
    }
  }

  /* 每次渲染后调用（幂等） */
  function afterRender() {
    if (!TUT.active || TUT.finished) return;
    if (!S) return;
    clearHl();
    if (S.over || S.phase === 'gameover') { end(); return; }
    const p = curPlayer();
    // 1. 完成判定（先于 AI 分支：行动完成后回合常已切给 AI）
    if (TUT.armed && !TUT.knowledge) {
      const step = STEPS[TUT.stepIdx];
      if (step && step.isDone && step.isDone(TUT.snap)) { advance(); return; }
    }
    // 2. AI 回合：等待态
    if (p.isAI) {
      TUT.armed = false;
      const step = STEPS[TUT.stepIdx];
      if (!step) { finishTutorial(); return; }
      setBar({ title: step.title, text: p.name + ' 正在思考…轮到你就继续教你', mode: 'wait' });
      return;
    }
    // 3. discard 阶段引导（拿球超上限）
    if (S.phase === 'discard') {
      TUT.armed = false;
      hl('.pball.clickable', true);
      setBar({ title: '手牌上限', text: '你的精灵球超过 ' + RULES.handLimit + ' 个啦！点自己面板里发光的精灵球退回 1 个（还需 ' + S.discardNeed + ' 个）', mode: 'action' });
      return;
    }
    // 4. evolve 阶段引导
    if (S.phase === 'evolve') {
      TUT.armed = false;
      showEvolveGuide();
      return;
    }
    TUT.evolveGuide = null;
    // 5. 知识卡步骤
    const step = STEPS[TUT.stepIdx];
    if (!step) { finishTutorial(); return; }
    if (step.type === 'knowledge') { showKnowledge(step); return; }
    // 6. 行动步骤
    if (!TUT.armed) {
      TUT.armed = true;
      TUT.snap = takeSnap();
      if (step.onArm && step.onArm()) { render(); return; }
    }
    if (step.skip && step.skip()) { toast('这一步的条件暂时不满足，先跳过'); advance(); return; }
    if (step.forceMode && S.mode !== step.forceMode) {
      S.mode = step.forceMode; S.selColors = []; S.selCard = null; S.selBlind = null; render(); return;
    }
    if (S.mode && !(step.allowedModes || []).includes(S.mode)) {
      S.mode = null; S.selColors = []; S.selCard = null; S.selBlind = null; render(); return;
    }
    step.apply();
  }

  /* ==================== 点击拦截（捕获阶段，早于所有冒泡监听） ==================== */
  function utilClick(e) {
    // .spc2-mask = 自定义确认框（confirm-dialog.js）。教程的「结束教程」自己就走这个框，
    // 白名单里漏了它 → 确认按钮的 click 会被捕获层 preventDefault 掉，框永远关不掉。
    return !!(e.target.closest('#tut-bar,#btn-sound,#btn-rules,#btn-logs,#btn-exit,.modal,#modal-overlay,.spc2-mask,#zoom,#vote-banner'));
  }
  function tutCapture(e) {
    if (!TUT.active || TUT.finished) return;
    if (!S) return;
    // A. 知识卡/进化引导遮罩态：除提示条按钮外全部拦截
    if (TUT.blockAll) {
      if (e.target.closest('#tut-bar')) return;
      e.stopPropagation(); e.preventDefault(); return;
    }
    const p = curPlayer();
    if (p.isAI) return; // 电脑回合：随便看，游戏逻辑自己会拦行动
    // B. 进化引导「已继续」态：只放行进化/跳过
    if (S.phase === 'evolve' && TUT.evolveGuide === 'continued') {
      if (utilClick(e) || e.target.closest('.btn.evolve,#act-skip-evo')) return;
      e.stopPropagation(); e.preventDefault();
      toast('先点绿色进化按钮，或点「跳过进化」');
      return;
    }
    // C. discard 引导：只放行退球
    if (S.phase === 'discard') {
      if (utilClick(e) || e.target.closest('.pball')) return;
      e.stopPropagation(); e.preventDefault();
      toast('精灵球超过 ' + RULES.handLimit + ' 个啦，点自己面板里发光的球退回 1 个');
      return;
    }
    // D. 行动步骤白名单（canClick 内部负责提示）
    const step = STEPS[TUT.stepIdx];
    if (step && step.canClick && !step.canClick(e)) {
      e.stopPropagation(); e.preventDefault();
    }
  }

  /* ==================== UI ==================== */
  function ensureUI() {
    if (document.getElementById('tut-bar')) { bar = document.getElementById('tut-bar'); }
    else {
      bar = document.createElement('div');
      bar.id = 'tut-bar';
      bar.hidden = true;
      const game = document.getElementById('screen-game');
      const main = game && game.querySelector('main');
      if (game && main) game.insertBefore(bar, main);
      else if (game) game.appendChild(bar);
      else document.body.appendChild(bar);
    }
    if (document.getElementById('tut-dim')) { dim = document.getElementById('tut-dim'); }
    else {
      dim = document.createElement('div');
      dim.id = 'tut-dim';
      dim.hidden = true;
      document.body.appendChild(dim);
    }
  }
  function setBar({ title, text, mode }) {
    ensureUI();
    bar.className = 'tut-bar' + (mode === 'knowledge' ? ' know' : '');
    bar.innerHTML = `
      <span class="tut-title">${title}</span>
      <span class="tut-text">${text}</span>
      <span class="tut-btns">
        <button class="btn ghost sm" id="tut-exit">结束教程</button>
        ${mode === 'knowledge' ? '<button class="btn primary sm" id="tut-continue">继续</button>' : ''}
        ${mode === 'done' ? '<button class="btn primary sm" id="tut-done">自由发挥</button>' : ''}
      </span>`;
    bar.hidden = false;
    const ex = document.getElementById('tut-exit');
    if (ex) ex.addEventListener('click', async () => {
      if (await spConfirm({ title: '结束教程', message: ONLINE ? '要结束教程吗？会返回大厅。' : '要结束教程吗？会回到设置页。', confirmText: '结束教程' })) {
        end();
        if (ONLINE) postApi({ type: 'backToLobby', cid: myCid }); // 本人即房主，可随时结束
        else backToSetup();
      }
    });
    const cont = document.getElementById('tut-continue');
    if (cont) cont.addEventListener('click', () => {
      TUT.knowledge = false;
      TUT.blockAll = false;
      if (TUT.evolveGuide === 'shown') { TUT.evolveGuide = 'continued'; render(); return; }
      if (dim) dim.hidden = true;
      advance();
    });
    const done = document.getElementById('tut-done');
    if (done) done.addEventListener('click', () => { bar.hidden = true; });
  }
  function hl(sel, on) {
    if (!sel) return;
    document.querySelectorAll(sel).forEach((el) => el.classList.toggle('tut-hl', on));
  }
  function clearHl() {
    document.querySelectorAll('.tut-hl').forEach((el) => el.classList.remove('tut-hl'));
  }
  function injectCSS() {
    const st = document.createElement('style');
    st.textContent = `
#tut-bar{ display:flex; align-items:center; gap:12px; margin:0 0 10px;
  background:#fffdf2; border:2px solid var(--gold); border-radius:16px;
  padding:9px 16px; box-shadow:var(--shadow); font-size:13.5px; }
#tut-bar .tut-title{ font-weight:900; color:var(--red); font-size:15px; white-space:nowrap; }
#tut-bar .tut-text{ color:var(--ink); line-height:1.55; flex:1; }
#tut-bar .tut-btns{ display:flex; gap:8px; }
#tut-bar .btn{ white-space:nowrap; }
#tut-bar.know{ position:fixed; top:80px; left:0; right:0; margin:0 auto;
  width:max-content; max-width:min(600px,92vw); z-index:130;
  flex-direction:column; align-items:stretch; gap:10px; padding:14px 18px;
  animation:tutFade .25s ease; }
#tut-bar.know .tut-title{ text-align:center; }
#tut-bar.know .tut-btns{ justify-content:center; }
@keyframes tutFade{ from{opacity:0} to{opacity:1} }
#tut-dim{ position:fixed; inset:0; background:rgba(23,34,46,.18); z-index:105; }
.tut-hl{ animation:pulseGold 1.1s infinite; }
.card.tut-hl{ cursor:pointer; }
.pool-group.tut-hl{ cursor:pointer;
  animation:poolNudge 1.1s infinite, pulseGold 1.1s infinite; }
.pool-group.tut-hl.selected{ animation:none; } /* 选中态完整露出（绿框绿底，不浮动） */
.tier-label.tut-hl{ cursor:pointer; border-color:var(--gold) !important; background:#fffdf2; }
.btn.tut-hl{ box-shadow:0 0 0 3px var(--gold), 0 5px 14px rgba(240,168,0,.35); }
#rl-wrap.tut-hl, #my-panel.tut-hl{ outline:3px solid var(--gold); outline-offset:4px; border-radius:16px; }
.pball.tut-hl{ outline:2px solid var(--gold); outline-offset:2px; border-radius:8px; }
.tut-btn{ background:linear-gradient(180deg,#4ade80,#15803d); color:#fff; border:none;
  box-shadow:0 5px 14px rgba(21,128,61,.35); }`;
    document.head.appendChild(st);
  }

  /* ==================== 启动与收尾包装 ==================== */
  async function startTutorial() {
    if (tutStarting) return;
    if (ONLINE) {
      // 联机：服务器一键建私有房间 + 电脑小智 + 15 分开局，对局状态经 SSE 推来
      tutStarting = true;
      try {
        const j = await postApi({ type: 'tutorial', token: myToken });
        if (!j.ok) return; // postApi 已提示错误
        TUT.active = true; TUT.finished = false; TUT.stepIdx = 0; TUT.armed = false;
        TUT.knowledge = false; TUT.blockAll = false; TUT.evolveGuide = null; TUT.snap = null;
        myCid = j.cid;
        openEvents(j.cid);
        ensureUI();
        // 兜底：SSE 首推（含对局状态）会在连接建立时发出，超时未收到则复位
        setTimeout(() => { if (TUT.active && !S) { end(); toast('教程开局超时，请重试'); } }, 10000);
      } finally {
        tutStarting = false;
      }
      return;
    }
    TUT.active = true; TUT.finished = false; TUT.stepIdx = 0; TUT.armed = false;
    TUT.knowledge = false; TUT.blockAll = false; TUT.evolveGuide = null; TUT.snap = null;
    const target = RULES.targets.includes(15) ? 15 : Math.min.apply(null, RULES.targets);
    const cfg = { players: [{ name: '小训练家', type: 'human' }, { name: '小智', type: 'easy' }], target };
    lastCfg = cfg;
    newGame(cfg);
    overShown = false;
    showScreen('game');
    hideModals();
    const zoom = document.getElementById('zoom');
    if (zoom) zoom.hidden = true;
    ensureUI();
    render();
    scheduleAI();
  }

  function wrapGlobals() {
    const origRender = window.render;
    window.render = function () {
      origRender();
      afterRender();
    };
    const origBackToSetup = window.backToSetup;
    window.backToSetup = function () {
      end();
      return origBackToSetup.apply(this, arguments);
    };
    const origOnGameOver = HOOKS.onGameOver;
    HOOKS.onGameOver = function () {
      end();
      if (origOnGameOver) origOnGameOver.apply(this, arguments);
    };
  }
  function injectButton() {
    const make = () => {
      const b = document.createElement('button');
      b.className = 'btn lg tut-btn';
      b.textContent = '新手教程';
      b.addEventListener('click', startTutorial);
      return b;
    };
    // 本地设置页（开始游戏前）注入：那一屏没有工具条，这是唯一入口。
    // 联机侧不再注入 —— 大厅（未进房 / 房内同一套外壳）统一走顶栏工具条「教程」，
    // 避免同一屏出现两颗教程按钮（去重靠"少注入一处"，不靠 CSS 藏起来）。
    const startBtn = document.getElementById('btn-start');
    if (startBtn && startBtn.parentNode) startBtn.parentNode.insertBefore(make(), startBtn);
  }

  /* ---- 初始化：装包装器、样式、按钮、拦截监听（两模式通用） ---- */
  // 教程入口要能被**本 IIFE 之外**的代码调用：大厅工具条「教程」弹层走 client.js，
  // 那里判的是全局 `typeof startTutorial === 'function'`。不挂到 window 上，
  // 工具条那颗按钮就永远落到 `toast('教程入口待接入')` 分支（濠哥报的"教程没接入"）。
  window.startTutorial = startTutorial;
  injectCSS();
  ensureUI();
  wrapGlobals();
  injectButton();
  document.addEventListener('click', tutCapture, true);
})();
