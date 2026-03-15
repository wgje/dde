-- ============================================
-- Focus Console 关键修复迁移
-- 修复审查发现的 CRITICAL/HIGH 数据库问题
-- ============================================
-- Rollback: 见各段末尾注释
-- 本迁移幂等安全：可重跑

-- ============================================
-- DB-1 修复：RLS 策略使用 (SELECT auth.uid()) 缓存
-- 原策略每行调用 auth.uid()，性能差 10-100×
-- ============================================

-- focus_sessions: 删除旧策略并重建
DO $$ BEGIN DROP POLICY IF EXISTS "focus_sessions_select" ON focus_sessions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "focus_sessions_insert" ON focus_sessions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "focus_sessions_update" ON focus_sessions; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN DROP POLICY IF EXISTS "focus_sessions_delete" ON focus_sessions; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_select"
    ON focus_sessions FOR SELECT
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_insert"
    ON focus_sessions FOR INSERT
    WITH CHECK ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_update"
    ON focus_sessions FOR UPDATE
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_delete"
    ON focus_sessions FOR DELETE
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- routine_tasks: 替换 FOR ALL 策略
DO $$ BEGIN DROP POLICY IF EXISTS "routine_tasks_all" ON routine_tasks; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_all"
    ON routine_tasks FOR ALL
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- routine_completions: 替换 FOR ALL 策略
DO $$ BEGIN DROP POLICY IF EXISTS "routine_completions_all" ON routine_completions; EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "routine_completions_all"
    ON routine_completions FOR ALL
    USING ((SELECT auth.uid()) = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- DB-2 修复：user_id FK 添加 ON DELETE CASCADE
-- 保持与项目其他表一致
-- ============================================

-- 1. focus_sessions.user_id
DO $$ BEGIN
  ALTER TABLE focus_sessions DROP CONSTRAINT IF EXISTS focus_sessions_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE focus_sessions
  ADD CONSTRAINT focus_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. routine_tasks.user_id
DO $$ BEGIN
  ALTER TABLE routine_tasks DROP CONSTRAINT IF EXISTS routine_tasks_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE routine_tasks
  ADD CONSTRAINT routine_tasks_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- 3. routine_completions.user_id
DO $$ BEGIN
  ALTER TABLE routine_completions DROP CONSTRAINT IF EXISTS routine_completions_user_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE routine_completions
  ADD CONSTRAINT routine_completions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ============================================
-- DI-1 修复：routine_completions 添加 updated_at 列
-- 支持 LWW 增量同步
-- ============================================

ALTER TABLE routine_completions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_routine_completions_updated_at'
  ) THEN
    CREATE TRIGGER trg_routine_completions_updated_at
      BEFORE UPDATE ON routine_completions
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================
-- M-01 补充：新表的 GRANT 语句
-- 与项目已有表保持一致
-- ============================================

GRANT ALL ON TABLE public.focus_sessions TO anon;
GRANT ALL ON TABLE public.focus_sessions TO authenticated;
GRANT ALL ON TABLE public.focus_sessions TO service_role;

GRANT ALL ON TABLE public.routine_tasks TO anon;
GRANT ALL ON TABLE public.routine_tasks TO authenticated;
GRANT ALL ON TABLE public.routine_tasks TO service_role;

GRANT ALL ON TABLE public.routine_completions TO anon;
GRANT ALL ON TABLE public.routine_completions TO authenticated;
GRANT ALL ON TABLE public.routine_completions TO service_role;

-- ============================================
-- C-5 修复：UUID 影子列添加 DEFAULT
-- 防止 phase1 和 phase2 迁移之间插入的行 id_uuid 为 NULL
-- ============================================

DO $$ BEGIN
  -- focus_sessions.id_uuid 默认值
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'focus_sessions' AND column_name = 'id_uuid'
  ) THEN
    ALTER TABLE focus_sessions ALTER COLUMN id_uuid SET DEFAULT gen_random_uuid();
  END IF;

  -- focus_sessions.started_at_v2 默认值
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'focus_sessions' AND column_name = 'started_at_v2'
  ) THEN
    ALTER TABLE focus_sessions ALTER COLUMN started_at_v2 SET DEFAULT now();
  END IF;

  -- routine_completions.id_uuid 默认值
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'routine_completions' AND column_name = 'id_uuid'
  ) THEN
    ALTER TABLE routine_completions ALTER COLUMN id_uuid SET DEFAULT gen_random_uuid();
  END IF;

  -- routine_completions.date_key_v2 默认值
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'routine_completions' AND column_name = 'date_key_v2'
  ) THEN
    ALTER TABLE routine_completions ALTER COLUMN date_key_v2 SET DEFAULT CURRENT_DATE;
  END IF;
END $$;

-- 安全回填：确保所有已有行的影子列不为 NULL
UPDATE focus_sessions SET id_uuid = gen_random_uuid() WHERE id_uuid IS NULL;
UPDATE focus_sessions SET started_at_v2 = coalesce(started_at, updated_at, now()) WHERE started_at_v2 IS NULL;
UPDATE routine_completions SET id_uuid = gen_random_uuid() WHERE id_uuid IS NULL;
UPDATE routine_completions SET date_key_v2 = coalesce(completed_date, CURRENT_DATE) WHERE date_key_v2 IS NULL;
