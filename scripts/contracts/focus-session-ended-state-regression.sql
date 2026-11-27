-- LOCAL SYNTHETIC DATABASE ONLY. A legacy direct end must not be undone by an older offline snapshot.
\set ON_ERROR_STOP on
BEGIN;
\if :{?candidate_file}
\i :candidate_file
\endif
INSERT INTO auth.users(id) VALUES('b1111111-1111-4111-8111-111111111111');
INSERT INTO public.focus_sessions(id,user_id,started_at,ended_at,updated_at,session_state)
VALUES('b2222222-2222-4222-8222-222222222222','b1111111-1111-4111-8111-111111111111',
 '2026-01-01T00:00:00Z',NULL,'2026-01-01T00:00:01Z','{"savedAt":"2026-01-01T00:00:01Z","syntheticRevision":1}');
UPDATE public.focus_sessions SET ended_at=now() WHERE id='b2222222-2222-4222-8222-222222222222';
SELECT set_config('request.jwt.claim.sub','b1111111-1111-4111-8111-111111111111',true);
DO $test$
DECLARE
  result JSONB;
  ended TIMESTAMPTZ;
BEGIN
  result := public.sync_upsert_focus_session(jsonb_build_object(
    'operation_id','b3333333-3333-4333-8333-333333333333','protocol_version',2147483647,'deployment_epoch',9223372036854775807,
    'focus_session',jsonb_build_object('id','b2222222-2222-4222-8222-222222222222','user_id','b1111111-1111-4111-8111-111111111111',
      'started_at','2026-01-01T00:00:00Z','ended_at',NULL,'updated_at','2026-01-01T00:00:02Z',
      'session_state',jsonb_build_object('savedAt','2026-01-01T00:00:02Z','syntheticRevision',2))));
  SELECT ended_at INTO ended FROM public.focus_sessions WHERE id='b2222222-2222-4222-8222-222222222222';
  IF ended IS NULL THEN
    RAISE EXCEPTION 'legacy direct end overwritten by older offline business snapshot: %',result;
  END IF;
  IF result->>'status'='applied' AND COALESCE((result->>'stale_payload')::BOOLEAN,false) IS FALSE THEN
    RAISE EXCEPTION 'older write was falsely acknowledged as applied: %',result;
  END IF;
END;
$test$;
ROLLBACK;
