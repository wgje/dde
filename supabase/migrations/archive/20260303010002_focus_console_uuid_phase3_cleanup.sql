-- Focus Console UUID migration (phase 3 cleanup / hardening)
-- Goal:
-- 1) Remove obsolete cutover indexes
-- 2) Enforce deterministic uniqueness under UUID PK scheme

drop index if exists public.uq_routine_completions_user_routine_date;
drop index if exists public.uq_focus_sessions_user_id;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'routine_completions'
      and column_name = 'completed_date'
  ) then
    alter table public.routine_completions
      drop column completed_date;
  end if;
end
$$;

create unique index if not exists uq_routine_completions_user_routine_date_key
  on public.routine_completions (user_id, routine_id, date_key);

create index if not exists idx_focus_sessions_user_updated_at
  on public.focus_sessions (user_id, updated_at desc);
