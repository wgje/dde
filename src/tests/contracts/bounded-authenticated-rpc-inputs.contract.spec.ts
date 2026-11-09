import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716001900_bounded_authenticated_rpc_inputs.sql';
const initPath = 'scripts/init-supabase.sql';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function functionDefinition(sql: string, functionName: string): string {
  const normalized = normalize(sql);
  const signature = `create or replace function public.${functionName}(`;
  const start = normalized.lastIndexOf(signature);
  expect(start, `${functionName} should exist`).toBeGreaterThanOrEqual(0);
  if (start < 0) return '';
  const end = normalized.indexOf('$$;', start);
  expect(end, `${functionName} should terminate`).toBeGreaterThan(start);
  return end > start ? normalized.slice(start, end + 3) : '';
}

function expectBoundedRpcInputs(sql: string): void {
  const normalized = normalize(sql);
  const tombstoneFunction = functionDefinition(sql, 'batch_get_tombstones');
  const taskDeleteFunction = functionDefinition(sql, 'sync_delete_tasks');

  expect(tombstoneFunction).toContain('v_max_project_ids constant integer := 100;');
  expect(tombstoneFunction).toContain(
    'if cardinality(coalesce(p_project_ids, array[]::uuid[])) > v_max_project_ids then',
  );
  expect(tombstoneFunction).toContain(
    "raise exception 'batch_get_tombstones accepts at most % project ids', v_max_project_ids using errcode = '22023';",
  );
  expect(tombstoneFunction).toContain('stable security invoker');

  expect(taskDeleteFunction).toContain('v_max_task_ids constant integer := 100;');
  expect(taskDeleteFunction).toContain(
    "if payload ? 'task_ids' and jsonb_typeof(payload->'task_ids') <> 'array' then",
  );
  expect(taskDeleteFunction).toContain(
    "raise exception 'sync_delete_tasks task_ids must be a json array' using errcode = '22023';",
  );
  expect(taskDeleteFunction).toContain(
    "if jsonb_array_length(coalesce(payload->'task_ids', '[]'::jsonb)) > v_max_task_ids then",
  );
  expect(taskDeleteFunction).toContain(
    "raise exception 'sync_delete_tasks accepts at most % task ids', v_max_task_ids using errcode = '22023';",
  );
  expect(taskDeleteFunction).toContain('security definer');

  expect(normalized).toContain(
    'revoke all on function public.batch_get_tombstones(uuid[]) from public, anon;',
  );
  expect(normalized).toContain(
    'grant execute on function public.batch_get_tombstones(uuid[]) to authenticated;',
  );
  expect(normalized).toContain(
    'revoke all on function public.sync_delete_tasks(jsonb) from public, anon;',
  );
  expect(normalized).toContain(
    'grant execute on function public.sync_delete_tasks(jsonb) to authenticated;',
  );
}

describe('bounded authenticated RPC input contract', () => {
  it('ships a forward migration that bounds tombstone and task-delete arrays', () => {
    const migration = read(migrationPath);
    expectBoundedRpcInputs(migration);
    expect(normalize(migration)).toContain("notify pgrst, 'reload schema';");
  });

  it('keeps fresh-init aligned with the same 100-ID boundary', () => {
    expectBoundedRpcInputs(read(initPath));
  });
});
