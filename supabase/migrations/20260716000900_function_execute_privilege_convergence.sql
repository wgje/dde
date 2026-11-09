-- Converge historical function privileges after the forward default-deny rule.
-- Missing optional functions are skipped so this remains safe across drifted projects.

DO $$
DECLARE
  function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.current_user_id()',
    'public.user_is_project_owner(uuid)',
    'public.user_has_project_access(uuid)',
    'public.user_accessible_project_ids()'
  ]
  LOOP
    IF to_regprocedure(function_signature) IS NULL THEN
      CONTINUE;
    END IF;

    function_signature := to_regprocedure(function_signature)::text;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', function_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', function_signature);
  END LOOP;
END;
$$;

DO $$
DECLARE
  function_signature text;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.update_updated_at_column()',
    'public.trigger_set_updated_at()',
    'public.user_preferences_keep_latest_backup_proof()',
    'public.prevent_tombstoned_connection_writes()',
    'public.record_connection_tombstone()',
    'public.prevent_tombstoned_task_writes()',
    'public.check_version_increment()',
    'public.validate_task_data()',
    'public.update_attachment_scans_timestamp()',
    'public.prevent_soft_deleted_row_resurrection()',
    'public.cleanup_cron_job_run_details(interval)'
  ]
  LOOP
    IF to_regprocedure(function_signature) IS NULL THEN
      CONTINUE;
    END IF;

    function_signature := to_regprocedure(function_signature)::text;

    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', function_signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', function_signature);
  END LOOP;
END;
$$;
