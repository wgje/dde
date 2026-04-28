-- 2026-04-22 widget-summary wave1 RPC 化
--
-- 动机：Edge Function 原本走 Promise.all 并行 4 个 PostgREST 查询（focus_sessions + projects +
-- black_box count + black_box preview），但由于 PostgREST 每个请求独立建连 + JSON 解析，
-- 实测仍需 ~1.5s。把这 4 个查询 + dock count/watermark 合并到一个 PL/pgSQL RPC，
-- 在单次 HTTP roundtrip 内完成，期望降到 ~500ms。
--
-- Wave 2（根据 session_state 解析出的 taskIds/projectIds 反查 tasks/projects）因为涉及
-- 版本化 dock snapshot 解析逻辑（toFocusSessionState 的 v2-v7 分支），保留在 Edge Function 的 JS 侧。
--
-- 语义与原 Edge Function 完全对齐：
-- - black_box gate 口径：未完成 / 未归档 / 未删除 / date < today / snooze_until 为 null 或已到期。
-- - projects 只取 owner_id = p_user_id 且未软删。
-- - dock count/watermark 以 `parking_meta @> '{"state":"parked"}'` 为过滤条件。
-- - black_box preview 按 created_at ASC 取前 p_preview_limit 条。

create or replace function public.widget_summary_wave1(
  p_user_id uuid,
  p_today date,
  p_preview_limit int default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_session_json jsonb := null;
  v_accessible_project_ids uuid[] := array[]::uuid[];
  v_pending_count int := 0;
  v_preview jsonb := '[]'::jsonb;
  v_dock_count int := 0;
  v_dock_watermark timestamptz;
begin
  -- Wave 1.1: 最近一次 focus_sessions
  select jsonb_build_object(
    'id', id,
    'updated_at', updated_at,
    'session_state', session_state
  )
    into v_session_json
    from public.focus_sessions
    where user_id = p_user_id
    order by updated_at desc
    limit 1;

  -- Wave 1.2: accessible projects
  select coalesce(array_agg(id), array[]::uuid[])
    into v_accessible_project_ids
    from public.projects
    where owner_id = p_user_id
      and deleted_at is null;

  -- Wave 1.3: black box pending count
  select count(*)::int
    into v_pending_count
    from public.black_box_entries
    where user_id = p_user_id
      and deleted_at is null
      and is_completed = false
      and is_archived = false
      and date < p_today
      and (snooze_until is null or snooze_until <= p_today);

  -- Wave 1.4: black box preview (top N by created_at asc)
  select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', bb.id,
        'date', bb.date,
        'project_id', bb.project_id,
        'content', bb.content,
        'created_at', bb.created_at,
        'snooze_until', bb.snooze_until,
        'updated_at', bb.updated_at
      ) order by bb.created_at asc
    ), '[]'::jsonb)
    into v_preview
    from (
      select id, date, project_id, content, created_at, snooze_until, updated_at
        from public.black_box_entries
        where user_id = p_user_id
          and deleted_at is null
          and is_completed = false
          and is_archived = false
          and date < p_today
          and (snooze_until is null or snooze_until <= p_today)
        order by created_at asc
        limit greatest(p_preview_limit, 0)
    ) bb;

  -- Wave 1.5: dock count + watermark（parked 任务在 accessibleProjects 下）
  if array_length(v_accessible_project_ids, 1) is not null then
    select count(*)::int, max(updated_at)
      into v_dock_count, v_dock_watermark
      from public.tasks
      where project_id = any(v_accessible_project_ids)
        and deleted_at is null
        and parking_meta @> '{"state":"parked"}'::jsonb;
  end if;

  return jsonb_build_object(
    'focusSession', v_session_json,
    'accessibleProjectIds', to_jsonb(v_accessible_project_ids),
    'pendingBlackBoxCount', v_pending_count,
    'blackBoxPreview', v_preview,
    'dockCount', v_dock_count,
    'dockWatermark', v_dock_watermark
  );
