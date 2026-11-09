import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715018100_default_function_execute_privileges.sql';
const convergenceMigrationPath =
  'supabase/migrations/20260716000900_function_execute_privilege_convergence.sql';
const expectedStatement =
  'alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated, service_role;';
const authenticatedHelperSignatures = [
  'public.current_user_id()',
  'public.user_is_project_owner(uuid)',
  'public.user_has_project_access(uuid)',
  'public.user_accessible_project_ids()',
];
const internalFunctionSignatures = [
  'public.update_updated_at_column()',
  'public.trigger_set_updated_at()',
  'public.user_preferences_keep_latest_backup_proof()',
  'public.prevent_tombstoned_connection_writes()',
  'public.record_connection_tombstone()',
  'public.prevent_tombstoned_task_writes()',
  'public.check_version_increment()',
  'public.validate_task_data()',
  'public.update_attachment_scans_timestamp()',
  'public.prevent_soft_deleted_row_resurrection()',
  'public.cleanup_cron_job_run_details(interval)',
];

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('default function execute privilege contract', () => {
  it('adds a transaction-safe default-deny forward migration for future functions', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain(expectedStatement);
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
    expect(migration).not.toContain('revoke execute on all functions in schema public');
  });

  it('places the default-deny rule at the end of fresh initialization', () => {
    const init = normalize(read(initPath));
    const marker = init.lastIndexOf(
      '-- final convergence: 20260715018100 default function execute privileges',
    );

    expect(marker).toBeGreaterThanOrEqual(0);
    expect(init.lastIndexOf(expectedStatement)).toBeGreaterThan(marker);
  });

  it('converges existing helper and trigger function privileges to least privilege', () => {
    const migration = normalize(read(convergenceMigrationPath));

    for (const signature of [...authenticatedHelperSignatures, ...internalFunctionSignatures]) {
      expect(migration).toContain(`'${signature}'`);
    }
    expect(migration).toContain(
      "execute format('revoke all on function %s from public, anon, authenticated, service_role', function_signature)",
    );
    expect(migration).toContain(
      "execute format('grant execute on function %s to authenticated, service_role', function_signature)",
    );
    expect(migration).toContain(
      "execute format('grant execute on function %s to service_role', function_signature)",
    );
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('keeps fresh initialization aligned with function privilege convergence', () => {
    const init = normalize(read(initPath));
    const marker = init.lastIndexOf(
      '-- final convergence: 20260716000900 function execute privilege convergence',
    );

    expect(marker).toBeGreaterThanOrEqual(0);
    const convergence = init.slice(marker);
    for (const signature of [...authenticatedHelperSignatures, ...internalFunctionSignatures]) {
      expect(convergence).toContain(`'${signature}'`);
    }
    expect(convergence).toContain(
      "execute format('revoke all on function %s from public, anon, authenticated, service_role', function_signature)",
    );
  });
});
