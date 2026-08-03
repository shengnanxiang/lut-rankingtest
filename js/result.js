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
        <div class="pk" title="该风格参与判断 PK 的次数">PK ${(result.stats[t.lutId] ? result.stats[t.lutId].n : 0)}</div>
      </div>
    `).join('');

    // 分档
    const tierLabels = ['第 11–15 名', '第 16–20 名', '第 21–26 名', '第 27–32 名'];
    const tiersEl = document.querySelector('#tiers');
    tiersEl.innerHTML = result.tiers.map((tier, i) => `
      <div class="tier">
        <div class="tier-label">${tierLabels[i] || ('档 ' + (i+1))}（${tier.length}）</div>
        <div class="tier-list">
          ${tier.map(t => `<span class="tier-chip">${fmtName(t.lutId)} · ${(t.winrate * 100).toFixed(0)}% · PK ${result.stats[t.lutId] ? result.stats[t.lutId].n : 0}</span>`).join('')}
        </div>
      </div>
    `).join('');

    // 导出
    document.querySelector('#btn-export-csv').addEventListener('click', () => exportCsv(judgments));
    document.querySelector('#btn-export-json').addEventListener('click', () => exportJson(result, judgments));

    // 样本量 / 95% 置信区间评估
    renderSampleSize(judgments, lutIds.length);

    // 参与均衡检查（按 PK 次数排序，识别低参与偏差）
    renderBalance(lutIds, result, fmtName);
  }

  // 样本量评估模块
  function renderSampleSize(judgments, lutCount) {
    const box = document.querySelector('#sample-size');
    if (!box) return;
    const s = window.LRT_RANKING.sampleSizeAssessment(judgments, lutCount);
    const pct = Math.min(100, (s.totalJudgments / s.targetTotal) * 100);
    const hw = isFinite(s.currentHalfWidth) ? (s.currentHalfWidth * 100).toFixed(1) : '∞';
    const ciRows = s.ciTargets.map(t => `
      <tr>
        <td>±${(t.halfWidth * 100).toFixed(0)}%</td>
        <td>${t.nPerStyle}</td>
        <td>${t.totalJudgments}</td>
      </tr>
    `).join('');

    box.innerHTML = `
      <h3>样本量评估（95% 置信区间）</h3>
      <p class="ss-line">当前总判断数：<b>${s.totalJudgments}</b> 次　|　平均每风格 PK：<b>${s.avgNPerStyle.toFixed(1)}</b> 次</p>
      <p class="ss-line">当前胜率估计 95% CI 半宽（最坏情况）：<b>±${hw}%</b></p>
      <div class="ss-progress"><div class="ss-progress-fill" style="width:${pct.toFixed(0)}%"></div></div>
      <p class="ss-line">达标进度（每风格 ≥ ${s.targetPerStyle} 次 PK，目标总 ${s.targetTotal} 次）：${pct.toFixed(0)}%</p>
      <table class="ss-table">
        <thead><tr><th>目标 CI 半宽</th><th>单风格需 PK</th><th>所需总判断数</th></tr></thead>
        <tbody>${ciRows}</tbody>
      </table>
      <p class="ss-hint">说明：每对 PK 同时计入 2 个风格各 1 次，故总判断数 = 单风格目标 × 风格数 ÷ 2。样本越均衡、单风格 PK 越多，排名越稳定。</p>
    `;
  }

  // 参与均衡检查：按 PK 次数升序，低参与标红 + 条形可视化
  function renderBalance(lutIds, result, fmtName) {
    const box = document.querySelector('#balance-check');
    if (!box || !result.balance) return;
    const balance = result.balance;
    const nOf = id => (result.stats[id] && result.stats[id].n) || 0;
    const target = balance.targetPerStyle;
    const maxN = Math.max(1, balance.maxN);
    // 按 PK 次数升序（参与最少的排最前，便于发现偏差）
    const sortedByN = lutIds.slice().sort((a, b) => nOf(a) - nOf(b));
    const rows = sortedByN.map(id => {
      const n = nOf(id);
      const ratio = n / maxN;
      const low = n < target;
      return `
        <div class="bal-row ${low ? 'bal-low' : ''}">
          <span class="bal-name">${fmtName(id)}</span>
          <span class="bal-bar"><span class="bal-bar-fill" style="width:${(ratio * 100).toFixed(0)}%"></span></span>
          <span class="bal-n">${n}${low ? ' ⚠' : ''}</span>
        </div>
      `;
    }).join('');

    const cvPct = (balance.cv * 100).toFixed(0);
    // CV 颜色标签：衡量「参与均衡度」（不是样本总量）
    //   <20% 均衡(绿) / 20%–40% 一般(黄) / >40% 失衡(红)
    const cvClass = balance.cv < 0.2 ? 'cv-good' : (balance.cv <= 0.4 ? 'cv-ok' : 'cv-bad');
    const cvLabel = balance.cv < 0.2 ? '均衡' : (balance.cv <= 0.4 ? '一般' : '失衡');
    box.innerHTML = `
      <h3>参与均衡检查（按 PK 次数升序）</h3>
      <p class="ss-line">参与风格数：<b>${balance.nParticipated}</b> / ${lutIds.length}　|
        最少 <b>${balance.minN}</b>　最多 <b>${balance.maxN}</b>　平均 <b>${balance.avgN.toFixed(1)}</b>　|
        变异系数 CV <b class="${cvClass}">${cvPct}%</b> <span class="cv-tag ${cvClass}">${cvLabel}</span></p>
      <p class="ss-line">目标每风格 ≥ ${target} 次　|　未达标 ${balance.underTarget.length} 个　|
        还需约 <b>${balance.extraJudgments}</b> 次判断使全部达标</p>
      <div class="bal-list">${rows}</div>
      <p class="ss-hint">⚠ 标红 = 未达目标参与次数，其排名可信度偏低，建议补充该风格的 PK。理想情况下所有风格 PK 次数应一致（CV→0%）。<br>
      📌 CV（变异系数）= 参与次数的标准差÷平均数，衡量的是「<b>均衡度</b>」而非样本总量；样本总量够不够请看上方「样本量评估」的 95% CI 半宽（±X%）。CV 越小越均衡：&lt;20% 均衡、20%–40% 一般、&gt;40% 失衡。</p>
    `;
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