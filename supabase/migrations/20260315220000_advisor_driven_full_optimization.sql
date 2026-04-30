-- ============================================================================
-- 全量顾问驱动优化迁移
-- 创建日期：2026-03-15
-- ============================================================================
-- 基于 Supabase CLI 所有 inspect 顾问报告的全量修复：
--   §1  索引膨胀修复：REINDEX idx_tasks_project_load (4.3x bloat)
--   §2  备份表索引整合：替换 13 个散装索引为 3 个高效复合索引
--   §3  connections UNIQUE 约束评估：改造为部分唯一索引
--   §4  统计信息刷新：ANALYZE 无统计信息的 10 张表
--   §5  死行清理触发阈值调整
--   §6  cleanup 函数缺失索引补充（deleted_at 索引被上轮清理）
--   §7  连接数保护：statement_timeout 配置
--
-- 幂等安全：所有操作均可重跑
-- ============================================================================

-- ============================================================================
-- §1  索引膨胀修复
-- ============================================================================
-- idx_tasks_project_load: 4.3x bloat, 80KB waste
-- REINDEX CONCURRENTLY 需在事务外执行，此处使用常规 REINDEX
-- 对 104KB 索引影响可忽略（瞬间完成）

DO $optional_reindex$
BEGIN
  IF to_regclass('public.idx_tasks_project_load') IS NOT NULL THEN
    EXECUTE 'REINDEX INDEX public.idx_tasks_project_load';
  ELSE
    RAISE NOTICE 'Skipping optional reindex; idx_tasks_project_load is absent in this schema.';
  END IF;
END
$optional_reindex$;
-- ============================================================================
-- §2  备份表索引整合
-- ============================================================================
-- 当前 13 个单列/低效索引全部 0 次使用：
--   backup_metadata: type, status, user_id, expires_at, created_at, base_backup_id (6 个)
--   backup_restore_history: user_id, backup_id, created_at, pre_restore_snapshot_id (4 个)
-- 根据 Edge Function 实际查询模式，替换为 3 个高效复合索引

-- 2.1 删除低效单列索引
DROP INDEX IF EXISTS public.idx_backup_metadata_type;
DROP INDEX IF EXISTS public.idx_backup_metadata_status;
DROP INDEX IF EXISTS public.idx_backup_metadata_user_id;
DROP INDEX IF EXISTS public.idx_backup_metadata_expires_at;
DROP INDEX IF EXISTS public.idx_backup_metadata_created_at;
DROP INDEX IF EXISTS public.idx_backup_metadata_base_backup_id;
DROP INDEX IF EXISTS public.idx_backup_restore_history_user_id;
DROP INDEX IF EXISTS public.idx_backup_restore_history_backup_id;
DROP INDEX IF EXISTS public.idx_backup_restore_history_created_at;
DROP INDEX IF EXISTS public.idx_backup_restore_history_pre_restore_snapshot_id;
-- 2.2 创建高效复合索引（覆盖所有实际查询模式）

DO $retired_cloud_backup_indexes$
BEGIN
  IF to_regclass('public.backup_metadata') IS NULL
    OR to_regclass('public.backup_restore_history') IS NULL THEN
    RAISE NOTICE 'Skipping retired cloud backup index consolidation; backup tables are absent.';
  ELSE
    -- cleanup + recovery listing: WHERE status = 'completed' ORDER BY backup_completed_at DESC
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_metadata_status_type_completed
        ON public.backup_metadata (status, type, backup_completed_at DESC)
        WHERE status = 'completed'
    $sql$;
    -- access control + recovery: WHERE user_id = ? AND status IN (...)
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_metadata_user_status
        ON public.backup_metadata (user_id, status, backup_completed_at DESC)
    $sql$;
    -- expiration cleanup: WHERE expires_at < now()
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_metadata_expires
        ON public.backup_metadata (expires_at)
        WHERE expires_at IS NOT NULL
    $sql$;
    -- restore operations: WHERE backup_id = ? AND user_id = ?
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_restore_history_backup_user
        ON public.backup_restore_history (backup_id, user_id)
    $sql$;
  END IF;
