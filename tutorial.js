'use strict';

/* ================================================================
   璀璨宝石·宝可梦 — 新手教程（交互式引导局）
   · 本地单机（file://）：直接在本页开教学局
   · 联机（http://）：点「新手教程」→ 服务器一键创建私有房间
     （本人 + 电脑小智，目标 15 分）并直接开局；引导逻辑两模式共用
   · 三个实操任务：拿球 → 收服（需要时继续攒球）→ 预约
   · 进阶训练：盲抽预约 → 同色双球 → 收服盲抽卡
   · 进化与稀有/传说保留为完成后的可选提示
   ================================================================ */

(function () {
  if (typeof window === 'undefined') return;

  const TUT = {
    active: false,      // 教程局进行中
    finished: false,    // 教程步骤已全部完成（拦截解除，游戏继续）
    stepIdx: -1,        // 当前训练的步骤下标
    armed: false,       // 当前行动步骤已武装（已取快照）
    snap: null,         // 武装时的玩家状态快照（完成判定基准）
    kind: 'basic',
    advancedCardId: null,
  };
  let bar = null;
  let spotlight = null;
  let spotlightTarget = null;
  let spotlightFrame = 0;
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
    return { colored: coloredSum(p), cards: p.cards.length, reserved: p.reserved.length,
      balls: { ...p.balls }, reservedIds: p.reserved.map((c) => c.id) };
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

  /* ==================== 三个实操任务 ==================== */
  // 每步用玩家状态差量判断完成，不依赖固定牌序或 AI 的具体动作。

  const BASIC_STEPS = [
    /* 1. 拿取精灵球 */
    {
      id: 'take3',
      title: '拿取精灵球',
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
      title: '收服宝可梦',
      allowedModes: ['buy', 'take3', 'take2', 'returnBalls', 'takeMaster'],
      isDone: (snap) => human().cards.length > snap.cards,
      apply() {
        const p = human();
        const aff = pickAffordable();
        if (!aff) {
          // 攒球子态：还没有付得起的卡，引导攒经济
          const tgt = pickClosest();
          if (tgt) targetCard('.tier-row .card[data-tier="' + tgt.tier + '"][data-idx="' + tgt.idx + '"]');
          if (S.mode === 'take3' || S.mode === 'take2') {
            hlPoolColored();
            const one = S.mode === 'take2' ? 1 : 3;
            if (S.selColors.length >= (S.mode === 'take2' ? 1 : Math.min(3, COLORS.filter((c) => S.pool[c] > 0).length))) hl('#act-confirm', true);
            setBar({ title: this.title, text: tgt ? '参考目标「' + tgt.card.name + '」，还差：' + missText(p, tgt.card) + '。选好 ' + one + ' 种颜色后确认拿取' : '先拿球攒一攒', mode: 'action' });
          } else if (S.mode === 'returnBalls') {
            hl('.pball.clickable', true);
            setBar({ title: this.title, text: '点自己面板中的一个球退还。每回合只能做一个行动；如果手牌未满，通常先取消并继续拿球更好。', mode: 'action' });
          } else if (S.mode === 'takeMaster') {
            hl('#act-confirm', true);
            setBar({ title: this.title, text: '大师球能代替任意颜色，也能支付稀有卡的额外费用。点「确认拿取」结束这回合。', mode: 'action' });
          } else {
            const full = totalBalls(p) >= RULES.handLimit;
            hl(full ? '#act-return' : '#act-take3', true);
            setBar({ title: this.title, text: full
              ? '手里已有 ' + RULES.handLimit + ' 个球，仍买不起时可退还暂时用不到的球，下一回合再调整颜色。'
              : tgt ? '还没有付得起的卡。参考蓝框的「' + tgt.card.name + '」，缺少：' + missText(p, tgt.card) + '。继续拿球，攒够后收服。'
                : '先拿球攒一攒，有付得起的卡时就能收服。', mode: 'action' });
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
      title: '预约宝可梦',
      allowedModes: ['reserve'],
      isDone: (snap) => human().reserved.length > snap.reserved,
      skip: () => ![1, 2, 3].some((t) => S.market[t].some(Boolean)),
      apply() {
        const masterInfo = S.pool.master > 0 ? '预约还送 1 个大师球（万能球）！' : '（大师球已领完，这次没有球可拿）';
        if (S.mode === 'reserve') {
          if (S.selCard) {
            hl('#act-confirm', true);
            setBar({ title: this.title, text: '点「确认预约」。卡会进入你的预约区，以后攒够球可以收服；它现在不会提供加成。', mode: 'action' });
          } else {
            hl('.tier-row .card[data-tier="1"],.tier-row .card[data-tier="2"],.tier-row .card[data-tier="3"]', true);
            setBar({ title: this.title, text: '你刚收服的卡会永久减少同色球费用。现在点场上一只一至三阶宝可梦预约。' + masterInfo, mode: 'action' });
          }
        } else {
          hl('#act-reserve', true);
          setBar({ title: this.title, text: '你刚收服的卡会永久减少同色球费用。现在点「预约宝可梦」，把想要的卡留到以后收服。' + masterInfo, mode: 'action' });
        }
      },
      canClick(e) {
        if (utilClick(e)) return true;
        const el = e.target;
        if (S.mode === 'reserve') {
          if (el.closest('.tier-label')) { toast('这次先预约场上的宝可梦；盲抽牌堆是进阶玩法'); return false; }
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
  ];

  const ADVANCED_STEPS = [
    {
      id: 'blind', title: '盲抽预约', allowedModes: ['reserve'],
      isDone: (snap) => human().reserved.some((c) => c.blind && !snap.reservedIds.includes(c.id)),
      skip: () => !S.decks[1].length || human().reserved.length >= RULES.reserveLimit,
      apply() {
        if (S.mode === 'reserve') {
          if (S.selBlind === 1) {
            hl('#act-confirm', true);
            setBar({ title: this.title, text: '点「确认盲抽」。一阶牌堆顶的卡会进入你的预约区；只有你能看到它，并可获得 1 个大师球。', mode: 'action' });
          } else {
            hl('.tier-label[data-tier="1"]', true);
            setBar({ title: this.title, text: '点一阶牌堆的标题，而不是场上的卡。盲抽的卡不会向其他玩家公开。', mode: 'action' });
          }
        } else {
          hl('#act-reserve', true);
          setBar({ title: this.title, text: '先点「预约宝可梦」。这次我们不预约明牌，而是从牌堆盲抽。', mode: 'action' });
        }
      },
      canClick(e) {
        if (utilClick(e)) return true;
        if (S.mode === 'reserve') return !!e.target.closest('.tier-label[data-tier="1"],#act-confirm,#act-cancel');
        return !!e.target.closest('#act-reserve');
      },
    },
    {
      id: 'take2', title: '同色双球', allowedModes: ['take2'],
      isDone: (snap) => COLORS.some((c) => human().balls[c] >= snap.balls[c] + 2),
      skip: () => COLORS.every((c) => S.pool[c] < RULES.takeTwoMin),
      apply() {
        if (S.mode === 'take2') {
          hlPoolColored();
          if (S.selColors.length === 1) hl('#act-confirm', true);
          setBar({ title: this.title, text: '供应区至少有 ' + RULES.takeTwoMin + ' 个的颜色才可拿 2 个。选择一种颜色，再点「确认拿取」。', mode: 'action' });
        } else {
          hl('#act-take2', true);
          setBar({ title: this.title, text: '点「拿 2 个相同球」。想快速攒某一种颜色时，用它代替拿 3 种不同球。', mode: 'action' });
        }
      },
      canClick(e) {
        if (utilClick(e)) return true;
        return !!e.target.closest(S.mode === 'take2' ? '.pool-group,#act-confirm,#act-cancel' : '#act-take2');
      },
    },
    {
      id: 'buyBlind', title: '收服盲抽卡', allowedModes: ['buy', 'take3', 'take2', 'returnBalls', 'takeMaster'],
      isDone: () => human().cards.some((c) => c.id === TUT.advancedCardId),
      skip: () => !human().reserved.some((c) => c.id === TUT.advancedCardId),
      apply() {
        const p = human();
        const idx = p.reserved.findIndex((c) => c.id === TUT.advancedCardId);
        const card = p.reserved[idx];
        if (!card) { advance(); return; }
        if (canAfford(p, card)) {
          if (S.mode === 'buy') {
            if (S.selCard && S.selCard.kind === 'reserved' && S.selCard.ridx === idx) hl('#act-confirm', true);
            else hl('.rchip[data-ridx="' + idx + '"]', true);
            setBar({ title: this.title, text: S.selCard ? '确认收服刚盲抽的「' + card.name + '」。大师球会自动补足缺少的颜色。' : '点行动区下方的预约卡「' + card.name + '」。大师球可以代替缺少的任意颜色。', mode: 'action' });
          } else {
            hl('#act-buy', true);
            setBar({ title: this.title, text: '已经攒够收服「' + card.name + '」的球了！点「收服宝可梦」，然后选择预约卡。', mode: 'action' });
          }
        } else if (S.mode === 'take3' || S.mode === 'take2') {
          hlPoolColored();
          const need = S.mode === 'take2' ? 1 : Math.min(3, COLORS.filter((c) => S.pool[c] > 0).length);
          if (S.selColors.length === need) hl('#act-confirm', true);
          setBar({ title: this.title, text: '「' + card.name + '」还缺：' + missText(p, card) + '。选球后确认，攒够就能收服。', mode: 'action' });
        } else if (S.mode === 'takeMaster') {
          hl('#act-confirm', true);
          setBar({ title: this.title, text: '确认拿取大师球。它可以替代任意颜色，但稀有/传说卡的额外大师球费用必须单独支付。', mode: 'action' });
        } else if (S.mode === 'returnBalls') {
          hl('.pball.clickable', true);
          if (S.selColors.length) hl('#act-confirm', true);
          setBar({ title: this.title, text: '手牌已满时，退还暂时不需要的球，再按缺口补充。', mode: 'action' });
        } else {
          const full = totalBalls(p) >= RULES.handLimit;
          hl(full ? '#act-return' : '#act-take3', true);
          setBar({ title: this.title, text: '目标是收服刚盲抽的「' + card.name + '」。还缺：' + missText(p, card) + (full ? '。手牌已满，先退还多余的球。' : '。继续拿球；已有大师球会自动补差。'), mode: 'action' });
        }
      },
      canClick(e) {
        if (utilClick(e)) return true;
        if (S.mode === 'buy') return !!e.target.closest('.rchip,#act-confirm,#act-cancel');
        if (S.mode === 'take3' || S.mode === 'take2') return !!e.target.closest('.pool-group,#act-confirm,#act-cancel');
        if (S.mode === 'takeMaster') return !!e.target.closest('#act-confirm,#act-cancel');
        if (S.mode === 'returnBalls') return !!e.target.closest('.pball,#act-confirm,#act-cancel');
        const card = human().reserved.find((c) => c.id === TUT.advancedCardId);
        if (card && canAfford(human(), card)) return !!e.target.closest('#act-buy');
        return !!e.target.closest('#act-buy,#act-take3,#act-take2,#act-master,#act-return');
      },
    },
  ];
  function steps() { return TUT.kind === 'advanced' ? ADVANCED_STEPS : BASIC_STEPS; }

  /* ==================== 步骤机 ==================== */
  function advance() {
    if (TUT.kind === 'advanced' && TUT.stepIdx === 0) {
      const card = human().reserved.find((c) => c.blind && !TUT.snap.reservedIds.includes(c.id));
      TUT.advancedCardId = card && card.id;
    }
    TUT.armed = false;
    TUT.stepIdx++;
    if (TUT.stepIdx >= steps().length) { finishTutorial(); return; }
    render();
  }
  function finishTutorial() {
    TUT.finished = true;
    TUT.armed = false;
    clearHl();
    toast('训练完成！继续这局试着拿到 15 分吧！');
    setBar({ title: '训练完成', text: TUT.kind === 'advanced'
      ? '你已经练过盲抽、同色双球与收服预约卡。接下来试着规划加成与大师球，向稀有或传说宝可梦迈进。'
      : '你已经会拿球、收服和预约了。收服的卡会永久减少同色球的费用；先拿到目标分数，再等所有人走完相同回合数。', mode: 'done' });
  }
  function end() {
    TUT.active = false; TUT.finished = false; TUT.armed = false; TUT.stepIdx = -1;
    TUT.snap = null;
    TUT.advancedCardId = null;
    clearHl();
    if (bar) bar.hidden = true;
  }
  function showEvolveGuide() {
    hl('.btn.evolve', true);
    hl('#act-skip-evo', true);
    setBar({ title: '额外机会：免费进化', text: '这次行动后可以免费进化。点绿色按钮进化，也可以点「跳过进化」。每回合最多进化一次。', mode: 'action' });
  }

  /* 每次渲染后调用（幂等） */
  function afterRender() {
    if (!TUT.active || TUT.finished) return;
    if (!S) return;
    clearHl();
    if (S.over || S.phase === 'gameover') { end(); return; }
    const p = curPlayer();
    // 1. 完成判定（先于 AI 分支：行动完成后回合常已切给 AI）
    if (TUT.armed) {
      const step = steps()[TUT.stepIdx];
      if (step && step.isDone && step.isDone(TUT.snap)) { advance(); return; }
    }
    // 2. AI 回合：等待态
    if (p.isAI) {
      TUT.armed = false;
      const step = steps()[TUT.stepIdx];
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
    // 5. 当前任务
    const step = steps()[TUT.stepIdx];
    if (!step) { finishTutorial(); return; }
    // 6. 行动步骤
    if (!TUT.armed) {
      TUT.armed = true;
      TUT.snap = takeSnap();
      if (step.onArm && step.onArm()) { render(); return; }
    }
    if (step.skip && step.skip()) { toast('这一步的条件暂时不满足，先跳过'); advance(); return; }
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
    const p = curPlayer();
    if (p.isAI) return; // 电脑回合：随便看，游戏逻辑自己会拦行动
    // A. 进化机会：放行进化/跳过
    if (S.phase === 'evolve') {
      if (utilClick(e) || e.target.closest('.btn.evolve,#act-skip-evo')) return;
      e.stopPropagation(); e.preventDefault();
      toast('先点绿色进化按钮，或点「跳过进化」');
      return;
    }
    // B. discard 引导：只放行退球
    if (S.phase === 'discard') {
      if (utilClick(e) || e.target.closest('.pball')) return;
      e.stopPropagation(); e.preventDefault();
      toast('精灵球超过 ' + RULES.handLimit + ' 个啦，点自己面板里发光的球退回 1 个');
      return;
    }
    // C. 行动步骤白名单（canClick 内部负责提示）
    const step = steps()[TUT.stepIdx];
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
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', '新手训练进度');
      bar.hidden = true;
      const game = document.getElementById('screen-game');
      const main = game && game.querySelector('main');
      if (game && main) game.insertBefore(bar, main);
      else if (game) game.appendChild(bar);
      else document.body.appendChild(bar);
    }
  }
  function setBar({ title, text, mode }) {
    ensureUI();
    bar.className = 'tut-bar tut-' + mode;
    const done = mode === 'done';
    const activeSteps = steps();
    const progress = done ? activeSteps.length : Math.max(0, TUT.stepIdx);
    bar.innerHTML = `
      <div class="tut-progress" aria-label="${done ? '三个任务已完成' : '第 ' + (TUT.stepIdx + 1) + ' 个任务，共 3 个'}">
        ${activeSteps.map((s, i) => `<span class="tut-progress-item ${i < progress ? 'complete' : ''} ${!done && i === TUT.stepIdx ? 'current' : ''}"><span class="tut-progress-number">${i < progress ? '✓' : i + 1}</span>${s.title}</span>`).join('')}
      </div>
      <div class="tut-content">
        <div class="tut-copy"><strong class="tut-title"></strong><span class="tut-text" aria-live="polite"></span></div>
        <div class="tut-btns">
          <button type="button" class="btn ghost sm" id="tut-exit">结束教学局</button>
          ${done ? '<button type="button" class="btn primary sm" id="tut-done">继续对局</button>' : ''}
        </div>
      </div>
      ${done ? `<details class="tut-more"><summary>想了解进阶玩法？</summary>
        <p><b>进化：</b>持有进化前的宝可梦，加成满足条件且进化型出现时，回合结束可免费进化。</p>
        <p><b>稀有与传说：</b>分数和加成更高，收服需额外支付大师球，不能预约。</p>
        <p><b>盲抽：</b>预约时点击一至三阶牌堆，抽到的卡只有你能看到。</p>
      </details>` : ''}`;
    bar.querySelector('.tut-title').textContent = title;
    bar.querySelector('.tut-text').textContent = text;
    bar.hidden = false;
    const ex = document.getElementById('tut-exit');
    if (ex) ex.addEventListener('click', async () => {
      if (await spConfirm({ title: '结束教程', message: ONLINE ? '要结束教程吗？会返回大厅。' : '要结束教程吗？会回到设置页。', confirmText: '结束教程' })) {
        end();
        if (ONLINE) postApi({ type: 'backToLobby', cid: myCid }); // 本人即房主，可随时结束
        else backToSetup();
      }
    });
    const doneButton = document.getElementById('tut-done');
    if (doneButton) doneButton.addEventListener('click', () => { bar.hidden = true; });
    if (mode === 'action') showSpotlight();
    else hideSpotlight();
  }
  function ensureSpotlight() {
    if (spotlight) return;
    spotlight = document.createElement('div');
    spotlight.id = 'tut-spotlight';
    spotlight.setAttribute('aria-hidden', 'true');
    spotlight.hidden = true;
    for (let i = 0; i < 4; i++) {
      const shade = document.createElement('div');
      shade.className = 'tut-shade';
      spotlight.appendChild(shade);
    }
    const rim = document.createElement('div');
    rim.className = 'tut-spotlight-rim';
    spotlight.appendChild(rim);
    document.body.appendChild(spotlight);
  }
  function hideSpotlight() {
    spotlightTarget = null;
    if (spotlight) spotlight.hidden = true;
  }
  function positionSpotlight() {
    spotlightFrame = 0;
    if (!spotlightTarget || !spotlight || spotlight.hidden) return;
    if (!spotlightTarget.isConnected) { hideSpotlight(); return; }
    const rect = spotlightTarget.getBoundingClientRect();
    const w = window.innerWidth, h = window.innerHeight;
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= h) { hideSpotlight(); return; }
    const left = Math.max(0, rect.left - 7), top = Math.max(0, rect.top - 7);
    const right = Math.min(w, rect.right + 7), bottom = Math.min(h, rect.bottom + 7);
    const shades = spotlight.querySelectorAll('.tut-shade');
    const boxes = [
      [0, 0, w, top], [0, bottom, w, h - bottom],
      [0, top, left, bottom - top], [right, top, w - right, bottom - top],
    ];
    boxes.forEach(([x, y, width, height], i) => {
      shades[i].style.cssText = `left:${x}px;top:${y}px;width:${Math.max(0, width)}px;height:${Math.max(0, height)}px`;
    });
    spotlight.querySelector('.tut-spotlight-rim').style.cssText = `left:${left}px;top:${top}px;width:${Math.max(0, right - left)}px;height:${Math.max(0, bottom - top)}px`;
  }
  function queueSpotlightPosition() {
    if (!spotlightTarget || spotlightFrame) return;
    spotlightFrame = window.requestAnimationFrame(positionSpotlight);
  }
  function showSpotlight() {
    // 只开一个可点击的聚光区；多颜色精灵球共用供应区，避免多个遮罩互相盖住。
    const target = document.querySelector('#act-confirm.tut-hl')
      || (document.querySelector('.pool-group.tut-hl') && document.getElementById('pool-wrap'))
      || document.querySelector('.btn.tut-hl')
      || document.querySelector('.tier-label.tut-hl,.card.tut-hl,.rchip.tut-hl,.pball.tut-hl')
      || document.querySelector('.tut-target');
    if (!target) { hideSpotlight(); return; }
    ensureSpotlight();
    spotlightTarget = target;
    spotlight.hidden = false;
    const rect = target.getBoundingClientRect();
    if (rect.bottom < 72 || rect.top > window.innerHeight - 48) target.scrollIntoView({ block: 'center', behavior: 'auto' });
    queueSpotlightPosition();
  }
  function hl(sel, on) {
    if (!sel) return;
    document.querySelectorAll(sel).forEach((el) => el.classList.toggle('tut-hl', on));
  }
  function targetCard(sel) {
    const el = document.querySelector(sel);
    if (el) el.classList.add('tut-target');
  }
  function clearHl() {
    hideSpotlight();
    document.querySelectorAll('.tut-hl').forEach((el) => el.classList.remove('tut-hl'));
    document.querySelectorAll('.tut-target').forEach((el) => el.classList.remove('tut-target'));
  }
  /* ==================== 启动与收尾包装 ==================== */
  async function startTutorial(kind = 'basic') {
    if (tutStarting || TUT.active) return;
    TUT.kind = kind === 'advanced' ? 'advanced' : 'basic';
    TUT.advancedCardId = null;
    if (ONLINE) {
      // 联机：服务器一键建私有房间 + 电脑小智 + 15 分开局，对局状态经 SSE 推来
      tutStarting = true;
      try {
        const j = await postApi({ type: 'tutorial', token: myToken });
        if (!j.ok) return; // postApi 已提示错误
        TUT.active = true; TUT.finished = false; TUT.stepIdx = 0; TUT.armed = false;
        TUT.snap = null;
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
    TUT.snap = null;
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
    const origShowScreen = window.showScreen;
    window.showScreen = function (id) {
      if (id !== 'game' && TUT.active) end();
      return origShowScreen.apply(this, arguments);
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
    const make = (advanced) => {
      const b = document.createElement('button');
      b.className = 'btn lg tut-btn';
      b.textContent = advanced ? '进阶训练' : '三步新手训练';
      b.addEventListener('click', advanced ? () => startTutorial('advanced') : () => startTutorial('basic'));
      return b;
    };
    // 本地设置页（开始游戏前）注入：那一屏没有工具条，这是唯一入口。
    // 联机侧不再注入 —— 大厅（未进房 / 房内同一套外壳）统一走顶栏工具条「教程」，
    // 避免同一屏出现两颗教程按钮（去重靠"少注入一处"，不靠 CSS 藏起来）。
    const startBtn = document.getElementById('btn-start');
    if (startBtn && startBtn.parentNode) {
      startBtn.parentNode.insertBefore(make(false), startBtn);
      startBtn.parentNode.insertBefore(make(true), startBtn);
    }
  }

  /* ---- 初始化：装包装器、样式、按钮、拦截监听（两模式通用） ---- */
  // 教程入口要能被**本 IIFE 之外**的代码调用：大厅工具条「教程」弹层走 client.js，
  // 那里判的是全局 `typeof startTutorial === 'function'`。不挂到 window 上，
  // 工具条那颗按钮就永远落到 `toast('教程入口待接入')` 分支（濠哥报的"教程没接入"）。
  window.startTutorial = startTutorial;
  window.startAdvancedTutorial = () => startTutorial('advanced');
  ensureUI();
  wrapGlobals();
  injectButton();
  document.addEventListener('click', tutCapture, true);
  window.addEventListener('resize', queueSpotlightPosition);
  window.addEventListener('scroll', queueSpotlightPosition, true);
})();
