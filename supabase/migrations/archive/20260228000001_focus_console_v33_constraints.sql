-- Focus Console v3.3 constraints and defaults
-- 1) cognitive_load default low + backfill historical nulls
-- 2) wait_minutes must be a subset of expected_minutes when expected is provided
-- 3) cognitive_load CHECK constraint (M-33 数据完整性修复)

alter table public.tasks
  alter column cognitive_load set default 'low';

update public.tasks
set cognitive_load = 'low'
where cognitive_load is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_wait_within_expected_check'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_wait_within_expected_check
      check (
        expected_minutes is null
        or wait_minutes is null
        or wait_minutes <= expected_minutes
      );
  end if;
end
$$;

-- cognitive_load 枚举值约束（M-33: 防止任意字符串插入）
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_cognitive_load_check'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_cognitive_load_check
      check (cognitive_load is null or cognitive_load in ('low', 'high'));
  end if;
end
$$;
