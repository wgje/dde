import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261114030701_sync_offline_command_field_lww_projection.sql';
const read = () => fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');

describe('offline command field LWW projection migration', () => {
  it('keeps projection separate, capability-gated, owner-scoped, and pullable', () => {
    const sql = read();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.sync_command_projection');
    expect(sql).toContain("@> '[\"field-lww-v1\"]'::jsonb");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_compare_command_version');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_apply_command_projection');
    expect(sql).toContain('trg_sync_command_projection');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_pull_offline_projections()');
    expect(sql).toContain('user_id = (SELECT auth.uid())');
    expect(sql).toContain('field_versions JSONB');
    expect(sql).toContain('tombstone JSONB');
    expect(sql).toContain('current_row.tombstone IS NOT NULL');
  });

  it('does not mutate legacy domain tables', () => {
    const sql = read();
    expect(sql).not.toContain('INSERT INTO public.tasks');
    expect(sql).not.toContain('UPDATE public.tasks');
    expect(sql).not.toContain('INSERT INTO public.projects');
    expect(sql).not.toContain('UPDATE public.projects');
  });
});