end;
$$;
revoke all on function public.widget_summary_wave1(uuid, date, int) from public, anon, authenticated;
grant execute on function public.widget_summary_wave1(uuid, date, int) to service_role;
comment on function public.widget_summary_wave1(uuid, date, int) is
  'Widget summary 第一波聚合：focus_sessions + projects + black_box count/preview + dock count/watermark 合并到单次 RPC，把 4-5 个 PostgREST roundtrip 压缩到 1 个。';
-- 2026-04-22 widget-summary 单 RPC 化
--
-- 动机：Edge Function 原本走 Promise.all 并行 4 个 PostgREST 查询 → 拿到 focus session + dock slot
-- id 后再并行 4 个 PostgREST 查询。每个 PostgREST roundtrip 约 400ms（JSON 解析 + 协议开销），
-- 两波下来 800ms-2s。改成一个 PL/pgSQL RPC 在单次连接内跑所有 SQL，只回一个 JSON，
-- 把两波 HTTP 变成一波，把 8 个 REST 解析变成 1 个。
--
-- 语义与原 Edge Function 完全对齐：
-- - 口径按 `black_box_entries` 的 gate 口径：未完成、未归档、未删除、date < today、snooze 已到期。
-- - projects 只取 owner_id = p_user_id 且未软删的。
-- - dock 用 `parking_meta->>'state' = 'parked'` 作为过滤。
-- - black box preview 按 created_at ASC 取前 p_preview_limit 条。
--
-- 返回 JSON 形状：
-- {
--   "focusSession": { id, updated_at, session_state } | null,
--   "accessibleProjectIds": [...],
--   "pendingBlackBoxCount": int,
--   "blackBoxPreview": [ { id, date, project_id, content, created_at, snooze_until, updated_at }, ... ],
--   "taskRefs":    [ { id, title, project_id, updated_at } ],     -- 对齐 focus slot + dock slot 的 taskIds
--   "projectRefs": [ { id, title, updated_at } ],                 -- 对齐 focus slot + dock slot + black box preview 的 projectIds
--   "dockCount": int,                                             -- parked 任务总数
--   "dockWatermark": timestamp | null                             -- parked 任务的 max(updated_at)
-- }