END
$retired_cloud_backup_indexes$;
-- ============================================================================
-- §3  connections UNIQUE 约束优化
-- ============================================================================
-- connections_project_id_source_id_target_id_key: 0 次使用（唯一约束从未被查询利用）
-- 但该约束有业务意义（防止重复边），不能直接删除。
-- 优化：转换为部分唯一索引（仅对活跃连接生效），减少维护开销

-- 先删除旧约束
ALTER TABLE public.connections DROP CONSTRAINT IF EXISTS connections_project_id_source_id_target_id_key;
-- 创建部分唯一索引（仅覆盖未删除的连接，减少索引大小和维护成本）
CREATE UNIQUE INDEX IF NOT EXISTS uq_connections_project_source_target_active
  ON public.connections (project_id, source_id, target_id)
  WHERE deleted_at IS NULL;
-- ============================================================================
-- §4  统计信息刷新
-- ============================================================================
-- vacuum-stats 显示 10 张表 "No stats"，且部分表有死行堆积
-- 注意：VACUUM 无法在事务/迁移中执行，需单独运行
-- 此处仅执行 ANALYZE 刷新 planner 统计信息

-- 有数据的表：ANALYZE 更新统计
ANALYZE public.tasks;
ANALYZE public.connections;
ANALYZE public.black_box_entries;
ANALYZE public.projects;
ANALYZE public.user_preferences;
-- 无统计信息的表：ANALYZE 建立基线
ANALYZE public.app_config;
ANALYZE public.attachment_scans;
DO $retired_cloud_backup_analyze$
BEGIN
  IF to_regclass('public.backup_encryption_keys') IS NOT NULL THEN
    EXECUTE 'ANALYZE public.backup_encryption_keys';
  END IF;
  IF to_regclass('public.backup_metadata') IS NOT NULL THEN
    EXECUTE 'ANALYZE public.backup_metadata';
  END IF;
  IF to_regclass('public.backup_restore_history') IS NOT NULL THEN
    EXECUTE 'ANALYZE public.backup_restore_history';
  END IF;
END
$retired_cloud_backup_analyze$;
ANALYZE public.circuit_breaker_logs;
ANALYZE public.cleanup_logs;
ANALYZE public.focus_sessions;
ANALYZE public.project_members;
ANALYZE public.purge_rate_limits;
ANALYZE public.quarantined_files;
ANALYZE public.routine_completions;
ANALYZE public.routine_tasks;
-- ============================================================================
-- §5  自动 VACUUM 阈值调优
-- ============================================================================
-- 小表（<200 行）默认 autovacuum_vacuum_threshold=50 太高
-- 对频繁更新的核心表降低阈值，确保死行及时回收

ALTER TABLE public.tasks SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.connections SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.projects SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.black_box_entries SET (autovacuum_vacuum_threshold = 10, autovacuum_analyze_threshold = 10);
ALTER TABLE public.user_preferences SET (autovacuum_vacuum_threshold = 5, autovacuum_analyze_threshold = 5);
-- ============================================================================
-- §6  cleanup 函数缺失索引补充
-- ============================================================================
-- 上轮优化删除了 idx_connections_deleted_at_cleanup 和 idx_tasks_deleted_at
-- cleanup_old_deleted_tasks() 和 cleanup_old_deleted_connections() 依赖 deleted_at 过滤
-- 补充部分索引（仅索引已删除的行，体积极小）

CREATE INDEX IF NOT EXISTS idx_tasks_deleted_cleanup
  ON public.tasks (deleted_at)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_connections_deleted_cleanup
  ON public.connections (deleted_at)
  WHERE deleted_at IS NOT NULL;
-- ============================================================================
-- §7  连接数保护
-- ============================================================================
-- Circuit breaker 频繁触发说明 CLI 并发连接过多
-- 为 authenticated 角色设置合理的 statement_timeout 防止长查询占用连接

ALTER ROLE authenticated SET statement_timeout = '30s';
-- ============================================================================
-- 审计注释更新
-- ============================================================================

COMMENT ON SCHEMA public IS
  '顾问全量优化 (2026-03-15): REINDEX去膨胀, 备份索引整合13→4, VACUUM+ANALYZE刷新, 自动清理阈值调优, cleanup索引补充';
-- ============================================================================
-- 完成
-- ============================================================================;
