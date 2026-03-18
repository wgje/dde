-- ============================================================================
-- 2026-03-18 最终修复：全量解决 Supabase Advisor Unindexed Foreign Keys 报告
-- ============================================================================
-- 【目标】彻底清空所有 Advisor 警告
-- 【问题】9 个 FK 缺少覆盖索引 + 2 个临时添加的索引未被使用
-- 【解决】删除临时索引、添加所有缺失的 FK 索引
--
-- API: mcp_supabase_apply_migration("repair_all_unindexed_foreign_keys")
-- 执行时间: 2026-03-18 18:00:00 UTC
-- ============================================================================

-- ============================================================================
-- PART 1: 清理临时/未使用的防御性索引
-- ============================================================================
-- v6.2.0 中作为软删除妥协添加的 2 个索引，现已证明需要删除以满足 Advisor

DROP INDEX IF EXISTS idx_backup_metadata_user_id;
DROP INDEX IF EXISTS idx_backup_restore_history_backup_id;

-- ============================================================================
-- PART 2: 添加所有 9 个缺失的 FK 约束索引
-- ============================================================================
-- Advisor 报告的完整列表，满足数据完整性要求

-- 【1】backup_metadata.base_backup_id → backup_metadata(id) ON DELETE SET NULL
CREATE INDEX IF NOT EXISTS idx_backup_metadata_base_backup_id 
  ON public.backup_metadata(base_backup_id);
COMMENT ON INDEX idx_backup_metadata_base_backup_id IS 
  'FK enforcement index. References: backup_metadata(id) [ON DELETE SET NULL]';

-- 【2】backup_restore_history.pre_restore_snapshot_id → backup_metadata(id) ON DELETE SET NULL  
CREATE INDEX IF NOT EXISTS idx_backup_restore_history_pre_restore_snapshot_id 
  ON public.backup_restore_history(pre_restore_snapshot_id);
COMMENT ON INDEX idx_backup_restore_history_pre_restore_snapshot_id IS 
  'FK enforcement index. References: backup_metadata(id) [ON DELETE SET NULL]';

-- 【3】backup_restore_history.user_id → auth.users(id) ON DELETE CASCADE
CREATE INDEX IF NOT EXISTS idx_backup_restore_history_user_id 
  ON public.backup_restore_history(user_id);
COMMENT ON INDEX idx_backup_restore_history_user_id IS 
  'FK enforcement index. References: auth.users(id) [ON DELETE CASCADE]';

-- 【4】black_box_entries.project_id → projects(id) ON DELETE CASCADE
CREATE INDEX IF NOT EXISTS idx_black_box_entries_project_id 
  ON public.black_box_entries(project_id);
COMMENT ON INDEX idx_black_box_entries_project_id IS 
  'FK enforcement index. References: projects(id) [ON DELETE CASCADE]';

-- 【5】connection_tombstones.deleted_by → auth.users(id) ON DELETE SET NULL
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_by 
  ON public.connection_tombstones(deleted_by);
COMMENT ON INDEX idx_connection_tombstones_deleted_by IS 
  'FK enforcement index. References: auth.users(id) [ON DELETE SET NULL]';

-- 【6】project_members.invited_by → auth.users(id) ON DELETE SET NULL
CREATE INDEX IF NOT EXISTS idx_project_members_invited_by 
  ON public.project_members(invited_by);
COMMENT ON INDEX idx_project_members_invited_by IS 
  'FK enforcement index. References: auth.users(id) [ON DELETE SET NULL]';

-- 【7】quarantined_files.quarantined_by → auth.users(id) ON DELETE SET NULL
CREATE INDEX IF NOT EXISTS idx_quarantined_files_quarantined_by 
  ON public.quarantined_files(quarantined_by);
COMMENT ON INDEX idx_quarantined_files_quarantined_by IS 
  'FK enforcement index. References: auth.users(id) [ON DELETE SET NULL]';

-- 【8】routine_completions.routine_id → routine_tasks(id) ON DELETE CASCADE
CREATE INDEX IF NOT EXISTS idx_routine_completions_routine_id 
  ON public.routine_completions(routine_id);
COMMENT ON INDEX idx_routine_completions_routine_id IS 
  'FK enforcement index. References: routine_tasks(id) [ON DELETE CASCADE]';

-- 【9】task_tombstones.deleted_by → auth.users(id) ON DELETE SET NULL
CREATE INDEX IF NOT EXISTS idx_task_tombstones_deleted_by 
  ON public.task_tombstones(deleted_by);
COMMENT ON INDEX idx_task_tombstones_deleted_by IS 
  'FK enforcement index. References: auth.users(id) [ON DELETE SET NULL]';

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- After applying this migration:
-- ✓ All 9 Advisor "unindexed_foreign_keys" warnings should be resolved
-- ✓ All 2 previous "unused_index" warnings should be cleared
-- 
-- Run Advisor check in Supabase Console:
-- https://supabase.com/dashboard/project/fkhihclpghmmtbbywvoj/advisors
-- ============================================================================
