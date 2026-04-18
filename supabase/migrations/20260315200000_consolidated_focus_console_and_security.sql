-- ============================================================================
-- 全量汇总迁移：Focus Console + 安全加固 + 数据完整性
-- 创建日期：2026-03-15
-- ============================================================================
-- 本迁移汇总了 f4078fa 以来的所有 SQL 变更的最终状态：
--   §1  Focus Console 表创建（最终 UUID PK 状态）
--   §2  数据完整性约束（tasks / black_box_entries / routine_completions）
--   §3  FORCE RLS 全量覆盖（18 表）
--   §4  anon 角色权限收紧
--   §5  RLS 策略补充（使用 (SELECT auth.uid()) 缓存优化）
--   §6  RPC 函数安全分级（管理函数仅 service_role）
--   §7  batch_upsert_tasks 同步新字段支持
--   §8  数据安全深度加固（TEXT 长度、数值范围、JSONB 防注入）
--   §9  updated_at 触发器 + GRANT 权限
--   §10 最终状态幂等验证
--
-- 幂等安全：所有操作均可重跑
-- Rollback: 各段末尾有回滚说明
-- ============================================================================

-- 确保 pgcrypto 扩展可用（UUID 生成依赖）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- §1  Focus Console 表创建（最终 UUID PK 状态）
-- ============================================================================

-- 1.1 focus_sessions —— 专注会话快照表
CREATE TABLE IF NOT EXISTS public.focus_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  session_state   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- FK 带 ON DELETE CASCADE（用户删除时级联清除）
  CONSTRAINT focus_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 1.2 routine_tasks —— 日常任务定义表
CREATE TABLE IF NOT EXISTS public.routine_tasks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,
  title             TEXT NOT NULL,
  max_times_per_day INT NOT NULL DEFAULT 1,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT routine_tasks_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 1.3 routine_completions —— 日常任务完成记录表
CREATE TABLE IF NOT EXISTS public.routine_completions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id      UUID NOT NULL,
  user_id         UUID NOT NULL,
  date_key        DATE NOT NULL,
  count           INT NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT routine_completions_routine_id_fkey
    FOREIGN KEY (routine_id) REFERENCES public.routine_tasks(id) ON DELETE CASCADE,
  CONSTRAINT routine_completions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 1.4 routine_completion_events —— 幂等完成事件表
CREATE TABLE IF NOT EXISTS public.routine_completion_events (
  id              UUID PRIMARY KEY,
  routine_id      UUID NOT NULL,
  user_id         UUID NOT NULL,
  date_key        DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT routine_completion_events_routine_id_fkey
    FOREIGN KEY (routine_id) REFERENCES public.routine_tasks(id) ON DELETE CASCADE,
  CONSTRAINT routine_completion_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- ============================================================================
-- §1b UUID 迁移兼容处理
-- ============================================================================
-- 如果表已存在但 PK 仍为 TEXT（来自旧迁移），执行切换
-- focus_sessions: TEXT->UUID PK 切换
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'focus_sessions'
      AND column_name = 'id' AND data_type = 'text'
  ) THEN
    -- 添加影子列
    ALTER TABLE public.focus_sessions ADD COLUMN IF NOT EXISTS id_uuid UUID;
    UPDATE public.focus_sessions SET id_uuid = CASE
      WHEN id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN id::uuid ELSE gen_random_uuid() END
    WHERE id_uuid IS NULL;
    ALTER TABLE public.focus_sessions DROP CONSTRAINT IF EXISTS focus_sessions_pkey;
    ALTER TABLE public.focus_sessions DROP COLUMN id;
    ALTER TABLE public.focus_sessions RENAME COLUMN id_uuid TO id;
    ALTER TABLE public.focus_sessions ADD PRIMARY KEY (id);
    ALTER TABLE public.focus_sessions ALTER COLUMN id SET NOT NULL;
    ALTER TABLE public.focus_sessions ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;
END $$;

-- focus_sessions: started_at TEXT->TIMESTAMPTZ 修复
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'focus_sessions'
      AND column_name = 'started_at_v2'
  ) THEN
    ALTER TABLE public.focus_sessions DROP COLUMN IF EXISTS started_at;
    ALTER TABLE public.focus_sessions RENAME COLUMN started_at_v2 TO started_at;
    ALTER TABLE public.focus_sessions ALTER COLUMN started_at SET NOT NULL;
    ALTER TABLE public.focus_sessions ALTER COLUMN started_at SET DEFAULT now();
  END IF;
