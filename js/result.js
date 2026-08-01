// =====================================================================
// 结果页（result.html）：拉全量判断 → 算 Top10 + 5/5/6/6 + 导出
// =====================================================================

(function () {
  'use strict';

  const cfg = window.LRT_CONFIG;
  const lutById = {};
  cfg.luts.forEach(l => lutById[l.lutId] = l);

  function fmtName(lutId) {
    const l = lutById[lutId];
    return l ? l.displayName : lutId;
  }

  async function load() {
    let judgments = [];
    let usedFallback = false;
    let errMsg = '';
    try {
      judgments = await window.LRT_SUPABASE.fetchJudgments(cfg.testId);
    } catch (e) {
      errMsg = e.message || String(e);
      document.querySelector('#err-banner').textContent =
        '拉取数据失败：' + errMsg + '。如刚配 Supabase RLS，请确认 policies.sql 已执行。';
      document.querySelector('#err-banner').style.display = 'block';
    }
    const lutIds = cfg.luts.map(l => l.lutId);
    const result = window.LRT_RANKING.rank(judgments || [], lutIds, cfg.ranking);
    usedFallback = result.usedFallback;

    // 总览
    document.querySelector('#stat-total').textContent = judgments.length;
    const voters = new Set(judgments.map(j => j.voter_id)).size;
    document.querySelector('#stat-voters').textContent = voters;
    const avg = voters ? (judgments.length / voters).toFixed(1) : '0';
    document.querySelector('#stat-avg').textContent = avg;
    document.querySelector('#stat-test').textContent = cfg.testId;
    if (usedFallback) {
      document.querySelector('#fallback-note').style.display = 'block';
    }

    // Top10
    const topGrid = document.querySelector('#top10-grid');
    topGrid.innerHTML = result.top.map(t => `
      <div class="top10-cell">
        <div class="rank">#${t.rank}</div>
        <div class="name">${fmtName(t.lutId)}</div>
        <div class="score">胜率 ${(t.winrate * 100).toFixed(0)}% ±${(t.ci * 100).toFixed(0)}%</div>
      </div>
    `).join('');

    // 分档
    const tierLabels = ['第 11–15 名', '第 16–20 名', '第 21–26 名', '第 27–32 名'];
    const tiersEl = document.querySelector('#tiers');
    tiersEl.innerHTML = result.tiers.map((tier, i) => `
      <div class="tier">
        <div class="tier-label">${tierLabels[i] || ('档 ' + (i+1))}（${tier.length}）</div>
        <div class="tier-list">
          ${tier.map(t => `<span class="tier-chip">${fmtName(t.lutId)} · ${(t.winrate * 100).toFixed(0)}%</span>`).join('')}
        </div>
      </div>
    `).join('');

    // 导出
    document.querySelector('#btn-export-csv').addEventListener('click', () => exportCsv(judgments));
    document.querySelector('#btn-export-json').addEventListener('click', () => exportJson(result, judgments));
  }

  function exportCsv(judgments) {
    const headers = ['test_id', 'voter_id', 'lut_a', 'lut_b', 'winner', 'photo', 'ts', 'resp_ms'];
    const rows = judgments.map(j => headers.map(h => JSON.stringify(j[h] ?? '')).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    download(`judgments-${cfg.testId}.csv`, csv, 'text/csv');
  }

  function exportJson(result, judgments) {
    const data = {
      testId: cfg.testId,
      generatedAt: new Date().toISOString(),
      totalJudgments: judgments.length,
      top10: result.top.map(t => ({ rank: t.rank, lutId: t.lutId, name: fmtName(t.lutId), winrate: t.winrate, ci: t.ci })),
      tiers: result.tiers.map((tier, i) => ({
        label: ['tier1','tier2','tier3','tier4'][i],
        items: tier.map(t => ({ lutId: t.lutId, name: fmtName(t.lutId), winrate: t.winrate }))
      }))
    };
    download(`ranking-${cfg.testId}.json`, JSON.stringify(data, null, 2), 'application/json');
  }

  function download(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();