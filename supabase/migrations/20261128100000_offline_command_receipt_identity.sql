-- Bind both normal replay and concurrent unique-key replay to the exact command.
-- Existing receipts deliberately retain NULL digest: an old operation ID alone
-- is not evidence that a newly submitted command was applied.
-- Identity is derived from the retained envelope, avoiding another payload copy.
ALTER TABLE public.sync_command_log
  ADD COLUMN IF NOT EXISTS command_digest TEXT;

CREATE OR REPLACE FUNCTION public.sync_offline_command_identity(payload JSONB, owner_user_id UUID)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $identity$
  SELECT jsonb_build_object(
    'identityVersion', 1,
    'schemaVersion', payload->'schemaVersion',
    'operationId', COALESCE(payload->>'operationId', payload->>'operation_id'),
    'ownerUserId', owner_user_id,
    'installationId', COALESCE(payload->>'installationId', payload->>'installation_id'),
    'deviceId', payload->>'deviceId',
    'logicalClock', COALESCE(payload->'logicalClock', '{}'::jsonb),
    'entityType', payload->>'entityType',
    'entityId', payload->>'entityId',
    'projectId', NULLIF(COALESCE(payload->>'projectId', payload->>'project_id'), ''),
    'command', payload->>'command',
    'intent', COALESCE(payload->'intent', '{}'::jsonb),
    'baseVersion', NULLIF(payload->>'baseVersion', '')::BIGINT,
    'baseUpdatedAt', NULLIF(COALESCE(payload->>'baseUpdatedAt', payload->>'base_updated_at'), ''),
    'normalizedResultPatch', payload->'normalizedResultPatch',
    'dependencyOperationIds', COALESCE(payload->'dependencyOperationIds', '[]'::jsonb),
    'fieldVersions', COALESCE(payload->'fieldVersions', '{}'::jsonb)
  );
