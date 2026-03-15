-- Focus Console inline creation metadata
-- Add optional JSONB field used by DockEngine.createInDock / inline archive flow.

alter table public.black_box_entries
  add column if not exists focus_meta jsonb null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'black_box_entries_focus_meta_source_check'
      and conrelid = 'public.black_box_entries'::regclass
  ) then
    alter table public.black_box_entries
      add constraint black_box_entries_focus_meta_source_check
      check (
        focus_meta is null
        or not (focus_meta ? 'source')
        or focus_meta->>'source' = 'focus-console-inline'
      );
  end if;
end $$;
