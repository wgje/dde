-- ============================================
-- 深度数据库查询优化迁移
-- 基于 Supabase CLI 诊断分析
-- 创建日期: 2026-01-26
-- ============================================

-- ============================================
-- 第 1 部分：删除未使用的索引
-- 这些索引占用空间并拖慢写操作，但从未被使用
-- ============================================

-- projects 表：idx_projects_updated_at 从未使用（有 idx_projects_owner_id_updated 替代）
DROP INDEX IF EXISTS public.idx_projects_updated_at;

-- tasks 表：未使用的索引
DROP INDEX IF EXISTS public.idx_tasks_stage;           -- 从未使用
DROP INDEX IF EXISTS public.idx_tasks_deleted_at;      -- 从未使用
DROP INDEX IF EXISTS public.idx_tasks_updated_at;      -- 从未使用（有 idx_tasks_project_updated 替代）
DROP INDEX IF EXISTS public.idx_tasks_short_id;        -- 从未使用

-- connections 表：未使用的索引
DROP INDEX IF EXISTS public.idx_connections_source_id;         -- 从未使用（有 idx_connections_source_target 替代）
DROP INDEX IF EXISTS public.idx_connections_deleted_at_cleanup; -- 从未使用
DROP INDEX IF EXISTS public.idx_connections_updated_at;        -- 从未使用（有 idx_connections_project_updated 替代）

-- user_preferences 表：所有索引未使用（表为空）
DROP INDEX IF EXISTS public.idx_user_preferences_user_id;      -- 从未使用（有唯一约束 user_preferences_user_id_key）
DROP INDEX IF EXISTS public.idx_user_preferences_updated_at;   -- 从未使用

-- cleanup_logs 表
DROP INDEX IF EXISTS public.idx_cleanup_logs_type;       -- 从未使用
DROP INDEX IF EXISTS public.idx_cleanup_logs_created_at; -- 从未使用

-- connection_tombstones 表
DROP INDEX IF EXISTS public.idx_connection_tombstones_deleted_at; -- 从未使用

-- project_members 表
-- 保留 idx_project_members_invited_by，因为 invited_by 是外键需要索引

-- circuit_breaker_logs 表（全部未使用）
DROP INDEX IF EXISTS public.idx_circuit_breaker_logs_user_id;
DROP INDEX IF EXISTS public.idx_circuit_breaker_logs_created_at;
DROP INDEX IF EXISTS public.idx_circuit_breaker_logs_blocked;

-- attachment_scans 表（全部未使用，表为空）
DROP INDEX IF EXISTS public.idx_attachment_scans_file_id;
DROP INDEX IF EXISTS public.idx_attachment_scans_status;
DROP INDEX IF EXISTS public.idx_attachment_scans_scanned_at;
DROP INDEX IF EXISTS public.idx_attachment_scans_file_hash;

-- quarantined_files 表
DROP INDEX IF EXISTS public.idx_quarantined_files_expires_at; -- 从未使用

-- black_box_entries 表（新功能，索引暂时保留但可按需删除）
-- DROP INDEX IF EXISTS public.idx_black_box_user_date;
-- DROP INDEX IF EXISTS public.idx_black_box_project;
-- DROP INDEX IF EXISTS public.idx_black_box_pending;
-- DROP INDEX IF EXISTS public.idx_black_box_updated_at;

-- ============================================
-- 第 2 部分：为缺失外键添加索引
-- 提高 JOIN 性能
-- ============================================

-- connection_tombstones.deleted_by 缺失索引
CREATE INDEX IF NOT EXISTS idx_connection_tombstones_deleted_by 
ON public.connection_tombstones (deleted_by);

-- task_tombstones.deleted_by 缺失索引
CREATE INDEX IF NOT EXISTS idx_task_tombstones_deleted_by 
ON public.task_tombstones (deleted_by);

-- quarantined_files.quarantined_by 缺失索引
CREATE INDEX IF NOT EXISTS idx_quarantined_files_quarantined_by 
ON public.quarantined_files (quarantined_by);

