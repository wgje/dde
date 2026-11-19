CREATE TABLE IF NOT EXISTS public.sync_command_projection (
  user_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  tombstone JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id),
  CONSTRAINT sync_command_projection_entity_type_check CHECK (entity_type IN ('task', 'project', 'connection', 'black_box_entry', 'preference', 'focus_session', 'routine_task', 'routine_completion'))
);
CREATE INDEX IF NOT EXISTS idx_sync_command_projection_owner_entity ON public.sync_command_projection (user_id, entity_type, entity_id);
ALTER TABLE public.sync_command_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_command_projection FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sync_command_projection FROM PUBLIC, anon;
GRANT SELECT ON public.sync_command_projection TO authenticated;
GRANT ALL ON public.sync_command_projection TO service_role;
DROP POLICY IF EXISTS sync_command_projection_owner_select ON public.sync_command_projection;
CREATE POLICY sync_command_projection_owner_select ON public.sync_command_projection FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE OR REPLACE FUNCTION public.sync_compare_command_version(existing_version JSONB, incoming_version JSONB)
RETURNS INTEGER LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN existing_version IS NULL THEN 1
    WHEN (incoming_version->>'physicalMs')::BIGINT > (existing_version->>'physicalMs')::BIGINT THEN 1
    WHEN (incoming_version->>'physicalMs')::BIGINT < (existing_version->>'physicalMs')::BIGINT THEN -1
    WHEN (incoming_version->>'logical')::BIGINT > (existing_version->>'logical')::BIGINT THEN 1
    WHEN (incoming_version->>'logical')::BIGINT < (existing_version->>'logical')::BIGINT THEN -1
    WHEN incoming_version->>'deviceId' > existing_version->>'deviceId' THEN 1
    WHEN incoming_version->>'deviceId' < existing_version->>'deviceId' THEN -1
    WHEN incoming_version->>'operationId' > existing_version->>'operationId' THEN 1
    WHEN incoming_version->>'operationId' < existing_version->>'operationId' THEN -1
    ELSE 0 END;
$$;
CREATE OR REPLACE FUNCTION public.sync_apply_command_projection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  capabilities JSONB;
  current_row public.sync_command_projection%ROWTYPE;
  next_fields JSONB;
  next_versions JSONB;
  incoming_version JSONB;
  existing_version JSONB;
  field_key TEXT;
  field_value JSONB;
  is_delete BOOLEAN := NEW.command LIKE '%.delete' OR NEW.command LIKE '%.permanently_delete';
  is_restore BOOLEAN := NEW.command LIKE '%.restore';
BEGIN
  SELECT capabilities INTO capabilities FROM public.sync_protocol_state WHERE scope = 'global';
  IF NOT (COALESCE(capabilities, '[]'::jsonb) @> '["field-lww-v1"]'::jsonb) THEN RETURN NEW; END IF;
  SELECT * INTO current_row FROM public.sync_command_projection WHERE user_id = NEW.user_id AND entity_type = NEW.entity_type AND entity_id = NEW.entity_id FOR UPDATE;
  next_fields := COALESCE(current_row.fields, '{}'::jsonb);
  next_versions := COALESCE(current_row.field_versions, '{}'::jsonb);
  incoming_version := jsonb_build_object('physicalMs', NEW.logical_clock_physical_ms, 'logical', NEW.logical_clock_logical, 'deviceId', NEW.device_id, 'operationId', NEW.operation_id);
  IF current_row.tombstone IS NOT NULL AND NOT is_restore THEN
    IF public.sync_compare_command_version(current_row.tombstone, incoming_version) >= 0 THEN RETURN NEW; END IF;
  END IF;
  IF is_delete OR is_restore THEN
    IF current_row.tombstone IS NULL OR public.sync_compare_command_version(current_row.tombstone, incoming_version) > 0 THEN
      INSERT INTO public.sync_command_projection(user_id, entity_type, entity_id, fields, field_versions, tombstone, updated_at)
      VALUES (NEW.user_id, NEW.entity_type, NEW.entity_id, next_fields, next_versions, CASE WHEN is_delete THEN incoming_version ELSE NULL END, now())
      ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET fields = EXCLUDED.fields, field_versions = EXCLUDED.field_versions, tombstone = EXCLUDED.tombstone, updated_at = EXCLUDED.updated_at;
    END IF;
    RETURN NEW;
  END IF;
  FOR field_key, field_value IN SELECT key, value FROM jsonb_each(NEW.normalized_result_patch) LOOP
    incoming_version := COALESCE(NEW.field_versions->field_key, jsonb_build_object('physicalMs', NEW.logical_clock_physical_ms, 'logical', NEW.logical_clock_logical, 'deviceId', NEW.device_id, 'operationId', NEW.operation_id));
    existing_version := next_versions->field_key;
    IF public.sync_compare_command_version(existing_version, incoming_version) > 0 THEN
      next_fields := jsonb_set(next_fields, ARRAY[field_key], field_value, true);
      next_versions := jsonb_set(next_versions, ARRAY[field_key], incoming_version, true);
    END IF;
  END LOOP;
  INSERT INTO public.sync_command_projection(user_id, entity_type, entity_id, fields, field_versions, tombstone, updated_at)
  VALUES (NEW.user_id, NEW.entity_type, NEW.entity_id, next_fields, next_versions, current_row.tombstone, now())
  ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET fields = EXCLUDED.fields, field_versions = EXCLUDED.field_versions, tombstone = EXCLUDED.tombstone, updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sync_command_projection ON public.sync_command_log;
CREATE TRIGGER trg_sync_command_projection AFTER INSERT ON public.sync_command_log FOR EACH ROW EXECUTE FUNCTION public.sync_apply_command_projection();
CREATE OR REPLACE FUNCTION public.sync_pull_offline_projections()
RETURNS TABLE (entity_type TEXT, entity_id UUID, fields JSONB, field_versions JSONB, tombstone JSONB, updated_at TIMESTAMPTZ)
LANGUAGE sql SECURITY INVOKER STABLE SET search_path = public, pg_temp AS $$
  SELECT entity_type, entity_id, fields, field_versions, tombstone, updated_at FROM public.sync_command_projection WHERE user_id = (SELECT auth.uid()) ORDER BY entity_type, entity_id;
$$;
REVOKE ALL ON FUNCTION public.sync_compare_command_version(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_compare_command_version(JSONB, JSONB) TO service_role;
REVOKE ALL ON FUNCTION public.sync_apply_command_projection() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_apply_command_projection() TO service_role;
REVOKE ALL ON FUNCTION public.sync_pull_offline_projections() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_pull_offline_projections() TO authenticated;