-- Reject unsupported command/entity pairs before they enter the shadow command log.
-- Keep this allowlist aligned with OFFLINE_SYNC_SERVER_DOMAIN_COMMANDS and the domain-apply trigger.
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

  SELECT * INTO v_existing
    FROM public.sync_command_log
    WHERE operation_id = v_operation_id;
  IF FOUND THEN
    IF v_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id_owned_by_other_user');
    END IF;
    RETURN jsonb_build_object(
      'status', 'idempotent-replay',
      'operationId', v_operation_id,
      'entityType', v_existing.entity_type,
      'entityId', v_existing.entity_id
    );
  END IF;

  INSERT INTO public.sync_command_log (
    operation_id, user_id, installation_id, device_id, entity_type, entity_id,
    command, logical_clock_physical_ms, logical_clock_logical, base_version,
    base_updated_at, dependency_operation_ids, intent, normalized_result_patch,
    field_versions, envelope, status
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
    'accepted-shadow'
  );

  RETURN jsonb_build_object(
    'status', 'accepted-shadow',
    'operationId', v_operation_id,
    'entityType', v_entity_type,
    'entityId', v_entity_id,
    'appliedToDomainTables', false,
    'projectionApplied', COALESCE(v_capabilities, '[]'::jsonb) @> '["field-lww-v1"]'::jsonb
  );
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing
    FROM public.sync_command_log
    WHERE operation_id = v_operation_id;
  IF FOUND AND v_existing.user_id = v_user THEN
    RETURN jsonb_build_object('status', 'idempotent-replay', 'operationId', v_operation_id);
  END IF;
  RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id_owned_by_other_user');
END;
$$;

REVOKE ALL ON FUNCTION public.sync_apply_offline_command(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_apply_offline_command(JSONB) TO authenticated;
COMMENT ON FUNCTION public.sync_apply_offline_command(JSONB) IS
  'Capability-gated command ingest with an exact entity/operation allowlist. Unsupported commands are quarantined before command-log insert.';