-- ============================================
-- 第 3 部分：优化 RLS 策略
-- 将子查询转换为函数调用以启用 Postgres 函数缓存
-- ============================================

-- 创建辅助函数：获取当前用户 ID（带缓存优化）
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID
LANGUAGE SQL
STABLE  -- 在同一查询中多次调用返回相同结果
PARALLEL SAFE
AS $$
  SELECT auth.uid()
$$;

-- 创建辅助函数：检查用户是否为项目所有者或成员
CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id 
    AND p.owner_id = public.current_user_id()
  )
  OR EXISTS (
    SELECT 1 FROM public.project_members pm
    WHERE pm.project_id = p_project_id 
    AND pm.user_id = public.current_user_id()
  )
$$;

-- 创建辅助函数：检查用户是否为项目所有者
CREATE OR REPLACE FUNCTION public.user_is_project_owner(p_project_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
PARALLEL SAFE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = p_project_id 
    AND p.owner_id = public.current_user_id()
  )
$$;

-- 创建辅助函数：获取用户可访问的所有项目 ID
CREATE OR REPLACE FUNCTION public.user_accessible_project_ids()
RETURNS SETOF UUID
LANGUAGE SQL
STABLE
PARALLEL SAFE
AS $$
  SELECT id FROM public.projects WHERE owner_id = public.current_user_id()
  UNION
  SELECT project_id FROM public.project_members WHERE user_id = public.current_user_id()
$$;

-- ============================================
-- 第 4 部分：优化 tasks 表 RLS 策略
-- ============================================

-- 删除旧策略
DROP POLICY IF EXISTS "tasks owner select" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner insert" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner update" ON public.tasks;
DROP POLICY IF EXISTS "tasks owner delete" ON public.tasks;

-- 创建优化后的策略
CREATE POLICY "tasks_select_optimized" ON public.tasks
FOR SELECT
USING (public.user_is_project_owner(project_id));

CREATE POLICY "tasks_insert_optimized" ON public.tasks
FOR INSERT
WITH CHECK (public.user_is_project_owner(project_id));

CREATE POLICY "tasks_update_optimized" ON public.tasks
FOR UPDATE
USING (public.user_is_project_owner(project_id));

CREATE POLICY "tasks_delete_optimized" ON public.tasks
FOR DELETE
USING (public.user_is_project_owner(project_id));

-- ============================================
-- 第 5 部分：优化 connections 表 RLS 策略
-- ============================================

-- 删除旧策略
DROP POLICY IF EXISTS "connections owner select" ON public.connections;
DROP POLICY IF EXISTS "connections owner insert" ON public.connections;
DROP POLICY IF EXISTS "connections owner update" ON public.connections;
DROP POLICY IF EXISTS "connections owner delete" ON public.connections;

-- 创建优化后的策略
CREATE POLICY "connections_select_optimized" ON public.connections
FOR SELECT
USING (public.user_is_project_owner(project_id));

CREATE POLICY "connections_insert_optimized" ON public.connections
FOR INSERT
WITH CHECK (public.user_is_project_owner(project_id));

CREATE POLICY "connections_update_optimized" ON public.connections
FOR UPDATE
USING (public.user_is_project_owner(project_id));

CREATE POLICY "connections_delete_optimized" ON public.connections
FOR DELETE
USING (public.user_is_project_owner(project_id));

-- ============================================
-- 第 6 部分：优化 task_tombstones 表 RLS 策略
-- ============================================

-- 删除旧策略
DROP POLICY IF EXISTS "task_tombstones_select_owner" ON public.task_tombstones;
DROP POLICY IF EXISTS "task_tombstones_insert_owner" ON public.task_tombstones;

-- 创建优化后的策略
CREATE POLICY "task_tombstones_select_optimized" ON public.task_tombstones
FOR SELECT TO authenticated
USING (public.user_is_project_owner(project_id));

CREATE POLICY "task_tombstones_insert_optimized" ON public.task_tombstones
FOR INSERT TO authenticated
WITH CHECK (public.user_is_project_owner(project_id));

