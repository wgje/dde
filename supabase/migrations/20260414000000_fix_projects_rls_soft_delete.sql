-- 修复：允许项目 owner 操作自己的软删除项目
-- 根因：upsert 对已软删除的项目触发 UPDATE，被 RLS 的 deleted_at IS NULL 条件阻断（42501）
-- 影响：projects UPDATE/SELECT 策略、user_has_project_access/user_is_project_owner 函数

-- 1. 修复 projects UPDATE 策略：移除 deleted_at IS NULL 限制
--    允许 owner 更新（含恢复）自己的软删除项目
DROP POLICY IF EXISTS "owner update" ON public.projects;
CREATE POLICY "owner update" ON public.projects FOR UPDATE
  USING ((( SELECT auth.uid() AS uid) = owner_id))
  WITH CHECK ((( SELECT auth.uid() AS uid) = owner_id));

-- 2. 修复 projects SELECT 策略：允许 owner 查看自己的软删除项目
--    使增量同步能够检测远端软删除事件
--    应用层查询已自带 .is('deleted_at', null) 过滤
DROP POLICY IF EXISTS "owner select" ON public.projects;
CREATE POLICY "owner select" ON public.projects FOR SELECT
  USING ((( SELECT auth.uid() AS uid) = owner_id));

-- 3. 修复 user_has_project_access：移除 deleted_at IS NULL 限制
--    防止 connections/tasks RLS 因父项目被软删除而级联失败
CREATE OR REPLACE FUNCTION public.user_has_project_access(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = public.current_user_id()
  )
$$;

-- 4. 修复 user_is_project_owner：与 user_has_project_access 保持一致
CREATE OR REPLACE FUNCTION public.user_is_project_owner(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.projects p
    WHERE p.id = p_project_id
      AND p.owner_id = public.current_user_id()
  )
$$;
