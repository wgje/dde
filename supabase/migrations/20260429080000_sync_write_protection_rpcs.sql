-- =============================================================================
-- Cloudflare 迁移 §6.4 / §16.26 —— 服务端写入保护 RPC（CAS + idempotency + protocol fence）
-- =============================================================================
--
-- 目的：
-- - 把同步实体（task / connection / project / black_box_entry）的 mutation 集中到
--   一组 SECURITY INVOKER 的 RPC，避免迁移窗口内旧 origin / 旧 protocol 直接绕过
--   客户端 Origin Gate 写入 Supabase。
-- - RPC 层做：
--   1. **operation_log** 幂等键去重：相同 operation_id 重放返回首次结果，不重复写；
--   2. **CAS** 条件更新：客户端必须携带 `base_updated_at`，服务端版本前进时返回
--      `remote-newer`，由客户端先 pull+merge 再决定重排队；
--   3. **min_protocol_version fence**：迁移窗口期 raise 最小 protocol，旧前端 push
--      会得到 `client-version-rejected`，进入 Sentry `ghost_write_rejected`；
--   4. RLS 复用现有 owner_id / user_id 策略，不放大数据可见性。
--
-- 客户端 flag：`NG_APP_SYNC_RPC_ENABLED`（默认 false）。本 migration 单独发布
-- 不会影响现有 PostgREST 写路径；客户端切换由独立 PR 携带 e2e + canary 完成。
--
-- =============================================================================

-- 1. operation_log：幂等键 + 拒绝原因审计
CREATE TABLE IF NOT EXISTS public.sync_operation_log (
  operation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  protocol_version INTEGER,
  client_git_sha TEXT,
  client_origin TEXT,
  result_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sync_operation_log_status_check
    CHECK (status IN ('applied', 'idempotent-replay', 'remote-newer', 'client-version-rejected', 'tombstoned', 'unauthorized'))
);

CREATE INDEX IF NOT EXISTS idx_sync_operation_log_user_created
  ON public.sync_operation_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_operation_log_entity
  ON public.sync_operation_log (entity_type, entity_id);

ALTER TABLE public.sync_operation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_operation_log_owner_select ON public.sync_operation_log;
CREATE POLICY sync_operation_log_owner_select
  ON public.sync_operation_log
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- 没有 INSERT/UPDATE/DELETE 策略：只允许 RPC（SECURITY DEFINER）写入。

COMMENT ON TABLE public.sync_operation_log IS
  'Idempotency + ghost-write audit log for sync RPCs. Each sync mutation MUST carry
   a client-generated operation_id. Repeated writes with the same operation_id return
   the first result instead of re-applying.';