$identity$;
REVOKE ALL ON FUNCTION public.sync_offline_command_identity(JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_offline_command_identity(JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_apply_offline_command(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_operation_id UUID;
  v_entity_id UUID;
  v_operation_text TEXT := NULLIF(COALESCE(payload->>'operationId', payload->>'operation_id'), '');
  v_entity_type TEXT := NULLIF(payload->>'entityType', '');
  v_entity_id_text TEXT := NULLIF(payload->>'entityId', '');
  v_command TEXT := NULLIF(payload->>'command', '');
  v_installation_id TEXT := NULLIF(COALESCE(payload->>'installationId', payload->>'installation_id'), '');
  v_device_id TEXT := NULLIF(payload->>'deviceId', '');
  v_clock JSONB := COALESCE(payload->'logicalClock', '{}'::jsonb);
  v_physical_ms BIGINT;
  v_logical BIGINT;
  v_existing public.sync_command_log%ROWTYPE;
  v_capabilities JSONB;
  v_capability_enabled BOOLEAN := false;
  v_reason TEXT;
  v_supported_command BOOLEAN := false;
  v_command_identity JSONB;
  v_command_digest TEXT;
  v_existing_identity JSONB;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'auth_required');
  END IF;

  IF jsonb_typeof(payload) <> 'object' OR v_operation_text IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-command-envelope');
  END IF;

  BEGIN
    v_operation_id := v_operation_text::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-operation-id');
  END;

  IF v_entity_type IS NULL OR v_entity_id_text IS NULL OR v_command IS NULL
     OR v_installation_id IS NULL OR v_device_id IS NULL
     OR jsonb_typeof(v_clock) IS DISTINCT FROM 'object'
     OR jsonb_typeof(payload->'normalizedResultPatch') IS DISTINCT FROM 'object'
     OR jsonb_typeof(COALESCE(payload->'dependencyOperationIds', '[]'::jsonb)) IS DISTINCT FROM 'array'
     THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-command-envelope');
  END IF;

  IF payload ? 'fieldVersions' AND jsonb_typeof(payload->'fieldVersions') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-field-versions');
  END IF;

  IF jsonb_typeof(v_clock->'physicalMs') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_clock->'logical') IS DISTINCT FROM 'number'
     OR (payload ? 'baseVersion' AND NULLIF(payload->>'baseVersion', '') IS NOT NULL
       AND NULLIF(payload->>'baseVersion', '') !~ '^-?[0-9]+$')
     OR (payload ? 'fieldVersions' AND EXISTS (
       SELECT 1 FROM jsonb_each(payload->'fieldVersions') AS field_entry
       WHERE jsonb_typeof(field_entry.value) IS DISTINCT FROM 'object'
          OR jsonb_typeof(field_entry.value->'physicalMs') IS DISTINCT FROM 'number'
          OR jsonb_typeof(field_entry.value->'logical') IS DISTINCT FROM 'number'
          OR jsonb_typeof(field_entry.value->'deviceId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(field_entry.value->'operationId') IS DISTINCT FROM 'string'
     )) THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-logical-clock');
  END IF;

  IF v_entity_type NOT IN ('task', 'project', 'connection', 'black_box_entry', 'preference', 'focus_session', 'routine_task', 'routine_completion')
     OR split_part(v_command, '.', 1) <> v_entity_type THEN
    v_reason := 'unsupported-command-entity';
  ELSE
    v_supported_command := CASE v_entity_type
      WHEN 'project' THEN v_command IN ('project.create', 'project.update', 'project.delete', 'project.restore')
      WHEN 'task' THEN v_command IN (
        'task.create', 'task.update', 'task.delete', 'task.permanently_delete', 'task.restore',
        'task.move', 'task.reorder', 'task.detach', 'task.assign', 'task.tags.update',
        'task.parking_meta.update', 'task.attention_items.update', 'task.todo.update'
      )
      WHEN 'connection' THEN v_command IN ('connection.create', 'connection.update', 'connection.restore', 'connection.reorder')
      WHEN 'black_box_entry' THEN v_command IN ('black_box_entry.create', 'black_box_entry.update')
      WHEN 'preference' THEN v_command IN ('preference.create', 'preference.update')
      WHEN 'focus_session' THEN v_command IN ('focus_session.create', 'focus_session.update')
      WHEN 'routine_task' THEN v_command IN ('routine_task.create', 'routine_task.update')
      WHEN 'routine_completion' THEN v_command = 'routine_completion.create'
      ELSE false
    END;

    IF NOT v_supported_command THEN
      v_reason := 'unsupported-domain-command';
    ELSIF jsonb_typeof(payload->'fieldVersions') IS NOT NULL
          AND jsonb_typeof(payload->'fieldVersions') <> 'object' THEN
      v_reason := 'invalid-field-versions';
    END IF;
  END IF;

  BEGIN
    v_entity_id := v_entity_id_text::UUID;
    v_physical_ms := (v_clock->>'physicalMs')::BIGINT;
    v_logical := (v_clock->>'logical')::BIGINT;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-identity-or-logical-clock');
  END;

  IF v_physical_ms < 0 OR v_logical < 0 THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-logical-clock');
  END IF;

  SELECT capabilities
    INTO v_capabilities
    FROM public.sync_protocol_state
    WHERE scope = 'global';
  v_capability_enabled := COALESCE(v_capabilities, '[]'::jsonb) @> '["command-envelope-v1"]'::jsonb;

  IF NOT v_capability_enabled THEN
    v_reason := COALESCE(v_reason, 'command-capability-disabled');
  END IF;

  IF v_reason IS NOT NULL THEN
    PERFORM public.record_sync_write_quarantine(
      v_operation_id,
      v_user,
      COALESCE(v_entity_type, 'offline-command'),
      v_entity_id,
      NULL,
      NULL,
      v_reason,
      payload
    );
    RETURN jsonb_build_object('status', 'quarantined', 'reason', v_reason, 'operationId', v_operation_id);
  END IF;

  IF payload->>'ownerUserId' IS DISTINCT FROM v_user::TEXT THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'command-owner-mismatch');
  END IF;
  v_command_identity := public.sync_offline_command_identity(payload, v_user);
  v_command_digest := encode(extensions.digest(v_command_identity::TEXT, 'sha256'), 'hex');

  SELECT * INTO v_existing
    FROM public.sync_command_log
    WHERE operation_id = v_operation_id;
  IF FOUND THEN
    IF v_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id_owned_by_other_user');
    END IF;
    IF v_existing.command_digest IS NULL THEN
      RETURN jsonb_build_object('status', 'reconciliation-pending', 'reason', 'command-receipt-identity-unverified', 'operationId', v_operation_id);
    END IF;
    v_existing_identity := public.sync_offline_command_identity(v_existing.envelope, v_existing.user_id);
    IF v_existing_identity IS DISTINCT FROM v_command_identity
       OR v_existing.command_digest IS DISTINCT FROM v_command_digest THEN
      RETURN jsonb_build_object('status', 'rejected', 'reason', 'operation_id_command_mismatch', 'operationId', v_operation_id);
    END IF;
    RETURN jsonb_build_object(
      'status', 'idempotent-replay',
      'operationId', v_operation_id,
      'entityType', v_existing.entity_type,
      'entityId', v_existing.entity_id,
      'commandIdentity', v_existing_identity,
      'commandDigest', v_existing.command_digest
    );
  END IF;

  INSERT INTO public.sync_command_log (
    operation_id, user_id, installation_id, device_id, entity_type, entity_id,
    command, logical_clock_physical_ms, logical_clock_logical, base_version,
    base_updated_at, dependency_operation_ids, intent, normalized_result_patch,
    field_versions, envelope, status, command_digest
  ) VALUES (
    v_operation_id,
    v_user,
    v_installation_id,
    v_device_id,
    v_entity_type,
    v_entity_id,
    v_command,
    v_physical_ms,
    v_logical,
    NULLIF(payload->>'baseVersion', '')::BIGINT,
    NULLIF(COALESCE(payload->>'baseUpdatedAt', payload->>'base_updated_at'), ''),
    COALESCE(payload->'dependencyOperationIds', '[]'::jsonb),
    COALESCE(payload->'intent', '{}'::jsonb),
    payload->'normalizedResultPatch',
    COALESCE(payload->'fieldVersions', '{}'::jsonb),
    payload,
    'accepted-shadow',
    v_command_digest
  );

  RETURN jsonb_build_object(
    'status', 'accepted-shadow',
    'operationId', v_operation_id,
    'entityType', v_entity_type,
    'entityId', v_entity_id,
    'commandIdentity', v_command_identity,
    'commandDigest', v_command_digest,
    'appliedToDomainTables', false,
    'projectionApplied', COALESCE(v_capabilities, '[]'::jsonb) @> '["field-lww-v1"]'::jsonb
  );
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing
    FROM public.sync_command_log
    WHERE operation_id = v_operation_id;
  IF FOUND AND v_existing.user_id = v_user THEN
    IF v_existing.command_digest IS NULL THEN
      RETURN jsonb_build_object('status', 'reconciliation-pending', 'reason', 'command-receipt-identity-unverified', 'operationId', v_operation_id);
    END IF;
    v_existing_identity := public.sync_offline_command_identity(v_existing.envelope, v_existing.user_id);
    IF v_existing_identity IS DISTINCT FROM v_command_identity
       OR v_existing.command_digest IS DISTINCT FROM v_command_digest THEN
      RETURN jsonb_build_object('status', 'rejected', 'reason', 'operation_id_command_mismatch', 'operationId', v_operation_id);
    END IF;
    RETURN jsonb_build_object('status', 'idempotent-replay', 'operationId', v_operation_id,
      'commandIdentity', v_existing_identity, 'commandDigest', v_existing.command_digest);
  END IF;
  RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id_owned_by_other_user');
END;
$$;

REVOKE ALL ON FUNCTION public.sync_apply_offline_command(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_apply_offline_command(JSONB) TO authenticated;
COMMENT ON FUNCTION public.sync_apply_offline_command(JSONB) IS
  'Capability-gated command ingest; operation ID replay is bound to a versioned command identity and SHA-256 digest, excluding deployment metadata.';

CREATE OR REPLACE FUNCTION public.sync_get_offline_command_status(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_operation_id UUID;
  v_command_status TEXT;
  v_entity_type TEXT;
  v_entity_id UUID;
  v_domain_status TEXT;
  v_domain_result JSONB;
  v_command_identity JSONB;
  v_command_digest TEXT;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'auth_required');
  END IF;
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-payload');
  END IF;
  BEGIN
    v_operation_id := NULLIF(COALESCE(payload->>'operationId', payload->>'operation_id'), '')::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-operation-id');
  END;
  IF v_operation_id IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'missing-operation-id');
  END IF;

  SELECT c.status, c.entity_type, c.entity_id, d.status, d.result,
      CASE WHEN c.command_digest IS NOT NULL THEN public.sync_offline_command_identity(c.envelope, c.user_id) ELSE NULL END,
      c.command_digest
    INTO v_command_status, v_entity_type, v_entity_id, v_domain_status, v_domain_result, v_command_identity, v_command_digest
    FROM public.sync_command_log AS c
    LEFT JOIN public.sync_command_domain_apply_log AS d
      ON d.operation_id = c.operation_id AND d.user_id = c.user_id
    WHERE c.operation_id = v_operation_id AND c.user_id = v_user;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'offline-command-not-found', 'operationId', v_operation_id);
  END IF;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_command_identity IS NULL OR v_command_digest IS NULL THEN 'reconciliation-pending'
      WHEN v_domain_status IN ('applied', 'idempotent-replay') THEN v_domain_status ELSE 'rejected' END,
    'operationId', v_operation_id,
    'commandStatus', v_command_status,
    'entityType', v_entity_type,
    'entityId', v_entity_id,
    'commandIdentity', v_command_identity,
    'commandDigest', v_command_digest,
    'domainApplyStatus', COALESCE(v_domain_status, 'missing'),
    'domainApplyResult', v_domain_result,
    'appliedToDomainTables', v_command_identity IS NOT NULL AND v_command_digest IS NOT NULL
      AND v_domain_status IN ('applied', 'idempotent-replay')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_get_offline_command_status(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_get_offline_command_status(JSONB) TO authenticated;
COMMENT ON FUNCTION public.sync_get_offline_command_status(JSONB) IS
  'Owner-scoped readback includes the exact command identity and digest; unbound historical receipts cannot acknowledge a pending command.';