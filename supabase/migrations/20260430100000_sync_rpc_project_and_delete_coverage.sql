-- =============================================================================
-- Cloudflare migration follow-up: project + delete sync RPC coverage
-- =============================================================================
-- Completes the first sync RPC migration by covering project upserts, project
-- deletes, and task batch deletes with the same idempotency/protocol fence used
-- by task, connection, and blackbox upserts.

ALTER TABLE public.sync_operation_log
  DROP CONSTRAINT IF EXISTS sync_operation_log_status_check;

ALTER TABLE public.sync_operation_log
  ADD CONSTRAINT sync_operation_log_status_check
    CHECK (status IN (
      'applied',
      'idempotent-replay',
      'remote-newer',
      'deleted-remote-newer',
      'client-version-rejected',
      'tombstoned',
      'unauthorized'
    ));

CREATE OR REPLACE FUNCTION public.sync_upsert_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_project JSONB := payload->'project';
  v_project_id UUID := (v_project->>'id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_deleted TIMESTAMPTZ;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  SELECT * INTO v_log_existing FROM public.sync_operation_log WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT owner_id, updated_at, deleted_at
    INTO v_existing_owner, v_existing_updated, v_existing_deleted
    FROM public.projects
    WHERE id = v_project_id
    FOR UPDATE;

  IF v_existing_owner IS NOT NULL AND v_existing_owner <> v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'unauthorized',
      'project_owned_by_other', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_owned_by_other');
  END IF;

  IF v_existing_deleted IS NOT NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project', v_project_id, 'deleted-remote-newer',
      'remote_project_tombstone', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'deleted-remote-newer',
      'remote_updated_at', COALESCE(v_existing_updated, v_existing_deleted),
      'reason', 'remote_project_tombstone'
    );
  END IF;

  IF v_existing_updated IS NULL THEN
    IF v_base_updated IS NOT NULL THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
      VALUES (v_op_id, v_user, 'project', v_project_id, 'remote-newer',
        'remote_missing_but_base_present', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
      RETURN jsonb_build_object('status', 'remote-newer', 'reason', 'remote_missing');
    END IF;

    INSERT INTO public.projects AS p (id, owner_id, title, description, version, migrated_to_v2, deleted_at)
    VALUES (
      v_project_id,
      v_user,
      v_project->>'title',
      NULLIF(v_project->>'description', ''),
      COALESCE((v_project->>'version')::INTEGER, 1),
      COALESCE((v_project->>'migrated_to_v2')::BOOLEAN, TRUE),
      NULLIF(v_project->>'deleted_at', '')::TIMESTAMPTZ
    )
    RETURNING p.updated_at INTO v_written_updated;
  ELSE
    IF v_base_updated IS NULL OR v_base_updated <> v_existing_updated THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
      VALUES (v_op_id, v_user, 'project', v_project_id, 'remote-newer',
        'cas_mismatch', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
      RETURN jsonb_build_object('status', 'remote-newer', 'remote_updated_at', v_existing_updated);
    END IF;

    UPDATE public.projects AS p
    SET title = v_project->>'title',
        description = NULLIF(v_project->>'description', ''),
        version = COALESCE((v_project->>'version')::INTEGER, p.version, 1),
        migrated_to_v2 = COALESCE((v_project->>'migrated_to_v2')::BOOLEAN, TRUE),
        deleted_at = NULLIF(v_project->>'deleted_at', '')::TIMESTAMPTZ,
        updated_at = NOW()
    WHERE p.id = v_project_id
    RETURNING p.updated_at INTO v_written_updated;
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'project_id', v_project_id,
    'updated_at', v_written_updated
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'project', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_upsert_project(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_delete_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_project_id UUID := (payload->>'project_id')::UUID;
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_existing_owner UUID;
  v_existing_updated TIMESTAMPTZ;
  v_existing_deleted TIMESTAMPTZ;
  v_log_existing RECORD;
  v_result JSONB;
  v_written_updated TIMESTAMPTZ;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  SELECT * INTO v_log_existing FROM public.sync_operation_log WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT owner_id, updated_at, deleted_at
    INTO v_existing_owner, v_existing_updated, v_existing_deleted
    FROM public.projects
    WHERE id = v_project_id
    FOR UPDATE;

  IF NOT FOUND THEN
    v_result := jsonb_build_object('status', 'applied', 'project_id', v_project_id, 'deleted_count', 0);
  ELSE
    IF v_existing_owner IS DISTINCT FROM v_user THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'unauthorized',
        'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
    END IF;

    IF v_existing_deleted IS NULL
      AND v_base_updated IS NOT NULL
      AND v_base_updated <> v_existing_updated
    THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
      VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'remote-newer',
        'cas_mismatch', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
      RETURN jsonb_build_object('status', 'remote-newer', 'remote_updated_at', v_existing_updated);
    END IF;

    IF v_existing_deleted IS NULL THEN
      PERFORM public.soft_delete_project(v_project_id);
      SELECT updated_at INTO v_written_updated FROM public.projects WHERE id = v_project_id;
    ELSE
      v_written_updated := v_existing_updated;
    END IF;

    v_result := jsonb_build_object(
      'status', 'applied',
      'operation_id', v_op_id,
      'project_id', v_project_id,
      'updated_at', v_written_updated
    );
  END IF;

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'project-delete', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_client_epoch BIGINT := COALESCE((payload->>'deployment_epoch')::BIGINT, 0);
  v_deployment_target TEXT := payload->>'deployment_target';
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_project_id UUID := (payload->>'project_id')::UUID;
  v_delete_mode TEXT := COALESCE(NULLIF(payload->>'delete_mode', ''), 'purge');
  v_task_ids UUID[];
  v_min_protocol INTEGER;
  v_min_epoch BIGINT;
  v_owner_id UUID;
  v_log_existing RECORD;
  v_result JSONB;
  v_deleted_count INTEGER;
  v_attachment_paths TEXT[];
BEGIN
  SELECT COALESCE(array_agg(task_id::UUID), ARRAY[]::UUID[])
    INTO v_task_ids
    FROM jsonb_array_elements_text(COALESCE(payload->'task_ids', '[]'::JSONB)) AS t(task_id);

  IF v_user IS NULL OR v_op_id IS NULL OR v_project_id IS NULL OR array_length(v_task_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  IF v_delete_mode NOT IN ('soft', 'purge') THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'invalid delete_mode');
  END IF;

  SELECT * INTO v_log_existing FROM public.sync_operation_log WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch
    FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'client-version-rejected',
      CASE
        WHEN v_protocol < COALESCE(v_min_protocol, 1) THEN 'protocol_version_below_min'
        ELSE 'deployment_epoch_below_min'
      END,
      v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object(
      'status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol,
      'deploymentEpoch', COALESCE(v_min_epoch, 0)
    );
  END IF;

  SELECT owner_id INTO v_owner_id
    FROM public.projects
    WHERE id = v_project_id
      AND owner_id = v_user;

  IF v_owner_id IS NULL THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  IF v_delete_mode = 'soft' THEN
    v_deleted_count := public.safe_delete_tasks(v_task_ids, v_project_id);
    v_attachment_paths := ARRAY[]::TEXT[];
  ELSE
    SELECT purged_count, attachment_paths
      INTO v_deleted_count, v_attachment_paths
      FROM public.purge_tasks_v3(v_project_id, v_task_ids);
  END IF;

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'project_id', v_project_id,
    'delete_mode', v_delete_mode,
    'deleted_count', COALESCE(v_deleted_count, 0),
    'attachment_paths', COALESCE(to_jsonb(v_attachment_paths), '[]'::JSONB)
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, deployment_epoch, deployment_target, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'task-delete', v_project_id, 'applied',
    v_protocol, v_client_epoch, v_deployment_target, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_project(JSONB) IS
  'Sync-protected project upsert with idempotency, CAS, tombstone barrier, and protocol/deployment epoch fence.';

COMMENT ON FUNCTION public.sync_delete_project(JSONB) IS
  'Sync-protected project delete using soft_delete_project after idempotency, optional CAS, and protocol/deployment epoch fence.';

COMMENT ON FUNCTION public.sync_delete_tasks(JSONB) IS
  'Sync-protected task batch delete/purge wrapper around purge_tasks_v3 with idempotency and protocol/deployment epoch fence.';
