-- ============================================
-- State Overlap: 停泊元数据列 + 部分索引
-- 策划案 A3.6 / A4 规范
-- ============================================

-- 1. 新增 parking_meta JSONB 列
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parking_meta JSONB DEFAULT NULL;
-- 2. 部分索引：加速「所有停泊任务」的跨项目轻量查询（A3.4）
CREATE INDEX IF NOT EXISTS idx_tasks_parking_meta
  ON tasks ((parking_meta IS NOT NULL))
  WHERE parking_meta IS NOT NULL;
-- 3. RLS 说明：现有 tasks 表的 RLS 策略按 user_id 隔离，
--    自动覆盖新列，无需额外策略。
--    跨项目轻量查询 parking_meta IS NOT NULL 走同一 RLS 规则。

COMMENT ON COLUMN tasks.parking_meta IS
  'State Overlap 停泊元数据（JSONB）。结构：{ state, parkedAt, lastVisitedAt, contextSnapshot, reminder, pinned }。NULL 表示非停泊任务。';
