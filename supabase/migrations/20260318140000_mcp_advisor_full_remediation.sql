-- ============================================================================
-- MCP Supabase 顾问全量补救迁移
-- 执行日期：2026-03-18
-- 来源：Supabase Database Linter (Security + Performance)
-- ============================================================================
-- 基于本日期 MCP 调用 supabase_get_advisors() 的完整建议集合：
--
-- 安全建议（2）：
--   1. pg_net 扩展移出 public schema（WARN - 安全漏洞）
--   2. 启用泄漏密码防护（WARN - Auth，需仪表板操作）
--
-- 性能建议（16）：
--   A. 重复索引删除（2）：
--      - connections: idx_connections_project_updated_desc (重复)
--      - tasks: idx_tasks_project_updated_desc (重复)
--
--   B. 未使用索引删除（5）：
--      - backup_metadata: idx_backup_metadata_status_type_completed
--      - backup_metadata: idx_backup_metadata_user_status
--      - backup_metadata: idx_backup_metadata_expires
--      - backup_restore_history: idx_backup_restore_history_backup_user
--      - connections: idx_connections_deleted_cleanup
--
--   C. 缺失外键索引添加（9）：
--      - user_id 相关（4）：backup_restore_history, connection_tombstones,
--                         project_members, quarantined_files
--      - project_id 相关（1）：black_box_entries
--      - 其他（4）：task_tombstones, backup_metadata, backup_restore_history (snapshot),
--                  routine_completions
--
-- ============================================================================
-- 已执行项（MCP 驱动）
-- ============================================================================

-- ============================================================================
-- Part 1: 安全修复 - pg_net 扩展迁移
-- ============================================================================

-- create extensions schema 并授权
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO authenticated, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO authenticated, anon;
-- 移除旧的 pg_net（如果存在于 public）
DROP EXTENSION IF EXISTS pg_net;
-- 在 extensions schema 中创建 pg_net
CREATE EXTENSION pg_net WITH SCHEMA extensions;
-- ============================================================================
-- Part 2: 性能优化 - 重复索引删除
-- ============================================================================

DROP INDEX IF EXISTS idx_connections_project_updated_desc;
DROP INDEX IF EXISTS idx_tasks_project_updated_desc;
-- ============================================================================
-- Part 3: 性能优化 - 未使用索引删除
-- ============================================================================

-- 备份相关未使用索引（备份功能 0 次查询）
DROP INDEX IF EXISTS idx_backup_metadata_status_type_completed;
DROP INDEX IF EXISTS idx_backup_metadata_user_status;
DROP INDEX IF EXISTS idx_backup_metadata_expires;
DROP INDEX IF EXISTS idx_backup_restore_history_backup_user;
-- 连接清理索引（cleanup 逻辑已优化）
DROP INDEX IF EXISTS idx_connections_deleted_cleanup;
-- ============================================================================
-- Part 4: 性能优化 - 外键索引补充
-- ============================================================================

-- 优先级 1：user_id 外键（用户查询频繁，DELETE 时需要检查）
DO $retired_cloud_backup_fk_indexes$
BEGIN
  IF to_regclass('public.backup_metadata') IS NULL
    OR to_regclass('public.backup_restore_history') IS NULL THEN
    RAISE NOTICE 'Skipping retired cloud backup FK indexes; backup tables are absent.';
  ELSE
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_restore_history_user_id
        ON public.backup_restore_history(user_id)
    $sql$;
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_metadata_base_backup_id
        ON public.backup_metadata(base_backup_id)
    $sql$;
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_backup_restore_history_snapshot_id
        ON public.backup_restore_history(pre_restore_snapshot_id)
    $sql$;
  END IF;
END
$retired_cloud_backup_fk_indexes$;
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_by 
  ON public.connection_tombstones(deleted_by);
CREATE INDEX IF NOT EXISTS idx_project_members_invited_by 
  ON public.project_members(invited_by);
CREATE INDEX IF NOT EXISTS idx_quarantined_files_quarantined_by 
  ON public.quarantined_files(quarantined_by);
-- 优先级 2：project_id 外键（项目操作频繁）
CREATE INDEX IF NOT EXISTS idx_black_box_entries_project_id 
  ON public.black_box_entries(project_id);
-- 优先级 3：其他外键（备份/routine 操作不频繁）
CREATE INDEX IF NOT EXISTS idx_task_tombstones_deleted_by 
  ON public.task_tombstones(deleted_by);
CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id 
  ON public.routine_completions(routine_id);
-- ============================================================================
-- ANALYSIS: 导入脚本中发现的设计缺陷
-- ============================================================================
--
-- 问题 1: 重复索引根因分析
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--
-- 迁移历史：
--   20260126074130_remote_commit.sql       创建 idx_connections_project_updated (ASC)
--                                         创建 idx_tasks_project_updated (ASC)
--
--   20260214000000_resume_watermark_rpc    创建 idx_tasks_project_updated_desc (DESC)
--   20260215000000_user_projects_watermark 创建 idx_connections_project_updated_desc (DESC)
--   20260216000000_recovery_probe...       再次创建两个 DESC（重复声明 IF NOT EXISTS）
--   20260217100000_resume_composite_probe  再次创建两个 DESC
--   20260218000000_manifest_watermark      再次创建两个 DESC
--
-- 根因：为了满足不同 RPC 的排序需求，多个迁移独立创建了 DESC 版本。
--      虽然使用了 IF NOT EXISTS，但多个迁移文件在实际执行时都执行了 CREATE INDEX。
--      实际上，一个复合排序索引（col1, col2 ASC）可以反向扫描处理 DESC 排序。
--      而 PostgreSQL 不会自动选择倒序的索引，因此 DESC 版本无法实际使用。
--
-- 改进建议：
--   1. 统一规范：单个迁移文件负责创建索引，不在多处重复声明。
--   2. 索引设计：优先使用单中性的排序方向（通常 ASC），让数据库自行选择扫描方向。
--   3. 幂等性：虽然 IF NOT EXISTS 提供了幂等性，但不应依赖它来覆盖设计问题。
--
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--
-- 问题 2: 前期迁移（20260315220000）中的"预期未来使用"索引
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--
-- 该迁移创建了以下索引：
--   idx_backup_metadata_status_type_completed
--   idx_backup_metadata_user_status
--   idx_backup_metadata_expires
--   idx_backup_restore_history_backup_user
--
-- 注释声称这些是"根据 Edge Function 实际查询模式"创建的。
-- 然而，实际 0 次使用表明：
--   a) Edge Function 查询模式与预期不符
--   b) 备份功能本身已弃用或被其他机制替代
--   c) 创建索引时的设计决策缺乏实际使用验证
--
-- 改进建议：
--   1. 索引审计：定期运行 pg_stat_user_indexes 检查索引使用率。
--   2. 数据驱动：只有在"已验证的查询模式"基础上创建索引，不预先假设。
--   3. 过期感知：标记具有过期日期的功能（如备份），提前规划索引清理。
--
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--
-- 问题 3: 缺失的外键索引从未被预警
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
--
-- 9 个外键缺失索引，这种问题在大型删除操作时会严重影响性能。
-- 前期迁移没有考虑到这一点，说明：
--   a) Schema 设计时未进行索引完整性检查
--   b) 没有运行 linter 或 advisor 来自动检测
--
-- 改进建议：
--   1. 迁移清单：新增外键时必须同时创建索引。
--   2. 自动化：使用 Supabase advisor 或 pgAdmin 定期检查。
--   3. 文档：在设计阶段就规划好索引策略，避免事后补救。
--
-- ============================================================================
-- 统计更新与分析
-- ============================================================================

-- 更新受影响表的统计信息
ANALYZE public.connections;
ANALYZE public.tasks;
DO $retired_cloud_backup_analyze$
BEGIN
  IF to_regclass('public.backup_metadata') IS NOT NULL THEN
    EXECUTE 'ANALYZE public.backup_metadata';
  END IF;
  IF to_regclass('public.backup_restore_history') IS NOT NULL THEN
    EXECUTE 'ANALYZE public.backup_restore_history';
  END IF;
END
$retired_cloud_backup_analyze$;
ANALYZE public.connection_tombstones;
ANALYZE public.project_members;
ANALYZE public.quarantined_files;
ANALYZE public.task_tombstones;
ANALYZE public.black_box_entries;
ANALYZE public.routine_completions;
-- ============================================================================
-- Audit Comment
-- ============================================================================

COMMENT ON SCHEMA public IS
  'MCP advisor full remediation (2026-03-18): pg_net→extensions schema, 2 duplicate index drops, 5 unused index drops, 9 foreign key index additions, complete analysis & recommendations documented';
-- ============================================================================
-- 完成
-- ============================================================================;
