-- ============================================================================
-- 全量数据库优化迁移
-- 创建日期：2026-03-15
-- ============================================================================
-- 基于全量审计报告修复所有发现的问题：
--   §1  C-1: backup 表安全加固（FORCE RLS + 策略 + GRANT）
--   §2  M-3: backup_restore_history 补充 updated_at
--   §3  H-2: 清理 13 个确认冗余的未使用索引
--   §4  补充：backup_encryption_keys 权限收紧
--   §5  补充：transcription_usage SELECT 策略一致性
--
-- 幂等安全：所有操作均可重跑
-- Rollback: 各段末尾有回滚说明
-- ============================================================================

-- ============================================================================
-- §1  backup 表安全加固
-- ============================================================================

-- 1.1 FORCE RLS
ALTER TABLE public.backup_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_metadata FORCE ROW LEVEL SECURITY;
ALTER TABLE public.backup_restore_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_restore_history FORCE ROW LEVEL SECURITY;
ALTER TABLE public.backup_encryption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_encryption_keys FORCE ROW LEVEL SECURITY;
-- 1.2 backup_metadata RLS 策略（user_id 可空，NULL 行仅 service_role 可见）
DO $$ BEGIN DROP POLICY IF EXISTS "backup_metadata_user_select" ON public.backup_metadata; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "backup_metadata_user_insert" ON public.backup_metadata; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "backup_metadata_user_update" ON public.backup_metadata; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "backup_metadata_user_delete" ON public.backup_metadata; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "backup_metadata_select" ON public.backup_metadata FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "backup_metadata_insert" ON public.backup_metadata FOR INSERT
    TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "backup_metadata_update" ON public.backup_metadata FOR UPDATE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "backup_metadata_delete" ON public.backup_metadata FOR DELETE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 1.3 backup_restore_history RLS 策略
DO $$ BEGIN DROP POLICY IF EXISTS "backup_restore_history_user_select" ON public.backup_restore_history; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "backup_restore_history_user_insert" ON public.backup_restore_history; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "backup_restore_history_user_update" ON public.backup_restore_history; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "backup_restore_history_user_delete" ON public.backup_restore_history; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "backup_restore_history_select" ON public.backup_restore_history FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "backup_restore_history_insert" ON public.backup_restore_history FOR INSERT
    TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "backup_restore_history_update" ON public.backup_restore_history FOR UPDATE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "backup_restore_history_delete" ON public.backup_restore_history FOR DELETE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 1.4 backup_encryption_keys: 无 user_id，仅 service_role 操作（RLS 阻止 authenticated）
-- 不创建 authenticated 策略 = authenticated 无法访问 = 安全

-- 1.5 GRANT 权限
-- backup_metadata / backup_restore_history：authenticated 需要通过 RLS 访问
GRANT SELECT, INSERT, UPDATE ON TABLE public.backup_metadata TO authenticated;
GRANT ALL ON TABLE public.backup_metadata TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.backup_restore_history TO authenticated;
GRANT ALL ON TABLE public.backup_restore_history TO service_role;
-- backup_encryption_keys：仅 service_role
REVOKE ALL ON TABLE public.backup_encryption_keys FROM anon;
REVOKE ALL ON TABLE public.backup_encryption_keys FROM authenticated;
GRANT ALL ON TABLE public.backup_encryption_keys TO service_role;
-- Rollback §1:
-- ALTER TABLE backup_metadata NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE backup_restore_history NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE backup_encryption_keys NO FORCE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS ... (各策略);

-- ============================================================================
-- §2  backup_restore_history 补充 updated_at
-- ============================================================================

ALTER TABLE public.backup_restore_history
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_backup_restore_history_updated_at'
  ) THEN
    CREATE TRIGGER trg_backup_restore_history_updated_at
      BEFORE UPDATE ON public.backup_restore_history
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;
-- Rollback §2: ALTER TABLE backup_restore_history DROP COLUMN IF EXISTS updated_at;

-- ============================================================================
-- §3  清理确认冗余的未使用索引（13 个）
-- ============================================================================
-- 说明：仅删除被更优索引替代的冗余索引或确认无查询使用的索引。
--       保留所有 PK、UNIQUE 约束索引和备份功能预备索引。

-- projects 表冗余索引（被更好的复合索引替代）
DROP INDEX IF EXISTS public.idx_projects_owner_updated;
-- 被 idx_projects_owner_id_updated 替代
DROP INDEX IF EXISTS public.idx_projects_owner_updated_desc;
-- 被 idx_projects_id_owner_updated_desc 替代

-- black_box_entries 表冗余索引
DROP INDEX IF EXISTS public.idx_black_box_entries_project_id;
-- project_id 已改为可空，旧查询模式
DROP INDEX IF EXISTS public.idx_black_box_entries_user_date;
-- 从未使用
DROP INDEX IF EXISTS public.idx_black_box_entries_user_updated_desc;
-- 被 idx_black_box_entries_user_updated 替代
DROP INDEX IF EXISTS public.idx_black_box_entries_user_shared_updated;
-- 新建但从未使用

-- focus_sessions / routine_tasks 冗余单列索引（被复合索引覆盖）
DROP INDEX IF EXISTS public.idx_focus_sessions_user_id;
-- 被 idx_focus_sessions_user_updated_at 覆盖
DROP INDEX IF EXISTS public.idx_routine_tasks_user_id;
-- 被 idx_routine_tasks_user_updated 覆盖

-- tombstone 表未使用索引
DROP INDEX IF EXISTS public.idx_task_tombstones_deleted_by;
-- 从未使用
DROP INDEX IF EXISTS public.idx_connection_tombstones_deleted_by;
-- 从未使用
DROP INDEX IF EXISTS public.idx_connection_tombstones_project_deleted_desc;
-- 从未使用

-- 其他未使用索引
DROP INDEX IF EXISTS public.idx_quarantined_files_quarantined_by;
-- 从未使用
DROP INDEX IF EXISTS public.idx_project_members_invited_by;
-- 从未使用

-- Rollback §3: 需逐个重建被删除索引（见 20260126000000 和 20260315200000 迁移中的 CREATE INDEX 语句）

-- ============================================================================
-- §4  补充：anon 收紧（backup 表）
-- ============================================================================

REVOKE ALL ON TABLE public.backup_metadata FROM anon;
REVOKE ALL ON TABLE public.backup_restore_history FROM anon;
REVOKE ALL ON TABLE public.backup_encryption_keys FROM anon;
-- ============================================================================
-- §5  transcription_usage SELECT 策略一致性确认
-- ============================================================================
-- base 迁移已有 transcription_usage_select_policy（使用 (SELECT auth.uid())），
-- 汇总迁移补充了 INSERT/UPDATE/DELETE。确保 SELECT 策略使用优化语法。

DO $$ BEGIN DROP POLICY IF EXISTS "transcription_usage_select_policy" ON public.transcription_usage; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "transcription_usage_select" ON public.transcription_usage FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- ============================================================================
-- 审计注释更新
-- ============================================================================

COMMENT ON SCHEMA public IS
  '全量优化完成 (2026-03-15): 21表 FORCE RLS, 13 冗余索引清理, backup 表安全加固, anon 零访问';
-- ============================================================================
-- 完成
-- ============================================================================;
