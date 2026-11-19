ALTER TABLE public.sync_protocol_state
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS public.sync_command_log (
  operation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  installation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  command TEXT NOT NULL,
  logical_clock_physical_ms BIGINT NOT NULL,
  logical_clock_logical BIGINT NOT NULL,
  base_version BIGINT,
  base_updated_at TEXT,
  dependency_operation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  intent JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_result_patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  envelope JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted-shadow',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sync_command_log_status_check CHECK (status IN ('accepted-shadow', 'idempotent-replay')),
  CONSTRAINT sync_command_log_entity_type_check CHECK (entity_type IN ('task', 'project', 'connection', 'black_box_entry', 'preference', 'focus_session', 'routine_task', 'routine_completion'))
);

CREATE INDEX IF NOT EXISTS idx_sync_command_log_owner_cursor
  ON public.sync_command_log (user_id, logical_clock_physical_ms, logical_clock_logical, device_id, operation_id);
CREATE INDEX IF NOT EXISTS idx_sync_command_log_owner_entity
  ON public.sync_command_log (user_id, entity_type, entity_id);

ALTER TABLE public.sync_command_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_command_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_command_log FROM PUBLIC, anon;
GRANT SELECT ON public.sync_command_log TO authenticated;
GRANT ALL ON public.sync_command_log TO service_role;

DROP POLICY IF EXISTS sync_command_log_owner_select ON public.sync_command_log;
CREATE POLICY sync_command_log_owner_select ON public.sync_command_log FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

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
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'auth_required'); END IF;
  IF jsonb_typeof(payload) <> 'object' OR v_operation_text IS NULL THEN RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-command-envelope'); END IF;
  BEGIN v_operation_id := v_operation_text::UUID; EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-operation-id'); END;
  IF v_entity_type IS NULL OR v_entity_id_text IS NULL OR v_command IS NULL OR v_installation_id IS NULL OR v_device_id IS NULL
     OR jsonb_typeof(v_clock) IS DISTINCT FROM 'object'
     OR jsonb_typeof(payload->'normalizedResultPatch') IS DISTINCT FROM 'object'
     OR jsonb_typeof(COALESCE(payload->'dependencyOperationIds', '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-command-envelope');
  END IF;
  IF jsonb_typeof(v_clock->'physicalMs') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_clock->'logical') IS DISTINCT FROM 'number'
     OR (payload ? 'baseVersion' AND NULLIF(payload->>'baseVersion', '') IS NOT NULL AND NULLIF(payload->>'baseVersion', '') !~ '^-?[0-9]+$')
     OR (payload ? 'fieldVersions' AND EXISTS (SELECT 1 FROM jsonb_each(payload->'fieldVersions') AS field_entry WHERE jsonb_typeof(field_entry.value) IS DISTINCT FROM 'object' OR jsonb_typeof(field_entry.value->'physicalMs') IS DISTINCT FROM 'number' OR jsonb_typeof(field_entry.value->'logical') IS DISTINCT FROM 'number' OR jsonb_typeof(field_entry.value->'deviceId') IS DISTINCT FROM 'string' OR jsonb_typeof(field_entry.value->'operationId') IS DISTINCT FROM 'string')) THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-logical-clock');
  END IF;
  IF v_entity_type NOT IN ('task', 'project', 'connection', 'black_box_entry', 'preference', 'focus_session', 'routine_task', 'routine_completion')
     OR split_part(v_command, '.', 1) NOT IN ('task', 'project', 'connection', 'black_box_entry', 'preference', 'focus_session', 'routine_task', 'routine_completion')
     OR split_part(v_command, '.', 1) <> v_entity_type THEN
    v_reason := 'unsupported-command-entity';
  ELSIF jsonb_typeof(payload->'fieldVersions') IS NOT NULL AND jsonb_typeof(payload->'fieldVersions') <> 'object' THEN
    v_reason := 'invalid-field-versions';
  END IF;
  BEGIN
    v_entity_id := v_entity_id_text::UUID;
    v_physical_ms := (v_clock->>'physicalMs')::BIGINT;
    v_logical := (v_clock->>'logical')::BIGINT;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-identity-or-logical-clock');
  END;
  IF v_physical_ms < 0 OR v_logical < 0 THEN RETURN jsonb_build_object('status', 'rejected', 'reason', 'invalid-logical-clock'); END IF;
  SELECT capabilities INTO v_capabilities FROM public.sync_protocol_state WHERE scope = 'global';
  v_capability_enabled := COALESCE(v_capabilities, '[]'::jsonb) @> '["command-envelope-v1"]'::jsonb;
  IF NOT v_capability_enabled THEN v_reason := COALESCE(v_reason, 'command-capability-disabled'); END IF;
  IF v_reason IS NOT NULL THEN
    PERFORM public.record_sync_write_quarantine(v_operation_id, v_user, COALESCE(v_entity_type, 'offline-command'), v_entity_id, NULL, NULL, v_reason, payload);
    RETURN jsonb_build_object('status', 'quarantined', 'reason', v_reason, 'operationId', v_operation_id);
  END IF;
  SELECT * INTO v_existing FROM public.sync_command_log WHERE operation_id = v_operation_id;
  IF FOUND THEN
    IF v_existing.user_id <> v_user THEN RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id_owned_by_other_user'); END IF;
    RETURN jsonb_build_object('status', 'idempotent-replay', 'operationId', v_operation_id, 'entityType', v_existing.entity_type, 'entityId', v_existing.entity_id);
  END IF;
  INSERT INTO public.sync_command_log (operation_id, user_id, installation_id, device_id, entity_type, entity_id, command, logical_clock_physical_ms, logical_clock_logical, base_version, base_updated_at, dependency_operation_ids, intent, normalized_result_patch, field_versions, envelope, status)
  VALUES (v_operation_id, v_user, v_installation_id, v_device_id, v_entity_type, v_entity_id, v_command, v_physical_ms, v_logical, NULLIF(payload->>'baseVersion', '')::BIGINT, NULLIF(COALESCE(payload->>'baseUpdatedAt', payload->>'base_updated_at'), ''), COALESCE(payload->'dependencyOperationIds', '[]'::jsonb), COALESCE(payload->'intent', '{}'::jsonb), payload->'normalizedResultPatch', COALESCE(payload->'fieldVersions', '{}'::jsonb), payload, 'accepted-shadow');
  RETURN jsonb_build_object('status', 'accepted-shadow', 'operationId', v_operation_id, 'entityType', v_entity_type, 'entityId', v_entity_id, 'appliedToDomainTables', false, 'projectionApplied', COALESCE(v_capabilities, '[]'::jsonb) @> '["field-lww-v1"]'::jsonb);
