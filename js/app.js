// =====================================================================
// 参与者主流程：A/B 对比、左右随机、平局/跳过、自适应配对、进度
// 速度策略：
//   1) 进入页面立即 prefetch 所有 _sm 图（~6MB 总，但很轻），放 Image 缓存
//   2) 每次新对展示前预加载 lg 图（srcset sm→lg 渐进）
//   3) lg 加载完才解锁点击（视觉占位 + 加载态）
// =====================================================================

(function () {
  'use strict';

  const cfg = window.LRT_CONFIG;
  const lutIds = cfg.luts.map(l => l.lutId);
  const photoIds = cfg.photos.map(p => p.id);

  // ---------- 状态 ----------
  // history 持久化到 localStorage：这样「再做一轮」时能避开已比过的对，
  // 否则会重复命中服务端唯一索引，第二轮数据全部落空。
  const HIST_KEY = `lrt_hist_${cfg.testId}`;

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }
    catch { return []; }
  }
  function saveHistory(h) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch {}
  }

  const savedHistory = loadHistory();

  const state = {
    pairIdx: 0,             // 本轮已完成对数（不含历史轮次）
    history: savedHistory,  // [{a, b, winner, photo, position, ts, respMs}] 跨轮累计
    elo: window.LRT_RANKING.newEloState(lutIds),
    currentPair: null,      // [lutA, lutB]
    currentPhoto: null,
    currentLeftIsA: null,   // true: 左=A；false: 左=B
    pairShownTs: 0
  };

  // 用历史重建 Elo，让自适应配对从上轮的认知继续，而不是从 1500 重来
  for (const h of savedHistory) {
    if (h.winner === 'tie') window.LRT_RANKING.applyElo(state.elo, h.a, h.b, true);
    else if (h.winner === h.a || h.winner === h.b) {
      window.LRT_RANKING.applyElo(state.elo, h.winner, h.winner === h.a ? h.b : h.a, false);
    }
  }

  // ---------- DOM ----------
  const $progressFill = () => document.querySelector('.progress-bar-fill');
  const $progressText = () => document.querySelector('.progress-text');
  const $leftImg = () => document.querySelector('.compare-side.left img');
  const $rightImg = () => document.querySelector('.compare-side.right img');
  const $leftSide = () => document.querySelector('.compare-side.left');
  const $rightSide = () => document.querySelector('.compare-side.right');

  function urlFor(lutId, photoId, size /* 'lg' | 'sm' */) {
    const sub = size === 'sm' ? '_sm/' : '';
    return `renders/${photoId}/${sub}${lutId}.jpg`;
  }

  // 预热：把所有 sm 图塞进浏览器缓存（一次 160 个并发请求，限速 6 并发）
  async function prefetchAllSm() {
    const tasks = [];
    for (const p of photoIds) {
      for (const l of lutIds) {
        tasks.push(() => new Promise(res => {
          const img = new Image();
          img.onload = img.onerror = () => res();
          img.src = urlFor(l, p, 'sm');
        }));
      }
    }
    // 简单并发 6
    const concurrency = 6;
    let i = 0;
    async function worker() {
      while (i < tasks.length) {
        const t = tasks[i++];
        await t();
      }
    }
    await Promise.all(Array.from({length: concurrency}, worker));
    console.log('[lrt] sm 图预热完成');
  }

  // 等两张 lg 图加载完
  function loadImage(src) {
    return new Promise(res => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = src;
    });
  }

  async function preloadPair(photoId, lutA, lutB) {
    const [la, lb] = await Promise.all([
      loadImage(urlFor(lutA, photoId, 'lg')),
      loadImage(urlFor(lutB, photoId, 'lg'))
    ]);
    return { la, lb };
  }

  // ---------- 流程 ----------
  async function startNewPair() {
    if (state.pairIdx >= cfg.comparisonsPerVoter) return finish();

    const pair = window.LRT_RANKING.pickNextPair(state.elo, lutIds, state.history);
    if (!pair) return finish();
    const [a, b] = pair;
    const photo = photoIds[Math.floor(Math.random() * photoIds.length)];
    const leftIsA = Math.random() < 0.5;

    // 显示占位
    $leftSide().classList.remove('loaded');
    $rightSide().classList.remove('loaded');

    // 预加载 lg
    const { la, lb } = await preloadPair(photo, a, b);
    if (!la || !lb) {
      console.error('图片加载失败', { photo, a, b });
      // 跳过该对
      state.pairIdx++;
      return startNewPair();
    }

    $leftImg().src = la.src;
    $rightImg().src = lb.src;
    $leftSide().classList.add('loaded');
    $rightSide().classList.add('loaded');

    state.currentPair = [a, b];
    state.currentPhoto = photo;
    state.currentLeftIsA = leftIsA;
    state.pairShownTs = Date.now();

    // 预取下一对的 sm 图
    prefetchNextPairSm();
    updateProgress();
  }

  function prefetchNextPairSm() {
    const pair = window.LRT_RANKING.pickNextPair(state.elo, lutIds, state.history);
    if (!pair) return;
    const [a, b] = pair;
    const photo = photoIds[Math.floor(Math.random() * photoIds.length)];
    [urlFor(a, photo, 'sm'), urlFor(b, photo, 'sm')].forEach(u => {
      const im = new Image(); im.src = u;
    });
  }

  async function submitChoice(side /* 'left' | 'right' | 'tie' */) {
    if (!state.currentPair) return;
    const [a, b] = state.currentPair;
    const leftIsA = state.currentLeftIsA;
    let winner;
    if (side === 'tie') winner = 'tie';
    else {
      const leftLut = leftIsA ? a : b;
      const rightLut = leftIsA ? b : a;
      winner = side === 'left' ? leftLut : rightLut;
    }
    const respMs = Date.now() - state.pairShownTs;
    const position = leftIsA ? { left: a, right: b } : { left: b, right: a };

    // 实时更新 Elo
    if (winner === 'tie') {
      window.LRT_RANKING.applyElo(state.elo, a, b, true);
    } else {
      const loser = winner === a ? b : a;
      window.LRT_RANKING.applyElo(state.elo, winner, loser, false);
    }

    const record = {
      test_id: cfg.testId,
      voter_id: window.LRT_SUPABASE.getVoterId(),
      lut_a: a,
      lut_b: b,
      winner,
      photo: state.currentPhoto,
      position: position,
      ts: new Date().toISOString(),
      resp_ms: respMs
    };
    state.history.push({ a, b, winner, photo: state.currentPhoto, position, ts: record.ts, respMs });
    saveHistory(state.history);
    state.pairIdx++;

    // 异步入库（不阻塞 UI）
    window.LRT_SUPABASE.insertJudgment(record).catch(e => console.warn(e));

    // 防快速乱点：< 250ms 不计
    if (respMs < 250) {
      console.warn('反应过快', respMs);
    }

    if (state.pairIdx >= cfg.comparisonsPerVoter) return finish();
    await startNewPair();
  }

  function finish() {
    document.querySelector('#compare-view').style.display = 'none';
    document.querySelector('.progress').style.display = 'none';
    document.querySelector('#done-view').style.display = 'block';
    // 实际提交数 = 本轮完成数（跳过的不入库，所以按 history 本轮增量算）
    document.querySelector('#done-count').textContent = state.pairIdx;
    // 若 32 个 LUT 的对已被这位参与者比完，隐藏「再做一轮」
    const remaining = window.LRT_RANKING.pickNextPair(state.elo, lutIds, state.history);
    if (!remaining) {
      const btn = document.querySelector('.btn-restart');
      if (btn) btn.style.display = 'none';
      document.querySelector('#done-view p').textContent +=
        ' 你已经比完了所有可比的组合，非常感谢！';
    }
    // 最后冲一次队列
    window.LRT_SUPABASE.flushQueue();
  }

  function updateProgress() {
    const total = cfg.comparisonsPerVoter;
    const done = state.pairIdx;
    $progressFill().style.width = `${(done / total) * 100}%`;
    $progressText().textContent = `第 ${done + 1} / ${total} 次`;
  }

  // ---------- 初始化 ----------
  async function init() {
    // 绑定按钮
    $leftSide().addEventListener('click', () => submitChoice('left'));
    $rightSide().addEventListener('click', () => submitChoice('right'));
    document.querySelector('.btn-tie').addEventListener('click', () => submitChoice('tie'));
    document.querySelector('.btn-skip').addEventListener('click', () => {
      // 必须把跳过的对写进 history，否则 pickNextPair 会立刻again选中同一对
      // （它是「分差最小 + 出场最少」的最优解），用户会卡在同一屏反复跳过。
      if (state.currentPair) {
        const [a, b] = state.currentPair;
        state.history.push({ a, b, winner: 'skip', photo: state.currentPhoto, ts: new Date().toISOString() });
        saveHistory(state.history);
      }
      state.pairIdx++;  // skip 计入进度，但不入库
      if (state.pairIdx >= cfg.comparisonsPerVoter) finish();
      else startNewPair();
    });
    document.querySelector('.btn-restart').addEventListener('click', () => location.reload());

    // 键盘快捷键（桌面端）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') submitChoice('left');
      else if (e.key === 'ArrowRight') submitChoice('right');
      else if (e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); submitChoice('tie'); }
    });

    // 异步预热 + 启动首对
    updateProgress();
    prefetchAllSm().catch(() => {});
    await startNewPair();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();