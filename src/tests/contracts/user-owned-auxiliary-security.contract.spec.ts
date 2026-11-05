import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ownershipMigrationPath =
  'supabase/migrations/20260714041000_user_owned_auxiliary_rows_hardening.sql';
const policyMigrationPath =
  'supabase/migrations/20260715017200_black_box_rls_initplan_optimization.sql';
const initPath = 'scripts/init-supabase.sql';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function policyBlock(sql: string, policyName: string): string {
  const normalized = normalize(sql);
  const start = normalized.indexOf(`create policy "${policyName}"`);
  expect(start, `${policyName} should exist`).toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf(';', start);
  expect(end, `${policyName} should terminate`).toBeGreaterThan(start);
  return normalized.slice(start, end + 1);
}

function mismatchGuard(sql: string): string {
  const normalized = normalize(sql);
  const start = normalized.indexOf('do $black_box_project_owner$');
  expect(start, 'black-box project owner mismatch guard should exist').toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf('$black_box_project_owner$;', start + 3);
  expect(end, 'black-box project owner mismatch guard should terminate').toBeGreaterThan(start);
  return normalized.slice(start, end + '$black_box_project_owner$;'.length);
}

const ownershipPredicate =
  '(select public.current_user_id()) = user_id and ( project_id is null or project_id in (select public.user_accessible_project_ids()) )';

describe('user-owned auxiliary row security contract', () => {
  it('fails closed on black-box project owner mismatches before replacing policies', () => {
    for (const relativePath of [ownershipMigrationPath, initPath]) {
      const sql = normalize(read(relativePath));
      const guard = mismatchGuard(sql);

      expect(guard).toContain('from public.black_box_entries entries');
      expect(guard).toContain('join public.projects projects on projects.id = entries.project_id');
      expect(guard).toContain('entries.project_id is not null');
      expect(guard).toContain('entries.user_id is distinct from projects.owner_id');
      expect(guard).toContain('raise exception');
      expect(guard).toContain('black_box_entries contains project/user owner mismatches');
      expect(guard).not.toContain('update public.black_box_entries');
      expect(guard).not.toContain('delete from public.black_box_entries');
      expect(sql.indexOf('do $black_box_project_owner$')).toBeLessThan(
        sql.indexOf('drop policy if exists "black_box_select_policy"'),
      );
    }
  });

  it('applies owner and referenced-project checks to all authenticated CRUD policies', () => {
    for (const relativePath of [policyMigrationPath, initPath]) {
      const sql = read(relativePath);
      const normalized = normalize(sql);
      const selectPolicy = policyBlock(sql, 'black_box_select_policy');
      const insertPolicy = policyBlock(sql, 'black_box_insert_policy');
      const updatePolicy = policyBlock(sql, 'black_box_update_policy');
      const deletePolicy = policyBlock(sql, 'black_box_delete_policy');

      expect(selectPolicy).toContain('for select to authenticated using');
      expect(selectPolicy).toContain(ownershipPredicate);
      expect(insertPolicy).toContain('for insert to authenticated with check');
      expect(insertPolicy).toContain(ownershipPredicate);
      expect(updatePolicy).toContain('for update to authenticated using');
      expect(updatePolicy).toContain(ownershipPredicate);
      expect(updatePolicy).toContain(`with check ( ${ownershipPredicate} )`);
      expect(deletePolicy).toContain('for delete to authenticated using');
      expect(deletePolicy).toContain(ownershipPredicate);
      expect(normalized).toContain(
        'drop policy if exists "black_box_select_optimized" on public.black_box_entries;',
      );
    }
  });

  it('keeps migration and fresh-init policies identical', () => {
    const migration = read(policyMigrationPath);
    const init = read(initPath);

    for (const policyName of [
      'black_box_select_policy',
      'black_box_insert_policy',
      'black_box_update_policy',
      'black_box_delete_policy',
    ]) {
      expect(policyBlock(init, policyName)).toBe(policyBlock(migration, policyName));
    }
  });

  it('revokes broad client grants and restores only authenticated CRUD plus service-role control', () => {
    for (const relativePath of [ownershipMigrationPath, policyMigrationPath, initPath]) {
      const sql = normalize(read(relativePath));

      expect(sql).toContain(
        'revoke all on table public.black_box_entries from anon, authenticated;',
      );
      expect(sql).toContain(
        'grant select, insert, update, delete on table public.black_box_entries to authenticated;',
      );
      expect(sql).toContain(
        'grant all on table public.black_box_entries to service_role;',
      );
      expect(sql).not.toContain(
        'grant all on table public.black_box_entries to authenticated;',
      );
    }
  });
});
