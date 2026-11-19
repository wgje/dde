import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261114030454_sync_offline_command_ingest_pull.sql';
const read = () => fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');

describe('offline command ingest/pull migration', () => {
  it('is additive, capability-gated, idempotent, owner-scoped, and shadow-only', () => {
    const sql = read();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.sync_command_log');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_apply_offline_command(payload JSONB)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_pull_offline_commands(');
    expect(sql).toContain("@> '[\"command-envelope-v1\"]'::jsonb");
    expect(sql).toContain("'command-capability-disabled'");
    expect(sql).toContain('record_sync_write_quarantine');
    expect(sql).toContain("'idempotent-replay'");
    expect(sql).toContain('appliedToDomainTables');
    expect(sql).toContain('projectionApplied');
    expect(sql).toContain('false');
    expect(sql).toContain('c.user_id = (SELECT auth.uid())');
    expect(sql).toContain('c.logical_clock_physical_ms');
    expect(sql).toContain('c.logical_clock_logical');
    expect(sql).toContain('c.device_id');
    expect(sql).toContain('c.operation_id');
    expect(sql).toContain('IS DISTINCT FROM');
    expect(sql).toContain('invalid-logical-clock');
    expect(sql).toContain('field_versions JSONB');
    expect(sql).toContain('normalized_result_patch JSONB');
  });

  it('limits the initial command entity surface and rejects mismatched command prefixes', () => {
    const sql = read();
    expect(sql).toContain("entity_type IN ('task', 'project', 'connection', 'black_box_entry', 'preference', 'focus_session', 'routine_task', 'routine_completion')");
    expect(sql).toContain("split_part(v_command, '.', 1) NOT IN ('task', 'project', 'connection', 'black_box_entry', 'preference', 'focus_session', 'routine_task', 'routine_completion')");
    expect(sql).toContain("'unsupported-command-entity'");
  });
});