EXCEPTION WHEN unique_violation THEN
  SELECT * INTO v_existing FROM public.sync_command_log WHERE operation_id = v_operation_id;
  IF FOUND AND v_existing.user_id = v_user THEN RETURN jsonb_build_object('status', 'idempotent-replay', 'operationId', v_operation_id); END IF;
  RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id_owned_by_other_user');
END;
$$;
REVOKE ALL ON FUNCTION public.sync_apply_offline_command(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_apply_offline_command(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_pull_offline_commands(p_after_physical_ms BIGINT DEFAULT 0, p_after_logical BIGINT DEFAULT 0, p_after_device_id TEXT DEFAULT '', p_after_operation_id UUID DEFAULT '00000000-0000-0000-0000-000000000000'::UUID, p_limit INTEGER DEFAULT 100)
RETURNS TABLE (operation_id UUID, user_id UUID, installation_id TEXT, device_id TEXT, entity_type TEXT, entity_id UUID, command TEXT, logical_clock_physical_ms BIGINT, logical_clock_logical BIGINT, base_version BIGINT, base_updated_at TEXT, dependency_operation_ids JSONB, intent JSONB, normalized_result_patch JSONB, field_versions JSONB, envelope JSONB, status TEXT, received_at TIMESTAMPTZ)
LANGUAGE sql SECURITY INVOKER STABLE SET search_path = public, pg_temp AS $$
  SELECT c.operation_id, c.user_id, c.installation_id, c.device_id, c.entity_type, c.entity_id, c.command, c.logical_clock_physical_ms, c.logical_clock_logical, c.base_version, c.base_updated_at, c.dependency_operation_ids, c.intent, c.normalized_result_patch, c.field_versions, c.envelope, c.status, c.received_at
  FROM public.sync_command_log AS c WHERE c.user_id = (SELECT auth.uid())
    AND (c.logical_clock_physical_ms, c.logical_clock_logical, c.device_id, c.operation_id) > (p_after_physical_ms, p_after_logical, p_after_device_id, p_after_operation_id)
  ORDER BY c.logical_clock_physical_ms, c.logical_clock_logical, c.device_id, c.operation_id LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;
REVOKE ALL ON FUNCTION public.sync_pull_offline_commands(BIGINT, BIGINT, TEXT, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_pull_offline_commands(BIGINT, BIGINT, TEXT, UUID, INTEGER) TO authenticated;