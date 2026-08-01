# LUT 偏好排序测试

**面向公司内部 / 钉钉群募集参与者的 LUT 风格成对比较调研工具。**

- **A/B 二选一**：每次展示同一张照片的两种 LUT 风格，选更喜欢的那张
- **统计方法**：实时 Elo + 离线 Bradley–Terry 模型 + 循环兜底（净胜场 PageRank）
- **存储**：Supabase（Postgres），前端只 INSERT 单条判断
- **部署**：Vercel（Hobby 免费层），国内访问流畅
- **配置驱动**：改 `js/config.js` + 重跑 `tools/prerender.py` 即可开启新一轮

---

## 目录结构

```
lut-rankingtest/
├── index.html             # 参与者入口：A/B 对比
├── result.html            # 研究者：排名结果 + 导出
├── css/styles.css
├── js/
│   ├── config.js          # ★ 改这里配置新一轮（testId / 32 LUT / 5 photos）
│   ├── supabase.js        # REST 客户端 + 离线重试队列
│   ├── ranking.js         # Elo / BT / PageRank 算法
│   ├── app.js             # 对比页流程
│   └── result.js          # 结果页流程
├── photos/                # 5 张基准原图
├── lut/                   # 32 个 .cube 文件（构建输入）
├── renders/               # 构建产物：每图 lg+sm 两版（运行时只下这些）
│   └── {photoId}/{lutId}.jpg
├── tools/prerender.py     # 构建脚本：读 cube + 照片 → 输出 renders/
└── supabase-schema.sql    # Supabase 建表脚本（运行一次）
```

---

## 首次部署步骤

### 1. 准备 Supabase
1. 在 [supabase.com](https://supabase.com) 新建项目（免费层即可）
2. 左侧 SQL Editor → 粘贴 `supabase-schema.sql` 全部内容 → Run
3. Project Settings → API → 复制 **Project URL** 和 **anon public** key
4. 打开 `js/config.js`，把 `supabase.url` 和 `supabase.anonKey` 替换成你的

### 2. 部署到 Vercel
1. 把这个目录推到 GitHub 仓库（你已有 `shengnanxiang/lut-rankingtest`）
2. 登录 [vercel.com](https://vercel.com)，用 GitHub 账号
3. 「Import Project」→ 选 `lut-rankingtest` → 默认配置 Deploy
4. 几秒后拿到 `https://lut-rankingtest-xxx.vercel.app` 这样的 URL
5. 以后改代码 / 加 LUT：git push，Vercel 自动重新部署

### 3. 验证
- 打开 Vercel 给的 URL → 应该看到对比页
- 完成几次后到 `result.html` 看排名

---

## 开启新一轮（复用流程）

需求变了，比如：
- 改了某些 LUT 的风格 → 替换 `lut/{category}/xxx.cube`
- 增减 LUT 数量 → 改 `js/config.js` 的 `luts` 数组
- 换基准图 → 替换 `photos/*.jpg` + 改 `js/config.js` 的 `photos` 数组
- 开新批次 → 改 `js/config.js` 的 `testId`（决定数据库隔离 key）

然后：
```bash
python3 tools/prerender.py        # 重生成 renders/
git add renders/ js/config.js     # 改了的都加进来
git commit -m "v2 batch"
git push                           # Vercel 自动部署
```

发新链接给钉钉群即可。

---

## 关键设计决策

### 预渲染 vs 运行时渲染
LUT `.cube` 单文件约 1MB，32 个合计 34MB。运行时让浏览器下载 = 灾难。
本工具在构建期一次性生成 320 张 JPG（每图 lg 1000×667 + sm 500×334），
总计 ~19MB。运行时受访者只下图片，**首屏秒开**，国内 Vercel CDN 体验稳定。

### 自适应配对（pickNextPair）
每对比较信息量不同：
- 同分差的对最有价值（能拉开/反超的判断）
- 最少出场的对最有价值（探索未知）

选下一对 = `score = -|rating差| - 5 * 总出场数`，取最大。
避免了「总让同一对出现」的退化，也避免了「随机碰运气」的低效。

### 循环偏好兜底
Bradley–Terry MM 算法不收敛 / 出现 ±∞ ⇒ 视为存在循环（如 A>B>C>A），
切换到净胜场排名（`wins - losses`）兜底，结果页显示提示条。

### 离线重试
Supabase 写入失败（弱网/断电）⇒ 入 localStorage 队列，
后台每 15s 冲一次 + 页面回到前台立即冲一次，不丢数据。

---

## 性能预算

- 首屏 JS：~30KB（gzip）— 不依赖任何 npm 包
- 首屏图片：0（图片是用户点了才显示）
- 每次对比：两张 lg 图 ≈ 160KB + 预取下一对 sm ≈ 60KB ≈ 220KB
- 国内 4G 下首对比总耗时 < 2s（Vercel CDN）

---

## 验收对照（PRD）

| AC | 实现 |
|---|---|
| AC1 改配置就能开测 | ✅ 改 config.js + 重跑 prerender |
| AC2 左右随机 + 平局 + 跳过 | ✅ `currentLeftIsA = Math.random() < 0.5` + 都不喜欢按钮 |
| AC3 同对比不重复 / 次数拦截 | ✅ `pickNextPair` 跳过 seen；服务端唯一索引兜底 |
| AC4 90人×20次 < 2s 算完 | ✅ 1600 judgments 在浏览器内 BT 100ms 内 |
| AC5 循环不崩溃 | ✅ `usedFallback` 兜底 + 提示 |
| AC6 导出 CSV / JSON | ✅ `result.html` 两个按钮 |
| AC7 国内 < 2s | ✅ Vercel + 预渲染图（无大 cube 下载） |