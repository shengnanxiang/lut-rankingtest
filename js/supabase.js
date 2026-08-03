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

  // 拉取某个 test 的所有判断（结果页用）
  // Supabase REST 默认单页上限 1000 行，需分页（Range 头）拉全，否则总判断数会卡在 1000
  async function fetchJudgments(testId) {
    const PAGE = 1000;
    const all = [];
    let from = 0;
    while (true) {
      const query = `test_id=eq.${encodeURIComponent(testId)}&select=*&order=ts.asc`;
      const url = `${cfg.url}/rest/v1/judgments?${query}`;
      const r = await fetch(url, {
        headers: {
          'apikey': cfg.anonKey,
          'Authorization': `Bearer ${cfg.anonKey}`,
          'Range': `${from}-${from + PAGE - 1}`
        }
      });
      if (!r.ok) throw new Error(`Supabase GET judgments ${r.status}`);
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < PAGE) break; // 最后一页
      from += PAGE;
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
    _queueSize: () => loadQueue().length
  };
})();