-- 2026-04-16 根因修复：固定 SECURITY DEFINER 函数的 search_path
--
-- Supabase Security Advisors 报告 function_search_path_mutable × 3：
--   - public.user_has_project_access  (RLS 断言核心)
--   - public.user_is_project_owner    (RLS 断言核心)
--   - public.cascade_soft_delete_connections
--
-- 风险：
--   SECURITY DEFINER 函数若未固定 search_path，攻击者可在自身 schema 中放置
--   与受信 schema 同名的对象，通过修改会话 search_path 实现"函数劫持"，绕过
--   权限检查或执行任意代码。RLS 断言函数一旦被劫持，整个 RLS 体系都形同虚设。
--
-- 修复：使用 ALTER FUNCTION ... SET search_path 显式固定为 public, pg_catalog。
--       pg_catalog 始终位于搜索路径，显式写出以避免误删；public 包含我们的
--       projects / current_user_id() 等依赖对象。

ALTER FUNCTION public.user_has_project_access(uuid)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.user_is_project_owner(uuid)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.cascade_soft_delete_connections()
  SET search_path = public, pg_catalog;
