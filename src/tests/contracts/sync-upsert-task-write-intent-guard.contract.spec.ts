import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migrationPath = path.join(
  root,
  'supabase',
  'migrations',
  '20260727000000_sync_upsert_task_write_intent_guard.sql',
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const bootstrap = readFileSync(path.join(root, 'scripts', 'init-supabase.sql'), 'utf8');
const taskFunctionMarker = 'CREATE OR REPLACE FUNCTION public.sync_upsert_task(payload JSONB)';

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function getLastTaskFunctionSection(sql: string): string {
  const start = sql.lastIndexOf(taskFunctionMarker);
  expect(start, 'sync_upsert_task final definition missing').toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n$$;', start);
  expect(end, 'sync_upsert_task final definition is not terminated').toBeGreaterThan(start);
  return normalize(sql.slice(start, end + 4));
}

describe('sync_upsert_task write-intent guard contract', () => {
  it('ships a forward migration without owning an outer transaction', () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/mi);
    expect(migration).toContain('Rollback: reapply the sync_upsert_task wrapper and batch_upsert_tasks grants from 20260726000000');
  });

  it('keeps the deployed and fresh-init wrapper definitions identical', () => {
    expect(getLastTaskFunctionSection(bootstrap)).toBe(getLastTaskFunctionSection(migration));
  });

  it('fails closed before delegating an existing-row task upsert without write intent', () => {
    for (const sql of [migration, bootstrap]) {
      const section = getLastTaskFunctionSection(sql);
      const replayIndex = section.indexOf('v_replay_result := public.sync_resolve_operation_replay');
      const changedFieldsIndex = section.indexOf('v_changed_fields := public.sync_task_changed_fields');
      const guardIndex = section.indexOf('IF v_user IS NOT NULL AND v_op_id IS NOT NULL AND v_task_id IS NOT NULL AND v_project_id IS NOT NULL AND v_changed_fields IS NOT NULL AND v_write_intent IS NULL THEN');
      const delegateIndex = section.indexOf('v_result := public.sync_upsert_task__unguarded_20260628(payload)');

      expect(section).toContain("v_write_intent TEXT := COALESCE(NULLIF(v_task->>'write_intent', ''), NULLIF(v_task->>'writeIntent', ''))");
      expect(replayIndex).toBeGreaterThanOrEqual(0);
      expect(changedFieldsIndex).toBeGreaterThan(replayIndex);
      expect(guardIndex).toBeGreaterThan(changedFieldsIndex);
      expect(delegateIndex).toBeGreaterThan(guardIndex);
      expect(section).toContain("'status', 'quarantined'");
      expect(section).toContain("'decision', 'quarantined'");
      expect(section).toContain("'reason', 'task_write_intent_required'");
      expect(section).toContain("'changed_fields', v_changed_fields");
      expect(section).toContain("'audit_id', NULL");
      expect(section).not.toContain("v_write_intent TEXT := 'task_full_upsert'");
    }
  });

  it('persists the rejection result for deterministic operation-id replay', () => {
    for (const sql of [migration, bootstrap]) {
      const section = getLastTaskFunctionSection(sql);
      const guardIndex = section.indexOf("'reason', 'task_write_intent_required'");
      const logIndex = section.indexOf('INSERT INTO public.sync_operation_log', guardIndex);
      const returnIndex = section.indexOf('RETURN v_result', guardIndex);

      expect(logIndex).toBeGreaterThan(guardIndex);
      expect(returnIndex).toBeGreaterThan(logIndex);
      expect(section).toContain('payload_digest, replay_payload_digest, result_payload');
      expect(section).toContain("'task', v_task_id, 'quarantined', 'task_write_intent_required'");
      expect(section).toContain('v_payload_digest, v_replay_payload_digest, v_result');
    }
  });

  it('allows first inserts to reach the existing validated write path', () => {
    for (const sql of [migration, bootstrap]) {
      const section = getLastTaskFunctionSection(sql);
      expect(section).toContain('v_changed_fields IS NOT NULL AND v_write_intent IS NULL');
      expect(section).toContain('v_result := public.sync_upsert_task__unguarded_20260628(payload)');
    }
  });

  it('removes every Data API bypass through batch_upsert_tasks', () => {
    const revoke = 'REVOKE ALL ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) FROM PUBLIC, anon, authenticated, service_role;';
    const serviceRoleGrant = 'GRANT EXECUTE ON FUNCTION public.batch_upsert_tasks(jsonb[], uuid) TO service_role;';

    for (const sql of [migration, bootstrap]) {
      const finalGuard = normalize(sql.slice(sql.lastIndexOf(taskFunctionMarker)));
      expect(finalGuard).toContain(normalize(revoke));
      expect(finalGuard).not.toContain(normalize(serviceRoleGrant));
    }
  });

  it('keeps the public wrapper authenticated-only with a locked search_path', () => {
    for (const sql of [migration, bootstrap]) {
      const section = getLastTaskFunctionSection(sql);
      expect(section).toContain('SECURITY DEFINER');
      expect(section).toContain('SET search_path = pg_catalog, public, extensions, pg_temp');
    }
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.sync_upsert_task(JSONB) FROM PUBLIC, anon;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.sync_upsert_task(JSONB) TO authenticated;');
  });
});
