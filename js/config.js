// =====================================================================
// LUT 偏好排序测试 · 配置（config-driven：未来改这里就能开新批次）
// 改完后需要重新运行 `python tools/prerender.py` 生成新的 renders/
// =====================================================================

window.LRT_CONFIG = {
  // 当前批次 ID，决定 Supabase 存储与查询隔离
  testId: 'v1-2025-Q3',

  // 批次标题（页面顶部展示）
  title: 'LUT 风格偏好调研 · 第一轮',
  subtitle: '每次会看到同一张照片套了两种不同风格，请选更喜欢的那张。预计 3 分钟。',

  // 每位参与者对比次数上限（PRD 默认 20）
  comparisonsPerVoter: 20,

  // 基准图：src 指向 photos/ 下文件；顺序即后续渲染目录前缀
  photos: [
    { id: 'portrait',  src: 'photos/portrait.jpg',  label: '人像' },
    { id: 'landscape', src: 'photos/landscape.jpg', label: '风景' },
    { id: 'food',      src: 'photos/food.jpg',      label: '美食' },
    { id: 'night',     src: 'photos/night.jpg',     label: '夜景' },
    { id: 'street',    src: 'photos/street.jpg',    label: '街景' }
  ],

  // 32 个 LUT 列表：path 是构建期预渲染产物 renders/{photoId}/{lutId}.jpg
  // lutId 是稳定短编号（前缀 l01~l32），防止受访者从 URL 看出风格名
  // displayName 仅在结果页对研究者展示，不出现于对比页
  luts: [
    { lutId: 'l01',  category: 'classic', displayName: '人像琥珀提亮' },
    { lutId: 'l02',  category: 'classic', displayName: '奥林帕斯' },
    { lutId: 'l03',  category: 'classic', displayName: '富士NN' },
    { lutId: 'l04',  category: 'classic', displayName: '日系1996' },
    { lutId: 'l05',  category: 'classic', displayName: '柏林之冬' },
    { lutId: 'l06',  category: 'classic', displayName: '柯达金' },
    { lutId: 'l07',  category: 'classic', displayName: '港味' },
    { lutId: 'l08',  category: 'classic', displayName: '黑白纪实' },
    { lutId: 'l09',  category: 'colors',  displayName: '低饱和蓝晒' },
    { lutId: 'l10',  category: 'colors',  displayName: '彩色反转T64' },
    { lutId: 'l11',  category: 'colors',  displayName: '彩色负片100T' },
    { lutId: 'l12',  category: 'colors',  displayName: '彩色负片' },
    { lutId: 'l13',  category: 'colors',  displayName: '摩卡' },
    { lutId: 'l14',  category: 'colors',  displayName: '灰绿色调' },
    { lutId: 'l15',  category: 'colors',  displayName: '蓝晒' },
    { lutId: 'l16',  category: 'colors',  displayName: '蓝调时光' },
    { lutId: 'l17',  category: 'colors',  displayName: '蓝调空间' },
    { lutId: 'l18',  category: 'retro',   displayName: '回忆录' },
    { lutId: 'l19',  category: 'retro',   displayName: '复古风' },
    { lutId: 'l20',  category: 'retro',   displayName: '怀旧绿' },
    { lutId: 'l21',  category: 'retro',   displayName: '黑白老照片 1' },
    { lutId: 'l22',  category: 'retro',   displayName: '黑白老照片 2' },
    { lutId: 'l23',  category: 'lab',     displayName: '交叉冲洗' },
    { lutId: 'l24',  category: 'lab',     displayName: '岛屿青雾' },
    { lutId: 'l25',  category: 'lab',     displayName: '漂白旁路' },
    { lutId: 'l26',  category: 'lab',     displayName: '花束暖调' },
    { lutId: 'l27',  category: 'movie',   displayName: '千禧电影' },
    { lutId: 'l28',  category: 'movie',   displayName: '电影感' },
    { lutId: 'l29',  category: 'movie',   displayName: '重庆森林' },
    { lutId: 'l30',  category: 'movie',   displayName: '重庆森林 (f)' },
    { lutId: 'l31',  category: 'movie',   displayName: '霸王别姬·红' },
    { lutId: 'l32',  category: 'movie',   displayName: '霸王别姬·蓝' }
  ],

  // 排名展示规则（PRD G2）
  ranking: {
    topN: 10,
    tiers: [5, 5, 6, 6] // 剩余 22 个按 5/5/6/6 分四档
  },

  // Supabase：URL + anon key（anon key 可公开；写入受 RLS 限制）
  // 后续如需轮换，直接改这里
  supabase: {
    url: 'https://tdvhftiincchvtgnkbzh.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkdmhmdGlpbmNjaHZ0Z25rYnpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1ODM3OTQsImV4cCI6MjEwMTE1OTc5NH0.tJq-bUcR7EB2pSCrbp3T_8NetOICeGIAhTH4IK7uyog'
  }
};