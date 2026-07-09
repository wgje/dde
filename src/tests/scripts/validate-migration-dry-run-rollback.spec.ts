import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const scriptPath = path.join(projectRoot, 'scripts', 'validate-migration-dry-run-rollback.cjs');
const tempRoots: string[] = [];

function createMigrationRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-migration-dry-run-'));
  tempRoots.push(root);
  mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true });
  return root;
}

function writeMigration(root: string, filename: string, sql: string): void {
  writeFileSync(path.join(root, 'supabase', 'migrations', filename), sql);
}

function writeManifest(root: string, entries: unknown[]): void {
  writeFileSync(
    path.join(root, 'scripts-migration-dry-run-manifest.json'),
    JSON.stringify({ schemaVersion: 1, entries }, null, 2),
  );
}

function runGuard(root: string) {
  return spawnSync(process.execPath, [
    scriptPath,
    '--root',
    root,
    '--manifest',
    path.join(root, 'scripts-migration-dry-run-manifest.json'),
    '--json',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

describe('migration dry-run rollback guard', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('separates transaction-safe migrations from rollback-risk migrations with manifest evidence', () => {
    const root = createMigrationRoot();
    writeMigration(root, '20260101000000_safe.sql', `
CREATE TABLE IF NOT EXISTS public.example_safe (
  id UUID PRIMARY KEY
);
`);
    writeMigration(root, '20260102000000_concurrent_index.sql', `
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_example_safe_id
  ON public.example_safe (id);
`);
    writeMigration(root, '20260103000000_explicit_transaction.sql', `
BEGIN;
ALTER TABLE public.example_safe ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
COMMIT;
`);
    writeManifest(root, [
      {
        path: 'supabase/migrations/20260102000000_concurrent_index.sql',
        category: 'out-of-transaction',
        reason: 'CREATE INDEX CONCURRENTLY cannot be wrapped by the transaction dry-run.',
        rollbackStrategy: 'Run only against a disposable Supabase branch after exporting data-safety package.',
        requiresDataSafetyExport: true,
      },
      {
        path: 'supabase/migrations/20260103000000_explicit_transaction.sql',
        category: 'explicit-transaction',
        reason: 'The migration owns BEGIN/COMMIT and cannot be nested inside the dry-run wrapper.',
        rollbackStrategy: 'Run isolated dry-run on a cloned database and restore from export on failure.',
        requiresDataSafetyExport: true,
      },
    ]);

    const result = runGuard(root);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.summary).toEqual({
      total: 3,
      transactionSafe: 1,
      outOfTransaction: 1,
      explicitTransaction: 1,
      requiresDataSafetyExport: 2,
    });
    expect(report.rollbackPlan.transactionDryRunFiles).toEqual([
      'supabase/migrations/20260101000000_safe.sql',
    ]);
    expect(report.rollbackPlan.psql).toContain('BEGIN;');
    expect(report.rollbackPlan.psql).toContain('SAVEPOINT nanoflow_migration_dry_run;');
    expect(report.rollbackPlan.psql).toContain('\\i supabase/migrations/20260101000000_safe.sql');
    expect(report.rollbackPlan.psql).toContain('ROLLBACK TO SAVEPOINT nanoflow_migration_dry_run;');
    expect(report.manualReview.map((item: { path: string; category: string }) => `${item.category}:${item.path}`)).toEqual([
      'out-of-transaction:supabase/migrations/20260102000000_concurrent_index.sql',
      'explicit-transaction:supabase/migrations/20260103000000_explicit_transaction.sql',
    ]);
  });

  it('fails when a rollback-risk migration is not declared in the manifest', () => {
    const root = createMigrationRoot();
    writeMigration(root, '20260102000000_concurrent_index.sql', `
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_example_safe_id
  ON public.example_safe (id);
`);
    writeManifest(root, []);

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing migration dry-run manifest entry');
    expect(result.stderr).toContain('20260102000000_concurrent_index.sql');
  });

  it('ignores transaction keywords in SQL comments and string literals', () => {
    const root = createMigrationRoot();
    writeMigration(root, '20260101000000_safe_comments.sql', `
-- CREATE INDEX CONCURRENTLY belongs in documentation, not executable SQL.
CREATE TABLE IF NOT EXISTS public.example_safe_comments (
  id UUID PRIMARY KEY,
  note TEXT DEFAULT 'VACUUM and COMMIT are plain text here'
);
`);
    writeManifest(root, []);

    const result = runGuard(root);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.summary.transactionSafe).toBe(1);
    expect(report.manualReview).toEqual([]);
  });
});