-- 2. sync_protocol_state：服务端最小 protocol 版本闸门
CREATE TABLE IF NOT EXISTS public.sync_protocol_state (
  scope TEXT PRIMARY KEY,
  min_protocol_version INTEGER NOT NULL DEFAULT 1,
  deployment_epoch BIGINT NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.sync_protocol_state (scope, min_protocol_version, deployment_epoch, reason)
VALUES ('global', 1, 0, 'initial')
ON CONFLICT (scope) DO NOTHING;

ALTER TABLE public.sync_protocol_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sync_protocol_state_authenticated_read ON public.sync_protocol_state;
CREATE POLICY sync_protocol_state_authenticated_read
  ON public.sync_protocol_state
  FOR SELECT
  TO authenticated
  USING (true);

-- 3. RPC：sync_check_protocol —— 客户端启动时探测最小 protocol
CREATE OR REPLACE FUNCTION public.sync_check_protocol()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
AS $$
DECLARE
  v_min INTEGER;
  v_epoch BIGINT;
BEGIN
  SELECT min_protocol_version, deployment_epoch
    INTO v_min, v_epoch
    FROM public.sync_protocol_state
    WHERE scope = 'global';
  RETURN jsonb_build_object(
    'minProtocolVersion', COALESCE(v_min, 1),
    'deploymentEpoch', COALESCE(v_epoch, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_check_protocol() TO authenticated;

COMMENT ON FUNCTION public.sync_check_protocol() IS
  'Returns server-side min protocol version + deployment epoch. Client compares with
   its own NG_APP_SYNC_PROTOCOL_VERSION and refuses to flush if rejected.';

-- 4. RPC：sync_upsert_task —— task 写入保护
--    入参 jsonb：
--      operation_id (uuid, required)
--      protocol_version (int, required)
--      base_updated_at (timestamptz, nullable —— null 表示客户端期望 INSERT)
--      task: { id, project_id, content, ... } (jsonb)
--      client_git_sha (text, nullable)
--      client_origin (text, nullable)
--    返回 jsonb：
--      { status, result, conflict?: { remote_updated_at } }
CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_task JSONB := payload->'task';
  v_task_id UUID := (v_task->>'id')::UUID;
  v_project_id UUID := (v_task->>'project_id')::UUID;
  v_client_git TEXT := payload->>'client_git_sha';
  v_client_origin TEXT := payload->>'client_origin';
  v_min_protocol INTEGER;
  v_existing_updated TIMESTAMPTZ;
  v_existing_owner UUID;
  v_log_existing RECORD;
  v_result JSONB;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'no auth');
  END IF;
  IF v_op_id IS NULL OR v_task_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  -- 4.a Idempotency：同 operation_id 已落盘 → 返回首次结果
  SELECT * INTO v_log_existing FROM public.sync_operation_log WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  -- 4.b Protocol fence
  SELECT min_protocol_version INTO v_min_protocol FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'client-version-rejected',
      'protocol_version_below_min', v_protocol, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'client-version-rejected',
      'minProtocolVersion', v_min_protocol);
  END IF;

  -- 4.c Project 所有权校验（防伪造 project_id）
  SELECT p.owner_id INTO v_existing_owner FROM public.projects p WHERE p.id = v_project_id;
  IF v_existing_owner IS DISTINCT FROM v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version, client_git_sha, client_origin)
    VALUES (v_op_id, v_user, 'task', v_task_id, 'unauthorized',
      'project_not_owned', v_protocol, v_client_git, v_client_origin);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  -- 4.d CAS：取当前 updated_at
  SELECT t.updated_at INTO v_existing_updated FROM public.tasks t WHERE t.id = v_task_id;

  IF v_existing_updated IS NULL THEN
    -- INSERT 路径：base_updated_at 必须为空
    IF v_base_updated IS NOT NULL THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, client_git_sha, client_origin)
      VALUES (v_op_id, v_user, 'task', v_task_id, 'remote-newer',
        'remote_missing_but_base_present', v_protocol, v_client_git, v_client_origin);
      RETURN jsonb_build_object('status', 'remote-newer', 'reason', 'remote_missing');
    END IF;
  ELSE
    -- UPDATE 路径：base_updated_at 必须等于服务端当前值
    IF v_base_updated IS NULL OR v_base_updated <> v_existing_updated THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version, client_git_sha, client_origin)
      VALUES (v_op_id, v_user, 'task', v_task_id, 'remote-newer',
        'cas_mismatch', v_protocol, v_client_git, v_client_origin);
      RETURN jsonb_build_object(
        'status', 'remote-newer',
        'remote_updated_at', v_existing_updated
      );
    END IF;
  END IF;

  -- 4.e 实际写入：复用现有 batch_upsert_tasks 逻辑（数组里只有一条）
  PERFORM public.batch_upsert_tasks(ARRAY[v_task], v_project_id);

  v_result := jsonb_build_object(
    'status', 'applied',
    'operation_id', v_op_id,
    'task_id', v_task_id
  );

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, client_git_sha, client_origin, result_payload)
  VALUES (v_op_id, v_user, 'task', v_task_id, 'applied',
    v_protocol, v_client_git, v_client_origin, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;

COMMENT ON FUNCTION public.sync_upsert_task(JSONB) IS
  'Sync-protected task upsert with idempotency + CAS + protocol fence. Default
   client path is NOT switched to this RPC; activation is gated by the client
   feature flag NG_APP_SYNC_RPC_ENABLED.';

-- 5. RPC：sync_upsert_connection
CREATE OR REPLACE FUNCTION public.sync_upsert_connection(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_conn JSONB := payload->'connection';
  v_conn_id UUID := (v_conn->>'id')::UUID;
  v_project_id UUID := (v_conn->>'project_id')::UUID;
  v_min_protocol INTEGER;
  v_existing_updated TIMESTAMPTZ;
  v_existing_owner UUID;
  v_log_existing RECORD;
  v_result JSONB;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_conn_id IS NULL OR v_project_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  SELECT * INTO v_log_existing FROM public.sync_operation_log WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version INTO v_min_protocol FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'client-version-rejected',
      'protocol_version_below_min', v_protocol);
    RETURN jsonb_build_object('status', 'client-version-rejected', 'minProtocolVersion', v_min_protocol);
  END IF;

  SELECT p.owner_id INTO v_existing_owner FROM public.projects p WHERE p.id = v_project_id;
  IF v_existing_owner IS DISTINCT FROM v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version)
    VALUES (v_op_id, v_user, 'connection', v_conn_id, 'unauthorized',
      'project_not_owned', v_protocol);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'project_not_owned');
  END IF;

  SELECT c.updated_at INTO v_existing_updated FROM public.connections c WHERE c.id = v_conn_id;
  IF v_existing_updated IS NULL THEN
    IF v_base_updated IS NOT NULL THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version)
      VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
        'remote_missing_but_base_present', v_protocol);
      RETURN jsonb_build_object('status', 'remote-newer', 'reason', 'remote_missing');
    END IF;
  ELSE
    IF v_base_updated IS NULL OR v_base_updated <> v_existing_updated THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version)
      VALUES (v_op_id, v_user, 'connection', v_conn_id, 'remote-newer',
        'cas_mismatch', v_protocol);
      RETURN jsonb_build_object('status', 'remote-newer', 'remote_updated_at', v_existing_updated);
    END IF;
  END IF;

  INSERT INTO public.connections AS c (id, project_id, source_id, target_id, updated_at)
  VALUES (
    v_conn_id,
    v_project_id,
    (v_conn->>'source_id')::UUID,
    (v_conn->>'target_id')::UUID,
    NOW()
  )
  ON CONFLICT (id) DO UPDATE
    SET source_id = EXCLUDED.source_id,
        target_id = EXCLUDED.target_id,
        updated_at = NOW();

  v_result := jsonb_build_object('status', 'applied', 'operation_id', v_op_id, 'connection_id', v_conn_id);

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, result_payload)
  VALUES (v_op_id, v_user, 'connection', v_conn_id, 'applied', v_protocol, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_upsert_connection(JSONB) TO authenticated;

-- 6. RPC：sync_upsert_blackbox_entry
CREATE OR REPLACE FUNCTION public.sync_upsert_blackbox_entry(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_op_id UUID := (payload->>'operation_id')::UUID;
  v_protocol INTEGER := COALESCE((payload->>'protocol_version')::INTEGER, 0);
  v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ;
  v_entry JSONB := payload->'entry';
  v_entry_id UUID := (v_entry->>'id')::UUID;
  v_min_protocol INTEGER;
  v_existing_updated TIMESTAMPTZ;
  v_existing_owner UUID;
  v_log_existing RECORD;
  v_result JSONB;
BEGIN
  IF v_user IS NULL OR v_op_id IS NULL OR v_entry_id IS NULL THEN
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'missing required fields');
  END IF;

  SELECT * INTO v_log_existing FROM public.sync_operation_log WHERE operation_id = v_op_id;
  IF FOUND THEN
    IF v_log_existing.user_id <> v_user THEN
      RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'operation_id owned by other user');
    END IF;
    RETURN COALESCE(
      v_log_existing.result_payload,
      jsonb_build_object('status', v_log_existing.status, 'reason', v_log_existing.reject_reason)
    );
  END IF;

  SELECT min_protocol_version INTO v_min_protocol FROM public.sync_protocol_state WHERE scope = 'global';
  IF v_protocol < COALESCE(v_min_protocol, 1) THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'client-version-rejected',
      'protocol_version_below_min', v_protocol);
    RETURN jsonb_build_object('status', 'client-version-rejected', 'minProtocolVersion', v_min_protocol);
  END IF;

  -- BlackBox entries 直接 user_id ownership
  SELECT b.updated_at, b.user_id INTO v_existing_updated, v_existing_owner
    FROM public.black_box_entries b WHERE b.id = v_entry_id;

  IF v_existing_owner IS NOT NULL AND v_existing_owner <> v_user THEN
    INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
      status, reject_reason, protocol_version)
    VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'unauthorized',
      'entry_owned_by_other', v_protocol);
    RETURN jsonb_build_object('status', 'unauthorized', 'reason', 'entry_owned_by_other');
  END IF;

  IF v_existing_updated IS NULL THEN
    IF v_base_updated IS NOT NULL THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version)
      VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'remote-newer',
        'remote_missing_but_base_present', v_protocol);
      RETURN jsonb_build_object('status', 'remote-newer', 'reason', 'remote_missing');
    END IF;
  ELSE
    IF v_base_updated IS NULL OR v_base_updated <> v_existing_updated THEN
      INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
        status, reject_reason, protocol_version)
      VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'remote-newer',
        'cas_mismatch', v_protocol);
      RETURN jsonb_build_object('status', 'remote-newer', 'remote_updated_at', v_existing_updated);
    END IF;
  END IF;

  INSERT INTO public.black_box_entries AS b (id, user_id, content, created_at, updated_at, deleted_at)
  VALUES (
    v_entry_id,
    v_user,
    v_entry->>'content',
    COALESCE(NULLIF(v_entry->>'created_at','')::TIMESTAMPTZ, NOW()),
    NOW(),
    NULLIF(v_entry->>'deleted_at','')::TIMESTAMPTZ
  )
  ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content,
        updated_at = NOW(),
        deleted_at = EXCLUDED.deleted_at;

  v_result := jsonb_build_object('status', 'applied', 'operation_id', v_op_id, 'entry_id', v_entry_id);

  INSERT INTO public.sync_operation_log (operation_id, user_id, entity_type, entity_id,
    status, protocol_version, result_payload)
  VALUES (v_op_id, v_user, 'blackbox', v_entry_id, 'applied', v_protocol, v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_upsert_blackbox_entry(JSONB) TO authenticated;

-- =============================================================================
-- 部署后 follow-up（独立 PR）：
-- 1. 客户端启用 NG_APP_SYNC_RPC_ENABLED=true 后，RetryQueue/ActionQueue 的 push 逻辑
--    切到 SyncRpcClientService.upsertTask/upsertConnection/upsertBlackboxEntry。
-- 2. 切换前必须有 e2e：覆盖 idempotent replay、CAS conflict、protocol fence 三类返回。
-- 3. 旧客户端淘汰后，把 sync_protocol_state.min_protocol_version raise 到 N+1，
--    锁死旧 origin 的 ghost write。
-- =============================================================================
