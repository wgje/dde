ALTER TABLE public.sync_protocol_state
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.sync_protocol_state
SET capabilities = '[]'::jsonb
WHERE capabilities IS NULL
   OR jsonb_typeof(capabilities) <> 'array';

CREATE OR REPLACE FUNCTION public.sync_check_protocol()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_min INTEGER;
  v_epoch BIGINT;
  v_capabilities JSONB;
BEGIN
  SELECT min_protocol_version, deployment_epoch, capabilities
    INTO v_min, v_epoch, v_capabilities
    FROM public.sync_protocol_state
    WHERE scope = 'global';

  RETURN jsonb_build_object(
    'minProtocolVersion', COALESCE(v_min, 1),
    'deploymentEpoch', COALESCE(v_epoch, 0),
    'capabilities', CASE
      WHEN jsonb_typeof(COALESCE(v_capabilities, '[]'::jsonb)) = 'array'
        THEN COALESCE(v_capabilities, '[]'::jsonb)
      ELSE '[]'::jsonb
    END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_check_protocol() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_check_protocol() TO authenticated;

COMMENT ON COLUMN public.sync_protocol_state.capabilities IS
  'Explicit server capabilities. Keep empty until the corresponding command transport and replay semantics are deployed and verified.';
COMMENT ON FUNCTION public.sync_check_protocol() IS
  'Returns server min protocol, deployment epoch, and explicit additive capabilities. Empty capabilities keep the new command path in shadow mode.';