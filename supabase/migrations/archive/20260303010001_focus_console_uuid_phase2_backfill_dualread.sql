-- Focus Console UUID migration (phase 2 backfill + cutover)
-- Goal:
-- 1) Switch PK to UUID for focus_sessions / routine_completions
-- 2) Replace completed_date with date_key
-- 3) Rebuild read/write indexes for new access path
--
-- ⚠️ WARNING: This migration acquires ACCESS EXCLUSIVE locks on focus_sessions
--            and routine_completions tables. All reads/writes are blocked during
--            PK rebuild. Schedule during a maintenance window for production.
-- Rollback: requires re-adding TEXT id columns and restoring old PKs.

drop index if exists public.uq_focus_sessions_user_id;
drop index if exists public.idx_focus_sessions_user_id;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'focus_sessions'
      and column_name = 'id_uuid'
  ) then
    alter table public.focus_sessions
      drop constraint if exists focus_sessions_pkey;
    alter table public.focus_sessions
      drop column if exists id;
    alter table public.focus_sessions
      rename column id_uuid to id;
    alter table public.focus_sessions
      add primary key (id);
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'focus_sessions'
      and column_name = 'started_at_v2'
  ) then
    alter table public.focus_sessions
      drop column if exists started_at;
    alter table public.focus_sessions
      rename column started_at_v2 to started_at;
  end if;
end
$$;

alter table public.focus_sessions
  alter column id set not null;

alter table public.focus_sessions
  alter column started_at set not null;

create index if not exists idx_focus_sessions_user_id
  on public.focus_sessions (user_id);

create index if not exists idx_focus_sessions_user_updated_at
  on public.focus_sessions (user_id, updated_at desc);

drop index if exists public.uq_routine_completions_user_routine_date;
drop index if exists public.idx_routine_completions_user_routine;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'routine_completions'
      and column_name = 'id_uuid'
  ) then
    alter table public.routine_completions
      drop constraint if exists routine_completions_pkey;
    alter table public.routine_completions
      drop column if exists id;
    alter table public.routine_completions
      rename column id_uuid to id;
    alter table public.routine_completions
      add primary key (id);
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'routine_completions'
      and column_name = 'date_key_v2'
  ) then
    alter table public.routine_completions
      drop column if exists completed_date;
    alter table public.routine_completions
      rename column date_key_v2 to date_key;
  end if;
end
$$;

alter table public.routine_completions
  alter column id set not null;

alter table public.routine_completions
  alter column date_key set not null;

create unique index if not exists uq_routine_completions_user_routine_date_key
  on public.routine_completions (user_id, routine_id, date_key);
