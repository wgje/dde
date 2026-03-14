-- Focus Console v3.3 N2 cutover hardening
-- Non-destructive migration: dedupe + unique indexes for upsert targets

-- 1) focus_sessions: keep only latest row per user (if legacy duplicates exist)
with ranked as (
  select
    id,
    user_id,
    row_number() over (
      partition by user_id
      order by updated_at desc nulls last, id desc
    ) as rn
  from public.focus_sessions
)
delete from public.focus_sessions fs
using ranked r
where fs.id = r.id
  and r.rn > 1;

create unique index if not exists uq_focus_sessions_user_id
  on public.focus_sessions (user_id);

-- 2) routine_completions: merge duplicate rows by (user_id, routine_id, completed_date)
with duplicate_groups as (
  select
    user_id,
    routine_id,
    completed_date,
    min(id) as keep_id,
    sum(count) as merged_count,
    count(*) as duplicate_count
  from public.routine_completions
  group by user_id, routine_id, completed_date
  having count(*) > 1
),
updated as (
  update public.routine_completions rc
  set count = dg.merged_count
  from duplicate_groups dg
  where rc.id = dg.keep_id
  returning rc.id
)
delete from public.routine_completions rc
using duplicate_groups dg
where rc.user_id = dg.user_id
  and rc.routine_id = dg.routine_id
  and rc.completed_date = dg.completed_date
  and rc.id <> dg.keep_id;

create unique index if not exists uq_routine_completions_user_routine_date
  on public.routine_completions (user_id, routine_id, completed_date);

-- Rollback notes:
-- drop index if exists public.uq_focus_sessions_user_id;
-- drop index if exists public.uq_routine_completions_user_routine_date;
