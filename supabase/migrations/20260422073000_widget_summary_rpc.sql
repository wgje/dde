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
set search_path = public, pg_catalog
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
        'is_read', bb.is_read,
        'created_at', bb.created_at,
        'snooze_until', bb.snooze_until,
        'updated_at', bb.updated_at
      ) order by bb.created_at asc
    ), '[]'::jsonb)
    into v_preview
    from (
      select id, date, project_id, content, is_read, created_at, snooze_until, updated_at
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
