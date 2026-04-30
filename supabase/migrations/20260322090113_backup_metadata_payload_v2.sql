DO $retired_cloud_backup_payload_v2$
BEGIN
  IF to_regclass('public.backup_metadata') IS NULL THEN
    RAISE NOTICE 'Skipping retired cloud backup payload v2 backfill; backup_metadata is absent.';
  ELSE
    EXECUTE $sql$
      ALTER TABLE public.backup_metadata
        ADD COLUMN IF NOT EXISTS payload_version text,
        ADD COLUMN IF NOT EXISTS table_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS coverage jsonb NOT NULL DEFAULT '{}'::jsonb
    $sql$;

    EXECUTE $sql$
      COMMENT ON COLUMN public.backup_metadata.payload_version IS
        '备份 payload 契约版本，例如 1.1.0 / 2.0.0。'
    $sql$;
    EXECUTE $sql$
      COMMENT ON COLUMN public.backup_metadata.table_counts IS
        '各逻辑表在备份 payload 中的记录数统计。'
    $sql$;
    EXECUTE $sql$
      COMMENT ON COLUMN public.backup_metadata.coverage IS
        '备份覆盖面元数据，例如是否包含项目数据、用户态数据、本地状态等。'
    $sql$;

    EXECUTE $sql$
      UPDATE public.backup_metadata
      SET
        payload_version = coalesce(payload_version, '1.1.0'),
        table_counts = CASE
          WHEN table_counts = '{}'::jsonb THEN jsonb_build_object(
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
          ELSE table_counts
        END,
        coverage = CASE
          WHEN coverage = '{}'::jsonb THEN jsonb_build_object(
            'includesProjectData', true,
            'includesCloudUserState', coalesce(user_preferences_count, 0) > 0 or coalesce(black_box_entry_count, 0) > 0,
            'includesLocalState', false
          )
          ELSE coverage
        END
    $sql$;

    EXECUTE $sql$
      ALTER TABLE public.backup_metadata
        ALTER COLUMN payload_version SET DEFAULT '2.0.0'
    $sql$;
  END IF;
END
$retired_cloud_backup_payload_v2$;