create or replace function public.widget_summary_fetch(
  p_user_id uuid,
  p_today date,
  p_preview_limit int default 6
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_session record;
  v_state jsonb;
  v_task_ids uuid[] := array[]::uuid[];
  v_project_id_set uuid[] := array[]::uuid[];
  v_accessible_project_ids uuid[] := array[]::uuid[];
  v_pending_count int := 0;
  v_preview jsonb := '[]'::jsonb;
  v_task_refs jsonb := '[]'::jsonb;
  v_project_refs jsonb := '[]'::jsonb;
  v_dock_count int := 0;
  v_dock_watermark timestamptz;
  v_session_json jsonb := null;
begin
  -- Wave 1.1: 最近一次 focus_sessions（用于解析 focus slot / dock slot）
  select id, updated_at, session_state
    into v_session
    from public.focus_sessions
    where user_id = p_user_id
    order by updated_at desc
    limit 1;
  if v_session.id is not null then
    v_state := coalesce(v_session.session_state, '{}'::jsonb);
    v_session_json := jsonb_build_object(
      'id', v_session.id,
      'updated_at', v_session.updated_at,
      'session_state', v_state
    );

    -- 从 session_state 里挑出所有 taskIds / sourceProjectIds（和 Edge Function 一致：
    -- primarySlot + comboSelectTasks + backupTasks）
    select coalesce(array_agg(distinct task_id) filter (where task_id is not null), array[]::uuid[])
      into v_task_ids
      from (
        select (v_state -> 'primarySlot' ->> 'taskId')::uuid as task_id
        union all
        select (jsonb_array_elements(coalesce(v_state -> 'comboSelectTasks', '[]'::jsonb)) ->> 'taskId')::uuid
        union all
        select (jsonb_array_elements(coalesce(v_state -> 'backupTasks', '[]'::jsonb)) ->> 'taskId')::uuid
      ) t
      where task_id is not null;

    select coalesce(array_agg(distinct project_id) filter (where project_id is not null), array[]::uuid[])
      into v_project_id_set
      from (
        select (v_state -> 'primarySlot' ->> 'sourceProjectId')::uuid as project_id
        union all
        select (jsonb_array_elements(coalesce(v_state -> 'comboSelectTasks', '[]'::jsonb)) ->> 'sourceProjectId')::uuid
        union all
        select (jsonb_array_elements(coalesce(v_state -> 'backupTasks', '[]'::jsonb)) ->> 'sourceProjectId')::uuid
      ) t
      where project_id is not null;
  end if;

  -- Wave 1.2: accessible projects（owner_id = user）
  select coalesce(array_agg(id), array[]::uuid[])
    into v_accessible_project_ids
    from public.projects
    where owner_id = p_user_id
      and deleted_at is null;

  -- Wave 1.3: black box pending count
  select count(*)::int
    into v_pending_count
    from public.black_box_entries
    where user_id = p_user_id
      and deleted_at is null
      and is_completed = false
      and is_archived = false
      and date < p_today
      and (snooze_until is null or snooze_until <= p_today);

  -- Wave 1.4: black box preview (top N by created_at asc)
  select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', bb.id,
        'date', bb.date,
        'project_id', bb.project_id,
        'content', bb.content,
        'created_at', bb.created_at,
        'snooze_until', bb.snooze_until,
        'updated_at', bb.updated_at
      ) order by bb.created_at asc
    ), '[]'::jsonb)
    into v_preview
    from (
      select id, date, project_id, content, created_at, snooze_until, updated_at
        from public.black_box_entries
        where user_id = p_user_id
          and deleted_at is null
          and is_completed = false
          and is_archived = false
          and date < p_today
          and (snooze_until is null or snooze_until <= p_today)
        order by created_at asc
        limit greatest(p_preview_limit, 0)
    ) bb;

  -- Wave 2.1: tasks 校验（taskIds ∩ accessibleProjects）
  if array_length(v_task_ids, 1) is not null
     and array_length(v_accessible_project_ids, 1) is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'project_id', t.project_id,
        'updated_at', t.updated_at
      )), '[]'::jsonb)
      into v_task_refs
      from public.tasks t
      where t.id = any(v_task_ids)
        and t.project_id = any(v_accessible_project_ids)
        and t.deleted_at is null;
  end if;

  -- Wave 2.2: projects 校验（focus/dock + black box preview 里引用的 projectIds）
  -- 合并 v_project_id_set 和 black box preview 里的 project_id
  with preview_projects as (
    select distinct (elem ->> 'project_id')::uuid as pid
      from jsonb_array_elements(v_preview) elem
      where elem ? 'project_id' and (elem ->> 'project_id') is not null
  ),
  all_pids as (
    select unnest(v_project_id_set) as pid
    union
    select pid from preview_projects where pid is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'title', p.title,
      'updated_at', p.updated_at
    )), '[]'::jsonb)
    into v_project_refs
    from public.projects p
    where p.id in (select pid from all_pids where pid is not null)
      and p.owner_id = p_user_id
      and p.deleted_at is null;

  -- Wave 2.3 + 2.4: dock count + watermark（parked 任务在 accessibleProjects 下）
  if array_length(v_accessible_project_ids, 1) is not null then
    select count(*)::int, max(updated_at)
      into v_dock_count, v_dock_watermark
      from public.tasks
      where project_id = any(v_accessible_project_ids)
        and deleted_at is null
        and parking_meta @> '{"state":"parked"}'::jsonb;
  end if;

  return jsonb_build_object(
    'focusSession', v_session_json,
    'accessibleProjectIds', to_jsonb(v_accessible_project_ids),
    'pendingBlackBoxCount', v_pending_count,
    'blackBoxPreview', v_preview,
    'taskRefs', v_task_refs,
    'projectRefs', v_project_refs,
    'dockCount', v_dock_count,
    'dockWatermark', v_dock_watermark
  );
end;
$$;
-- 仅 service_role 调用（Edge Function 用 service role key 访问）
revoke all on function public.widget_summary_fetch(uuid, date, int) from public, anon, authenticated;
grant execute on function public.widget_summary_fetch(uuid, date, int) to service_role;
comment on function public.widget_summary_fetch(uuid, date, int) is
  'Widget summary 聚合查询：一次 PL/pgSQL 调用返回 focus session + accessible projects + black box + dock 全部数据，避免 8 个 PostgREST roundtrip。';
