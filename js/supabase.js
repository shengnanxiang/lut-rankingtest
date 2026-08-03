// =====================================================================
// Supabase 客户端（用 REST API 直连，不依赖 SDK，减少首屏体积）
// anon key 可公开（行级安全由 RLS 控制），前端只允许 INSERT judgments
// =====================================================================

(function () {
  'use strict';

  const cfg = window.LRT_CONFIG.supabase;

  // 离线重试队列（PRD 异常处理）
  const QUEUE_KEY = 'lrt_pending_judgments';

  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch { return []; }
  }
  function saveQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {}
  }

  async function post(table, row) {
    const url = `${cfg.url}/rest/v1/${table}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': cfg.anonKey,
        'Authorization': `Bearer ${cfg.anonKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!r.ok) {
      const txt = await r.text();
      // 409 / 23505 = 唯一索引冲突（同一 voter 对同一对已投过票）
      // 这不是失败，是幂等保护生效。必须视为成功，否则会永久卡在重试队列里。
      if (r.status === 409 || txt.includes('23505') || txt.includes('duplicate key')) {
        return 'duplicate';
      }
      const err = new Error(`Supabase ${table} ${r.status}: ${txt.slice(0, 200)}`);
      err.status = r.status;
      // 4xx（除 409）多为配置错误（RLS 未开、表不存在、key 失效），重试没用
      err.permanent = r.status >= 400 && r.status < 500;
      throw err;
    }
    return true;
  }

  async function insertJudgment(rec) {
    try {
      const res = await post('judgments', rec);
      return { ok: true, queued: false, duplicate: res === 'duplicate' };
    } catch (e) {
      if (e.permanent) {
        // 配置类错误，重试无意义，直接报警不入队（避免队列无限膨胀）
        console.error('[supabase] 配置错误，判断未记录:', e.message);
        return { ok: false, queued: false, fatal: true };
      }
      // 网络类错误 → 入队，后台重试
      const q = loadQueue();
      q.push(rec);
      saveQueue(q);
      console.warn('[supabase] 网络失败，已入队重试:', e.message);
      return { ok: true, queued: true };
    }
  }

  async function flushQueue() {
    const q = loadQueue();
    if (!q.length) return 0;
    const remain = [];
    let flushed = 0;
    for (const rec of q) {
      try {
        await post('judgments', rec);
        flushed++;   // 含 'duplicate'：也算冲掉，从队列移除
      } catch (e) {
        if (e.permanent) { flushed++; continue; }  // 永久错误也丢弃，不然队列永不清空
        remain.push(rec);
      }
    }
    saveQueue(remain);
    return flushed;
  }

  async function get(table, query) {
    const url = `${cfg.url}/rest/v1/${table}?${query}`;
    const r = await fetch(url, {
      headers: { 'apikey': cfg.anonKey, 'Authorization': `Bearer ${cfg.anonKey}` }
    });
    if (!r.ok) throw new Error(`Supabase GET ${table} ${r.status}`);
    return r.json();
  }

  // 拉取某个 test 的所有判断（结果页用）
  // Supabase REST 默认单页上限 1000 行，需用 limit+offset 分页拉全，否则总判断数会卡在 1000
  // 与 lutstyles 站 editor 的分页逻辑保持一致，确保两边排名基于同一份全量数据
  async function fetchJudgments(testId) {
    const PAGE = 1000;
    let all = [];
    let offset = 0;
    while (true) {
      const rows = await get('judgments',
        `test_id=eq.${encodeURIComponent(testId)}&select=*&order=ts.asc&limit=${PAGE}&offset=${offset}`);
      if (!Array.isArray(rows) || rows.length === 0) break;
      all = all.concat(rows);
      if (rows.length < PAGE) break; // 最后一页
      offset += rows.length;
    }
    return all;
  }

  // 匿名 voter_id：首次进入生成 + 存 localStorage
  function getVoterId() {
    let id = localStorage.getItem('lrt_voter_id');
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
            ('v-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
      localStorage.setItem('lrt_voter_id', id);
    }
    return id;
  }

  // 浏览器指纹：基于设备硬件特征生成稳定标识
  // 用途：即使受访者清除 localStorage 或使用无痕模式，同设备同浏览器仍能识别为同一人。
  // 不依赖 cookie / canvas / WebGL，纯功能检测，隐私友好。
  function generateFingerprint() {
    const parts = [
      navigator.userAgent || '',
      screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || 0),
      navigator.hardwareConcurrency || 0,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      navigator.language || '',
      navigator.platform || ''
    ];
    const raw = parts.join('|');
    // 简单 hash（非加密用途，仅作去重 key；用减法 hash 兼顾速度与均匀性）
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    }
    return 'fp-' + Math.abs(h).toString(36);
  }

  // 后台定期重试队列 + 页面可见时立即冲一次
  setInterval(flushQueue, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushQueue();
  });

  window.LRT_SUPABASE = {
    insertJudgment,
    flushQueue,
    fetchJudgments,
    getVoterId,
    getFingerprint: generateFingerprint,
    _queueSize: () => loadQueue().length
  };
})();