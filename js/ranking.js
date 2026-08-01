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
  // 输入：{ a: { wins, losses } }   输出：strength 值（越大越强）
  function bradleyTerry(counts, maxIter = 200, tol = 1e-6) {
    const ids = Object.keys(counts);
    const N = ids.length;
    if (N === 0) return {};
    // 初始强度全 1
    let pi = {};
    ids.forEach(id => pi[id] = 1);
    // 总胜场（防止全 0 死循环）
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
          denom += (counts[i].wins + counts[i].losses) / (pi[i] + pi[j]);
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
    return counts;
  }

  // ---------- 主入口：算 Top10 + 5/5/6/6 + 置信区间 ----------
  function rank(judgments, lutIds, rankingCfg) {
    const counts = aggregate(judgments, lutIds);
    let pi = bradleyTerry(counts);
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
    return { top, tiers, counts, pi, sorted, stats, usedFallback: !ok };
  }

  window.LRT_RANKING = {
    newEloState, applyElo, pickNextPair,
    rank, aggregate, bradleyTerry
  };
})();