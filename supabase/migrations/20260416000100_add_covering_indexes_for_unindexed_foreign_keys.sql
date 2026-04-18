-- 2026-04-16 根因修复：为 5 个未覆盖的外键补索引
--
-- Supabase Performance Advisors 报告 unindexed_foreign_keys × 5：
--   1. black_box_entries.project_id
--   2. connection_tombstones.deleted_by
--   3. routine_completion_events.routine_id
--   4. routine_completions.routine_id
--   5. task_tombstones.deleted_by
--
-- 影响：
--   - 父表 DELETE/UPDATE 时触发级联检查需对子表做顺序扫描，记录增长后呈 O(n) 恶化
--   - black_box_entries.project_id 尤其关键：黑匣子同步按 project_id 过滤频繁
--   - deleted_by 字段关联 auth.users，用户注销/删除账户将触发级联全表扫描
--
-- 策略：
--   - 使用 CREATE INDEX IF NOT EXISTS 保证幂等
--   - 仅对 FK 列建单列 btree，避免与既有复合索引重叠浪费空间
--   - 不使用 CONCURRENTLY（Supabase Management API 查询默认事务化），
--     表体量小不会造成可感知锁占用

CREATE INDEX IF NOT EXISTS idx_black_box_entries_project_id
  ON public.black_box_entries (project_id);

CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_by
  ON public.connection_tombstones (deleted_by);

CREATE INDEX IF NOT EXISTS idx_routine_completion_events_routine_id
  ON public.routine_completion_events (routine_id);

CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id
  ON public.routine_completions (routine_id);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_deleted_by
  ON public.task_tombstones (deleted_by);
