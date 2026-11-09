-- =============================================================================
-- Sync RPC operationId payload-digest replay guard
-- =============================================================================
-- A repeated operation_id is only an idempotent replay when the payload digest
-- is the same. Different payloads with the same operation_id must not replay an
-- old result, and must not reach the original write RPC.
-- =============================================================================

ALTER TABLE public.sync_operation_log
  ADD COLUMN IF NOT EXISTS payload_digest TEXT,
  ADD COLUMN IF NOT EXISTS result_payload JSONB;

CREATE INDEX IF NOT EXISTS idx_sync_operation_log_payload_digest
  ON public.sync_operation_log (payload_digest)
  WHERE payload_digest IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_operation_log_fill_payload_digest()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_payload_digest TEXT;
BEGIN
  v_payload_digest := NULLIF(current_setting('app.payload_digest', true), '');

  IF NEW.payload_digest IS NULL AND v_payload_digest IS NOT NULL THEN
    NEW.payload_digest := v_payload_digest;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_operation_log_fill_payload_digest ON public.sync_operation_log;
CREATE TRIGGER sync_operation_log_fill_payload_digest
  BEFORE INSERT ON public.sync_operation_log
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_operation_log_fill_payload_digest();

REVOKE ALL ON FUNCTION public.sync_operation_log_fill_payload_digest() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_operation_log_fill_payload_digest() TO service_role;

ALTER FUNCTION public.sync_upsert_task(JSONB) RENAME TO sync_upsert_task__unguarded_20260628;
ALTER FUNCTION public.sync_upsert_connection(JSONB) RENAME TO sync_upsert_connection__unguarded_20260628;
ALTER FUNCTION public.sync_upsert_blackbox_entry(JSONB) RENAME TO sync_upsert_blackbox_entry__unguarded_20260628;
ALTER FUNCTION public.sync_upsert_project(JSONB) RENAME TO sync_upsert_project__unguarded_20260628;
ALTER FUNCTION public.sync_upsert_user_preferences(JSONB) RENAME TO sync_upsert_user_preferences__unguarded_20260628;
ALTER FUNCTION public.sync_upsert_focus_session(JSONB) RENAME TO sync_upsert_focus_session__unguarded_20260628;
ALTER FUNCTION public.sync_upsert_routine_task(JSONB) RENAME TO sync_upsert_routine_task__unguarded_20260628;
ALTER FUNCTION public.sync_increment_routine_completion(JSONB) RENAME TO sync_increment_routine_completion__unguarded_20260628;
ALTER FUNCTION public.sync_delete_project(JSONB) RENAME TO sync_delete_project__unguarded_20260628;
ALTER FUNCTION public.sync_delete_tasks(JSONB) RENAME TO sync_delete_tasks__unguarded_20260628;

CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_upsert_task__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_connection(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_upsert_connection__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_blackbox_entry(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_upsert_blackbox_entry__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_upsert_project__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_user_preferences(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_upsert_user_preferences__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_focus_session(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_upsert_focus_session__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_upsert_routine_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_upsert_routine_task__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_increment_routine_completion(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_increment_routine_completion__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_delete_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_delete_project__unguarded_20260628(payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_delete_tasks(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex');
  v_log_existing RECORD;
BEGIN
  PERFORM set_config('app.payload_digest', v_payload_digest, true);
  IF v_user IS NOT NULL AND v_op_id IS NOT NULL THEN
    SELECT user_id, payload_digest, result_payload, status, reject_reason
      INTO v_log_existing
      FROM public.sync_operation_log
      WHERE operation_id = v_op_id;
    IF FOUND THEN
      IF v_log_existing.user_id IS DISTINCT FROM v_user THEN
        RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
      END IF;
      IF v_log_existing.payload_digest IS NOT NULL
        AND v_log_existing.payload_digest IS DISTINCT FROM v_payload_digest
      THEN
        RETURN jsonb_build_object(
          'status', 'unauthorized',
          'reason', 'operation_id_payload_mismatch',
          'operation_id', v_op_id,
          'existing_payload_digest', v_log_existing.payload_digest,
          'payload_digest', v_payload_digest
        );
      END IF;
      RETURN COALESCE(
        v_log_existing.result_payload,
        jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
      );
    END IF;
  END IF;
  RETURN public.sync_delete_tasks__unguarded_20260628(payload);
END;
$$;

REVOKE ALL ON FUNCTION public.sync_upsert_task__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_connection__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_project__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_focus_session__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_upsert_routine_task__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_increment_routine_completion__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_delete_project__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_delete_tasks__unguarded_20260628(JSONB) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_connection(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_focus_session(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_upsert_routine_task(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_increment_routine_completion(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_delete_tasks(JSONB) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_connection(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_user_preferences(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_focus_session(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_upsert_routine_task(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_increment_routine_completion(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_delete_tasks(JSONB) TO authenticated;
