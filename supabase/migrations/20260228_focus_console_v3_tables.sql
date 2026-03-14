-- ============================================
-- Focus Console v3.0: 新增表 + RLS
-- 策划案 §13.1 / §13.3
-- ============================================
-- 注意：tasks 表的 expected_minutes / cognitive_load / wait_minutes
-- 已在 20260226_add_task_planning_fields.sql 中添加，对应策划案
-- focus_estimated_minutes / focus_cognitive_load / focus_wait_minutes，
-- 不再重复 ALTER。
--
-- ⚠️ WARNING: Phase-2 cutover migration (uuid_phase2) requires ACCESS EXCLUSIVE lock.
--            Schedule during maintenance window for production deployments.
-- Rollback: DROP TABLE IF EXISTS routine_completions, routine_tasks, focus_sessions CASCADE;

-- 1. 专注会话快照表 ──────────────────────────
CREATE TABLE IF NOT EXISTS focus_sessions (
  id              TEXT PRIMARY KEY,           -- 客户端 crypto.randomUUID()
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  session_state   JSONB NOT NULL,             -- FocusSessionState 序列化
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_id
  ON focus_sessions (user_id);

-- 2. 日常任务表 ────────────────────────────
CREATE TABLE IF NOT EXISTS routine_tasks (
  id                TEXT PRIMARY KEY,         -- 客户端 crypto.randomUUID()
  user_id           UUID NOT NULL REFERENCES auth.users(id),
  title             TEXT NOT NULL,
  max_times_per_day INT NOT NULL DEFAULT 1,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_id
  ON routine_tasks (user_id);

-- 复合索引：按用户+更新时间排序查询（M-13 性能优化）
CREATE INDEX IF NOT EXISTS idx_routine_tasks_user_updated
  ON routine_tasks (user_id, updated_at DESC);

-- 3. 日常任务完成记录表 ─────────────────────
CREATE TABLE IF NOT EXISTS routine_completions (
  id              TEXT PRIMARY KEY,           -- 客户端 crypto.randomUUID()
  routine_id      TEXT NOT NULL REFERENCES routine_tasks(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  completed_date  DATE NOT NULL,
  count           INT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_routine_completions_user_routine
  ON routine_completions (user_id, routine_id, completed_date);

-- ============================================
-- updated_at 自动刷新触发器（H-21 修复）
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_focus_sessions_updated_at'
  ) THEN
    CREATE TRIGGER trg_focus_sessions_updated_at
      BEFORE UPDATE ON focus_sessions
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_routine_tasks_updated_at'
  ) THEN
    CREATE TRIGGER trg_routine_tasks_updated_at
      BEFORE UPDATE ON routine_tasks
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ============================================
-- RLS 策略（策划案 §13.3）
-- 幂等包装：避免重跑时 CREATE POLICY 报 duplicate_object 错误（H-20 修复）
-- ============================================

-- focus_sessions
ALTER TABLE focus_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_select"
    ON focus_sessions FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_insert"
    ON focus_sessions FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_update"
    ON focus_sessions FOR UPDATE
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "focus_sessions_delete"
    ON focus_sessions FOR DELETE
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- routine_tasks
ALTER TABLE routine_tasks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "routine_tasks_all"
    ON routine_tasks FOR ALL
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- routine_completions
ALTER TABLE routine_completions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "routine_completions_all"
    ON routine_completions FOR ALL
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
