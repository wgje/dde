-- Widget Gate read cooldown:
-- - `read` hides the entry from the current widget Gate queue for 30 minutes.
-- - After the cooldown, the same unfinished entry can reappear with its read age.
-- This keeps the Android widget aligned with the "intermittent Gate" design
-- without changing the existing snooze_until DATE column.

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
  v_unread_count int := 0;
  v_preview jsonb := '[]'::jsonb;
  v_black_box_watermark timestamptz;
  v_gate_read_cooldown_cutoff timestamptz := now() - interval '30 minutes';
  v_dock_count int := 0;
  v_dock_watermark timestamptz;
begin
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

  select coalesce(array_agg(id), array[]::uuid[])
    into v_accessible_project_ids
    from public.projects
    where owner_id = p_user_id
      and deleted_at is null;

  select count(*)::int
    into v_pending_count
    from public.black_box_entries
    where user_id = p_user_id
      and deleted_at is null
      and is_completed = false
      and is_archived = false
      and date < p_today
      and (snooze_until is null or snooze_until <= p_today)
      and (is_read = false or updated_at <= v_gate_read_cooldown_cutoff);

  select count(*)::int
    into v_unread_count
    from public.black_box_entries
    where user_id = p_user_id
      and deleted_at is null
      and is_read = false
      and is_completed = false
      and is_archived = false
      and date < p_today
      and (snooze_until is null or snooze_until <= p_today);

  select max(updated_at)
    into v_black_box_watermark
    from public.black_box_entries
    where user_id = p_user_id
      and deleted_at is null
      and is_archived = false
      and date < p_today;

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
          and (is_read = false or updated_at <= v_gate_read_cooldown_cutoff)
        order by created_at asc
        limit greatest(p_preview_limit, 0)
    ) bb;

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
    'unreadBlackBoxCount', v_unread_count,
    'blackBoxPreview', v_preview,
    'blackBoxWatermark', v_black_box_watermark,
    'dockCount', v_dock_count,
    'dockWatermark', v_dock_watermark
  );
end;
$$;
revoke all on function public.widget_summary_wave1(uuid, date, int) from public, anon, authenticated;
grant execute on function public.widget_summary_wave1(uuid, date, int) to service_role;
comment on function public.widget_summary_wave1(uuid, date, int) is
  'Widget summary 第一波聚合：focus_sessions + projects + black_box 当前可见队列/read cooldown/preview/watermark + dock count/watermark 合并到单次 RPC。';