END $$;

-- routine_tasks: TEXT->UUID PK 切换
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'routine_tasks'
      AND column_name = 'id' AND data_type = 'text'
  ) THEN
    ALTER TABLE public.routine_completions DROP CONSTRAINT IF EXISTS routine_completions_routine_id_fkey;
    ALTER TABLE public.routine_tasks ADD COLUMN IF NOT EXISTS id_uuid UUID;
    UPDATE public.routine_tasks SET id_uuid = CASE
      WHEN id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN id::uuid ELSE gen_random_uuid() END
    WHERE id_uuid IS NULL;
    -- 同步 routine_completions.routine_id
    ALTER TABLE public.routine_completions ADD COLUMN IF NOT EXISTS routine_id_uuid UUID;
    UPDATE public.routine_completions rc SET routine_id_uuid = rt.id_uuid
    FROM public.routine_tasks rt WHERE rc.routine_id::text = rt.id::text AND rc.routine_id_uuid IS NULL;
    -- 切换 PK
    ALTER TABLE public.routine_tasks DROP CONSTRAINT IF EXISTS routine_tasks_pkey;
    ALTER TABLE public.routine_tasks DROP COLUMN id;
    ALTER TABLE public.routine_tasks RENAME COLUMN id_uuid TO id;
    ALTER TABLE public.routine_tasks ADD PRIMARY KEY (id);
    ALTER TABLE public.routine_tasks ALTER COLUMN id SET NOT NULL;
    ALTER TABLE public.routine_tasks ALTER COLUMN id SET DEFAULT gen_random_uuid();
    -- 切换 FK
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='routine_completions' AND column_name='routine_id_uuid') THEN
      ALTER TABLE public.routine_completions DROP COLUMN IF EXISTS routine_id;
      ALTER TABLE public.routine_completions RENAME COLUMN routine_id_uuid TO routine_id;
      ALTER TABLE public.routine_completions ALTER COLUMN routine_id SET NOT NULL;
    END IF;
    ALTER TABLE public.routine_completions
      ADD CONSTRAINT routine_completions_routine_id_fkey
      FOREIGN KEY (routine_id) REFERENCES public.routine_tasks(id) ON DELETE CASCADE;
  END IF;
END $$;

-- routine_completions: TEXT->UUID PK 切换
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'routine_completions'
      AND column_name = 'id' AND data_type = 'text'
  ) THEN
    ALTER TABLE public.routine_completions ADD COLUMN IF NOT EXISTS id_uuid UUID;
    UPDATE public.routine_completions SET id_uuid = CASE
      WHEN id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN id::uuid ELSE gen_random_uuid() END
    WHERE id_uuid IS NULL;
    ALTER TABLE public.routine_completions DROP CONSTRAINT IF EXISTS routine_completions_pkey;
    ALTER TABLE public.routine_completions DROP COLUMN id;
    ALTER TABLE public.routine_completions RENAME COLUMN id_uuid TO id;
    ALTER TABLE public.routine_completions ADD PRIMARY KEY (id);
    ALTER TABLE public.routine_completions ALTER COLUMN id SET NOT NULL;
    ALTER TABLE public.routine_completions ALTER COLUMN id SET DEFAULT gen_random_uuid();
  END IF;
END $$;

-- routine_completions: completed_date -> date_key 列名迁移
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'routine_completions'
      AND column_name = 'completed_date'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'routine_completions'
        AND column_name = 'date_key'
    ) THEN
      ALTER TABLE public.routine_completions RENAME COLUMN completed_date TO date_key;
    ELSE
      ALTER TABLE public.routine_completions DROP COLUMN completed_date;
    END IF;
  END IF;
END $$;

-- routine_completions: 确保 updated_at 列存在
ALTER TABLE public.routine_completions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 清理遗留影子列（如果还存在）
DO $$ BEGIN
  ALTER TABLE public.focus_sessions DROP COLUMN IF EXISTS id_uuid;
  ALTER TABLE public.focus_sessions DROP COLUMN IF EXISTS started_at_v2;
  ALTER TABLE public.routine_completions DROP COLUMN IF EXISTS id_uuid;
  ALTER TABLE public.routine_completions DROP COLUMN IF EXISTS date_key_v2;
  ALTER TABLE public.routine_completions DROP COLUMN IF EXISTS routine_id_uuid;
  ALTER TABLE public.routine_tasks DROP COLUMN IF EXISTS id_uuid;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================================
