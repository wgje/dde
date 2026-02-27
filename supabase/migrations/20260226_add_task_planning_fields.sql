-- Add nullable planning attributes for Dock/Focus scheduling.
alter table public.tasks
  add column if not exists expected_minutes integer,
  add column if not exists cognitive_load text,
  add column if not exists wait_minutes integer;

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
      check (cognitive_load is null or cognitive_load in ('high', 'low'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_expected_minutes_check'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_expected_minutes_check
      check (expected_minutes is null or expected_minutes > 0);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_wait_minutes_check'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_wait_minutes_check
      check (wait_minutes is null or wait_minutes > 0);
  end if;
end
$$;

