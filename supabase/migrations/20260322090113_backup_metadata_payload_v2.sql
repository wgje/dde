alter table public.backup_metadata
  add column if not exists payload_version text,
  add column if not exists table_counts jsonb not null default '{}'::jsonb,
  add column if not exists coverage jsonb not null default '{}'::jsonb;

comment on column public.backup_metadata.payload_version is
  '备份 payload 契约版本，例如 1.1.0 / 2.0.0。';
comment on column public.backup_metadata.table_counts is
  '各逻辑表在备份 payload 中的记录数统计。';
comment on column public.backup_metadata.coverage is
  '备份覆盖面元数据，例如是否包含项目数据、用户态数据、本地状态等。';

update public.backup_metadata
set
  payload_version = coalesce(payload_version, '1.1.0'),
  table_counts = case
    when table_counts = '{}'::jsonb then jsonb_build_object(
      'projects', coalesce(project_count, 0),
      'tasks', coalesce(task_count, 0),
      'connections', coalesce(connection_count, 0),
      'userPreferences', coalesce(user_preferences_count, 0),
      'blackBoxEntries', coalesce(black_box_entry_count, 0),
      'focusSessions', 0,
      'transcriptionUsage', 0,
      'routineTasks', 0,
      'routineCompletions', 0
    )
    else table_counts
  end,
  coverage = case
    when coverage = '{}'::jsonb then jsonb_build_object(
      'includesProjectData', true,
      'includesCloudUserState', coalesce(user_preferences_count, 0) > 0 or coalesce(black_box_entry_count, 0) > 0,
      'includesLocalState', false
    )
    else coverage
  end;

alter table public.backup_metadata
  alter column payload_version set default '2.0.0';;
