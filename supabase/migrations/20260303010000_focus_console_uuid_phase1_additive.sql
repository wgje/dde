-- Focus Console UUID migration (phase 1 additive)
-- Goal:
-- 1) Introduce UUID shadow columns for focus_sessions / routine_completions
-- 2) Introduce date_key_v2 for routine_completions (replace completed_date)
-- 3) Backfill shadows without breaking current readers

create extension if not exists pgcrypto;

alter table if exists public.focus_sessions
  add column if not exists id_uuid uuid;

alter table if exists public.focus_sessions
  add column if not exists started_at_v2 timestamptz;

update public.focus_sessions
set
  id_uuid = case
    when id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then id::uuid
    else gen_random_uuid()
  end,
  started_at_v2 = coalesce(started_at, updated_at, now())
where id_uuid is null
   or started_at_v2 is null;

alter table if exists public.routine_completions
  add column if not exists id_uuid uuid;

alter table if exists public.routine_completions
  add column if not exists date_key_v2 date;

update public.routine_completions
set
  id_uuid = case
    when id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then id::uuid
    else gen_random_uuid()
  end,
  date_key_v2 = coalesce(date_key_v2, completed_date)
where id_uuid is null
   or date_key_v2 is null;