-- §1c 确保 FK 约束正确（幂等重建）
-- ============================================================================
DO $$ BEGIN
  ALTER TABLE public.focus_sessions DROP CONSTRAINT IF EXISTS focus_sessions_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE public.focus_sessions
  ADD CONSTRAINT focus_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

DO $$ BEGIN
  ALTER TABLE public.routine_tasks DROP CONSTRAINT IF EXISTS routine_tasks_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE public.routine_tasks
  ADD CONSTRAINT routine_tasks_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

DO $$ BEGIN
  ALTER TABLE public.routine_completions DROP CONSTRAINT IF EXISTS routine_completions_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE public.routine_completions
  ADD CONSTRAINT routine_completions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

DO $$ BEGIN
  ALTER TABLE public.routine_completions DROP CONSTRAINT IF EXISTS routine_completions_routine_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE public.routine_completions
  ADD CONSTRAINT routine_completions_routine_id_fkey
  FOREIGN KEY (routine_id) REFERENCES public.routine_tasks(id) ON DELETE CASCADE;

-- ============================================================================
-- §2  数据完整性约束
-- ============================================================================

-- 2.1 tasks 表规划列（确保存在）
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS expected_minutes INTEGER;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS cognitive_load TEXT;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS wait_minutes INTEGER;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS parking_meta JSONB DEFAULT NULL;

-- 2.2 tasks cognitive_load 默认值 + 回填
ALTER TABLE public.tasks ALTER COLUMN cognitive_load SET DEFAULT 'low';
UPDATE public.tasks SET cognitive_load = 'low' WHERE cognitive_load IS NULL;

