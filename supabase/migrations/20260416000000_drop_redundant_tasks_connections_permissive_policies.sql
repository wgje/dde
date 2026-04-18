-- 2026-04-16 根因修复：删除 tasks/connections 上冗余的旧 PERMISSIVE 策略
--
-- 历史：
--   20260126000000_database_optimization.sql 已将 `tasks owner *` / `connections owner *`
--   替换为 `tasks_*_optimized` / `connections_*_optimized`，两套谓词函数
--   (user_has_project_access / user_is_project_owner) 目前实现完全等价。
--
--   20260404103000_projects_soft_delete_alignment.sql 在对齐 project_members RLS 时
--   无意中重建了旧的 `tasks/connections owner *` 策略，导致两张表上每个 command 都存在
--   两份 PERMISSIVE 策略并列，Supabase Advisors 报告 48 条 multiple_permissive_policies。
--
-- 影响：
--   - 每次查询对每行都要执行两次等价访问控制函数，SELECT 吞吐下降
--   - 全表扫描（例如 parking_meta=not.is.null）压力叠加，可能引发 401/429/慢查询放大
--   - 两条策略维护成本翻倍，未来迁移更易偏离
--
-- 修复：仅保留 *_optimized 命名的 PERMISSIVE 策略，删除旧名策略。
--       采用 DROP POLICY IF EXISTS 以保证幂等。

BEGIN;

-- tasks ---------------------------------------------------------------
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;

-- connections ---------------------------------------------------------
DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;

COMMIT;
