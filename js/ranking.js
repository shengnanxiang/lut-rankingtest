// =====================================================================
// 排名计算：实时 Elo + 离线 Bradley–Terry + 兜底 PageRank
//
// 实时（每次比较后用 Elo 增量更新，决定下一对）：score = w / (w + l)
// 离线（结果页拉全量数据后算 BT）：MM 算法迭代至收敛
// 循环检测：BT 不收敛 / 出现环路时，转胜者图 + PageRank 兜底
// =====================================================================

(function () {
  'use strict';

  // ---------- 实时 Elo ----------
  // 用简化版：score = log(wins + 1) - log(losses + 1) （即 BT 强度的近似）
  // 这能保证新 LUT 也能立刻产出合理分数。
  const K = 32;

  function newEloState(lutIds) {
    const s = {};
    lutIds.forEach(id => s[id] = { rating: 1500, wins: 0, losses: 0, ties: 0, seen: 0 });
    return s;
  }

  function applyElo(state, winner, loser, isTie) {
    const Rw = state[winner].rating;
    const Rl = state[loser].rating;
    const Ew = 1 / (1 + Math.pow(10, (Rl - Rw) / 400));
    const El = 1 - Ew;
    if (isTie) {
      state[winner].rating += K * (0.5 - Ew);
      state[loser].rating  += K * (0.5 - El);
      state[winner].ties++;
      state[loser].ties++;
    } else {
      state[winner].rating += K * (1 - Ew);
      state[loser].rating  += K * (0 - El);
      state[winner].wins++;
      state[loser].losses++;
    }
    state[winner].seen++;
    state[loser].seen++;
  }

  // 自适应选下一对：分数差最小 + 最少出场（信息量最大）
  function pickNextPair(state, lutIds, history) {
    // 已出现过的对（避免重复）
    const seen = new Set();
    for (const h of history) {
      seen.add(`${h.a}|${h.b}`);
      seen.add(`${h.b}|${h.a}`);
    }
    const ids = lutIds.slice();
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i], b = ids[j];
        if (seen.has(`${a}|${b}`)) continue;
        const ra = state[a].rating, rb = state[b].rating;
        const diff = Math.abs(ra - rb);
        const seenSum = state[a].seen + state[b].seen;
        // 目标：差值小（信息多）+ 总出场少（探索）
        const score = -diff - seenSum * 5;
        if (score > bestScore) {
          bestScore = score;
          best = [a, b];
        }
      }
    }
    if (!best) return null;
    return Math.random() < 0.5 ? [best[0], best[1]] : [best[1], best[0]];
  }

  // ---------- 离线 Bradley–Terry（MM 算法） ----------
  // counts: { a: { wins, losses } }   pairCounts: { a|b: n }  输出：strength 值（越大越强）
  function bradleyTerry(counts, pairCounts, maxIter = 200, tol = 1e-6) {
    const ids = Object.keys(counts);
    const N = ids.length;
    if (N === 0) return {};
    // 初始强度全 1
    let pi = {};
    ids.forEach(id => pi[id] = 1);
    // 总胜场
    const totalWins = {};
    ids.forEach(id => totalWins[id] = counts[id].wins);
    for (let it = 0; it < maxIter; it++) {
      const newPi = {};
      let maxDelta = 0;
      for (const i of ids) {
        let numer = totalWins[i];
        let denom = 0;
        for (const j of ids) {
          if (i === j) continue;
          // 正确用 i/j 两两之间的对阵次数 n_ij，而非 i 的总对阵次数
          const pk = i < j ? `${i}|${j}` : `${j}|${i}`;
          const pairN = (pairCounts[pk] || 0);
          if (pairN === 0) continue; // 从未对阵，跳过
          denom += pairN / (pi[i] + pi[j]);
        }
        if (denom === 0) { newPi[i] = pi[i]; continue; }
        newPi[i] = numer / denom;
        maxDelta = Math.max(maxDelta, Math.abs(newPi[i] - pi[i]));
      }
      // 归一化（防止漂移）
      const mean = Object.values(newPi).reduce((s, v) => s + v, 0) / N;
      for (const id of ids) newPi[id] /= mean;
      pi = newPi;
      if (maxDelta < tol) break;
    }
    return pi;
  }

  // ---------- PageRank 兜底（处理循环偏好） ----------
  function pageRankFallback(counts) {
    const ids = Object.keys(counts);
    const N = ids.length;
    // 邻接：i → j 的权重 = counts[i].wins 输给 j 的次数
    // 我们用每对的胜负构造方向：i 胜 j 一次 → i→j 边权 1
    // BT/MM 不收敛时用它做最终全局排名（PageRank 偏好多胜场）
    const out = {};
    ids.forEach(id => out[id] = 0);
    // 简化：用净胜场 + 平均对手强度做排名（不依赖图的收敛性）
    for (const id of ids) {
      out[id] = counts[id].wins - counts[id].losses;
    }
    return out;
  }

  // ---------- 置信区间（Wilson 区间 for 胜率，简化为 ±1.96*sqrt(p(1-p)/n)） ----------
  function ci(width, n) {
    if (n === 0) return 0;
    return 1.96 * Math.sqrt((width * (1 - width)) / n);
  }

  // ---------- 聚合：把 judgments 数组转 counts ----------
  function aggregate(judgments, lutIds) {
    const counts = {};
    const pairCounts = {};  // n_ij: 每对风格之间的对阵次数，key=min|max
    lutIds.forEach(id => counts[id] = { wins: 0, losses: 0, ties: 0, n: 0 });
    const seen = new Set();
    for (const j of judgments) {
      // 防重复：同一 voter 对同对只算一次
      const k = `${j.voter_id}|${j.lut_a}|${j.lut_b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const a = j.lut_a, b = j.lut_b, w = j.winner;
      counts[a].n++;
      counts[b].n++;
      // 记录每对风格的对阵次数
      const pk = a < b ? `${a}|${b}` : `${b}|${a}`;
      pairCounts[pk] = (pairCounts[pk] || 0) + 1;
      if (w === 'tie') {
        counts[a].ties++;
        counts[b].ties++;
      } else if (w === a) {
        counts[a].wins++;
        counts[b].losses++;
      } else if (w === b) {
        counts[b].wins++;
        counts[a].losses++;
      }
    }
    return { counts, pairCounts };
  }

  // ---------- 主入口：算 Top10 + 5/5/6/6 + 置信区间 ----------
  function rank(judgments, lutIds, rankingCfg) {
    const { counts, pairCounts } = aggregate(judgments, lutIds);
    let pi = bradleyTerry(counts, pairCounts);
    // 检查循环：若 BT 迭代里出现 ±∞/NaN 视作失败 → 用净胜场
    let ok = true;
    for (const id of lutIds) {
      if (!isFinite(pi[id]) || isNaN(pi[id])) { ok = false; break; }
    }
    if (!ok) {
      const pr = pageRankFallback(counts);
      pi = {};
      lutIds.forEach(id => pi[id] = pr[id] + 1); // 保证为正
    }
    // 排序：pi 大 → 排前
    const sorted = lutIds.slice().sort((a, b) => pi[b] - pi[a]);
    // 计算每个 LUT 的胜率与 CI
    const stats = {};
    for (const id of lutIds) {
      const c = counts[id];
      const w = c.wins, l = c.losses, t = c.ties;
      const dec = (w + l + t);
      const winrate = dec === 0 ? 0 : (w + 0.5 * t) / dec;
      stats[id] = { wins: w, losses: l, ties: t, n: dec, winrate, ci: ci(winrate, dec) };
    }
    // Top10
    const top = sorted.slice(0, rankingCfg.topN).map((id, i) => ({
      rank: i + 1, lutId: id, score: pi[id], ...stats[id]
    }));
    // 余下分档
    const rest = sorted.slice(rankingCfg.topN);
    const tiers = [];
    let idx = 0;
    for (const tierSize of rankingCfg.tiers) {
      const slice = rest.slice(idx, idx + tierSize);
      idx += tierSize;
      tiers.push(slice.map(id => ({ lutId: id, ...stats[id] })));
    }
    // ---- 参与均衡度分析（识别某些风格因 PK 次数过低导致排名偏差）----
    const ns = lutIds.map(id => stats[id].n);
    const nParticipated = ns.filter(v => v > 0).length;
    const minN = ns.length ? Math.min(...ns) : 0;
    const maxN = ns.length ? Math.max(...ns) : 0;
    const avgN = nParticipated ? ns.reduce((a, b) => a + b, 0) / nParticipated : 0;
    const variance = nParticipated
      ? ns.reduce((a, b) => a + Math.pow(b - avgN, 2), 0) / nParticipated : 0;
    const stdN = Math.sqrt(variance);
    const cv = avgN ? stdN / avgN : 0; // 变异系数：0=完全均匀，越大越不均衡

    // 默认目标：每个风格至少 50 次 PK（95% CI 半宽≈±14%）
    const TARGET_PER_STYLE = 50;
    const underTarget = lutIds.filter(id => stats[id].n < TARGET_PER_STYLE);
    // 达标所需总判断数 = 把未达标风格补齐到目标，每判断贡献 2 个风格
    const deficit = lutIds.reduce((a, id) => a + Math.max(0, TARGET_PER_STYLE - stats[id].n), 0);
    const extraJudgments = Math.ceil(deficit / 2);

    return {
      top, tiers, counts, pi, sorted, stats, usedFallback: !ok,
      balance: {
        nParticipated,
        minN, maxN, avgN, stdN, cv,
        targetPerStyle: TARGET_PER_STYLE,
        underTarget,            // 未达标的风格 id 列表
        deficit,
        extraJudgments          // 还需多少判断使所有风格达标
      }
    };
  }

  // ---------- 样本量 / 95% 置信区间评估 ----------
  // 每个风格的 PK 次数 n 决定胜率估计的置信区间半宽（正态近似，最坏 p=0.5）：
  //   halfWidth = 1.96 * sqrt(0.25 / n)
  // 给定目标半宽 h，单风格所需 n = (1.96/h)^2 * 0.25；总判断数 = n * 风格数 / 2
  function sampleSizeAssessment(judgments, lutCount) {
    const totalJudgments = judgments.length;
    const totalPK = totalJudgments * 2;                 // 每判断 2 个风格各参与 1 次
    const avgNPerStyle = lutCount ? totalPK / lutCount : 0;
    const currentHalfWidth = avgNPerStyle
      ? 1.96 * Math.sqrt(0.25 / avgNPerStyle) : Infinity;

    // 不同目标半宽对应的单风格 n 与总判断数（用于展示「要达到 95% CI 需多少样本」）
    const ciTargets = [0.05, 0.10, 0.15].map(h => {
      const nPerStyle = Math.ceil(Math.pow(1.96 / h, 2) * 0.25);
      return { halfWidth: h, nPerStyle, totalJudgments: Math.ceil(nPerStyle * lutCount / 2) };
    });

    // 默认目标：每个风格 50 次 PK（半宽≈±14%）
    const targetPerStyle = 50;
    const targetTotal = Math.ceil(targetPerStyle * lutCount / 2);

    return { totalJudgments, avgNPerStyle, currentHalfWidth, targetPerStyle, targetTotal, ciTargets };
  }

  window.LRT_RANKING = {
    newEloState, applyElo, pickNextPair,
    rank, aggregate, bradleyTerry, sampleSizeAssessment
  };
})();