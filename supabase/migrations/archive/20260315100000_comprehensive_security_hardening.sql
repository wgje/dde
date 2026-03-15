-- ============================================
-- 全量安全加固 + Focus Console 迁移汇总验证
-- 创建日期：2026-03-15
-- ============================================
-- 本迁移对整个项目进行全量安全审查和加固：
--   §1  FORCE RLS：所有 18 张表启用 FORCE ROW LEVEL SECURITY
--   §2  收紧 anon 角色：敏感数据表移除 anon 写入权限
--   §3  补充缺失的 RLS 策略（transcription_usage / circuit_breaker_logs）
--   §4  RPC 函数安全：管理维护函数仅限 service_role
--   §5  Focus Console 最终状态验证（幂等补偿）
--   §6  数据完整性约束补充
--
-- 幂等安全：所有操作可重跑，使用 IF NOT EXISTS / DROP IF EXISTS / EXCEPTION WHEN
-- Rollback: 各段末尾有回滚说明
-- ============================================

-- ============================================
-- §1  FORCE ROW LEVEL SECURITY - 全量覆盖
-- ============================================
-- 说明：ENABLE RLS 仅阻止非策略匹配的行访问，
--       FORCE RLS 确保连表拥有者（service_role）也必须遵守策略。
--       此前仅 focus_sessions / routine_tasks / routine_completions / black_box_entries
--       有 FORCE RLS，其余 14 张表缺失。

-- 核心业务表
ALTER TABLE public.tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_preferences FORCE ROW LEVEL SECURITY;

-- 墓碑表
ALTER TABLE public.task_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.connection_tombstones FORCE ROW LEVEL SECURITY;

-- 协作表
ALTER TABLE public.project_members FORCE ROW LEVEL SECURITY;

-- 系统/审计表
ALTER TABLE public.app_config FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attachment_scans FORCE ROW LEVEL SECURITY;
ALTER TABLE public.circuit_breaker_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cleanup_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purge_rate_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quarantined_files FORCE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_usage FORCE ROW LEVEL SECURITY;

-- Focus Console 表（幂等重复，确保一致性）
ALTER TABLE public.focus_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.black_box_entries FORCE ROW LEVEL SECURITY;

-- Rollback §1: ALTER TABLE ... NO FORCE ROW LEVEL SECURITY;

-- ============================================
-- §2  收紧 anon 角色权限
-- ============================================
-- 说明：anon 角色用于未认证请求。敏感数据表不应允许 anon 写入或读取。
--       仅 app_config 保留 anon SELECT（公共配置）。

-- 用户数据表：完全移除 anon 权限
REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.projects FROM anon;
REVOKE ALL ON TABLE public.connections FROM anon;
REVOKE ALL ON TABLE public.user_preferences FROM anon;
REVOKE ALL ON TABLE public.black_box_entries FROM anon;
REVOKE ALL ON TABLE public.focus_sessions FROM anon;
REVOKE ALL ON TABLE public.routine_tasks FROM anon;
REVOKE ALL ON TABLE public.routine_completions FROM anon;
REVOKE ALL ON TABLE public.transcription_usage FROM anon;

-- 墓碑/协作表：移除 anon 权限
REVOKE ALL ON TABLE public.task_tombstones FROM anon;
REVOKE ALL ON TABLE public.connection_tombstones FROM anon;
REVOKE ALL ON TABLE public.project_members FROM anon;

-- 审计/内部表：移除 anon 权限
REVOKE ALL ON TABLE public.circuit_breaker_logs FROM anon;
REVOKE ALL ON TABLE public.cleanup_logs FROM anon;
REVOKE ALL ON TABLE public.purge_rate_limits FROM anon;
REVOKE ALL ON TABLE public.quarantined_files FROM anon;
REVOKE ALL ON TABLE public.attachment_scans FROM anon;

-- 视图：移除 anon 权限
DO $$ BEGIN REVOKE ALL ON TABLE public.active_tasks FROM anon; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN REVOKE ALL ON TABLE public.active_connections FROM anon; EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- app_config：仅保留 anon 只读（公共配置项）
REVOKE ALL ON TABLE public.app_config FROM anon;
GRANT SELECT ON TABLE public.app_config TO anon;

