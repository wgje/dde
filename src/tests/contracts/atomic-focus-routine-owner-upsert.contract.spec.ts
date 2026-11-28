import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261128090000_atomic_focus_routine_owner_upsert.sql';
const initPath = 'scripts/init-supabase.sql';

function readMigration(): string {
  return fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');
}

function readInit(): string {
  return fs.readFileSync(path.join(process.cwd(), initPath), 'utf8');
}

describe('atomic focus and routine owner-upsert migration contract', () => {
  it('requires the reviewed live function body hashes before rewriting either function', () => {
    const sql = readMigration();

    expect(sql).toContain("('sync_upsert_focus_session', 'e23feb0b6836d4ffdd25f068cef07e2d')");
    expect(sql).toContain("('sync_upsert_routine_task', 'b6f81140b419a5a02b81103995a82341')");
    expect(sql).toMatch(/IF v_oid IS NULL OR md5\(v_body\) <> v_expected_md5 THEN/);
    expect(sql.indexOf('IF v_oid IS NULL OR md5(v_body) <> v_expected_md5 THEN'))
      .toBeLessThan(sql.indexOf('EXECUTE v_patched_definition;'));
  });

  it.each([
    {
      functionName: 'sync_upsert_focus_session',
      predicate: 'WHERE sessions.user_id = v_user',
      rejection: 'focus_session_owned_by_other_user',
    },
    {
      functionName: 'sync_upsert_routine_task',
      predicate: 'WHERE tasks.user_id = v_user',
      rejection: 'routine_task_owned_by_other_user',
    },
  ])('guards $functionName conflicts and rejects an unreturned row', ({ predicate, rejection }) => {
    const sql = readMigration();

    expect(sql).toContain(predicate);
    expect(sql).toContain(rejection);
    expect(sql).toContain('IF NOT FOUND THEN');
    expect(sql).toContain('INSERT INTO public.sync_operation_log');
    expect(sql).toContain('RETURN v_result;');
  });

  it('requires exactly one recognized conflict clause and one returning clause per function', () => {
    const sql = readMigration();

    expect(sql.match(/expected one conflict update in public\.%/g)).toHaveLength(1);
    expect(sql.match(/expected one RETURNING clause in public\.%/g)).toHaveLength(1);
    expect(sql).toContain('v_replacements := regexp_count(v_body, v_pattern, 1, \'i\');');
    expect(sql).toContain('v_replacements := regexp_count(v_patched_body, v_pattern, 1, \'i\');');
    expect(sql).toContain('postcondition failed for public.%');
  });

  it('keeps fresh-init conflict clauses aligned with the forward repair', () => {
    const sql = readInit();

    expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(sql).toContain('WHERE sessions.user_id = v_user');
    expect(sql).toContain('WHERE tasks.user_id = v_user');
    expect(sql).toContain('focus_session_owned_by_other_user');
    expect(sql).toContain('routine_task_owned_by_other_user');
  });

  it('does not repair auth rows or mutate unrelated business tables', () => {
    const sql = readMigration();

    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO\s+|TABLE\s+)?auth\.users\b/i);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO\s+|TABLE\s+)?public\.(?!sync_operation_log\b)[a-z_]+/i);
  });
});