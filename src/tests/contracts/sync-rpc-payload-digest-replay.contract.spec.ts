import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const taskMigrationPath = 'supabase/migrations/20260606051000_sync_upsert_task_stale_result.sql';
const userPreferencesMigrationPath = 'supabase/migrations/20260615020000_sync_upsert_user_preferences_rpc.sql';
const focusConsoleMigrationPath = 'supabase/migrations/20260615030000_sync_upsert_focus_console_rpcs.sql';
const replayGuardForwardMigrationPath = 'supabase/migrations/20260628193000_sync_rpc_payload_digest_replay_guard.sql';
const bootstrapPath = 'scripts/init-supabase.sql';

function readSql(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function getFunctionSection(sql: string, functionName: string): string {
  const pattern = new RegExp(
    String.raw`CREATE OR REPLACE FUNCTION public\.${functionName}\(payload JSONB\)[\s\S]*?\n\$\$;`,
  );
  const match = sql.match(pattern);

  expect(match, `function ${functionName} not found`).not.toBeNull();

  return match?.[0] ?? '';
}

function expectPayloadDigestReplayGuard(sql: string, functionName: string): void {
  const section = normalize(getFunctionSection(sql, functionName));

  expect(section).toContain('v_payload_digest TEXT := encode(extensions.digest(payload::TEXT,');
  expect(section).toContain("set_config('app.payload_digest', v_payload_digest, true)");
  expect(section).toContain('SELECT user_id, payload_digest, result_payload, status, reject_reason');
  expect(section).toMatch(
    /IF FOUND THEN[\s\S]*?v_log_existing\.payload_digest IS NOT NULL[\s\S]*?v_log_existing\.payload_digest IS DISTINCT FROM v_payload_digest[\s\S]*?'operation_id_payload_mismatch'[\s\S]*?RETURN COALESCE/,
  );
}

describe('sync RPC payload digest replay guard contract', () => {
  it('latest task upsert rejects operationId replay with a different payload digest', () => {
    expectPayloadDigestReplayGuard(readSql(taskMigrationPath), 'sync_upsert_task');
  });

  it('user preference upsert rejects operationId replay with a different payload digest', () => {
    expectPayloadDigestReplayGuard(readSql(userPreferencesMigrationPath), 'sync_upsert_user_preferences');
  });

  it('focus console RPCs reject operationId replay with a different payload digest', () => {
    const sql = readSql(focusConsoleMigrationPath);

    for (const functionName of [
      'sync_upsert_focus_session',
      'sync_upsert_routine_task',
      'sync_increment_routine_completion',
    ]) {
      expectPayloadDigestReplayGuard(sql, functionName);
    }
  });

  it('fresh bootstrap keeps payload digest replay guards aligned with sync RPC migrations', () => {
    const sql = readSql(bootstrapPath);

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
      'sync_upsert_user_preferences',
      'sync_upsert_focus_session',
      'sync_upsert_routine_task',
      'sync_increment_routine_completion',
      'sync_delete_project',
      'sync_delete_tasks',
    ]) {
      expectPayloadDigestReplayGuard(sql, functionName);
    }
  });

  it('fresh bootstrap fills operation log payload digests from the active RPC transaction', () => {
    const sql = normalize(readSql(bootstrapPath));

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_operation_log_fill_payload_digest()');
    expect(sql).toContain("NULLIF(current_setting('app.payload_digest', true), '')");
    expect(sql).toContain('NEW.payload_digest := v_payload_digest');
    expect(sql).toContain('CREATE TRIGGER sync_operation_log_fill_payload_digest');
  });

  it('forward migration protects already deployed sync RPCs with digest-aware wrappers', () => {
    const rawSql = readSql(replayGuardForwardMigrationPath);
    const sql = normalize(rawSql);

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_operation_log_fill_payload_digest()');
    expect(sql).toContain('CREATE TRIGGER sync_operation_log_fill_payload_digest');

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
      'sync_upsert_user_preferences',
      'sync_upsert_focus_session',
      'sync_upsert_routine_task',
      'sync_increment_routine_completion',
      'sync_delete_project',
      'sync_delete_tasks',
    ]) {
      expectPayloadDigestReplayGuard(rawSql, functionName);
      expect(sql).toContain(`ALTER FUNCTION public.${functionName}(JSONB) RENAME TO ${functionName}__unguarded_20260628`);
      expect(sql).toContain(`public.${functionName}__unguarded_20260628(payload)`);
    }
  });
});