-- 确保 authenticated 和 service_role 权限完整
GRANT ALL ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;
GRANT ALL ON TABLE public.projects TO authenticated;
GRANT ALL ON TABLE public.projects TO service_role;
GRANT ALL ON TABLE public.connections TO authenticated;
GRANT ALL ON TABLE public.connections TO service_role;
GRANT ALL ON TABLE public.user_preferences TO authenticated;
GRANT ALL ON TABLE public.user_preferences TO service_role;
GRANT ALL ON TABLE public.black_box_entries TO authenticated;
GRANT ALL ON TABLE public.black_box_entries TO service_role;
GRANT ALL ON TABLE public.focus_sessions TO authenticated;
GRANT ALL ON TABLE public.focus_sessions TO service_role;
GRANT ALL ON TABLE public.routine_tasks TO authenticated;
GRANT ALL ON TABLE public.routine_tasks TO service_role;
GRANT ALL ON TABLE public.routine_completions TO authenticated;
GRANT ALL ON TABLE public.routine_completions TO service_role;
GRANT ALL ON TABLE public.transcription_usage TO authenticated;
GRANT ALL ON TABLE public.transcription_usage TO service_role;
GRANT ALL ON TABLE public.task_tombstones TO authenticated;
GRANT ALL ON TABLE public.task_tombstones TO service_role;
GRANT ALL ON TABLE public.connection_tombstones TO authenticated;
GRANT ALL ON TABLE public.connection_tombstones TO service_role;
GRANT ALL ON TABLE public.project_members TO authenticated;
GRANT ALL ON TABLE public.project_members TO service_role;
GRANT ALL ON TABLE public.circuit_breaker_logs TO authenticated;
GRANT ALL ON TABLE public.circuit_breaker_logs TO service_role;
GRANT ALL ON TABLE public.purge_rate_limits TO authenticated;
GRANT ALL ON TABLE public.purge_rate_limits TO service_role;
GRANT ALL ON TABLE public.app_config TO authenticated;
GRANT ALL ON TABLE public.app_config TO service_role;
GRANT ALL ON TABLE public.attachment_scans TO service_role;
GRANT ALL ON TABLE public.cleanup_logs TO service_role;
GRANT ALL ON TABLE public.quarantined_files TO service_role;

-- 视图权限
DO $$ BEGIN GRANT ALL ON TABLE public.active_tasks TO authenticated; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN GRANT ALL ON TABLE public.active_tasks TO service_role; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN GRANT ALL ON TABLE public.active_connections TO authenticated; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN GRANT ALL ON TABLE public.active_connections TO service_role; EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 收紧 anon 默认权限：新表不自动授权 anon
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- Rollback §2: GRANT ALL ON TABLE ... TO anon; (恢复各表)

-- ============================================
-- §3  补充缺失的 RLS 策略
-- ============================================

-- 3.1 transcription_usage: 缺少 INSERT / UPDATE / DELETE 策略
-- 原始只有 SELECT，应用需要 INSERT 写入配额记录

DO $$ BEGIN
  CREATE POLICY "transcription_usage_insert_policy"
    ON public.transcription_usage FOR INSERT
    TO authenticated
    WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "transcription_usage_update_policy"
    ON public.transcription_usage FOR UPDATE
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "transcription_usage_delete_policy"
    ON public.transcription_usage FOR DELETE
    TO authenticated
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3.2 circuit_breaker_logs: 缺少 INSERT 策略
-- 应用需要写入熔断审计日志

DO $$ BEGIN
  CREATE POLICY "circuit_breaker_logs_insert_own"
    ON public.circuit_breaker_logs FOR INSERT
    TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3.3 cleanup_logs: 补充 authenticated SELECT 策略（只读审计）
DO $$ BEGIN
  CREATE POLICY "cleanup_logs_authenticated_select"
    ON public.cleanup_logs FOR SELECT
    TO authenticated
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Rollback §3: DROP POLICY IF EXISTS "..." ON ...;

-- ============================================
-- §4  RPC 函数安全加固
-- ============================================
-- 管理/维护函数不应暴露给 authenticated 用户，仅限 service_role

