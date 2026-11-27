-- Local synthetic database only. Demonstrates trigger server time masking a newer logical snapshot.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id) VALUES('a1111111-1111-4111-8111-111111111111');
SELECT set_config('request.jwt.claim.sub','a1111111-1111-4111-8111-111111111111',true);
DO $test$
DECLARE
  base JSONB := jsonb_build_object('protocol_version',2147483647,'deployment_epoch',9223372036854775807,
    'focus_session',jsonb_build_object('id','a2222222-2222-4222-8222-222222222222','user_id','a1111111-1111-4111-8111-111111111111',
    'started_at','2026-01-01T00:00:00Z','ended_at',NULL,'updated_at','2026-01-01T00:00:01Z',
    'session_state',jsonb_build_object('savedAt','2026-01-01T00:00:01Z','syntheticRevision',1)));
  result JSONB;
  revision INTEGER;
BEGIN
  result := public.sync_upsert_focus_session(base || jsonb_build_object('operation_id','a3333333-3333-4333-8333-333333333331'));
  IF result->>'status'<>'applied' OR COALESCE((result->>'stale_payload')::BOOLEAN,false) THEN
    RAISE EXCEPTION 'first snapshot not applied: %',result;
  END IF;
  base := jsonb_set(base,'{focus_session,updated_at}','"2026-01-01T00:00:02Z"');
  base := jsonb_set(base,'{focus_session,session_state}','{"savedAt":"2026-01-01T00:00:02Z","syntheticRevision":2}');
  result := public.sync_upsert_focus_session(base || jsonb_build_object('operation_id','a3333333-3333-4333-8333-333333333332'));
  IF result->>'status'<>'applied' OR COALESCE((result->>'stale_payload')::BOOLEAN,false) THEN
    RAISE EXCEPTION 'second snapshot not applied: %',result;
  END IF;
  base := jsonb_set(base,'{focus_session,updated_at}','"2026-01-01T00:00:03Z"');
  base := jsonb_set(base,'{focus_session,session_state}','{"savedAt":"2026-01-01T00:00:03Z","syntheticRevision":3}');
  result := public.sync_upsert_focus_session(base || jsonb_build_object('operation_id','a3333333-3333-4333-8333-333333333333'));
  IF COALESCE((result->>'stale_payload')::BOOLEAN,false) THEN
    RAISE EXCEPTION 'newer logical snapshot rejected after server-time trigger: %',result;
  END IF;
  SELECT (session_state->>'syntheticRevision')::INTEGER INTO revision FROM public.focus_sessions WHERE id='a2222222-2222-4222-8222-222222222222';
  IF revision<>3 THEN RAISE EXCEPTION 'newer snapshot content not stored'; END IF;
END;
$test$;
ROLLBACK;
