-- Close the missing-row owner-check race in focus and routine RPC upserts.
-- The function hashes are an intentional drift gate: if live code has moved,
-- stop and review the replacement rather than rewriting an unknown body.
DO $migration$
DECLARE
  v_oid oid;
  v_body text;
  v_patched_body text;
  v_definition text;
  v_patched_definition text;
  v_pattern text;
  v_insert_guard text;
  v_function_name text;
  v_expected_md5 text;
  v_replacements integer;
BEGIN
  FOR v_function_name, v_expected_md5 IN
    SELECT * FROM (VALUES
      ('sync_upsert_focus_session', 'e23feb0b6836d4ffdd25f068cef07e2d'),
      ('sync_upsert_routine_task', 'b6f81140b419a5a02b81103995a82341')
    ) AS expected(function_name, body_md5)
  LOOP
    SELECT p.oid, p.prosrc
      INTO v_oid, v_body
      FROM pg_proc AS p
      WHERE p.oid = format('public.%I(jsonb)', v_function_name)::regprocedure;

    IF v_oid IS NULL OR md5(v_body) <> v_expected_md5 THEN
      RAISE EXCEPTION 'atomic owner upsert migration drift for public.%: expected body md5 %, got %',
        v_function_name, v_expected_md5, COALESCE(md5(v_body), '<missing>');
    END IF;

    IF v_function_name = 'sync_upsert_focus_session' THEN
      v_pattern := 'on conflict\s*\(id\)\s*do update\s+set\s+started_at\s*=\s*excluded\.started_at\s*,\s*ended_at\s*=\s*excluded\.ended_at\s*,\s*session_state\s*=\s*excluded\.session_state\s*,\s*updated_at\s*=\s*excluded\.updated_at';
      v_insert_guard := E'RETURNING sessions.updated_at INTO v_written_updated;\n  IF NOT FOUND THEN\n    v_result := jsonb_build_object(''status'', ''unauthorized'', ''reason'', ''focus_session_owned_by_other_user'');\n    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id, status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, payload_digest, result_payload)\n    VALUES (v_op_id, v_user, ''focus-session'', v_session_id, ''unauthorized'', ''focus_session_owned_by_other_user'', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_payload_digest, v_result);\n    RETURN v_result;\n  END IF;';
    ELSE
      v_pattern := 'on conflict\s*\(id\)\s*do update\s+set\s+title\s*=\s*excluded\.title\s*,\s*max_times_per_day\s*=\s*excluded\.max_times_per_day\s*,\s*is_enabled\s*=\s*excluded\.is_enabled\s*,\s*updated_at\s*=\s*excluded\.updated_at';
      v_insert_guard := E'RETURNING tasks.updated_at INTO v_written_updated;\n  IF NOT FOUND THEN\n    v_result := jsonb_build_object(''status'', ''unauthorized'', ''reason'', ''routine_task_owned_by_other_user'');\n    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id, status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, payload_digest, result_payload)\n    VALUES (v_op_id, v_user, ''routine-task'', v_task_id, ''unauthorized'', ''routine_task_owned_by_other_user'', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_payload_digest, v_result);\n    RETURN v_result;\n  END IF;';
    END IF;

    v_replacements := regexp_count(v_body, v_pattern, 1, 'i');
    IF v_replacements <> 1 THEN
      RAISE EXCEPTION 'expected one conflict update in public.%, found %', v_function_name, v_replacements;
    END IF;

    v_patched_body := regexp_replace(
      v_body,
      v_pattern,
      CASE WHEN v_function_name = 'sync_upsert_focus_session'
        THEN 'ON CONFLICT (id) DO UPDATE SET started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, session_state = EXCLUDED.session_state, updated_at = EXCLUDED.updated_at WHERE sessions.user_id = v_user'
        ELSE 'ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, max_times_per_day = EXCLUDED.max_times_per_day, is_enabled = EXCLUDED.is_enabled, updated_at = EXCLUDED.updated_at WHERE tasks.user_id = v_user'
      END,
      'i'
    );

    v_pattern := CASE WHEN v_function_name = 'sync_upsert_focus_session'
      THEN 'returning\s+sessions\.updated_at\s+into\s+v_written_updated\s*;'
      ELSE 'returning\s+tasks\.updated_at\s+into\s+v_written_updated\s*;'
    END;
    v_replacements := regexp_count(v_patched_body, v_pattern, 1, 'i');
    IF v_replacements <> 1 THEN
      RAISE EXCEPTION 'expected one RETURNING clause in public.%, found %', v_function_name, v_replacements;
    END IF;
    v_patched_body := regexp_replace(v_patched_body, v_pattern, v_insert_guard, 'i');

    v_definition := pg_get_functiondef(v_oid);
    v_patched_definition := replace(v_definition, v_body, v_patched_body);
    IF v_patched_definition = v_definition THEN
      RAISE EXCEPTION 'failed to patch function definition for public.%', v_function_name;
    END IF;
    EXECUTE v_patched_definition;

    SELECT p.prosrc INTO v_body FROM pg_proc AS p WHERE p.oid = v_oid;
    IF position(CASE WHEN v_function_name = 'sync_upsert_focus_session'
        THEN 'WHERE sessions.user_id = v_user'
        ELSE 'WHERE tasks.user_id = v_user'
      END IN v_body) = 0
      OR position('IF NOT FOUND THEN' IN v_body) = 0 THEN
      RAISE EXCEPTION 'postcondition failed for public.%', v_function_name;
    END IF;
  END LOOP;
END;
$migration$;

COMMENT ON FUNCTION public.sync_upsert_focus_session(jsonb) IS
  'Sync-protected focus session upsert; conflict UPDATE has an atomic owner predicate and rejects a zero-row result.';
COMMENT ON FUNCTION public.sync_upsert_routine_task(jsonb) IS
  'Sync-protected routine task upsert; conflict UPDATE has an atomic owner predicate and rejects a zero-row result.';
