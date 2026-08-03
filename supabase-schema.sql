-- =====================================================================
-- LUT 偏好排序测试 · Supabase 建表脚本
-- 在 Supabase SQL Editor 中执行一次即可
-- =====================================================================

-- judgments：单条成对判断
CREATE TABLE IF NOT EXISTS public.judgments (
  id          bigserial PRIMARY KEY,
  test_id     text NOT NULL,
  voter_id    text NOT NULL,
  fingerprint text,               -- 浏览器指纹（跨会话识别同设备，老数据为 null）
  lut_a       text NOT NULL,
  lut_b       text NOT NULL,
  winner      text NOT NULL CHECK (winner = 'tie' OR winner = lut_a OR winner = lut_b),
  photo       text NOT NULL,
  position    jsonb NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now(),
  resp_ms     integer NOT NULL DEFAULT 0
);

-- 兼容旧表：如果表已存在但缺 fingerprint 列
ALTER TABLE public.judgments ADD COLUMN IF NOT EXISTS fingerprint text;

-- 索引：拉取某批次时按 test_id 过滤 + 按 ts 排序
CREATE INDEX IF NOT EXISTS idx_judgments_test_ts ON public.judgments (test_id, ts);
-- 索引：去重校验（同一 voter 对同一对只能落库一次）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_judgments_pair
  ON public.judgments (test_id, voter_id, lut_a, lut_b);

-- RLS：前端 anon key 只能 INSERT，不能 SELECT/UPDATE/DELETE
ALTER TABLE public.judgments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can insert judgments" ON public.judgments;
CREATE POLICY "anon can insert judgments"
  ON public.judgments
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- 结果页 SELECT：前端需要能读到数据才能算分
-- （如果不想公开，可改为研究者用 service_role key 读，结果页改后端代理）
DROP POLICY IF EXISTS "anon can select judgments" ON public.judgments;
CREATE POLICY "anon can select judgments"
  ON public.judgments
  FOR SELECT
  TO anon
  USING (true);