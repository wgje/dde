CREATE OR REPLACE FUNCTION public.consume_transcription_quota(
  p_user_id UUID,
  p_usage_date DATE,
  p_daily_limit INTEGER,
  p_audio_seconds INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_usage_count INTEGER;
  v_usage_id UUID;
BEGIN
  IF p_user_id IS NULL OR p_usage_date IS NULL OR p_daily_limit IS NULL OR p_daily_limit <= 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_quota_request', 'usage_count', 0);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('transcription_usage'), hashtext(p_user_id::TEXT || ':' || p_usage_date::TEXT));

  SELECT count(*) INTO v_usage_count
  FROM public.transcription_usage
  WHERE user_id = p_user_id
    AND date = p_usage_date;

  IF v_usage_count >= p_daily_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'quota_exceeded', 'usage_count', v_usage_count);
  END IF;

  v_usage_id := extensions.gen_random_uuid();
  INSERT INTO public.transcription_usage (id, user_id, date, audio_seconds)
  VALUES (v_usage_id, p_user_id, p_usage_date, GREATEST(COALESCE(p_audio_seconds, 0), 0));

  RETURN jsonb_build_object('allowed', true, 'usage_count', v_usage_count + 1, 'usage_id', v_usage_id);
END;
$$;

REVOKE ALL ON FUNCTION public.consume_transcription_quota(UUID, DATE, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_transcription_quota(UUID, DATE, INTEGER, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.release_transcription_quota(
  p_usage_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted_count INTEGER := 0;
BEGIN
  IF p_usage_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'invalid_release_request', 'deleted_count', 0);
  END IF;

  DELETE FROM public.transcription_usage
  WHERE id = p_usage_id AND user_id = p_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN jsonb_build_object('released', v_deleted_count > 0, 'deleted_count', v_deleted_count);
END;
$$;

REVOKE ALL ON FUNCTION public.release_transcription_quota(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_transcription_quota(UUID, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
