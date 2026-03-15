-- Focus Console v3.3 N2 cutover hardening
-- Non-destructive migration: dedupe + unique indexes for upsert targets

-- 1) focus_sessions: keep only latest row per user (if legacy duplicates exist)
with ranked as (
  select
    id,
    user_id,
    row_number() over (
      partition by user_id
      order by updated_at desc nulls last, id desc
    ) as rn
  from public.focus_sessions
)
delete from public.focus_sessions fs
using ranked r
where fs.id = r.id
  and r.rn > 1;

create unique index if not exists uq_focus_sessions_user_id
  on public.focus_sessions (user_id);

-- 2) routine_completions: merge duplicate rows (防御性：兼容 completed_date 和 date_key)
DO $$ 
DECLARE
  v_date_col TEXT;
BEGIN
  -- 检测实际列名
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'routine_completions' AND column_name = 'completed_date'
  ) THEN
    v_date_col := 'completed_date';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'routine_completions' AND column_name = 'date_key'
  ) THEN
    v_date_col := 'date_key';
  ELSE
    RETURN; -- 列都不存在，跳过
  END IF;

  -- 合并重复行
  EXECUTE format('
    WITH duplicate_groups AS (
      SELECT user_id, routine_id, %I AS dk,
        min(id) AS keep_id, sum(count) AS merged_count, count(*) AS dup_cnt
      FROM public.routine_completions
      GROUP BY user_id, routine_id, %I
      HAVING count(*) > 1
    ),
    updated AS (
      UPDATE public.routine_completions rc SET count = dg.merged_count
      FROM duplicate_groups dg WHERE rc.id = dg.keep_id
      RETURNING rc.id
    )
    DELETE FROM public.routine_completions rc
    USING duplicate_groups dg
    WHERE rc.user_id = dg.user_id AND rc.routine_id = dg.routine_id
      AND rc.%I = dg.dk AND rc.id <> dg.keep_id
  ', v_date_col, v_date_col, v_date_col);

  -- 创建唯一索引
  EXECUTE format('
    CREATE UNIQUE INDEX IF NOT EXISTS uq_routine_completions_user_routine_date
    ON public.routine_completions (user_id, routine_id, %I)
  ', v_date_col);
END $$;

-- Rollback notes:
-- drop index if exists public.uq_focus_sessions_user_id;
-- drop index if exists public.uq_routine_completions_user_routine_date;