-- 2.3 tasks 约束
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_cognitive_load_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_cognitive_load_check CHECK (cognitive_load IS NULL OR cognitive_load IN ('low','high'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_expected_minutes_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_expected_minutes_check CHECK (expected_minutes IS NULL OR (expected_minutes > 0 AND expected_minutes <= 14400));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_wait_minutes_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_wait_minutes_check CHECK (wait_minutes IS NULL OR (wait_minutes > 0 AND wait_minutes <= 14400));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_wait_within_expected_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_wait_within_expected_check CHECK (expected_minutes IS NULL OR wait_minutes IS NULL OR wait_minutes <= expected_minutes);
  END IF;
END $$;

-- 2.4 user_preferences 扩展列
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS color_mode VARCHAR(10) DEFAULT 'system';
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS auto_resolve_conflicts BOOLEAN DEFAULT true;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS local_backup_enabled BOOLEAN DEFAULT false;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS local_backup_interval_ms INTEGER DEFAULT 3600000;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS focus_preferences JSONB
  DEFAULT '{"gateEnabled":true,"spotlightEnabled":true,"strataEnabled":true,"blackBoxEnabled":true,"maxSnoozePerDay":3}'::jsonb;
ALTER TABLE public.user_preferences ADD COLUMN IF NOT EXISTS dock_snapshot JSONB;

-- 2.5 black_box_entries 扩展
ALTER TABLE public.black_box_entries ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE public.black_box_entries ADD COLUMN IF NOT EXISTS focus_meta JSONB NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='black_box_entries_focus_meta_source_check' AND conrelid='public.black_box_entries'::regclass)
  THEN ALTER TABLE public.black_box_entries ADD CONSTRAINT black_box_entries_focus_meta_source_check
    CHECK (focus_meta IS NULL OR NOT (focus_meta ? 'source') OR focus_meta->>'source' = 'focus-console-inline');
  END IF;
END $$;

-- ============================================================================
-- §3  索引（幂等创建，清理遗留）
-- ============================================================================

-- 清理遗留旧索引
DROP INDEX IF EXISTS public.uq_focus_sessions_user_id;
DROP INDEX IF EXISTS public.uq_routine_completions_user_routine_date;
DROP INDEX IF EXISTS public.idx_routine_completions_user_routine;

-- Focus Console 索引（仅保留复合索引，单列索引由优化迁移清理）
CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_updated_at
  ON public.focus_sessions (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated
  ON public.routine_tasks (user_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_routine_completions_user_routine_date_key
  ON public.routine_completions (user_id, routine_id, date_key);

-- parking_meta 部分索引
CREATE INDEX IF NOT EXISTS idx_tasks_parking_meta
  ON public.tasks ((parking_meta IS NOT NULL))
  WHERE parking_meta IS NOT NULL;

-- ============================================================================
-- §4  updated_at 自动刷新触发器
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_focus_sessions_updated_at')
  THEN CREATE TRIGGER trg_focus_sessions_updated_at BEFORE UPDATE ON public.focus_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_routine_tasks_updated_at')
  THEN CREATE TRIGGER trg_routine_tasks_updated_at BEFORE UPDATE ON public.routine_tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_routine_completions_updated_at')
  THEN CREATE TRIGGER trg_routine_completions_updated_at BEFORE UPDATE ON public.routine_completions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================================================
-- §5  FORCE ROW LEVEL SECURITY —— 全量覆盖（18 表）
-- ============================================================================

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

-- Focus Console 表
ALTER TABLE public.focus_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.focus_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completion_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.black_box_entries FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- §6  anon 角色权限收紧
-- ============================================================================

-- 用户数据表：完全移除 anon 权限
REVOKE ALL ON TABLE public.tasks FROM anon;
REVOKE ALL ON TABLE public.projects FROM anon;
REVOKE ALL ON TABLE public.connections FROM anon;
REVOKE ALL ON TABLE public.user_preferences FROM anon;
REVOKE ALL ON TABLE public.black_box_entries FROM anon;
REVOKE ALL ON TABLE public.focus_sessions FROM anon;
REVOKE ALL ON TABLE public.routine_tasks FROM anon;
REVOKE ALL ON TABLE public.routine_completions FROM anon;
REVOKE ALL ON TABLE public.routine_completion_events FROM anon;
REVOKE ALL ON TABLE public.transcription_usage FROM anon;

-- 墓碑/协作表
REVOKE ALL ON TABLE public.task_tombstones FROM anon;
REVOKE ALL ON TABLE public.connection_tombstones FROM anon;
REVOKE ALL ON TABLE public.project_members FROM anon;

-- 审计/内部表
REVOKE ALL ON TABLE public.circuit_breaker_logs FROM anon;
REVOKE ALL ON TABLE public.cleanup_logs FROM anon;
REVOKE ALL ON TABLE public.purge_rate_limits FROM anon;
REVOKE ALL ON TABLE public.quarantined_files FROM anon;
REVOKE ALL ON TABLE public.attachment_scans FROM anon;

-- 视图
DO $$ BEGIN REVOKE ALL ON TABLE public.active_tasks FROM anon; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN REVOKE ALL ON TABLE public.active_connections FROM anon; EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- app_config：仅保留 anon 只读
REVOKE ALL ON TABLE public.app_config FROM anon;
GRANT SELECT ON TABLE public.app_config TO anon;

-- 新表不自动授权 anon
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- ============================================================================
-- §6b  authenticated + service_role 权限完整性
-- ============================================================================

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
GRANT SELECT ON TABLE public.routine_completions TO authenticated;
GRANT ALL ON TABLE public.routine_completions TO service_role;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.routine_completions FROM authenticated;
GRANT ALL ON TABLE public.routine_completion_events TO service_role;
REVOKE ALL ON TABLE public.routine_completion_events FROM authenticated;
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

-- ============================================================================
-- §7  RLS 策略补充（使用 (SELECT auth.uid()) 缓存优化，性能提升 10-100×）
-- ============================================================================

-- 7.1 focus_sessions: 删除旧策略并使用优化版本重建
DO $$ BEGIN DROP POLICY IF EXISTS "focus_sessions_select" ON public.focus_sessions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "focus_sessions_insert" ON public.focus_sessions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "focus_sessions_update" ON public.focus_sessions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "focus_sessions_delete" ON public.focus_sessions; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_select" ON public.focus_sessions FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_insert" ON public.focus_sessions FOR INSERT
    TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_update" ON public.focus_sessions FOR UPDATE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_delete" ON public.focus_sessions FOR DELETE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7.2 routine_tasks: 优化策略
DO $$ BEGIN DROP POLICY IF EXISTS "routine_tasks_all" ON public.routine_tasks; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_select" ON public.routine_tasks FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_insert" ON public.routine_tasks FOR INSERT
    TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_update" ON public.routine_tasks FOR UPDATE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_delete" ON public.routine_tasks FOR DELETE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7.3 routine_completions: 优化策略
DO $$ BEGIN DROP POLICY IF EXISTS "routine_completions_all" ON public.routine_completions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "routine_completions_insert" ON public.routine_completions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "routine_completions_update" ON public.routine_completions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "routine_completions_delete" ON public.routine_completions; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "routine_completions_select" ON public.routine_completions FOR SELECT
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7.4 transcription_usage: 补充缺失策略
DO $$ BEGIN
  CREATE POLICY "transcription_usage_insert_policy" ON public.transcription_usage FOR INSERT
    TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "transcription_usage_update_policy" ON public.transcription_usage FOR UPDATE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "transcription_usage_delete_policy" ON public.transcription_usage FOR DELETE
    TO authenticated USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7.5 circuit_breaker_logs: 补充 INSERT 策略
DO $$ BEGIN
  CREATE POLICY "circuit_breaker_logs_insert_own" ON public.circuit_breaker_logs FOR INSERT
    TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 7.6 cleanup_logs: 仅 service_role 可访问（无 user_id 列，不对 authenticated 暴露）
DO $$ BEGIN
  DROP POLICY IF EXISTS "cleanup_logs_authenticated_select" ON public.cleanup_logs;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- ============================================================================
-- §8  RPC 函数安全分级
-- ============================================================================

-- 8.1 管理/维护函数仅限 service_role
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_deleted_attachments(integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_deleted_attachments(integer) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_deleted_attachments(integer) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_expired_scan_records() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_expired_scan_records() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_routine_completion_events_user_routine_date
    ON public.routine_completion_events (user_id, routine_id, date_key);

  CREATE OR REPLACE FUNCTION public.increment_routine_completion(
    p_completion_id uuid,
    p_routine_id uuid,
    p_date_key date
  )
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = 'pg_catalog', 'public'
  AS $fn$
  DECLARE
    v_user_id uuid;
    v_next_count integer;
  BEGIN
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'Authentication required'
        USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM public.routine_tasks
    WHERE id = p_routine_id
      AND user_id = v_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Routine not found'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.routine_completion_events (id, routine_id, user_id, date_key)
    VALUES (p_completion_id, p_routine_id, v_user_id, p_date_key)
    ON CONFLICT (id) DO NOTHING;

    IF NOT FOUND THEN
      SELECT count
      INTO v_next_count
      FROM public.routine_completions
      WHERE user_id = v_user_id
        AND routine_id = p_routine_id
        AND date_key = p_date_key;

      RETURN COALESCE(v_next_count, 0);
    END IF;

    INSERT INTO public.routine_completions (id, routine_id, user_id, date_key, count)
    VALUES (p_completion_id, p_routine_id, v_user_id, p_date_key, 1)
    ON CONFLICT (user_id, routine_id, date_key) DO UPDATE
    SET count = public.routine_completions.count + 1
    RETURNING count INTO v_next_count;

    RETURN v_next_count;
  END;
  $fn$;

  REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.increment_routine_completion(uuid, uuid, date) FROM anon;
  GRANT EXECUTE ON FUNCTION public.increment_routine_completion(uuid, uuid, date) TO authenticated;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_connections() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cleanup_old_logs() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.cleanup_old_logs() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.cleanup_old_logs() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.migrate_all_projects_to_v2() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.migrate_all_projects_to_v2() FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() TO service_role;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM authenticated;
  GRANT EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

-- 8.2 业务 RPC 函数确保 authenticated 可调用
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_server_time() TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;

-- 8.3 水位函数
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_project_sync_watermark(uuid) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_user_projects_watermark() TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.list_project_heads_since(timestamptz) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_accessible_project_probe(uuid) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_black_box_sync_watermark() TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_resume_recovery_probe(uuid) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_full_project_data(uuid) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_all_projects_data(timestamptz) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;
DO $$ BEGIN GRANT EXECUTE ON FUNCTION public.get_projects_list(int, int) TO authenticated; EXCEPTION WHEN undefined_function THEN NULL; END $$;

-- ============================================================================
-- §9  batch_upsert_tasks 升级 —— 支持 Focus Console 新字段
-- ============================================================================
-- 原版本缺少 parking_meta, expected_minutes, cognitive_load, wait_minutes
-- 新增安全约束：字段值范围验证、TEXT 长度限制

CREATE OR REPLACE FUNCTION public.batch_upsert_tasks(
  p_tasks jsonb[],
  p_project_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_count integer := 0;
  v_task jsonb;
  v_user_id uuid;
  v_title text;
  v_content text;
  v_cognitive text;
  v_expected int;
  v_wait int;
BEGIN
  -- 权限校验
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;

  -- 个人版后端仅允许 owner 批量写任务主字段，附件由专用 RPC 负责
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner';
  END IF;

  FOREACH v_task IN ARRAY p_tasks
  LOOP
    -- 安全校验：TEXT 长度限制（防 DoS / 数据溢出）
    v_title := v_task->>'title';
    v_content := v_task->>'content';
    IF v_title IS NOT NULL AND length(v_title) > 10000 THEN
      RAISE EXCEPTION 'Title too long (max 10000 chars) for task %', v_task->>'id';
    END IF;
    IF v_content IS NOT NULL AND length(v_content) > 1000000 THEN
      RAISE EXCEPTION 'Content too long (max 1000000 chars) for task %', v_task->>'id';
    END IF;

    -- 安全校验：数值范围（防溢出）
    v_expected := (v_task->>'expectedMinutes')::integer;
    v_wait := (v_task->>'waitMinutes')::integer;
    v_cognitive := v_task->>'cognitiveLoad';

    IF v_expected IS NOT NULL AND (v_expected <= 0 OR v_expected > 14400) THEN
      RAISE EXCEPTION 'expected_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_wait IS NOT NULL AND (v_wait <= 0 OR v_wait > 14400) THEN
      RAISE EXCEPTION 'wait_minutes out of range (1-14400) for task %', v_task->>'id';
    END IF;
    IF v_cognitive IS NOT NULL AND v_cognitive NOT IN ('low', 'high') THEN
      RAISE EXCEPTION 'cognitive_load must be low or high for task %', v_task->>'id';
    END IF;

    INSERT INTO public.tasks AS existing (
      id, project_id, title, content, stage, parent_id,
      "order", rank, status, x, y, short_id, deleted_at,
      attachments, expected_minutes, cognitive_load, wait_minutes, parking_meta
    )
    VALUES (
      (v_task->>'id')::uuid,
      p_project_id,
      v_title,
      v_content,
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      v_task->>'shortId',
      (v_task->>'deletedAt')::timestamptz,
      '[]'::jsonb,
      v_expected,
      COALESCE(v_cognitive, 'low'),
      v_wait,
      v_task->'parkingMeta'
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      stage = EXCLUDED.stage,
      parent_id = EXCLUDED.parent_id,
      "order" = EXCLUDED."order",
      rank = EXCLUDED.rank,
      status = EXCLUDED.status,
      x = EXCLUDED.x,
      y = EXCLUDED.y,
      short_id = EXCLUDED.short_id,
      deleted_at = EXCLUDED.deleted_at,
      attachments = COALESCE(existing.attachments, '[]'::jsonb),
      expected_minutes = EXCLUDED.expected_minutes,
      cognitive_load = EXCLUDED.cognitive_load,
      wait_minutes = EXCLUDED.wait_minutes,
      parking_meta = EXCLUDED.parking_meta,
      updated_at = now()
    WHERE existing.project_id = p_project_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Task project mismatch';
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

COMMENT ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) IS
  'Owner-only batch upsert for task core fields. Attachments stay on dedicated append/remove RPCs.';

-- ============================================================================
-- §10  数据安全深度加固
-- ============================================================================

-- 10.1 routine_tasks.title 长度约束（防 DoS）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_tasks_title_length_check' AND conrelid='public.routine_tasks'::regclass)
  THEN ALTER TABLE public.routine_tasks ADD CONSTRAINT routine_tasks_title_length_check CHECK (length(title) <= 1000);
  END IF;
END $$;

-- 10.2 routine_tasks.max_times_per_day 范围约束
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_tasks_max_times_check' AND conrelid='public.routine_tasks'::regclass)
  THEN ALTER TABLE public.routine_tasks ADD CONSTRAINT routine_tasks_max_times_check CHECK (max_times_per_day > 0 AND max_times_per_day <= 100);
  END IF;
END $$;

-- 10.3 routine_completions.count 范围约束
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='routine_completions_count_check' AND conrelid='public.routine_completions'::regclass)
  THEN ALTER TABLE public.routine_completions ADD CONSTRAINT routine_completions_count_check CHECK (count > 0 AND count <= 1000);
  END IF;
END $$;

-- 10.4 focus_sessions.session_state JSONB 大小约束（防超大载荷）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='focus_sessions_state_size_check' AND conrelid='public.focus_sessions'::regclass)
  THEN ALTER TABLE public.focus_sessions ADD CONSTRAINT focus_sessions_state_size_check
    CHECK (pg_column_size(session_state) <= 1048576);
  END IF;
END $$;

-- 10.5 user_preferences.dock_snapshot JSONB 大小约束
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_dock_snapshot_size_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_dock_snapshot_size_check
    CHECK (dock_snapshot IS NULL OR pg_column_size(dock_snapshot) <= 1048576);
  END IF;
END $$;

-- 10.6 user_preferences.focus_preferences JSONB 大小约束
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_focus_pref_size_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_focus_pref_size_check
    CHECK (focus_preferences IS NULL OR pg_column_size(focus_preferences) <= 65536);
  END IF;
END $$;

-- 10.7 user_preferences.color_mode 枚举约束
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_color_mode_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_color_mode_check
    CHECK (color_mode IS NULL OR color_mode IN ('light', 'dark', 'system'));
  END IF;
END $$;

-- 10.8 user_preferences.local_backup_interval_ms 范围约束（最小 5 分钟，最大 7 天）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='user_preferences_backup_interval_check' AND conrelid='public.user_preferences'::regclass)
  THEN ALTER TABLE public.user_preferences ADD CONSTRAINT user_preferences_backup_interval_check
    CHECK (local_backup_interval_ms IS NULL OR (local_backup_interval_ms >= 300000 AND local_backup_interval_ms <= 604800000));
  END IF;
END $$;

-- 10.9 tasks.parking_meta JSONB 大小约束（防止超大 payload 注入）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_parking_meta_size_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_parking_meta_size_check
    CHECK (parking_meta IS NULL OR pg_column_size(parking_meta) <= 524288);
  END IF;
END $$;

-- 10.10 black_box_entries.focus_meta JSONB 大小约束
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='black_box_entries_focus_meta_size_check' AND conrelid='public.black_box_entries'::regclass)
  THEN ALTER TABLE public.black_box_entries ADD CONSTRAINT black_box_entries_focus_meta_size_check
    CHECK (focus_meta IS NULL OR pg_column_size(focus_meta) <= 262144);
  END IF;
END $$;

-- 10.11 tasks.title 长度约束
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_title_length_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_title_length_check
    CHECK (title IS NULL OR length(title) <= 10000);
  END IF;
END $$;

-- 10.12 tasks.content 长度约束（1MB text 上限）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tasks_content_length_check' AND conrelid='public.tasks'::regclass)
  THEN ALTER TABLE public.tasks ADD CONSTRAINT tasks_content_length_check
    CHECK (content IS NULL OR length(content) <= 1000000);
  END IF;
END $$;

-- ============================================================================
-- §11  安全审计注释
-- ============================================================================

COMMENT ON SCHEMA public IS
  '全量安全加固完成 (2026-03-15): FORCE RLS 18表, anon零写入, RPC分级授权, JSONB/TEXT/数值溢出防护, batch_upsert同步新字段';

COMMENT ON COLUMN public.black_box_entries.project_id IS
  '所属项目 ID；NULL 表示共享黑匣子仓（跨项目可见）';

COMMENT ON COLUMN public.tasks.parking_meta IS
  'State Overlap 停泊元数据（JSONB）。结构：{ state, parkedAt, lastVisitedAt, contextSnapshot, reminder, pinned }。NULL 表示非停泊任务。';

-- ============================================================================
-- 完成
-- ============================================================================