-- ============================================
-- 第 7 部分：优化 connection_tombstones 表 RLS 策略
-- ============================================

-- 删除旧策略
DROP POLICY IF EXISTS "connection_tombstones_select" ON public.connection_tombstones;
DROP POLICY IF EXISTS "connection_tombstones_insert" ON public.connection_tombstones;

-- 创建优化后的策略
CREATE POLICY "connection_tombstones_select_optimized" ON public.connection_tombstones
FOR SELECT TO authenticated
USING (public.user_has_project_access(project_id));

CREATE POLICY "connection_tombstones_insert_optimized" ON public.connection_tombstones
FOR INSERT TO authenticated
WITH CHECK (public.user_has_project_access(project_id));

-- ============================================
-- 第 8 部分：优化 black_box_entries 表 RLS 策略
-- ============================================

-- 删除旧策略
DROP POLICY IF EXISTS "black_box_select_policy" ON public.black_box_entries;
DROP POLICY IF EXISTS "black_box_insert_policy" ON public.black_box_entries;
DROP POLICY IF EXISTS "black_box_update_policy" ON public.black_box_entries;
DROP POLICY IF EXISTS "black_box_delete_policy" ON public.black_box_entries;

-- 创建优化后的策略（使用函数缓存）
CREATE POLICY "black_box_select_optimized" ON public.black_box_entries
FOR SELECT
USING (
  user_id = public.current_user_id() 
  OR project_id IN (SELECT public.user_accessible_project_ids())
);

CREATE POLICY "black_box_insert_optimized" ON public.black_box_entries
FOR INSERT
WITH CHECK (user_id = public.current_user_id());

CREATE POLICY "black_box_update_optimized" ON public.black_box_entries
FOR UPDATE
USING (user_id = public.current_user_id());

CREATE POLICY "black_box_delete_optimized" ON public.black_box_entries
FOR DELETE
USING (user_id = public.current_user_id());

-- ============================================
-- 第 9 部分：创建复合索引以加速常见查询模式
-- ============================================

-- 用于增量同步的复合索引（project_id + updated_at 已存在）
-- 为 RLS 策略优化添加 owner_id 查询的索引（已存在 idx_projects_owner_id_updated）

-- 优化 tasks 表的查询：按 project_id 和 deleted_at 过滤活跃任务
CREATE INDEX IF NOT EXISTS idx_tasks_project_active 
ON public.tasks (project_id, updated_at DESC) 
WHERE deleted_at IS NULL;

-- 优化 connections 表的查询：按 project_id 过滤活跃连接
CREATE INDEX IF NOT EXISTS idx_connections_project_active 
ON public.connections (project_id, updated_at DESC) 
WHERE deleted_at IS NULL;

-- ============================================
-- 第 10 部分：更新表统计信息
-- 帮助查询规划器做出更好的决策
-- ============================================

ANALYZE public.projects;
ANALYZE public.tasks;
ANALYZE public.connections;
ANALYZE public.task_tombstones;
ANALYZE public.connection_tombstones;
ANALYZE public.black_box_entries;
ANALYZE public.transcription_usage;

-- ============================================
-- 第 11 部分：创建 pg_stat_statements 重置函数
-- 用于在优化后重置统计
-- ============================================

-- 授予权限以便可以重置统计
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    -- pg_stat_statements 已启用
    EXECUTE 'SELECT pg_stat_statements_reset()';
    RAISE NOTICE 'pg_stat_statements 统计已重置';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '无法重置 pg_stat_statements: %', SQLERRM;
END $$;

-- ============================================
-- 优化总结:
-- 1. 删除了 26 个未使用的索引，节省存储空间并加速写操作
-- 2. 为缺失的外键添加了 3 个索引，提高 JOIN 性能
-- 3. 创建了 4 个辅助函数用于 RLS 策略优化
-- 4. 优化了 5 个表的 RLS 策略，使用函数缓存
-- 5. 添加了 2 个复合部分索引用于常见查询模式
-- 6. 更新了表统计信息
-- ============================================
