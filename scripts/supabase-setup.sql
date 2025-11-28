-- NanoFlow 完整数据库设置
-- 在 Supabase SQL 编辑器中运行此脚本

-- ============================================
-- 1. 项目表 (projects)
-- ============================================

-- 如果表不存在则创建
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  created_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  data JSONB DEFAULT '{}'::jsonb  -- 重要：存储 tasks 和 connections
);

-- 如果 data 列不存在，添加它（针对已有表的情况）
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'projects' 
    AND column_name = 'data'
  ) THEN
    ALTER TABLE public.projects ADD COLUMN data JSONB DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- 启用行级安全策略 (RLS)
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- 删除旧策略（如果存在）
DROP POLICY IF EXISTS "owner select" ON public.projects;
DROP POLICY IF EXISTS "owner insert" ON public.projects;
DROP POLICY IF EXISTS "owner update" ON public.projects;
DROP POLICY IF EXISTS "owner delete" ON public.projects;

-- 创建新策略
CREATE POLICY "owner select" ON public.projects
  FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "owner insert" ON public.projects
  FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "owner update" ON public.projects
  FOR UPDATE USING (auth.uid() = owner_id);
CREATE POLICY "owner delete" ON public.projects
  FOR DELETE USING (auth.uid() = owner_id);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON public.projects(owner_id);

-- 启用实时订阅（如果尚未添加）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'projects'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.projects;
  END IF;
END $$;

-- ============================================
-- 2. 用户偏好设置表 (user_preferences)
-- ============================================

CREATE TABLE IF NOT EXISTS public.user_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  theme VARCHAR(20) DEFAULT 'default',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 启用行级安全策略 (RLS)
ALTER TABLE public.user_preferences ENABLE ROW LEVEL SECURITY;

-- 删除旧策略（如果存在）
DROP POLICY IF EXISTS "Users can view own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can insert own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can update own preferences" ON public.user_preferences;
DROP POLICY IF EXISTS "Users can delete own preferences" ON public.user_preferences;

-- 创建策略
CREATE POLICY "Users can view own preferences" ON public.user_preferences
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own preferences" ON public.user_preferences
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own preferences" ON public.user_preferences
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own preferences" ON public.user_preferences
  FOR DELETE USING (auth.uid() = user_id);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON public.user_preferences(user_id);

-- ============================================
-- 完成！
-- ============================================
-- 运行后，你的数据库将支持：
-- 1. 项目数据（包含 tasks 和 connections）的云端同步
-- 2. 用户主题偏好的云端同步
-- 3. 行级安全策略确保用户只能访问自己的数据
-- 4. 实时订阅支持多设备同步