-- 4.1 cleanup 函数仅限 service_role
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_deleted_attachments(integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_deleted_attachments(integer) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_deleted_attachments(integer) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_expired_scan_records() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_expired_scan_records() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_connections() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_old_logs() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_old_logs() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

-- 4.2 migrate 函数仅限 service_role（数据迁移不应被普通用户调用）
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.migrate_all_projects_to_v2() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.migrate_all_projects_to_v2() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

-- 4.3 确保业务 RPC 函数已授权 authenticated
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_server_time() TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

-- 4.4 确保水位函数已授权（幂等）
DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_project_sync_watermark(uuid) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_user_projects_watermark() TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.list_project_heads_since(timestamptz) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_accessible_project_probe(uuid) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_black_box_sync_watermark() TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_resume_recovery_probe(uuid) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_full_project_data(uuid) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_all_projects_data(timestamptz) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION public.get_projects_list(int, int) TO authenticated;
EXCEPTION WHEN undefined_function THEN NULL;
END $$;

-- Rollback §4: GRANT EXECUTE ON FUNCTION ... TO authenticated/PUBLIC;

-- ============================================
-- §5  Focus Console 最终状态验证（幂等补偿）
-- ============================================
-- 确保所有 focus console 迁移的最终状态一致

-- 5.1 focus_sessions 表结构验证
-- PK 应为 UUID（已由 phase2 cutover 完成）
-- 确保 user_id FK 有 ON DELETE CASCADE
DO $$ BEGIN
  ALTER TABLE public.focus_sessions DROP CONSTRAINT IF EXISTS focus_sessions_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.focus_sessions
    ADD CONSTRAINT focus_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5.2 routine_tasks 表结构验证
DO $$ BEGIN
  ALTER TABLE public.routine_tasks DROP CONSTRAINT IF EXISTS routine_tasks_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.routine_tasks
    ADD CONSTRAINT routine_tasks_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5.3 routine_completions 表结构验证
DO $$ BEGIN
  ALTER TABLE public.routine_completions DROP CONSTRAINT IF EXISTS routine_completions_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.routine_completions
    ADD CONSTRAINT routine_completions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 确保 routine_completions.routine_id FK 有 ON DELETE CASCADE
DO $$ BEGIN
  ALTER TABLE public.routine_completions DROP CONSTRAINT IF EXISTS routine_completions_routine_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.routine_completions
    ADD CONSTRAINT routine_completions_routine_id_fkey
    FOREIGN KEY (routine_id) REFERENCES public.routine_tasks(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5.4 确保 routine_completions 有 updated_at 列和触发器
ALTER TABLE public.routine_completions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_routine_completions_updated_at'
  ) THEN
    CREATE TRIGGER trg_routine_completions_updated_at
      BEFORE UPDATE ON public.routine_completions
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- 5.5 确保索引完整（幂等）
CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_id
  ON public.focus_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_updated_at
  ON public.focus_sessions (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_id
  ON public.routine_tasks (user_id);
CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated
  ON public.routine_tasks (user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_routine_completions_user_routine_date_key
  ON public.routine_completions (user_id, routine_id, date_key);

-- 5.6 确保 black_box_entries.focus_meta 列存在
ALTER TABLE public.black_box_entries
  ADD COLUMN IF NOT EXISTS focus_meta JSONB NULL;

-- 5.7 确保 black_box_entries shared bucket 索引
CREATE INDEX IF NOT EXISTS idx_black_box_entries_user_shared_updated
  ON public.black_box_entries (user_id, updated_at DESC)
  WHERE project_id IS NULL AND deleted_at IS NULL;

-- ============================================
-- §6  数据完整性约束补充
-- ============================================

-- 6.1 tasks 表规划字段约束（幂等验证）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_cognitive_load_check'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_cognitive_load_check
      CHECK (cognitive_load IS NULL OR cognitive_load IN ('low', 'high'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_expected_minutes_check'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_expected_minutes_check
      CHECK (expected_minutes IS NULL OR expected_minutes > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_wait_minutes_check'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_wait_minutes_check
      CHECK (wait_minutes IS NULL OR wait_minutes > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_wait_within_expected_check'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_wait_within_expected_check
      CHECK (
        expected_minutes IS NULL
        OR wait_minutes IS NULL
        OR wait_minutes <= expected_minutes
      );
  END IF;
END $$;

-- 6.2 focus_meta 约束（幂等验证）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'black_box_entries_focus_meta_source_check'
      AND conrelid = 'public.black_box_entries'::regclass
  ) THEN
    ALTER TABLE public.black_box_entries
      ADD CONSTRAINT black_box_entries_focus_meta_source_check
      CHECK (
        focus_meta IS NULL
        OR NOT (focus_meta ? 'source')
        OR focus_meta->>'source' = 'focus-console-inline'
      );
  END IF;
END $$;

-- 6.3 user_preferences 扩展列（幂等验证）
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS color_mode VARCHAR(10) DEFAULT 'system';
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS auto_resolve_conflicts BOOLEAN DEFAULT true;
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS local_backup_enabled BOOLEAN DEFAULT false;
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS local_backup_interval_ms INTEGER DEFAULT 3600000;
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS focus_preferences JSONB
    DEFAULT '{"gateEnabled":true,"spotlightEnabled":true,"strataEnabled":true,"blackBoxEnabled":true,"maxSnoozePerDay":3}'::jsonb;
ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS dock_snapshot JSONB;

-- 6.4 tasks 表规划列（幂等验证）
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS expected_minutes INTEGER;
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS cognitive_load TEXT;
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS wait_minutes INTEGER;
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS parking_meta JSONB DEFAULT NULL;

-- parking_meta 部分索引
CREATE INDEX IF NOT EXISTS idx_tasks_parking_meta
  ON public.tasks ((parking_meta IS NOT NULL))
  WHERE parking_meta IS NOT NULL;

-- ============================================
-- §7  安全审计摘要（注释记录）
-- ============================================

COMMENT ON SCHEMA public IS
  '全量安全加固完成 (2026-03-15): FORCE RLS 覆盖 18 表, anon 权限收紧, 缺失策略补充, RPC 函数分级授权';

-- ============================================
-- 完成
-- ============================================
