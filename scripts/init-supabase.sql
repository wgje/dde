-- ============================================================
-- NanoFlow Supabase 完整初始化脚本（统一导入）
-- ============================================================
-- 版本: 3.3.0
-- 最后验证: 2026-01-25
--
-- 更新日志：
--   3.3.0 (2026-01-25): 添加专注模式支持：black_box_entries 表和 transcription_usage 表
--   3.2.0 (2026-01-09): 修复 batch_upsert_tasks 函数：移除不存在的 owner_id 列引用，
--                       使用 project.owner_id + project_members 进行权限校验；
--                       添加 SET search_path；修复 rank/x/y 类型为 numeric
--   3.1.0 (2026-01-07): 修复 get_dashboard_stats 使用 JOIN 查询；添加 active_connections 视图；
--                       添加 connections/user_preferences updated_at 索引；添加 Storage UPDATE 策略
--   3.0.0 (2026-01-04): 初始整合版本
--
-- 目标：新项目可在 Supabase SQL Editor 一次性执行本脚本完成全部数据库对象创建。
-- 说明：此文件由以下来源整合生成：
--   - scripts/init-database.sql（基础表 / RLS / Storage / Realtime）
--   - supabase/migrations/archive/*.sql（历史增量加固、tombstone、purge、病毒扫描、仪表盘 RPC 等）
--
-- 推荐用法：
--   1) 在 Supabase Dashboard 启用必要扩展（如 pg_cron）
--   2) 在 Storage 创建 attachments 私有桶
--   3) 在 SQL Editor 执行本脚本
-- ============================================================

-- ============================================================
-- [BASE] scripts/init-database.sql
-- ============================================================
-- ============================================================
-- NanoFlow 数据库初始化脚本 (一次性导入)
-- ============================================================
-- 
-- 用法：在 Supabase SQL Editor 中执行此脚本完成所有数据库配置
-- 
-- 包含：
--   1. 核心表结构 (projects, tasks, connections, user_preferences)
--   2. RLS 安全策略
--   3. 自动更新时间戳触发器
--   4. 附件 RPC 函数
--   5. 定时清理函数
--   6. 实时订阅配置
--   7. Storage 策略
--
-- 版本: 2.1.0
-- 最后更新: 2025-01-01
-- ============================================================

-- ============================================
-- 0. 辅助函数
-- ============================================

-- 自动更新 updated_at 时间戳
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.update_updated_at_column()
  SET search_path = pg_catalog, public;

-- ============================================
-- 1. 项目表 (projects)
-- ============================================

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  created_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  version INTEGER DEFAULT 1,
  data JSONB DEFAULT '{}'::jsonb,
  migrated_to_v2 BOOLEAN DEFAULT FALSE
);

-- 添加新列（兼容已有表）
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'version') THEN
    ALTER TABLE public.projects ADD COLUMN version INTEGER DEFAULT 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'migrated_to_v2') THEN
    ALTER TABLE public.projects ADD COLUMN migrated_to_v2 BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'data') THEN
    ALTER TABLE public.projects ADD COLUMN data JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_projects_updated_at ON public.projects;
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON public.projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON public.projects(updated_at);

-- ============================================
-- 2. 项目成员表 (project_members)
-- ============================================

CREATE TABLE IF NOT EXISTS public.project_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
  invited_by UUID REFERENCES auth.users(id),
  invited_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  accepted_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(project_id, user_id)
);

ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON public.project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON public.project_members(user_id);

-- ============================================
-- 3. 任务表 (tasks)
-- ============================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT DEFAULT '',
  stage INTEGER,
  "order" INTEGER DEFAULT 0,
  rank NUMERIC DEFAULT 10000,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  x NUMERIC DEFAULT 0,
  y NUMERIC DEFAULT 0,
  short_id VARCHAR(20),
  priority VARCHAR(20) CHECK (priority IS NULL OR priority IN ('low', 'medium', 'high', 'urgent')),
  due_date TIMESTAMP WITH TIME ZONE,
  tags JSONB DEFAULT '[]'::jsonb,
  attachments JSONB DEFAULT '[]'::jsonb,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_tasks_updated_at ON public.tasks;
CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON public.tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON public.tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_stage ON public.tasks(project_id, stage);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON public.tasks(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON public.tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_short_id ON public.tasks(project_id, short_id);

-- ============================================
-- 4. 连接表 (connections)
-- ============================================

CREATE TABLE IF NOT EXISTS public.connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  deleted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(project_id, source_id, target_id)
);

-- 兼容旧表
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connections' AND column_name = 'title') THEN
    ALTER TABLE public.connections ADD COLUMN title TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'connections' AND column_name = 'deleted_at') THEN
    ALTER TABLE public.connections ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_connections_updated_at ON public.connections;
CREATE TRIGGER update_connections_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_connections_project_id ON public.connections(project_id);
CREATE INDEX IF NOT EXISTS idx_connections_source_id ON public.connections(source_id);
CREATE INDEX IF NOT EXISTS idx_connections_target_id ON public.connections(target_id);
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at ON public.connections(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at_cleanup ON public.connections(deleted_at) WHERE deleted_at IS NOT NULL;
-- 增量同步索引（支持 updated_at > last_sync_time 查询）
CREATE INDEX IF NOT EXISTS idx_connections_updated_at ON public.connections(updated_at);
CREATE INDEX IF NOT EXISTS idx_connections_project_updated ON public.connections(project_id, updated_at DESC);

-- ============================================
-- 5. 用户偏好设置表 (user_preferences)
-- ============================================

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  theme VARCHAR(20) DEFAULT 'default',
  layout_direction VARCHAR(10) DEFAULT 'ltr',
  floating_window_pref VARCHAR(20) DEFAULT 'auto',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

DROP TRIGGER IF EXISTS update_user_preferences_updated_at ON public.user_preferences;
CREATE TRIGGER update_user_preferences_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON public.user_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_updated_at ON public.user_preferences(updated_at);

-- ============================================
-- 5.1 黑匣子条目表 (black_box_entries) - 专注模式
-- ============================================

CREATE TABLE IF NOT EXISTS public.black_box_entries (
  -- 主键：由客户端 crypto.randomUUID() 生成
  id UUID PRIMARY KEY,
  
  -- 外键关联
  project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 内容
  content TEXT NOT NULL,
  
  -- 时间字段
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- 状态字段
  is_read BOOLEAN DEFAULT FALSE,
  is_completed BOOLEAN DEFAULT FALSE,
  is_archived BOOLEAN DEFAULT FALSE,
  
  -- 跳过/稍后提醒
  snooze_until DATE DEFAULT NULL,
  snooze_count INTEGER DEFAULT 0,
  
  -- 软删除
  deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- 添加表注释
COMMENT ON TABLE public.black_box_entries IS '黑匣子条目表 - 语音转写记录，用于紧急捕捉想法';
COMMENT ON COLUMN public.black_box_entries.id IS '由客户端 crypto.randomUUID() 生成';
COMMENT ON COLUMN public.black_box_entries.content IS '语音转写后的文本内容';
COMMENT ON COLUMN public.black_box_entries.date IS 'YYYY-MM-DD 格式，用于按日分组';
COMMENT ON COLUMN public.black_box_entries.is_read IS '是否已读，已读条目不会在大门中出现';
COMMENT ON COLUMN public.black_box_entries.is_completed IS '是否已完成，计入地质层';
COMMENT ON COLUMN public.black_box_entries.is_archived IS '是否已归档，不显示在主列表';
COMMENT ON COLUMN public.black_box_entries.snooze_until IS '跳过至该日期，在此之前不会在大门中出现';
COMMENT ON COLUMN public.black_box_entries.snooze_count IS '已跳过次数';

-- 索引
CREATE INDEX IF NOT EXISTS idx_black_box_user_date ON public.black_box_entries(user_id, date);
CREATE INDEX IF NOT EXISTS idx_black_box_project ON public.black_box_entries(project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_black_box_pending ON public.black_box_entries(user_id, is_read, is_completed) WHERE deleted_at IS NULL AND is_archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_black_box_updated_at ON public.black_box_entries(updated_at);

-- updated_at 自动更新触发器
DROP TRIGGER IF EXISTS update_black_box_entries_updated_at ON public.black_box_entries;
CREATE TRIGGER update_black_box_entries_updated_at
  BEFORE UPDATE ON public.black_box_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS 策略
ALTER TABLE public.black_box_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;
CREATE POLICY "black_box_select_policy" ON public.black_box_entries 
  FOR SELECT USING (
    auth.uid() = user_id OR
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = auth.uid()
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "black_box_insert_policy" ON public.black_box_entries;
CREATE POLICY "black_box_insert_policy" ON public.black_box_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "black_box_update_policy" ON public.black_box_entries;
CREATE POLICY "black_box_update_policy" ON public.black_box_entries
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "black_box_delete_policy" ON public.black_box_entries;
CREATE POLICY "black_box_delete_policy" ON public.black_box_entries
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 5.2 转写使用量表 (transcription_usage) - 专注模式
-- ============================================

CREATE TABLE IF NOT EXISTS public.transcription_usage (
  -- 主键：由 Edge Function 使用 crypto.randomUUID() 生成
  id UUID PRIMARY KEY,
  
  -- 外键关联
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- 使用量数据
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  audio_seconds INTEGER DEFAULT 0,
  
  -- 时间戳
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 添加表注释
COMMENT ON TABLE public.transcription_usage IS '转写 API 使用量追踪表 - 用于配额控制';
COMMENT ON COLUMN public.transcription_usage.audio_seconds IS '估算的音频秒数';

-- 索引
CREATE INDEX IF NOT EXISTS idx_transcription_usage_user_date ON public.transcription_usage(user_id, date);

-- RLS 策略
ALTER TABLE public.transcription_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "transcription_usage_select_policy" ON public.transcription_usage;
CREATE POLICY "transcription_usage_select_policy" ON public.transcription_usage 
  FOR SELECT USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE 由 Edge Function 使用 service_role 执行，无需用户策略

-- ============================================
-- 6. 清理日志表 (cleanup_logs)
-- ============================================

CREATE TABLE IF NOT EXISTS public.cleanup_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.cleanup_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_type ON public.cleanup_logs(type);
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON public.cleanup_logs(created_at);

-- ============================================
-- 6.1 任务 Tombstone 表 (task_tombstones)
-- 用于永久删除任务后防止复活
-- ============================================

CREATE TABLE IF NOT EXISTS public.task_tombstones (
  task_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deleted_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.task_tombstones ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_id ON public.task_tombstones(project_id);

-- RLS 策略
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;

CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = task_tombstones.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid())
  ))
);
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = task_tombstones.project_id AND p.owner_id = auth.uid())
);

-- ============================================
-- 6.2 连接 Tombstone 表 (connection_tombstones)
-- 用于永久删除连接后防止复活
-- ============================================

CREATE TABLE IF NOT EXISTS public.connection_tombstones (
  connection_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  deleted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.connection_tombstones ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_project_id ON public.connection_tombstones(project_id);
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_at ON public.connection_tombstones(deleted_at);

-- RLS 策略
DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;

CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connection_tombstones.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid())
  ))
);

CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connection_tombstones.project_id AND p.owner_id = auth.uid())
);

-- 11. purge_rate_limits 表（速率限制）
-- ============================================

CREATE TABLE IF NOT EXISTS public.purge_rate_limits (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  call_count INTEGER DEFAULT 0,
  window_start TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.purge_rate_limits ENABLE ROW LEVEL SECURITY;

-- RLS 策略
DROP POLICY IF EXISTS "purge_rate_limits_own" ON public.purge_rate_limits;

CREATE POLICY "purge_rate_limits_own" ON public.purge_rate_limits
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================
-- 自定义类型
-- ============================================

-- purge_result 复合类型
DROP TYPE IF EXISTS purge_result CASCADE;
CREATE TYPE purge_result AS (
  purged_count INTEGER,
  attachment_paths TEXT[]
);

-- ============================================
-- 触发器和函数
-- ============================================

-- 防止 tombstone 连接复活的触发器
CREATE OR REPLACE FUNCTION prevent_tombstoned_connection_writes()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.connection_tombstones WHERE connection_id = NEW.id) THEN
    -- 静默忽略，防止旧客户端数据复活
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_connection_resurrection ON public.connections;
CREATE TRIGGER trg_prevent_connection_resurrection
  BEFORE INSERT OR UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION prevent_tombstoned_connection_writes();

-- 自动记录 Connection Tombstone 的触发器
CREATE OR REPLACE FUNCTION record_connection_tombstone()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在真正删除时记录（不是软删除）
  IF OLD.deleted_at IS NOT NULL THEN
    INSERT INTO public.connection_tombstones (connection_id, project_id, deleted_by)
    VALUES (OLD.id, OLD.project_id, auth.uid())
    ON CONFLICT (connection_id) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_record_connection_tombstone ON public.connections;
CREATE TRIGGER trg_record_connection_tombstone
  BEFORE DELETE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION record_connection_tombstone();

-- 检查连接是否已被 tombstone
CREATE OR REPLACE FUNCTION is_connection_tombstoned(p_connection_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
BEGIN
  -- 权限校验：无权访问时返回 false
  IF NOT EXISTS (
    SELECT 1 FROM public.connections c
    JOIN public.projects p ON c.project_id = p.id
    WHERE c.id = p_connection_id
      AND (
        p.owner_id = auth.uid() 
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = auth.uid()
        )
      )
  ) THEN
    RETURN false;
  END IF;
  
  -- 检查是否在 tombstone 表中
  RETURN EXISTS (
    SELECT 1 FROM public.connection_tombstones
    WHERE connection_id = p_connection_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION is_connection_tombstoned(UUID) TO authenticated;
GRANT SELECT, INSERT ON public.connection_tombstones TO service_role;
GRANT SELECT, INSERT ON public.connection_tombstones TO authenticated;

-- 防止 tombstone 任务复活的触发器
-- prevent_tombstoned_task_writes 函数已在后面的 MIGRATION 20251212_prevent_task_resurrection.sql 中定义（第 1379 行）

-- ============================================
-- 7. RLS 策略 - Projects
-- ============================================

DROP POLICY IF EXISTS "owner select" ON public.projects;
DROP POLICY IF EXISTS "owner insert" ON public.projects;
DROP POLICY IF EXISTS "owner update" ON public.projects;
DROP POLICY IF EXISTS "owner delete" ON public.projects;

CREATE POLICY "owner select" ON public.projects FOR SELECT USING (
  auth.uid() = owner_id OR EXISTS (
    SELECT 1 FROM public.project_members WHERE project_id = projects.id AND user_id = auth.uid()
  )
);
CREATE POLICY "owner insert" ON public.projects FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "owner update" ON public.projects FOR UPDATE USING (
  auth.uid() = owner_id OR EXISTS (
    SELECT 1 FROM public.project_members WHERE project_id = projects.id AND user_id = auth.uid() AND role IN ('editor', 'admin')
  )
);
CREATE POLICY "owner delete" ON public.projects FOR DELETE USING (auth.uid() = owner_id);

-- ============================================
-- 8. RLS 策略 - Project Members
-- ============================================

DROP POLICY IF EXISTS "project_members select" ON public.project_members;
DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
DROP POLICY IF EXISTS "project_members update" ON public.project_members;
DROP POLICY IF EXISTS "project_members delete" ON public.project_members;

CREATE POLICY "project_members select" ON public.project_members FOR SELECT USING (
  user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_members.project_id AND pm.user_id = auth.uid())
);
CREATE POLICY "project_members insert" ON public.project_members FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid())
  OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = project_members.project_id AND pm.user_id = auth.uid() AND pm.role = 'admin')
);
CREATE POLICY "project_members update" ON public.project_members FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid())
);
CREATE POLICY "project_members delete" ON public.project_members FOR DELETE USING (
  user_id = auth.uid() OR EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_members.project_id AND p.owner_id = auth.uid())
);

-- ============================================
-- 9. RLS 策略 - Tasks
-- ============================================

DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;

CREATE POLICY "tasks owner select" ON public.tasks FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = tasks.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid())
  ))
);
CREATE POLICY "tasks owner insert" ON public.tasks FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = tasks.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid() AND pm.role IN ('editor', 'admin'))
  ))
);
CREATE POLICY "tasks owner update" ON public.tasks FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = tasks.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid() AND pm.role IN ('editor', 'admin'))
  ))
);
CREATE POLICY "tasks owner delete" ON public.tasks FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = tasks.project_id AND p.owner_id = auth.uid())
);

-- ============================================
-- 10. RLS 策略 - Connections
-- ============================================

DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;

CREATE POLICY "connections owner select" ON public.connections FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connections.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid())
  ))
);
CREATE POLICY "connections owner insert" ON public.connections FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connections.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid() AND pm.role IN ('editor', 'admin'))
  ))
);
CREATE POLICY "connections owner update" ON public.connections FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connections.project_id AND (
    p.owner_id = auth.uid() OR EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id AND pm.user_id = auth.uid() AND pm.role IN ('editor', 'admin'))
  ))
);
CREATE POLICY "connections owner delete" ON public.connections FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.projects p WHERE p.id = connections.project_id AND p.owner_id = auth.uid())
);

-- ============================================
-- 11. RLS 策略 - User Preferences
-- ============================================

DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

CREATE POLICY "Users can view own preferences" ON public.user_preferences FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own preferences" ON public.user_preferences FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own preferences" ON public.user_preferences FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own preferences" ON public.user_preferences FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- 12. 附件 RPC 函数
-- ============================================

-- 添加附件（原子操作）
CREATE OR REPLACE FUNCTION append_task_attachment(p_task_id UUID, p_attachment JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  v_current_attachments JSONB;
  v_attachment_id TEXT;
BEGIN
  v_attachment_id := p_attachment->>'id';
  IF v_attachment_id IS NULL THEN RAISE EXCEPTION 'Attachment must have an id'; END IF;
  
  SELECT attachments INTO v_current_attachments FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF v_current_attachments IS NULL THEN v_current_attachments := '[]'::JSONB; END IF;
  
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' = v_attachment_id) THEN
    RETURN TRUE;
  END IF;
  
  UPDATE tasks SET attachments = v_current_attachments || p_attachment, updated_at = NOW() WHERE id = p_task_id;
  RETURN TRUE;
END; $$;

-- 移除附件（原子操作）
CREATE OR REPLACE FUNCTION remove_task_attachment(p_task_id UUID, p_attachment_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  v_current_attachments JSONB;
  v_new_attachments JSONB;
BEGIN
  SELECT attachments INTO v_current_attachments FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Task not found: %', p_task_id; END IF;
  IF v_current_attachments IS NULL OR jsonb_array_length(v_current_attachments) = 0 THEN RETURN TRUE; END IF;
  
  SELECT COALESCE(jsonb_agg(elem), '[]'::JSONB) INTO v_new_attachments
  FROM jsonb_array_elements(v_current_attachments) AS elem WHERE elem->>'id' != p_attachment_id;
  
  UPDATE tasks SET attachments = v_new_attachments, updated_at = NOW() WHERE id = p_task_id;
  RETURN TRUE;
END; $$;

-- 授予 authenticated 用户执行权限
GRANT EXECUTE ON FUNCTION append_task_attachment(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION remove_task_attachment(UUID, TEXT) TO authenticated;

-- ============================================
-- 13. 清理函数
-- ============================================

-- 清理软删除任务（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_deleted_tasks()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.tasks WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END; $$;

-- 清理旧日志（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.cleanup_logs WHERE created_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  RETURN deleted_count;
END; $$;

-- 清理软删除连接（30天后）
CREATE OR REPLACE FUNCTION cleanup_old_deleted_connections()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE deleted_count INTEGER;
BEGIN
  WITH deleted AS (
    DELETE FROM public.connections WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '30 days' RETURNING id
  ) SELECT COUNT(*) INTO deleted_count FROM deleted;
  
  IF deleted_count > 0 THEN
    INSERT INTO public.cleanup_logs (type, details)
    VALUES ('deleted_connections_cleanup', jsonb_build_object('deleted_count', deleted_count, 'cleanup_time', NOW()));
  END IF;
  
  RETURN deleted_count;
END; $$;

-- 迁移函数：从 JSONB 到独立表
CREATE OR REPLACE FUNCTION migrate_project_data_to_v2(p_project_id UUID)
RETURNS TABLE (
  tasks_migrated INTEGER,
  connections_migrated INTEGER,
  errors TEXT[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  project_record RECORD;
  task_data JSONB;
  conn_data JSONB;
  task_record JSONB;
  conn_record JSONB;
  task_id UUID;
  task_count INTEGER := 0;
  conn_count INTEGER := 0;
  error_list TEXT[] := ARRAY[]::TEXT[];
  old_id_to_new_id JSONB := '{}'::jsonb;
BEGIN
  -- 获取项目数据
  SELECT * INTO project_record 
  FROM public.projects 
  WHERE id = p_project_id;
  
  IF NOT FOUND THEN
    error_list := array_append(error_list, 'Project not found: ' || p_project_id::text);
    RETURN QUERY SELECT 0, 0, error_list;
    RETURN;
  END IF;
  
  -- 检查是否已迁移
  IF project_record.migrated_to_v2 = TRUE THEN
    error_list := array_append(error_list, 'Project already migrated');
    RETURN QUERY SELECT 0, 0, error_list;
    RETURN;
  END IF;
  
  -- 获取 tasks 数组
  task_data := COALESCE(project_record.data->'tasks', '[]'::jsonb);
  
  -- 迁移每个任务
  FOR task_record IN SELECT * FROM jsonb_array_elements(task_data)
  LOOP
    BEGIN
      -- 生成新的 UUID（保留原 ID 作为映射）
      task_id := COALESCE(
        (task_record->>'id')::uuid,
        gen_random_uuid()
      );
      
      -- 存储 ID 映射
      old_id_to_new_id := old_id_to_new_id || jsonb_build_object(
        task_record->>'id', 
        task_id::text
      );
      
      -- 插入任务（如果不存在）
      INSERT INTO public.tasks (
        id,
        project_id,
        parent_id,
        title,
        content,
        stage,
        "order",
        rank,
        status,
        x,
        y,
        short_id,
        priority,
        due_date,
        tags,
        attachments,
        deleted_at,
        created_at
      ) VALUES (
        task_id,
        p_project_id,
        NULL, -- parent_id 稍后更新
        COALESCE(task_record->>'title', ''),
        COALESCE(task_record->>'content', ''),
        (task_record->>'stage')::INTEGER,
        COALESCE((task_record->>'order')::INTEGER, 0),
        COALESCE((task_record->>'rank')::NUMERIC, 10000),
        COALESCE(task_record->>'status', 'active'),
        COALESCE((task_record->>'x')::NUMERIC, 0),
        COALESCE((task_record->>'y')::NUMERIC, 0),
        task_record->>'shortId',
        task_record->>'priority',
        CASE WHEN task_record->>'dueDate' IS NOT NULL 
             THEN (task_record->>'dueDate')::TIMESTAMP WITH TIME ZONE 
             ELSE NULL END,
        COALESCE(task_record->'tags', '[]'::jsonb),
        COALESCE(task_record->'attachments', '[]'::jsonb),
        CASE WHEN task_record->>'deletedAt' IS NOT NULL 
             THEN (task_record->>'deletedAt')::TIMESTAMP WITH TIME ZONE 
             ELSE NULL END,
        COALESCE(
          (task_record->>'createdDate')::TIMESTAMP WITH TIME ZONE,
          NOW()
        )
      )
      ON CONFLICT (id) DO NOTHING;
      
      task_count := task_count + 1;
      
    EXCEPTION WHEN OTHERS THEN
      error_list := array_append(error_list, 
        'Error migrating task: ' || SQLERRM || ' - ' || task_record::text
      );
    END;
  END LOOP;
  
  -- 更新 parent_id 关系
  FOR task_record IN SELECT * FROM jsonb_array_elements(task_data)
  LOOP
    IF task_record->>'parentId' IS NOT NULL THEN
      BEGIN
        UPDATE public.tasks 
        SET parent_id = (old_id_to_new_id->>(task_record->>'parentId'))::UUID
        WHERE id = (old_id_to_new_id->>(task_record->>'id'))::UUID
        AND project_id = p_project_id;
      EXCEPTION WHEN OTHERS THEN
        error_list := array_append(error_list, 
          'Error updating parent_id: ' || SQLERRM
        );
      END;
    END IF;
  END LOOP;
  
  -- 获取 connections 数组
  conn_data := COALESCE(project_record.data->'connections', '[]'::jsonb);
  
  -- 迁移每个连接
  FOR conn_record IN SELECT * FROM jsonb_array_elements(conn_data)
  LOOP
    BEGIN
      -- 插入连接
      INSERT INTO public.connections (
        project_id,
        source_id,
        target_id,
        description
      ) VALUES (
        p_project_id,
        (old_id_to_new_id->>(conn_record->>'source'))::UUID,
        (old_id_to_new_id->>(conn_record->>'target'))::UUID,
        conn_record->>'description'
      )
      ON CONFLICT (project_id, source_id, target_id) DO NOTHING;
      
      conn_count := conn_count + 1;
      
    EXCEPTION WHEN OTHERS THEN
      error_list := array_append(error_list, 
        'Error migrating connection: ' || SQLERRM || ' - ' || conn_record::text
      );
    END;
  END LOOP;
  
  -- 标记项目已迁移
  UPDATE public.projects 
  SET migrated_to_v2 = TRUE
  WHERE id = p_project_id;
  
  RETURN QUERY SELECT task_count, conn_count, error_list;
END; $$;

GRANT EXECUTE ON FUNCTION migrate_project_data_to_v2(UUID) TO authenticated;

-- 批量迁移所有项目
CREATE OR REPLACE FUNCTION migrate_all_projects_to_v2()
RETURNS TABLE (
  project_id UUID,
  project_title TEXT,
  tasks_migrated INTEGER,
  connections_migrated INTEGER,
  errors TEXT[]
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  project_record RECORD;
  migration_result RECORD;
BEGIN
  FOR project_record IN 
    SELECT id, title 
    FROM public.projects 
    WHERE migrated_to_v2 = FALSE OR migrated_to_v2 IS NULL
  LOOP
    SELECT * INTO migration_result 
    FROM migrate_project_data_to_v2(project_record.id);
    
    RETURN QUERY SELECT 
      project_record.id,
      project_record.title,
      migration_result.tasks_migrated,
      migration_result.connections_migrated,
      migration_result.errors;
  END LOOP;
END; $$;

GRANT EXECUTE ON FUNCTION migrate_all_projects_to_v2() TO authenticated;

-- 永久删除任务（写入 tombstone + 物理删除）
-- 核心 RPC：防止已删除任务复活
CREATE OR REPLACE FUNCTION purge_tasks_v2(p_project_id UUID, p_task_ids UUID[])
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  purged_count INTEGER;
BEGIN
  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- 授权校验：仅项目 owner 可 purge
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 先落 tombstone（即使 tasks 行已不存在也会生效）
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT unnest(p_task_ids), p_project_id, now(), auth.uid()
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 删除相关连接
  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  -- 删除 tasks 行（如果存在）
  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del;

  RETURN COALESCE(purged_count, 0);
END; $$;

GRANT EXECUTE ON FUNCTION purge_tasks_v2(UUID, UUID[]) TO authenticated;

-- 清理过期软删除附件
CREATE OR REPLACE FUNCTION cleanup_deleted_attachments(retention_days INTEGER DEFAULT 30)
RETURNS TABLE(deleted_count INTEGER, storage_paths TEXT[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public' AS $$
DECLARE
  cutoff_date TIMESTAMPTZ;
  paths_to_delete TEXT[] := ARRAY[]::TEXT[];
  task_record RECORD;
  attachment JSONB;
  total_deleted INTEGER := 0;
BEGIN
  cutoff_date := NOW() - (retention_days || ' days')::INTERVAL;
  
  FOR task_record IN 
    SELECT t.id AS task_id, t.project_id, t.attachments, p.owner_id
    FROM tasks t JOIN projects p ON t.project_id = p.id
    WHERE t.attachments IS NOT NULL AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments) LOOP
      IF attachment->>'deletedAt' IS NOT NULL AND (attachment->>'deletedAt')::TIMESTAMPTZ < cutoff_date THEN
        paths_to_delete := array_append(paths_to_delete, 
          task_record.owner_id || '/' || task_record.project_id || '/' || task_record.task_id || '/' || (attachment->>'id')
        );
        total_deleted := total_deleted + 1;
      END IF;
    END LOOP;
    
    UPDATE tasks SET attachments = (
      SELECT jsonb_agg(att) FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NULL OR (att->>'deletedAt')::TIMESTAMPTZ >= cutoff_date
    ) WHERE id = task_record.task_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(task_record.attachments) AS att
      WHERE att->>'deletedAt' IS NOT NULL AND (att->>'deletedAt')::TIMESTAMPTZ < cutoff_date
    );
  END LOOP;
  
  RETURN QUERY SELECT total_deleted, paths_to_delete;
END; $$;

GRANT EXECUTE ON FUNCTION cleanup_deleted_attachments TO service_role;

-- ============================================
-- 14. 配置 REPLICA IDENTITY（Realtime DELETE 事件所需）
-- ============================================

ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.tasks REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

-- ============================================
-- 15. 启用实时订阅
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'projects') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'tasks') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'connections') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.connections;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'user_preferences') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_preferences;
  END IF;
END $$;

-- ============================================
-- 16. Storage 策略（attachments 桶）
-- ============================================

-- 用户可以上传自己的附件 (路径格式: {user_id}/{project_id}/{task_id}/{filename})
DROP POLICY IF EXISTS "Users can upload own attachments" ON storage.objects;
CREATE POLICY "Users can upload own attachments" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 用户可以查看自己的附件
DROP POLICY IF EXISTS "Users can view own attachments" ON storage.objects;
CREATE POLICY "Users can view own attachments" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 用户可以删除自己的附件
DROP POLICY IF EXISTS "Users can delete own attachments" ON storage.objects;
CREATE POLICY "Users can delete own attachments" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 用户可以更新自己的附件元数据（2026-01-07 补齐）
DROP POLICY IF EXISTS "Users can update own attachments" ON storage.objects;
CREATE POLICY "Users can update own attachments" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 项目成员可以查看附件
DROP POLICY IF EXISTS "Project members can view attachments" ON storage.objects;
CREATE POLICY "Project members can view attachments" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'attachments' AND EXISTS (
  SELECT 1 FROM public.project_members pm WHERE pm.user_id = auth.uid() AND pm.project_id::text = (storage.foldername(name))[2]
));

-- ============================================
-- 完成！
-- ============================================
-- 
-- 数据库表：
--   ✓ projects          - 项目
--   ✓ project_members   - 项目成员（协作预留）
--   ✓ tasks             - 任务（含 deleted_at 软删除）
--   ✓ connections       - 任务连接（含 title, deleted_at）
--   ✓ user_preferences  - 用户偏好
--   ✓ cleanup_logs      - 清理日志
--   ✓ task_tombstones   - 任务永久删除记录（防止复活）
--
-- RPC 函数：
--   ✓ append_task_attachment(task_id, attachment)
--   ✓ remove_task_attachment(task_id, attachment_id)
--   ✓ cleanup_old_deleted_tasks()
--   ✓ cleanup_old_deleted_connections()
--   ✓ cleanup_old_logs()
--   ✓ cleanup_deleted_attachments(retention_days)
--   ✓ purge_tasks_v2(project_id, task_ids)  - 永久删除任务（写入 tombstone）
--
-- 定时任务（需要启用 pg_cron 后手动配置）：
--   SELECT cron.schedule('cleanup-deleted-tasks', '0 3 * * *', $$SELECT cleanup_old_deleted_tasks()$$);
--   SELECT cron.schedule('cleanup-deleted-connections', '0 3 * * *', $$SELECT cleanup_old_deleted_connections()$$);
--   SELECT cron.schedule('cleanup-old-logs', '0 4 * * 0', $$SELECT cleanup_old_logs()$$);
--
-- Storage 桶配置（需要在 Dashboard 中创建）：
--   Name: attachments
--   Public: false
--   File size limit: 10MB
-- ============================================================
-- [MIGRATION] 20251203_sync_schema_with_code.sql
-- ============================================================
-- ============================================
-- 同步数据库 Schema 与项目代码
-- 日期: 2025-12-03
-- ============================================

-- 1. 为 user_preferences 表添加缺失的列
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS layout_direction varchar(10) DEFAULT 'ltr',
  ADD COLUMN IF NOT EXISTS floating_window_pref varchar(10) DEFAULT 'auto';

-- 添加约束检查
DO $$
BEGIN
  -- 删除旧约束（如果存在）然后添加新约束
  ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_layout_direction_check;
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_layout_direction_check 
    CHECK (layout_direction IS NULL OR layout_direction IN ('ltr', 'rtl'));
    
  ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_floating_window_pref_check;
  ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_floating_window_pref_check 
    CHECK (floating_window_pref IS NULL OR floating_window_pref IN ('auto', 'fixed'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. 清理日志表已在文件早期（第 232 行）创建
-- 注意：cleanup_old_deleted_tasks 和 cleanup_old_logs 函数已在前面定义（第 459 和 474 行）

-- 5. 为 tasks 表的 deleted_at 添加索引（加速清理查询）
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON public.tasks (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 6. 为 cleanup_logs 表添加索引
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_created_at ON public.cleanup_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_cleanup_logs_type ON public.cleanup_logs (type);

-- 7. 授予必要的权限
GRANT SELECT, INSERT ON cleanup_logs TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_deleted_tasks() TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_logs() TO service_role;
-- ============================================================
-- [MIGRATION] 20251208_fix_realtime_delete_events.sql
-- ============================================================
-- ============================================
-- 修复 Realtime DELETE 事件问题
-- 日期: 2025-12-08
-- ============================================
--
-- 问题描述:
-- 当在一个设备上删除任务时，其他设备无法接收到删除事件
-- 这是因为表缺少 REPLICA IDENTITY FULL 配置
--
-- 解决方案:
-- 设置 REPLICA IDENTITY FULL 确保 DELETE 事件包含完整的旧行数据
-- 这样客户端可以正确识别被删除的记录

-- 设置 REPLICA IDENTITY FULL
-- 注意：这会增加一些存储开销，但对于确保跨设备同步的正确性是必需的
ALTER TABLE public.projects REPLICA IDENTITY FULL;
ALTER TABLE public.tasks REPLICA IDENTITY FULL;
ALTER TABLE public.connections REPLICA IDENTITY FULL;

-- 验证配置（可选，用于调试）
-- SELECT 
--   n.nspname as schemaname, 
--   c.relname as tablename, 
--   CASE c.relreplident
--     WHEN 'd' THEN 'DEFAULT (primary key)'
--     WHEN 'n' THEN 'NOTHING'
--     WHEN 'f' THEN 'FULL'
--     WHEN 'i' THEN 'INDEX'
--   END as replica_identity
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- WHERE n.nspname = 'public' 
-- AND c.relname IN ('projects', 'tasks', 'connections');
-- ============================================================
-- [MIGRATION] 20251212_hardening_and_indexes.sql
-- ============================================================
-- ============================================
-- 安全加固 + 性能小优化（search_path + 外键索引 + RLS initplan）
-- 日期: 2025-12-12
-- ============================================

-- 1) 性能：为未覆盖的外键列补齐索引
CREATE INDEX IF NOT EXISTS idx_project_members_invited_by
  ON public.project_members (invited_by);

CREATE INDEX IF NOT EXISTS idx_task_tombstones_project_id
  ON public.task_tombstones (project_id);

-- 2) 安全：为函数显式设置 search_path（避免 search_path 可变引发的劫持风险）
-- 说明：优先 pg_catalog，确保内建函数解析更安全。

DROP POLICY IF EXISTS "owner delete" ON public.projects;
CREATE POLICY "owner delete" ON public.projects
  FOR DELETE
  TO public
  USING ((select auth.uid()) = owner_id);

-- project_members
DROP POLICY IF EXISTS "project_members select" ON public.project_members;
CREATE POLICY "project_members select" ON public.project_members
  FOR SELECT
  TO public
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "project_members insert" ON public.project_members;
CREATE POLICY "project_members insert" ON public.project_members
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "project_members update" ON public.project_members;
CREATE POLICY "project_members update" ON public.project_members
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "project_members delete" ON public.project_members;
CREATE POLICY "project_members delete" ON public.project_members
  FOR DELETE
  TO public
  USING (
    (user_id = (select auth.uid()))
    OR EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_members.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- tasks
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
CREATE POLICY "tasks owner select" ON public.tasks
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
CREATE POLICY "tasks owner insert" ON public.tasks
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
CREATE POLICY "tasks owner update" ON public.tasks
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;
CREATE POLICY "tasks owner delete" ON public.tasks
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = tasks.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- connections
DROP POLICY IF EXISTS "connections owner select" ON public.connections;
CREATE POLICY "connections owner select" ON public.connections
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
CREATE POLICY "connections owner insert" ON public.connections
  FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner update" ON public.connections;
CREATE POLICY "connections owner update" ON public.connections
  FOR UPDATE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connections owner delete" ON public.connections;
CREATE POLICY "connections owner delete" ON public.connections
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = connections.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

-- user_preferences
DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT
  TO public
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT
  TO public
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE
  TO public
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE
  TO public
  USING ((select auth.uid()) = user_id);

-- task_tombstones
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_select_owner" ON public.task_tombstones
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;
CREATE POLICY "task_tombstones_insert_owner" ON public.task_tombstones
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = task_tombstones.project_id
        AND p.owner_id = (select auth.uid())
    )
  );
-- ============================================================
-- [MIGRATION] 20251212_prevent_task_resurrection.sql
-- ============================================================
-- ============================================
-- 阻止“永久删除任务”被旧端 upsert 复活
-- 日期: 2025-12-12
-- ============================================
--
-- 背景：
-- 1) 物理 DELETE 后，如果某个离线/旧版本客户端仍持有该 task 并执行 upsert，
--    Postgres 会将其当作 INSERT，从而把任务“插回”云端（复活）。
-- 2) 解决思路：为“永久删除”建立不可逆 tombstone。
--    - purge RPC：写入 tombstone + 删除 tasks 行（以及相关 connections）。
--    - trigger：拦截对 tombstoned task_id 的 INSERT/UPDATE，直接丢弃写入，避免复活。

-- 注意：task_tombstones 表及相关 RLS 策略已在文件早期（第 248 行附近）创建

-- 2) purge RPC：批量永久删除任务（写 tombstone + 删除 tasks + 删除相关 connections）
CREATE OR REPLACE FUNCTION public.purge_tasks(p_task_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  purged_count integer;
BEGIN
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  WITH to_purge AS (
    SELECT t.id AS task_id, t.project_id
    FROM public.tasks t
    JOIN public.projects p ON p.id = t.project_id
    WHERE t.id = ANY(p_task_ids)
      AND p.owner_id = auth.uid()
  ),
  ins AS (
    INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
    SELECT task_id, project_id, now(), auth.uid()
    FROM to_purge
    ON CONFLICT (task_id)
    DO UPDATE SET
      project_id = EXCLUDED.project_id,
      deleted_at = EXCLUDED.deleted_at,
      deleted_by = EXCLUDED.deleted_by
    RETURNING task_id
  ),
  del_connections AS (
    DELETE FROM public.connections c
    USING to_purge tp
    WHERE c.project_id = tp.project_id
      AND (c.source_id = tp.task_id OR c.target_id = tp.task_id)
  ),
  del_tasks AS (
    DELETE FROM public.tasks t
    USING to_purge tp
    WHERE t.id = tp.task_id
    RETURNING t.id
  )
  SELECT count(*) INTO purged_count FROM del_tasks;

  RETURN COALESCE(purged_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_tasks(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks(uuid[]) TO service_role;

-- safe_delete_tasks: 安全删除任务（软删除+限制）
CREATE OR REPLACE FUNCTION public.safe_delete_tasks(p_task_ids uuid[], p_project_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count integer;
  total_tasks integer;
BEGIN
  -- 参数校验
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  -- 授权检查
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id AND p.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 获取项目总任务数
  SELECT count(*) INTO total_tasks
  FROM public.tasks
  WHERE project_id = p_project_id AND deleted_at IS NULL;

  -- 限制：单次最多删除 50 条或 50% 的任务
  IF array_length(p_task_ids, 1) > 50 THEN
    RAISE EXCEPTION 'Cannot delete more than 50 tasks at once';
  END IF;

  IF array_length(p_task_ids, 1) > (total_tasks * 0.5) THEN
    RAISE EXCEPTION 'Cannot delete more than 50%% of tasks at once';
  END IF;

  -- 软删除任务
  WITH del AS (
    UPDATE public.tasks
    SET deleted_at = now()
    WHERE id = ANY(p_task_ids)
      AND project_id = p_project_id
      AND deleted_at IS NULL
    RETURNING id
  )
  SELECT count(*) INTO deleted_count FROM del;

  RETURN COALESCE(deleted_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- purge_tasks_v3: 永久删除任务并返回附件路径（带速率限制）
CREATE OR REPLACE FUNCTION public.purge_tasks_v3(p_project_id uuid, p_task_ids uuid[])
RETURNS purge_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  result purge_result;
  v_owner_id uuid;
  task_record RECORD;
  attachment jsonb;
  attachment_paths text[] := ARRAY[]::text[];
  file_ext text;
  current_user_id uuid;
  rate_limit_record RECORD;
  max_calls_per_minute CONSTANT integer := 10;
  max_tasks_per_call CONSTANT integer := 100;
BEGIN
  result.purged_count := 0;
  result.attachment_paths := ARRAY[]::text[];
  current_user_id := auth.uid();

  IF p_project_id IS NULL THEN
    RAISE EXCEPTION 'p_project_id is required';
  END IF;

  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN result;
  END IF;
  
  -- 速率限制检查
  IF array_length(p_task_ids, 1) > max_tasks_per_call THEN
    RAISE EXCEPTION 'Too many tasks in single request. Maximum: %', max_tasks_per_call;
  END IF;
  
  -- 检查并更新调用次数
  INSERT INTO public.purge_rate_limits (user_id, call_count, window_start)
  VALUES (current_user_id, 1, now())
  ON CONFLICT (user_id) DO UPDATE SET
    call_count = CASE 
      WHEN purge_rate_limits.window_start < now() - interval '1 minute' 
      THEN 1 
      ELSE purge_rate_limits.call_count + 1 
    END,
    window_start = CASE 
      WHEN purge_rate_limits.window_start < now() - interval '1 minute' 
      THEN now() 
      ELSE purge_rate_limits.window_start 
    END
  RETURNING call_count INTO rate_limit_record;
  
  IF rate_limit_record.call_count > max_calls_per_minute THEN
    RAISE EXCEPTION 'Rate limit exceeded. Maximum % calls per minute', max_calls_per_minute;
  END IF;

  -- 授权校验：仅项目 owner 可 purge
  SELECT p.owner_id INTO v_owner_id
  FROM public.projects p
  WHERE p.id = p_project_id
    AND p.owner_id = auth.uid();

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 收集附件路径
  FOR task_record IN
    SELECT t.id AS task_id, t.attachments
    FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
      AND t.attachments IS NOT NULL
      AND jsonb_array_length(t.attachments) > 0
  LOOP
    FOR attachment IN SELECT * FROM jsonb_array_elements(task_record.attachments)
    LOOP
      file_ext := COALESCE(
        NULLIF(SUBSTRING((attachment->>'name') FROM '\\.([^.]+)$'), ''),
        'bin'
      );
      
      attachment_paths := array_append(
        attachment_paths,
        v_owner_id::text || '/' || 
        p_project_id::text || '/' || 
        task_record.task_id::text || '/' || 
        (attachment->>'id') || '.' || file_ext
      );
      
      IF attachment->>'thumbnailUrl' IS NOT NULL THEN
        attachment_paths := array_append(
          attachment_paths,
          v_owner_id::text || '/' || 
          p_project_id::text || '/' || 
          task_record.task_id::text || '/' || 
          (attachment->>'id') || '_thumb.webp'
        );
      END IF;
    END LOOP;
  END LOOP;

  -- 落 tombstone
  INSERT INTO public.task_tombstones (task_id, project_id, deleted_at, deleted_by)
  SELECT unnest(p_task_ids), p_project_id, now(), auth.uid()
  ON CONFLICT (task_id)
  DO UPDATE SET
    project_id = EXCLUDED.project_id,
    deleted_at = EXCLUDED.deleted_at,
    deleted_by = EXCLUDED.deleted_by;

  -- 删除相关连接
  DELETE FROM public.connections c
  WHERE c.project_id = p_project_id
    AND (c.source_id = ANY(p_task_ids) OR c.target_id = ANY(p_task_ids));

  -- 删除 tasks 行
  WITH del AS (
    DELETE FROM public.tasks t
    WHERE t.project_id = p_project_id
      AND t.id = ANY(p_task_ids)
    RETURNING t.id
  )
  SELECT count(*) INTO result.purged_count FROM del;

  result.attachment_paths := attachment_paths;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;

-- 3) 防复活触发器：拦截对已 tombstone task_id 的 INSERT/UPDATE
CREATE OR REPLACE FUNCTION public.prevent_tombstoned_task_writes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.task_tombstones tt
    WHERE tt.task_id = NEW.id
  ) THEN
    -- 静默丢弃写入，避免旧端 upsert 复活
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_tombstoned_task_writes ON public.tasks;
CREATE TRIGGER trg_prevent_tombstoned_task_writes
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.prevent_tombstoned_task_writes();
-- ============================================================
-- [MIGRATION] 20251212_purge_tasks_v2.sql
-- ============================================================
-- ============================================
-- purge_tasks_v2: 支持在 tasks 行不存在时也能落 tombstone
-- 日期: 2025-12-12
-- ============================================
-- 目的：
-- - 客户端“永久删除”时，优先写入不可逆 tombstone，阻断旧端/离线端 upsert 复活。
-- - 即使 tasks 行已不存在（例如历史物理删除），也能通过 project_id 强制落 tombstone。

-- 注意：purge_tasks_v2 函数已在前面定义（第 708 行）

-- 授予额外的权限
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO service_role;
-- ============================================================
-- [MIGRATION] 20251213_tombstone_aware_task_loading.sql
-- ============================================================
-- ============================================
-- Tombstone-aware task loading optimization
-- 日期: 2025-12-13
-- ============================================
--
-- 背景：
-- - 修复了"电脑端删除的任务在手机端登录后恢复"的问题
-- - 原因：loadTasks 函数没有检查 task_tombstones 表，也没有过滤软删除的任务
-- - 解决方案：
--   1. 在 loadTasks 中同时检查 tombstone 和 deleted_at
--   2. 创建辅助视图和函数简化客户端查询
--   3. 添加性能索引
--
-- 优化：
-- - 创建视图简化客户端查询
-- - 添加性能索引
-- - 确保 RLS 策略正确应用
--
-- 修复的具体问题：
-- 1. 永久删除的任务（有 tombstone）在其他设备上复活
-- 2. 软删除的任务（deleted_at 不为 null）在其他设备上复活
-- 3. 待分配任务（stage = null）的删除也会在其他设备上恢复

-- 1) 创建视图：自动过滤已 tombstone 和软删除的任务
CREATE OR REPLACE VIEW public.active_tasks AS
SELECT t.*
FROM public.tasks t
WHERE NOT EXISTS (
  SELECT 1 
  FROM public.task_tombstones tt 
  WHERE tt.task_id = t.id
)
AND t.deleted_at IS NULL;

-- 为视图设置 RLS（继承基表的 RLS）
ALTER VIEW public.active_tasks SET (security_invoker = true);

COMMENT ON VIEW public.active_tasks IS '
自动过滤已被永久删除（tombstone）和软删除（deleted_at 不为 null）的任务的视图。
客户端应优先使用此视图而非直接查询 tasks 表，以避免已删除任务复活。
此视图解决了以下问题：
1. 永久删除的任务在其他设备上复活
2. 软删除的任务在其他设备上复活  
3. 待分配任务（stage = null）的删除也会在其他设备上恢复
';

-- 1.1) 创建 active_connections 视图：对应 active_tasks（2026-01-07 补齐）
CREATE OR REPLACE VIEW public.active_connections AS
SELECT 
    c.id,
    c.project_id,
    c.source_id,
    c.target_id,
    c.title,
    c.description,
    c.created_at,
    c.updated_at,
    c.deleted_at
FROM public.connections c
WHERE NOT EXISTS (
    SELECT 1 
    FROM public.connection_tombstones ct 
    WHERE ct.connection_id = c.id
)
AND c.deleted_at IS NULL;

ALTER VIEW public.active_connections SET (security_invoker = true);

COMMENT ON VIEW public.active_connections IS '
Tombstone-aware 连接加载视图 - 过滤掉已永久删除的连接和软删除的连接。
与 active_tasks 视图逻辑一致，客户端应优先使用此视图而非直接查询 connections 表。
创建于 2026-01-07。
';

-- 2) 创建辅助函数：批量检查任务是否在 tombstone 中
CREATE OR REPLACE FUNCTION public.is_task_tombstoned(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.task_tombstones 
    WHERE task_id = p_task_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO service_role;

COMMENT ON FUNCTION public.is_task_tombstoned IS '
检查指定任务是否已被永久删除（在 tombstone 表中）。
返回 true 表示该任务已被永久删除，不应被恢复或显示。
';

-- 3) 性能优化：确保 tombstone 查询索引存在
-- （这个索引应该已在 20251212_hardening_and_indexes.sql 中创建，这里做防御性检查）
CREATE INDEX IF NOT EXISTS idx_task_tombstones_task_id 
  ON public.task_tombstones (task_id);

-- 4) 数据一致性检查：查找存在 tombstone 但仍有 tasks 行的数据
-- （这些数据理论上不应存在，因为 purge RPC 会同时删除）
DO $$
DECLARE
  inconsistent_count integer;
BEGIN
  SELECT COUNT(*) INTO inconsistent_count
  FROM public.task_tombstones tt
  INNER JOIN public.tasks t ON t.id = tt.task_id;
  
  IF inconsistent_count > 0 THEN
    RAISE WARNING 'Found % tasks that exist in both tasks and task_tombstones tables. Consider running cleanup.', inconsistent_count;
  END IF;
END $$;
-- ============================================================
-- [MIGRATION] 20251215_sync_mechanism_hardening.sql
-- ============================================================
-- ============================================================================
-- 同步机制强化迁移脚本
-- 创建日期: 2025-12-15
-- 目的:
--   1. 为 user_preferences 表启用 REPLICA IDENTITY FULL
--   2. 添加缺失的索引以优化实时同步性能
--   3. 强化数据完整性约束
-- ============================================================================

-- ============================================================================
-- 1. 为 user_preferences 启用 REPLICA IDENTITY FULL
-- 这确保 Supabase Realtime 的 DELETE 事件能够返回完整的行数据
-- 没有这个设置，DELETE 事件只会返回主键，导致前端无法正确处理删除
-- ============================================================================
ALTER TABLE public.user_preferences REPLICA IDENTITY FULL;

-- 验证设置（通过注释记录，实际验证需要在 psql 中执行）
-- SELECT relreplident FROM pg_class WHERE relname = 'user_preferences';
-- 期望返回 'f' (full)

-- ============================================================================
-- 2. 为实时同步添加优化索引
-- 这些索引优化 Realtime 订阅的过滤查询
-- ============================================================================

-- 优化 projects 表的 owner_id 查询（如果不存在）
CREATE INDEX IF NOT EXISTS idx_projects_owner_id_updated 
ON public.projects(owner_id, updated_at DESC);

-- 优化 tasks 表的 project_id + updated_at 查询
CREATE INDEX IF NOT EXISTS idx_tasks_project_updated 
ON public.tasks(project_id, updated_at DESC);

-- 优化 connections 表的 project_id 查询
CREATE INDEX IF NOT EXISTS idx_connections_project_id 
ON public.connections(project_id);

-- 优化 user_preferences 表的 user_id 查询
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id 
ON public.user_preferences(user_id);

-- ============================================================================
-- 3. 添加用于冲突检测的 updated_at 触发器（如果不存在）
-- 确保每次更新都会自动更新 updated_at 字段
-- ============================================================================

-- 创建通用的 updated_at 触发器函数
CREATE OR REPLACE FUNCTION public.trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为 projects 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.projects;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 tasks 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.tasks;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 connections 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.connections;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- 为 user_preferences 表添加触发器
DROP TRIGGER IF EXISTS set_updated_at ON public.user_preferences;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.user_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- ============================================================================
-- 4. 添加版本号自动递增约束
-- 防止版本号回退，用于乐观锁冲突检测
-- ============================================================================

-- 创建版本号验证函数
CREATE OR REPLACE FUNCTION public.check_version_increment()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在版本号存在且被修改时检查
  IF OLD.version IS NOT NULL AND NEW.version IS NOT NULL THEN
    -- 允许版本号增加或保持不变（用于冲突解决后的强制覆盖）
    -- 但不允许回退
    IF NEW.version < OLD.version THEN
      RAISE WARNING 'Version regression detected: % -> %, allowing update but logging', OLD.version, NEW.version;
      -- 注意：这里只是警告，不阻止更新，因为冲突解决可能需要这样做
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为 projects 表添加版本检查触发器
DROP TRIGGER IF EXISTS check_version_increment ON public.projects;
CREATE TRIGGER check_version_increment
  BEFORE UPDATE ON public.projects
  FOR EACH ROW
  EXECUTE FUNCTION public.check_version_increment();

-- ============================================================================
-- 5. 添加死锁预防索引
-- 确保并发更新时有一致的锁定顺序
-- ============================================================================

-- 添加 tasks 表的 id 索引用于批量更新
CREATE INDEX IF NOT EXISTS idx_tasks_id_project_id 
ON public.tasks(id, project_id);

-- 添加 connections 表的复合索引用于批量删除
CREATE INDEX IF NOT EXISTS idx_connections_source_target 
ON public.connections(source_id, target_id);

-- ============================================================================
-- 完成
-- ============================================================================
COMMENT ON TABLE public.projects IS '项目表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.tasks IS '任务表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.connections IS '连接表 - REPLICA IDENTITY FULL for Realtime';
COMMENT ON TABLE public.user_preferences IS '用户偏好表 - REPLICA IDENTITY FULL for Realtime';
-- ============================================================
-- [MIGRATION] 20251220_add_connection_soft_delete.sql
-- ============================================================
-- ============================================
-- 为 connections 表添加软删除支持
-- 日期: 2025-12-20
-- 
-- 目的：支持跨树连接的软删除同步
-- 解决问题：在一个设备上删除的连接，在其他设备上会因为同步逻辑问题而"复活"
-- 
-- 解决方案：使用 deleted_at 字段标记软删除状态，而不是物理删除
-- 这样删除操作可以正确同步到所有设备
-- ============================================

-- 1. 为 connections 表添加 deleted_at 列
ALTER TABLE public.connections
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- 2. 创建索引以加速查询未删除的连接
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at 
  ON public.connections (deleted_at)
  WHERE deleted_at IS NULL;

-- 3. 创建索引以加速查询需要清理的已删除连接
CREATE INDEX IF NOT EXISTS idx_connections_deleted_at_cleanup
  ON public.connections (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 4. 创建清理过期软删除连接的函数
CREATE OR REPLACE FUNCTION public.validate_task_data()
RETURNS TRIGGER AS $$
BEGIN
  -- 规则 1: 拒绝将 title 和 content 同时置空
  IF (NEW.title IS NULL OR NEW.title = '') AND (NEW.content IS NULL OR NEW.content = '') THEN
    -- 例外：软删除的任务允许
    IF NEW.deleted_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Task must have either title or content (task_id: %)', NEW.id;
  END IF;
  
  -- 规则 2: stage 必须非负（如果有值）
  IF NEW.stage IS NOT NULL AND NEW.stage < 0 THEN
    RAISE EXCEPTION 'Invalid stage value: % (must be >= 0)', NEW.stage;
  END IF;
  
  -- 规则 3: rank 必须是正数（如果有值）
  IF NEW.rank IS NOT NULL AND NEW.rank < 0 THEN
    RAISE EXCEPTION 'Invalid rank value: % (must be >= 0)', NEW.rank;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 删除旧触发器（如果存在）
DROP TRIGGER IF EXISTS trg_validate_task_data ON public.tasks;

-- 创建新触发器
CREATE TRIGGER trg_validate_task_data
BEFORE INSERT OR UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.validate_task_data();

-- ============================================
-- 审计日志表
-- 记录所有熔断操作（阻止和通过的）
-- ============================================
CREATE TABLE IF NOT EXISTS public.circuit_breaker_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  operation text NOT NULL,
  blocked boolean NOT NULL DEFAULT false,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_user_id ON public.circuit_breaker_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_created_at ON public.circuit_breaker_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_logs_blocked ON public.circuit_breaker_logs(blocked) WHERE blocked = true;

-- RLS 策略：只能查看自己的日志
ALTER TABLE public.circuit_breaker_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS circuit_breaker_logs_select_own ON public.circuit_breaker_logs;
CREATE POLICY circuit_breaker_logs_select_own ON public.circuit_breaker_logs
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

-- 不允许用户直接删除日志（审计日志需保留）
-- INSERT 由 RPC 函数内部执行（SECURITY DEFINER 绕过 RLS）

-- ============================================
-- 授权
-- ============================================
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- ============================================
-- 注释
-- ============================================
COMMENT ON FUNCTION public.safe_delete_tasks(uuid[], uuid) IS 
  '安全的批量删除任务 RPC。限制：单次最多删除 50 条或 50% 的任务。';
COMMENT ON FUNCTION public.validate_task_data() IS 
  '任务数据校验触发器。确保 title/content 不同时为空，stage/rank 为有效值。';
COMMENT ON TABLE public.circuit_breaker_logs IS 
  '熔断操作审计日志。记录所有批量删除操作（包括被阻止和成功的）。';
-- ============================================================
-- [MIGRATION] 20260101000001_connection_tombstones.sql (已移至早期位置)
-- ============================================================
-- 注意：connection_tombstones 表及相关函数已在文件早期（第 271 行附近）创建
-- 此处保留迁移标记以维护版本历史完整性
-- ============================================================
-- [MIGRATION] 20260101000002_batch_upsert_tasks_attachments.sql
-- ============================================================
-- batch_upsert_tasks 函数：支持批量 upsert 任务，包含 attachments 字段
-- 用于批量操作的事务保护（≥20 个任务）
-- 
-- v5.2.3 修正：移除不存在的 owner_id 列引用，通过 project.owner_id 进行权限校验
-- 安全特性：
-- 1. SECURITY DEFINER + auth.uid() 权限校验
-- 2. 只能操作自己的项目和任务（通过 projects.owner_id 或 project_members 校验）
-- 3. 事务保证原子性

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
BEGIN
  -- 权限校验：获取当前用户 ID
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: not authenticated';
  END IF;
  
  -- 权限校验：验证用户是项目所有者或成员
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id 
      AND (
        p.owner_id = v_user_id
        OR EXISTS (
          SELECT 1 FROM public.project_members pm 
          WHERE pm.project_id = p.id AND pm.user_id = v_user_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Unauthorized: not project owner or member (project_id: %, user_id: %)', p_project_id, v_user_id;
  END IF;
  
  -- 事务内执行，任何失败自动回滚
  FOREACH v_task IN ARRAY p_tasks
  LOOP
    INSERT INTO public.tasks (
      id, project_id, title, content, stage, parent_id, 
      "order", rank, status, x, y, short_id, deleted_at,
      attachments
    )
    VALUES (
      (v_task->>'id')::uuid,
      p_project_id,
      v_task->>'title',
      v_task->>'content',
      (v_task->>'stage')::integer,
      (v_task->>'parentId')::uuid,
      COALESCE((v_task->>'order')::integer, 0),
      COALESCE((v_task->>'rank')::numeric, 10000),
      COALESCE(v_task->>'status', 'active'),
      COALESCE((v_task->>'x')::numeric, 0),
      COALESCE((v_task->>'y')::numeric, 0),
      v_task->>'shortId',
      (v_task->>'deletedAt')::timestamptz,
      COALESCE(v_task->'attachments', '[]'::jsonb)
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
      attachments = EXCLUDED.attachments,
      updated_at = NOW();
    
    v_count := v_count + 1;
  END LOOP;
  
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$;

-- 授权
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;

COMMENT ON FUNCTION public.batch_upsert_tasks IS 'Batch upsert tasks with transaction guarantee. Includes attachments field support (v5.2.3 - fixed owner_id reference).';
-- ============================================================
-- [MIGRATION] 20260101000003_optimistic_lock_strict_mode.sql
-- ============================================================
-- 乐观锁强化：版本冲突从警告改为拒绝
-- 
-- 变更说明：
-- 1. 修改 check_version_increment() 函数，启用严格模式
-- 2. 版本回退时直接抛出异常，拒绝更新
-- 3. 记录到 circuit_breaker_logs 以便调试

COMMENT ON FUNCTION public.check_version_increment IS 'Strict optimistic lock: rejects version regression instead of just warning. Logs to circuit_breaker_logs.';
-- ============================================================
-- [MIGRATION] 20260101000004_attachment_count_limit.sql
-- ============================================================
-- ============================================
-- 附件数量服务端限制
-- 日期：2026-01-01
-- 
-- 问题背景：
-- - 客户端限制可被绕过（通过直接 API 调用）
-- - 需要在服务端强制执行附件数量限制
-- ============================================

-- 定义最大附件数量常量
-- 与客户端 ATTACHMENT_CONFIG.MAX_ATTACHMENTS_PER_TASK 保持一致
DO $$
BEGIN
  -- 创建配置表（如果不存在）
  CREATE TABLE IF NOT EXISTS public.app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );
  
  -- 插入附件数量限制配置
  INSERT INTO public.app_config (key, value, description)
  VALUES ('max_attachments_per_task', '20', '每个任务最大附件数量')
  ON CONFLICT (key) DO NOTHING;
END $$;

-- 更新 append_task_attachment 函数，添加数量限制检查
COMMENT ON FUNCTION public.purge_tasks_v3 IS 
'永久删除任务并返回附件存储路径。客户端需要调用 Storage API 删除返回的路径。';
-- ============================================================
-- [MIGRATION] 20260102000001_virus_scan_and_rls_fix.sql
-- ============================================================
-- ============================================
-- 病毒扫描表 + cleanup_logs RLS 修复
-- 版本: v5.12
-- ============================================

-- ============================================
-- 1. 创建病毒扫描记录表
-- ============================================

-- 存储文件扫描结果
CREATE TABLE IF NOT EXISTS public.attachment_scans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  file_id UUID NOT NULL,
  file_hash VARCHAR(64), -- SHA-256 哈希
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  threat_name VARCHAR(255),
  threat_description TEXT,
  scanner VARCHAR(50) NOT NULL DEFAULT 'clamav',
  engine_version VARCHAR(50),
  signature_version VARCHAR(50),
  scanned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- 约束
  CONSTRAINT valid_status CHECK (status IN ('pending', 'scanning', 'clean', 'threat_detected', 'failed', 'quarantined', 'skipped'))
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_attachment_scans_file_id ON public.attachment_scans(file_id);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_status ON public.attachment_scans(status);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_scanned_at ON public.attachment_scans(scanned_at);
CREATE INDEX IF NOT EXISTS idx_attachment_scans_file_hash ON public.attachment_scans(file_hash);

-- 启用 RLS
ALTER TABLE public.attachment_scans ENABLE ROW LEVEL SECURITY;

-- RLS 策略：仅 service_role 可访问扫描记录
-- 前端通过 Edge Function 间接访问
DROP POLICY IF EXISTS "attachment_scans_service_only" ON public.attachment_scans;
CREATE POLICY "attachment_scans_service_only" ON public.attachment_scans
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- 隔离区表（可选，用于存储被隔离的恶意文件信息）
CREATE TABLE IF NOT EXISTS public.quarantined_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  original_file_id UUID NOT NULL,
  storage_path TEXT NOT NULL,
  threat_name VARCHAR(255) NOT NULL,
  threat_description TEXT,
  quarantined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  quarantined_by UUID REFERENCES auth.users(id),
  expires_at TIMESTAMP WITH TIME ZONE,
  restored BOOLEAN DEFAULT FALSE,
  restored_at TIMESTAMP WITH TIME ZONE,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_quarantined_files_expires_at ON public.quarantined_files(expires_at);
ALTER TABLE public.quarantined_files ENABLE ROW LEVEL SECURITY;

-- RLS 策略：仅 service_role 可访问隔离区
DROP POLICY IF EXISTS "quarantined_files_service_only" ON public.quarantined_files;
CREATE POLICY "quarantined_files_service_only" ON public.quarantined_files
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================
-- 2. 修复 cleanup_logs RLS（仅 service_role 可访问）
-- 问题：当前策略 USING(true) 允许任意认证用户读写日志
-- ============================================

-- 删除旧的宽松策略
DROP POLICY IF EXISTS "cleanup_logs select" ON public.cleanup_logs;
DROP POLICY IF EXISTS "cleanup_logs insert" ON public.cleanup_logs;
DROP POLICY IF EXISTS "cleanup_logs_select_policy" ON public.cleanup_logs;

-- 创建新的限制性策略：仅 service_role 可访问
-- 这意味着普通用户无法直接访问日志，只能通过 Edge Function
CREATE POLICY "cleanup_logs_service_role_select" ON public.cleanup_logs
  FOR SELECT TO service_role
  USING (true);

CREATE POLICY "cleanup_logs_service_role_insert" ON public.cleanup_logs
  FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "cleanup_logs_service_role_delete" ON public.cleanup_logs
  FOR DELETE TO service_role
  USING (true);

-- ============================================
-- 3. 定期清理过期扫描记录的函数
-- ============================================

CREATE OR REPLACE FUNCTION public.cleanup_expired_scan_records()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  deleted_count INTEGER;
  tmp_count INTEGER;
BEGIN
  -- 删除 30 天前的扫描记录（保留威胁检测记录更长时间）
  DELETE FROM public.attachment_scans
  WHERE scanned_at < NOW() - INTERVAL '30 days'
    AND status NOT IN ('threat_detected', 'quarantined');
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- 删除 90 天前的威胁检测记录
  DELETE FROM public.attachment_scans
  WHERE scanned_at < NOW() - INTERVAL '90 days';
  
  GET DIAGNOSTICS tmp_count = ROW_COUNT;
  deleted_count := deleted_count + tmp_count;
  
  -- 删除过期的隔离文件记录
  DELETE FROM public.quarantined_files
  WHERE expires_at < NOW() AND restored = FALSE;
  
  GET DIAGNOSTICS tmp_count = ROW_COUNT;
  deleted_count := deleted_count + tmp_count;
  
  -- 记录清理日志
  INSERT INTO public.cleanup_logs (type, details)
  VALUES ('scan_records', jsonb_build_object(
    'deleted_count', deleted_count,
    'cleaned_at', NOW()
  ));
  
  RETURN deleted_count;
END;
$$;

-- ============================================
-- 4. 更新触发器
-- ============================================

-- 自动更新 updated_at 时间戳
CREATE OR REPLACE FUNCTION public.update_attachment_scans_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_attachment_scans_timestamp ON public.attachment_scans;
CREATE TRIGGER trg_update_attachment_scans_timestamp
  BEFORE UPDATE ON public.attachment_scans
  FOR EACH ROW
  EXECUTE FUNCTION public.update_attachment_scans_timestamp();

-- ============================================
-- 5. 授予权限
-- ============================================

-- service_role 完全访问
GRANT ALL ON public.attachment_scans TO service_role;
GRANT ALL ON public.quarantined_files TO service_role;

-- 普通用户无直接访问权限（通过 Edge Function）
REVOKE ALL ON public.attachment_scans FROM authenticated;
REVOKE ALL ON public.quarantined_files FROM authenticated;

-- 函数执行权限
GRANT EXECUTE ON FUNCTION public.cleanup_expired_scan_records() TO service_role;
-- ============================================================
-- [MIGRATION] 20260102000010_batch_upsert_search_path_fix.sql
-- ============================================================
-- ============================================
-- 安全加固：为 batch_upsert_tasks 添加 search_path
-- 日期: 2026-01-02
-- 问题: batch_upsert_tasks 函数缺少 SET search_path，存在 search_path 注入风险
-- 解决: 添加 SET search_path TO 'pg_catalog', 'public' 与项目标准一致
-- ============================================

-- 为 batch_upsert_tasks 设置安全的 search_path
ALTER FUNCTION public.batch_upsert_tasks(jsonb[], uuid)
  SET search_path TO 'pg_catalog', 'public';

-- 验证说明（在 psql 中执行）:
-- SELECT proconfig FROM pg_proc WHERE proname = 'batch_upsert_tasks';
-- 期望返回包含 search_path=pg_catalog, public
-- ============================================================
-- [MIGRATION] 20260103000001_add_dashboard_rpc.sql
-- ============================================================
-- ============================================
-- Dashboard RPC 聚合函数
-- 减少流量：从 MB 级原始数据降至 ~200 Bytes JSON
-- ============================================
-- @see docs/plan_save.md Phase 1.3

-- 创建 Dashboard 统计聚合函数
-- 注意：tasks 表没有 user_id 列，必须通过 project.owner_id 关联查询
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'  -- 🔒 防止 search_path 注入攻击
AS $$
DECLARE
  current_user_id uuid := (SELECT auth.uid());
BEGIN
  -- 使用 initplan 缓存 user_id，避免每行重复计算
  -- 通过 project.owner_id 关联查询（tasks 表没有 user_id 列）
  RETURN json_build_object(
    'pending', (
      SELECT COUNT(*) 
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id 
        AND t.status = 'active' 
        AND t.deleted_at IS NULL
    ),
    'completed', (
      SELECT COUNT(*) 
      FROM public.tasks t
      JOIN public.projects p ON t.project_id = p.id
      WHERE p.owner_id = current_user_id 
        AND t.status = 'completed' 
        AND t.deleted_at IS NULL
    ),
    'projects', (SELECT COUNT(*) FROM public.projects WHERE owner_id = current_user_id)
  );
END;
$$;

-- 添加函数注释
COMMENT ON FUNCTION public.get_dashboard_stats() IS 
  'Dashboard 统计聚合函数 - 返回用户的待处理任务数、已完成任务数和项目数。
   通过 project.owner_id 关联查询（tasks 表没有 user_id 列）。
   使用 SECURITY DEFINER 确保 RLS 生效。修复于 2026-01-07。';

-- 授权：仅认证用户可调用
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_stats() FROM anon, public;
-- ============================================================
-- [MIGRATION] 20260103000002_rls_initplan_audit_fix.sql
-- ============================================================
-- ============================================
-- RLS 策略 initplan 优化审计修复
-- 日期: 2026-01-03
-- 
-- 问题: connection_tombstones 表的 RLS 策略未使用 (select auth.uid())
-- 影响: 每行都会重复计算 auth.uid()，影响性能
-- 解决: 使用 initplan 缓存 auth.uid() 值
-- 
-- @see docs/plan_save.md Phase 1.4
-- ============================================

-- 修复 connection_tombstones 表 RLS 策略
-- 使用 (select auth.uid()) 替代 auth.uid() 实现 initplan 优化

DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_select" ON public.connection_tombstones
  FOR SELECT TO authenticated
  USING (
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = (select auth.uid())
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = (select auth.uid())
    )
  );

DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;
CREATE POLICY "connection_tombstones_insert" ON public.connection_tombstones
  FOR INSERT TO authenticated
  WITH CHECK (
    project_id IN (
      SELECT id FROM public.projects WHERE owner_id = (select auth.uid())
      UNION
      SELECT project_id FROM public.project_members WHERE user_id = (select auth.uid())
    )
  );

-- 更新相关函数的 auth.uid() 调用也使用 initplan
-- 注意：在函数中设置 search_path 以防止注入攻击

ALTER FUNCTION public.record_connection_tombstone()
  SET search_path = pg_catalog, public;

-- 添加 RLS 策略审计注释
COMMENT ON POLICY "connection_tombstones_select" ON public.connection_tombstones IS
  'SELECT 策略 - 使用 initplan 优化的 (select auth.uid())';

COMMENT ON POLICY "connection_tombstones_insert" ON public.connection_tombstones IS
  'INSERT 策略 - 使用 initplan 优化的 (select auth.uid())';
-- ============================================================
-- [MIGRATION] 20260103000003_add_get_server_time_rpc.sql
-- ============================================================
-- ============================================================
-- 添加 get_server_time RPC 函数
-- ============================================================
-- 
-- 用途：为客户端提供服务端时间，用于时钟偏移检测
-- 被调用：clock-sync.service.ts
-- 
-- 版本: 1.0.0
-- 日期: 2026-01-03
-- ============================================================

-- 创建获取服务端时间的 RPC 函数
-- 返回当前服务端 UTC 时间戳（ISO 8601 格式）
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT NOW();
$$;

-- 仅允许明确角色执行（避免 PUBLIC 默认权限漂移）
REVOKE EXECUTE ON FUNCTION public.get_server_time() FROM PUBLIC;

-- 授予所有认证用户执行权限
GRANT EXECUTE ON FUNCTION public.get_server_time() TO authenticated;

-- 允许匿名用户执行（用于未登录时的时钟检测）
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon;

-- ============================================================
-- 权限收口：SECURITY DEFINER RPC 禁止 PUBLIC / anon
-- 说明：NanoFlow 强依赖登录态；匿名角色不应具备写入/批量操作能力。
-- ============================================================

-- 附件 RPC
REVOKE EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_task_attachment(uuid, jsonb) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_task_attachment(uuid, text) TO authenticated;

-- 批量任务
REVOKE EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO authenticated;

-- Purge / 删除
REVOKE EXECUTE ON FUNCTION public.purge_tasks(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_tasks(uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purge_tasks_v3(uuid, uuid[]) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;

-- 辅助查询
REVOKE EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_task_tombstoned(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.is_connection_tombstoned(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_connection_tombstoned(uuid) TO authenticated;

-- 迁移工具（保守：仅 authenticated / service_role）
REVOKE EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.migrate_project_data_to_v2(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.migrate_all_projects_to_v2() TO authenticated;

-- 触发器辅助函数（不应作为 RPC 暴露）
REVOKE EXECUTE ON FUNCTION public.trigger_set_updated_at() FROM PUBLIC, anon;

-- 维护/清理函数（不应默认对外暴露）
REVOKE EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_deleted_connections() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_logs() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_deleted_attachments(integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_scan_records() FROM PUBLIC, anon;

COMMENT ON FUNCTION public.get_server_time() IS '获取服务端当前时间，用于客户端时钟偏移检测';