import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260615030000_sync_upsert_focus_console_rpcs.sql';
const initScriptPath = 'scripts/init-supabase.sql';

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

function expectSharedSyncRpcContract(sql: string, functionName: string): string {
  const section = normalize(getFunctionSection(sql, functionName));

  expect(section).toContain('SECURITY DEFINER');
  expect(section).toContain('SET search_path = pg_catalog, pg_temp');
  expect(section).toContain('v_user UUID := auth.uid()');
  expect(section).toContain("v_op_id UUID := (payload->>'operation_id')::UUID");
  expect(section).toContain("v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex')");
  expect(section).toContain('PERFORM pg_advisory_xact_lock');
  expect(section).toContain('FROM public.sync_operation_log');
  expect(section).toContain('operation_id owned by other user');
  expect(section).toContain('FROM public.sync_protocol_state WHERE scope =');
  expect(section).toContain("'client-version-rejected'");
  expect(section).toContain('payload_digest, result_payload');

  expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${functionName}(JSONB) FROM PUBLIC, anon;`);
  expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${functionName}(JSONB) TO authenticated;`);

  return section;
}

describe('sync_upsert_focus_console RPC contracts', () => {
  it('adds an idempotent authenticated-only focus session RPC migration', () => {
    const sql = readSql(migrationPath);
    const section = expectSharedSyncRpcContract(sql, 'sync_upsert_focus_session');

    expect(section).toContain("v_record JSONB := COALESCE(payload->'focus_session', '{}'::JSONB)");
    expect(section).toContain("v_session_id UUID := (v_record->>'id')::UUID");
    expect(section).toContain("v_target_user UUID := (v_record->>'user_id')::UUID");
    expect(section).toContain('v_target_user IS DISTINCT FROM v_user');
    expect(section).toContain('INSERT INTO public.focus_sessions AS sessions');
    expect(section).toContain('ON CONFLICT (id) DO UPDATE');
    expect(section).toContain('v_existing_updated');
    expect(section).toContain('v_existing_saved_at');
    expect(section).toContain('stale_payload');
    expect(section).toContain("'focus_session_id', v_session_id");
  });

  it('adds an idempotent authenticated-only routine task RPC migration', () => {
    const sql = readSql(migrationPath);
    const section = expectSharedSyncRpcContract(sql, 'sync_upsert_routine_task');

    expect(section).toContain("v_task JSONB := COALESCE(payload->'routine_task', '{}'::JSONB)");
    expect(section).toContain("v_task_id UUID := (v_task->>'id')::UUID");
    expect(section).toContain("v_target_user UUID := (payload->>'user_id')::UUID");
    expect(section).toContain('v_target_user IS DISTINCT FROM v_user');
    expect(section).toContain('INSERT INTO public.routine_tasks AS tasks');
    expect(section).toContain('ON CONFLICT (id) DO UPDATE');
    expect(section).toContain('v_existing_updated');
    expect(section).toContain('stale_payload');
    expect(section).toContain("'routine_task_id', v_task_id");
  });

  it('adds an idempotent authenticated-only routine completion increment RPC migration', () => {
    const sql = readSql(migrationPath);
    const section = expectSharedSyncRpcContract(sql, 'sync_increment_routine_completion');

    expect(section).toContain("v_completion JSONB := COALESCE(payload->'routine_completion', '{}'::JSONB)");
    expect(section).toContain("v_completion_id UUID := (v_completion->>'id')::UUID");
    expect(section).toContain("v_routine_id UUID := (v_completion->>'routine_id')::UUID");
    expect(section).toContain("v_date_key DATE := NULLIF(v_completion->>'date_key', '')::DATE");
    expect(section).toContain('v_target_user IS DISTINCT FROM v_user');
    expect(section).toContain('INSERT INTO public.routine_completion_events');
    expect(section).toContain('ON CONFLICT (id) DO NOTHING');
    expect(section).toContain("'idempotent-replay'");
    expect(section).toContain('INSERT INTO public.routine_completions');
    expect(section).toContain('ON CONFLICT (user_id, routine_id, date_key) DO UPDATE');
    expect(section).toContain('SET count = public.routine_completions.count + 1');
    expect(section).toContain("'routine_completion_id', v_completion_id");
    expect(section).toContain("'routine-completion'");
  });

  it('keeps fresh bootstrap aligned with focus console sync RPC migrations', () => {
    const sql = readSql(initScriptPath);
    const focusSection = expectSharedSyncRpcContract(sql, 'sync_upsert_focus_session');
    const routineSection = expectSharedSyncRpcContract(sql, 'sync_upsert_routine_task');
    const completionSection = expectSharedSyncRpcContract(sql, 'sync_increment_routine_completion');

    expect(focusSection).toContain('INSERT INTO public.focus_sessions AS sessions');
    expect(focusSection).toContain('ON CONFLICT (id) DO UPDATE');
    expect(focusSection).toContain('stale_payload');

    expect(routineSection).toContain('INSERT INTO public.routine_tasks AS tasks');
    expect(routineSection).toContain('ON CONFLICT (id) DO UPDATE');
    expect(routineSection).toContain('stale_payload');

    expect(completionSection).toContain('INSERT INTO public.routine_completion_events');
    expect(completionSection).toContain('INSERT INTO public.routine_completions');
    expect(completionSection).toContain("'idempotent-replay'");
    expect(completionSection).toContain("'routine_completion_id', v_completion_id");

    expect(sql).toContain('COMMENT ON FUNCTION public.sync_upsert_focus_session(JSONB)');
    expect(sql).toContain('COMMENT ON FUNCTION public.sync_upsert_routine_task(JSONB)');
    expect(sql).toContain('COMMENT ON FUNCTION public.sync_increment_routine_completion(JSONB)');
  });
});
