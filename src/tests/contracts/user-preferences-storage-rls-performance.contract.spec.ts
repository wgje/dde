import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715017400_user_preferences_storage_rls_initplan.sql';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function policyBlock(sql: string, policyName: string): string {
  const normalized = normalize(sql);
  const start = normalized.lastIndexOf(`create policy "${policyName.toLowerCase()}"`);
  expect(start, `${policyName} should exist`).toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf(';', start);
  expect(end, `${policyName} should terminate`).toBeGreaterThan(start);
  return normalized.slice(start, end + 1);
}

function expectUserPreferencePolicies(sql: string): void {
  const ownerCheck = '(select auth.uid()) = user_id';
  const selectPolicy = policyBlock(sql, 'Users can view own preferences');
  const insertPolicy = policyBlock(sql, 'Users can insert own preferences');
  const updatePolicy = policyBlock(sql, 'Users can update own preferences');
  const deletePolicy = policyBlock(sql, 'Users can delete own preferences');

  expect(selectPolicy).toContain('for select to authenticated using');
  expect(selectPolicy).toContain(ownerCheck);
  expect(insertPolicy).toContain('for insert to authenticated with check');
  expect(insertPolicy).toContain(ownerCheck);
  expect(updatePolicy).toContain('for update to authenticated using');
  expect(updatePolicy).toContain(ownerCheck);
  expect(updatePolicy).toContain(`with check (${ownerCheck})`);
  expect(deletePolicy).toContain('for delete to authenticated using');
  expect(deletePolicy).toContain(ownerCheck);
}

function expectAttachmentPolicies(sql: string): void {
  const ownerCheck =
    "bucket_id = 'attachments' and (storage.foldername(name))[1] = (select auth.uid())::text";
  const uploadPolicy = policyBlock(sql, 'Users can upload own attachments');
  const viewPolicy = policyBlock(sql, 'Users can view own attachments');
  const deletePolicy = policyBlock(sql, 'Users can delete own attachments');
  const updatePolicy = policyBlock(sql, 'Users can update own attachments');

  expect(uploadPolicy).toContain('for insert to authenticated with check');
  expect(uploadPolicy).toContain(ownerCheck);
  expect(viewPolicy).toContain('for select to authenticated using');
  expect(viewPolicy).toContain(ownerCheck);
  expect(deletePolicy).toContain('for delete to authenticated using');
  expect(deletePolicy).toContain(ownerCheck);
  expect(updatePolicy).toContain('for update to authenticated using');
  expect(updatePolicy).toContain(ownerCheck);
  expect(updatePolicy).toContain(`with check (${ownerCheck})`);
}

describe('user preferences and attachment RLS performance contract', () => {
  it('uses initPlan-cached owner checks in fresh initialization', () => {
    const initSql = read(initPath);

    expectUserPreferencePolicies(initSql);
    expectAttachmentPolicies(initSql);
  });

  it('repairs existing policies with a transaction-safe forward migration', () => {
    const migration = read(migrationPath);

    expectUserPreferencePolicies(migration);
    expectAttachmentPolicies(migration);
    expect(normalize(migration)).not.toContain('begin;');
    expect(normalize(migration)).not.toContain('commit;');
  });

  it('keeps fresh initialization aligned with the final forward policies', () => {
    const initSql = read(initPath);
    const migration = read(migrationPath);

    for (const policyName of [
      'Users can view own preferences',
      'Users can insert own preferences',
      'Users can update own preferences',
      'Users can delete own preferences',
      'Users can upload own attachments',
      'Users can view own attachments',
      'Users can delete own attachments',
      'Users can update own attachments',
    ]) {
      expect(policyBlock(initSql, policyName)).toBe(policyBlock(migration, policyName));
    }
  });

  it('removes the duplicate attachment read policy and narrows preference grants', () => {
    for (const relativePath of [initPath, migrationPath]) {
      const sql = normalize(read(relativePath));

      expect(sql).toContain(
        'drop policy if exists "project members can view attachments" on storage.objects;',
      );
      expect(sql).not.toContain(
        'create policy "project members can view attachments" on storage.objects',
      );
      expect(sql).toContain(
        'revoke all on table public.user_preferences from anon, authenticated;',
      );
      expect(sql).toContain(
        'grant select, insert, update, delete on table public.user_preferences to authenticated;',
      );
      expect(sql).toContain(
        'grant all on table public.user_preferences to service_role;',
      );
      expect(sql).not.toContain(
        'grant all on table public.user_preferences to authenticated;',
      );
    }
  });
});
