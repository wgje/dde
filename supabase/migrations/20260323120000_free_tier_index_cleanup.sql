-- ============================================================
-- 免费层优化：删除未使用/冗余索引
-- ============================================================
-- 版本：免费层用量审查 2026-03-23
-- 
-- 背景：基于 71 天（2026-01-11 ~ 2026-03-23）的 pg_stat_user_indexes 数据，
-- 删除 10 个确认未使用或被更高效索引完全替代的索引。
--
-- 预期效果：
--   - 释放 ~208 KB 索引空间
--   - 减少每次写入的索引维护开销（10 个索引 × 每次 UPDATE/INSERT）
--   - 降低 autovacuum 负载
--
-- 删除清单（scan 次数为 71 天累计）：
--   | 索引名                              | 表                   | 使用次数 | 原因                                          |
--   |--------------------------------------|----------------------|----------|-----------------------------------------------|
--   | idx_task_tombstones_deleted_by       | task_tombstones      | 0        | FK enforcement，应用使用软删除，级联从未触发   |
--   | idx_connection_tombstones_deleted_by  | connection_tombstones | 0        | 同上                                          |
--   | idx_black_box_entries_project_id      | black_box_entries    | 0        | FK enforcement，查询全走 user_id + updated_at  |
--   | idx_routine_completions_routine_id    | routine_completions  | 0        | routine 功能尚未上线                          |
--   | idx_tasks_project_load               | tasks                | 1        | 80KB 覆盖索引，idx_tasks_project_order 替代    |
--   | idx_connections_deleted_at            | connections          | 1        | idx_connections_project_updated 替代           |
--   | idx_projects_owner_id                | projects             | 7        | idx_projects_owner_id_updated 完全覆盖         |
--   | idx_tasks_project_id                 | tasks                | 122      | idx_tasks_project_updated + project_order 替代 |
--   | idx_tasks_project_active             | tasks                | 3        | idx_tasks_project_updated 替代                 |
--   | idx_connections_project_active        | connections          | 4        | idx_connections_project_updated 替代           |
--
-- 回滚：重建索引（见底部注释）
-- ============================================================

DROP INDEX IF EXISTS public.idx_task_tombstones_deleted_by;
DROP INDEX IF EXISTS public.idx_connection_tombstones_deleted_by;
DROP INDEX IF EXISTS public.idx_black_box_entries_project_id;
DROP INDEX IF EXISTS public.idx_routine_completions_routine_id;
DROP INDEX IF EXISTS public.idx_tasks_project_load;
DROP INDEX IF EXISTS public.idx_connections_deleted_at;
DROP INDEX IF EXISTS public.idx_projects_owner_id;
DROP INDEX IF EXISTS public.idx_tasks_project_id;
DROP INDEX IF EXISTS public.idx_tasks_project_active;
DROP INDEX IF EXISTS public.idx_connections_project_active;

-- ============================================================
-- 回滚 SQL（如需恢复，执行以下语句）：
-- ============================================================
-- CREATE INDEX idx_task_tombstones_deleted_by ON public.task_tombstones(deleted_by);
-- CREATE INDEX idx_connection_tombstones_deleted_by ON public.connection_tombstones(deleted_by);
-- CREATE INDEX idx_black_box_entries_project_id ON public.black_box_entries(project_id);
-- CREATE INDEX idx_routine_completions_routine_id ON public.routine_completions(routine_id);
-- CREATE INDEX idx_tasks_project_load ON public.tasks(project_id, stage, "order") INCLUDE (id, title, content, parent_id, rank, status, x, y, updated_at, deleted_at, short_id) WHERE (deleted_at IS NULL);
-- CREATE INDEX idx_connections_deleted_at ON public.connections(deleted_at) WHERE (deleted_at IS NULL);
-- CREATE INDEX idx_projects_owner_id ON public.projects(owner_id);
-- CREATE INDEX idx_tasks_project_id ON public.tasks(project_id);
-- CREATE INDEX idx_tasks_project_active ON public.tasks(project_id, updated_at DESC) WHERE (deleted_at IS NULL);
-- CREATE INDEX idx_connections_project_active ON public.connections(project_id, updated_at DESC) WHERE (deleted_at IS NULL);
