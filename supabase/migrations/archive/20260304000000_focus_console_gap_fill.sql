-- Focus Console v3.3 gap fill
-- 1) black_box_entries.project_id must support shared bucket (NULL)
-- 2) add index for shared-bucket incremental sync path

alter table public.black_box_entries
  alter column project_id drop not null;

create index if not exists idx_black_box_entries_user_shared_updated
  on public.black_box_entries (user_id, updated_at desc)
  where project_id is null and deleted_at is null;

comment on column public.black_box_entries.project_id is
  '所属项目 ID；NULL 表示共享黑匣子仓（跨项目可见）';

