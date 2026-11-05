import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migrationPath = path.join(
  root,
  'supabase',
  'migrations',
  '20260715017000_sync_upsert_task_explainability.sql',
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const bootstrap = readFileSync(path.join(root, 'scripts', 'init-supabase.sql'), 'utf8');

const explainableTaskFields = [
  'project_id',
  'parent_id',
  'title',
  'content',
  'stage',
  'order',
  'rank',
  'status',
  'x',
  'y',
  'short_id',
  'priority',
  'due_date',
  'expected_minutes',
  'cognitive_load',
  'wait_minutes',
  'tags',
  'attachments',
  'deleted_at',
  'completed_at',
  'parking_meta',
  'attention_meta',
] as const;

describe('sync_upsert_task explainability contract', () => {
  it('ships an additive migration for deployed databases', () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it('records every persisted task field in changed_fields', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.sync_task_changed_fields');
    expect(bootstrap).toContain('CREATE OR REPLACE FUNCTION public.sync_task_changed_fields');

    for (const field of explainableTaskFields) {
      const appendStatement = `jsonb_build_array('${field}')`;
      expect(migration, `migration missing ${field}`).toContain(appendStatement);
      expect(bootstrap, `bootstrap missing ${field}`).toContain(appendStatement);
    }
  });

  it('preserves replay digest protection and persists the enriched RPC result', () => {
    expect(migration).toContain('operation_id_payload_mismatch');
    expect(migration).toContain('public.sync_upsert_task__unguarded_20260628(payload)');
    expect(migration).toMatch(/UPDATE\s+public\.sync_operation_log[\s\S]*result_payload\s*=\s*v_result/i);
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public, extensions, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.sync_task_changed_fields(UUID, JSONB) FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated');
  });

  it('uses the comprehensive helper for fresh bootstrap writes', () => {
    expect(bootstrap).toContain('v_changed_fields := public.sync_task_changed_fields(v_task_id, v_task);');
    expect(bootstrap).toContain("v_changed_fields := jsonb_build_array('insert');");
  });
});
