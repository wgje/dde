-- LOCAL SYNTHETIC DATABASE ONLY. Applies optional migration and fixtures in one rollback-only transaction.
-- psql -v ON_ERROR_STOP=1 -v migration_file=/tmp/recovery-project-head.sql -f this-file.sql
\set ON_ERROR_STOP on
BEGIN;
\if :{?migration_file}
\i :migration_file
\endif
INSERT INTO auth.users (id) VALUES
 ('91111111-1111-4111-8111-111111111111'),
 ('92222222-2222-4222-8222-222222222222');
INSERT INTO public.projects (id,owner_id,title,updated_at,deleted_at) VALUES
 ('93333333-3333-4333-8333-333333333331','91111111-1111-4111-8111-111111111111','synthetic-head-a','2026-11-01T00:00:00Z',NULL),
 ('93333333-3333-4333-8333-333333333332','91111111-1111-4111-8111-111111111111','synthetic-head-b','2026-11-01T00:00:00Z',NULL),
 ('93333333-3333-4333-8333-333333333333','91111111-1111-4111-8111-111111111111','synthetic-head-c','2026-11-01T00:00:00Z',NULL),
 ('93333333-3333-4333-8333-333333333334','91111111-1111-4111-8111-111111111111','synthetic-deleted','2026-11-01T00:00:00Z','2026-11-02T00:00:00Z'),
 ('94444444-4444-4444-8444-444444444444','92222222-2222-4222-8222-222222222222','synthetic-other-owner','2026-11-01T00:00:00Z',NULL);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','91111111-1111-4111-8111-111111111111',true);
DO $test$
DECLARE
  heads UUID[] := ARRAY[]::UUID[];
  head RECORD;
  cursor_time TIMESTAMPTZ := NULL;
  cursor_id UUID := NULL;
  n INTEGER;
BEGIN
  LOOP
    SELECT * INTO head FROM public.list_project_heads_page(NULL,'2026-11-02',cursor_time,cursor_id,1);
    EXIT WHEN NOT FOUND;
    IF head.project_id = ANY(heads) THEN RAISE EXCEPTION 'keyset repeated an equal-timestamp row'; END IF;
    heads := array_append(heads,head.project_id);
    cursor_time := head.updated_at; cursor_id := head.project_id;
    IF cardinality(heads)>3 THEN RAISE EXCEPTION 'owner/deleted isolation failed'; END IF;
  END LOOP;
  IF heads IS DISTINCT FROM ARRAY[
    '93333333-3333-4333-8333-333333333331'::UUID,
    '93333333-3333-4333-8333-333333333332'::UUID,
    '93333333-3333-4333-8333-333333333333'::UUID] THEN
    RAISE EXCEPTION 'equal timestamp pagination omitted or leaked rows: %',heads;
  END IF;
  SELECT count(*) INTO n FROM public.list_project_heads_page(NULL,'2026-10-31',NULL,NULL,100);
  IF n<>0 THEN RAISE EXCEPTION 'upper watermark not enforced'; END IF;
  SELECT count(*) INTO n FROM public.list_project_heads_page('2026-11-01','2026-11-02',NULL,NULL,100);
  IF n<>0 THEN RAISE EXCEPTION 'since must be exclusive'; END IF;
  BEGIN
    PERFORM * FROM public.list_project_heads_page(NULL,'2026-11-02',NULL,NULL,101);
    RAISE EXCEPTION 'page limit was not bounded';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM * FROM public.list_project_heads_page(NULL,'2026-11-02','2026-11-01',NULL,1);
    RAISE EXCEPTION 'partial cursor accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN
    PERFORM * FROM public.list_project_heads_since(NULL);
    RAISE EXCEPTION 'legacy unbounded RPC remains executable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END;
$test$;
SELECT set_config('request.jwt.claim.sub','92222222-2222-4222-8222-222222222222',true);
DO $test$
DECLARE ids UUID[];
BEGIN
  SELECT array_agg(project_id) INTO ids FROM public.list_project_heads_page(NULL,'2026-11-02',NULL,NULL,100);
  IF ids IS DISTINCT FROM ARRAY['94444444-4444-4444-8444-444444444444'::UUID] THEN
    RAISE EXCEPTION 'second owner isolation failed';
  END IF;
END;
$test$;
RESET ROLE;
DO $test$
BEGIN
  IF has_function_privilege('anon','public.list_project_heads_page(timestamptz,timestamptz,timestamptz,uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'anon execute exposed';
  END IF;
END;
$test$;
ROLLBACK;
