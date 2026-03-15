-- Focus Console RLS hardening
-- 1) FORCE ROW LEVEL SECURITY 确保表拥有者（service_role）也受 RLS 约束
-- 2) 清除 phase-3 遗留的旧索引（仍引用已删除的 completed_date 列）

-- § 1  FORCE RLS —— ENABLE 已在 v3 tables 迁移中执行，此处补充 FORCE
ALTER TABLE public.focus_sessions   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_tasks    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.routine_completions FORCE ROW LEVEL SECURITY;
-- M-32: black_box_entries 也需要 FORCE RLS
ALTER TABLE public.black_box_entries FORCE ROW LEVEL SECURITY;

-- § 2  幂等清除遗留旧索引（phase-2 已执行 DROP，此处为防御性重复保障）
DROP INDEX IF EXISTS public.idx_routine_completions_user_routine;
