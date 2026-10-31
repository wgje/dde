import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const scriptPath = path.join(projectRoot, 'scripts', 'validate-migration-dry-run-rollback.cjs');
const tempRoots: string[] = [];
const { isPathContained, pathIdentityKey } = createRequire(import.meta.url)(scriptPath) as {
  isPathContained?: (pathApi: typeof path.win32, root: string, candidate: string) => boolean;
  pathIdentityKey?: (pathApi: typeof path.posix, filePath: string) => string;
};

function createMigrationRoot(withMigrationDirectory = true): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-migration-dry-run-'));
  tempRoots.push(root);
  if (withMigrationDirectory) mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true });
  return root;
}

function writeMigration(root: string, filename: string, sql: string): void {
  writeFileSync(path.join(root, 'supabase', 'migrations', filename), sql);
}

function writeManifest(root: string, entries: unknown[], manifestPath = path.join(root, 'scripts-migration-dry-run-manifest.json')): void {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, entries }, null, 2));
}

function manifestEntry(entryPath: string, category = 'out-of-transaction') {
  return {
    path: entryPath,
    category,
    reason: 'Requires isolated rollback evidence.',
    rollbackStrategy: 'Restore the disposable database from export.',
    requiresDataSafetyExport: true,
  };
}

function runGuard(root: string, manifestPath: string | null = path.join(root, 'scripts-migration-dry-run-manifest.json'), json = true) {
  const args = [scriptPath, '--root', root];
  if (manifestPath) args.push('--manifest', manifestPath);
  if (json) args.push('--json');
  return spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

function makeDanglingDirectoryLink(root: string, linkPath: string): void {
  const target = path.join(root, `missing-${path.basename(linkPath)}`);
  mkdirSync(target, { recursive: true });
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, 'junction');
  rmSync(target, { recursive: true, force: true });
}

describe('migration dry-run rollback guard', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['drive child', 'C:\\repo\\supabase\\migrations', 'C:\\repo\\supabase\\migrations\\one.sql', true],
    ['different drive', 'C:\\repo\\supabase\\migrations', 'D:\\repo\\supabase\\migrations\\one.sql', false],
    ['UNC child', '\\\\server\\share\\migrations', '\\\\server\\share\\migrations\\one.sql', true],
    ['UNC share escape', '\\\\server\\share\\migrations', '\\\\server\\other\\migrations\\one.sql', false],
    ['traversal', 'C:\\repo\\supabase\\migrations', 'C:\\repo\\supabase\\migrations\\..\\escape.sql', false],
    ['prefix sibling', 'C:\\repo\\supabase\\migrations', 'C:\\repo\\supabase\\migrations-copy\\one.sql', false],
    ['mixed separators', 'C:\\repo\\supabase/migrations', 'C:/repo\\supabase/migrations\\one.sql', true],
    ['case-insensitive child', 'C:\\Repo\\Supabase\\Migrations', 'c:\\repo\\supabase\\migrations\\ONE.sql', true],
  ])('uses Windows path semantics for %s containment', (_case, root, candidate, expected) => {
    expect(typeof isPathContained).toBe('function');
    if (!isPathContained) return;
    expect(isPathContained(path.win32, root, candidate)).toBe(expected);
  });

  it('keeps POSIX identities case-sensitive while folding Windows aliases', () => {
    expect(typeof pathIdentityKey).toBe('function');
    if (!pathIdentityKey) return;
    expect(pathIdentityKey(path.posix, 'supabase/migrations/Foo.sql')).not.toBe(
      pathIdentityKey(path.posix, 'supabase/migrations/foo.sql'),
    );
    expect(pathIdentityKey(path.win32, 'supabase\\migrations\\Foo.sql')).toBe(
      pathIdentityKey(path.win32, 'supabase\\migrations\\foo.sql'),
    );
  });

  it.each([
    ['missing', 'valid', false, 'migration-evidence-migrations-path-unavailable'], ['file', 'valid', false, 'migration-evidence-migrations-path-not-directory'],
    ['dangling', 'valid', false, 'migration-evidence-migrations-path-unavailable'], ['empty', 'valid', false, 'migration-evidence-migration-set-empty'],
    ['ready', 'missing', false, 'migration-evidence-manifest-path-unavailable'], ['ready', 'directory', false, 'migration-evidence-manifest-path-not-file'],
    ['ready', 'dangling', false, 'migration-evidence-manifest-path-unavailable'], ['ready', 'missing', true, 'migration-evidence-manifest-path-unavailable'],
    ['ready', 'directory', true, 'migration-evidence-manifest-path-not-file'], ['ready', 'dangling', true, 'migration-evidence-manifest-path-unavailable'],
  ] as const)('fails closed for %s migrations and %s manifest (default=%s)', (migrationState, manifestState, useDefault, reason) => {
    const root = createMigrationRoot(migrationState === 'empty' || migrationState === 'ready');
    const migrationPath = path.join(root, 'supabase', 'migrations');
    if (migrationState === 'file') {
      mkdirSync(path.dirname(migrationPath), { recursive: true });
      writeFileSync(migrationPath, 'not a directory');
    } else if (migrationState === 'dangling') {
      makeDanglingDirectoryLink(root, migrationPath);
    } else if (migrationState === 'ready') {
      writeMigration(root, '20260101000000_safe.sql', 'SELECT 1;');
    }
    const manifestPath = useDefault
      ? path.join(root, 'scripts', 'migration-dry-run-manifest.json')
      : path.join(root, 'scripts-migration-dry-run-manifest.json');
    if (manifestState === 'valid') writeManifest(root, [], manifestPath);
    if (manifestState === 'directory') mkdirSync(manifestPath, { recursive: true });
    if (manifestState === 'dangling') makeDanglingDirectoryLink(root, manifestPath);

    const result = runGuard(root, useDefault ? null : manifestPath);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(`[migration-dry-run] ${reason}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain('[migration-dry-run] checked');
  });

  it('accepts valid linked evidence and excludes symlinked migration entries where supported', () => {
    const root = createMigrationRoot(false);
    const actualMigrations = path.join(root, 'supabase', 'actual-migrations');
    mkdirSync(actualMigrations, { recursive: true });
    writeFileSync(path.join(actualMigrations, '20260101000000_safe.sql'), 'SELECT 1;');
    writeFileSync(path.join(root, 'linked-target.sql'), 'SELECT 2;');
    try {
      symlinkSync(path.join(root, 'linked-target.sql'), path.join(actualMigrations, 'linked.sql'), 'file');
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    symlinkSync(actualMigrations, path.join(root, 'supabase', 'migrations'), 'junction');
    writeManifest(root, []);
    let result = runGuard(root);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).summary.total).toBe(1);
    const manifestPath = path.join(root, 'scripts-migration-dry-run-manifest.json');
    const manifestTarget = path.join(root, 'manifest-target.json');
    writeManifest(root, [], manifestTarget);
    rmSync(manifestPath);
    try {
      symlinkSync(manifestTarget, manifestPath, 'file');
    } catch (error) {
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    expect(runGuard(root).status).toBe(0);
  });

  it('rejects a migration-directory junction that canonically escapes the root', () => {
    const root = createMigrationRoot(false);
    const outside = mkdtempSync(path.join(tmpdir(), 'nanoflow-migration-escape-'));
    tempRoots.push(outside);
    writeFileSync(path.join(outside, '20260101000000_safe.sql'), 'SELECT 1;');
    mkdirSync(path.join(root, 'supabase'), { recursive: true });
    symlinkSync(outside, path.join(root, 'supabase', 'migrations'), 'junction');
    writeManifest(root, []);

    const result = runGuard(root);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      '[migration-dry-run] migration-evidence-migrations-path-canonical-escape',
    );
  });

  it.skipIf(process.platform !== 'win32')('rejects raw, canonical-alias, and case-only manifest duplicates once each', () => {
    expect(process.platform).toBe('win32');
    const root = createMigrationRoot();
    const migration = 'supabase/migrations/20260102000000_concurrent.sql';
    writeMigration(root, path.basename(migration), 'CREATE INDEX CONCURRENTLY idx ON public.example (id);');
    writeManifest(root, [
      manifestEntry(migration),
      manifestEntry(migration),
      manifestEntry('supabase/migrations/./20260102000000_concurrent.sql'),
      manifestEntry('SUPABASE/MIGRATIONS/20260102000000_CONCURRENT.SQL'),
    ]);

    const lines = runGuard(root).stderr.trim().split(/\r?\n/);
    expect(lines).toEqual([
      `[migration-dry-run] ${migration}: duplicate migration dry-run manifest entry`,
      '[migration-dry-run] supabase/migrations/./20260102000000_concurrent.sql: duplicate migration dry-run manifest entry',
      '[migration-dry-run] SUPABASE/MIGRATIONS/20260102000000_CONCURRENT.SQL: duplicate migration dry-run manifest entry',
    ]);
  });

  it.skipIf(process.platform === 'win32')('requires distinct evidence for POSIX case-distinct migration paths', () => {
    expect(process.platform).not.toBe('win32');
    const root = createMigrationRoot();
    const upper = 'supabase/migrations/20260102000000_Case.sql';
    const lower = 'supabase/migrations/20260102000000_case.sql';
    writeMigration(root, path.basename(upper), 'CREATE INDEX CONCURRENTLY upper_idx ON public.example (id);');
    writeMigration(root, path.basename(lower), 'CREATE INDEX CONCURRENTLY lower_idx ON public.example (id);');
    writeManifest(root, [manifestEntry(upper)]);

    const missingEvidence = runGuard(root);
    expect(missingEvidence.status).toBe(1);
    expect(missingEvidence.stderr).toContain(
      `${lower}: missing migration dry-run manifest entry`,
    );

    writeManifest(root, [manifestEntry(upper), manifestEntry(lower)]);
    const completeEvidence = runGuard(root);
    expect(completeEvidence.status).toBe(0);
    expect(new Set(
      JSON.parse(completeEvidence.stdout).manualReview.map(
        (item: { path: string }) => item.path,
      ),
    )).toEqual(new Set([upper, lower]));
  });

  it('rejects traversal and prefix-sibling manifest paths in manifest order', () => {
    const root = createMigrationRoot();
    writeMigration(root, '20260101000000_safe.sql', 'SELECT 1;');
    writeManifest(root, [
      manifestEntry('supabase/migrations/../outside.sql'),
      manifestEntry('supabase/migrations-copy/other.sql'),
    ]);

    expect(runGuard(root).stderr.trim().split(/\r?\n/)).toEqual([
      '[migration-dry-run] supabase/migrations/../outside.sql: manifest path must stay inside supabase/migrations',
      '[migration-dry-run] supabase/migrations-copy/other.sql: manifest path must stay inside supabase/migrations',
    ]);
  });

  it('rejects canonical manifest link escapes where links are supported', () => {
    const root = createMigrationRoot();
    writeMigration(root, '20260101000000_safe.sql', 'SELECT 1;');
    const outside = path.join(root, 'outside.sql');
    writeFileSync(outside, 'CREATE INDEX CONCURRENTLY idx ON public.example (id);');
    const linked = path.join(root, 'supabase', 'migrations', 'linked.sql');
    try {
      symlinkSync(outside, linked, 'file');
    } catch (error) {
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    writeManifest(root, [manifestEntry('supabase/migrations/linked.sql')]);

    expect(runGuard(root).stderr.trim().split(/\r?\n/)).toEqual([
      '[migration-dry-run] supabase/migrations/linked.sql: manifest path canonical target must stay inside migration directory',
    ]);
  });

  it('validates reverse evidence after preserving forward migration error order', () => {
    const root = createMigrationRoot();
    const safe = 'supabase/migrations/20260101000000_safe.sql';
    const risky = 'supabase/migrations/20260102000000_concurrent.sql';
    writeMigration(root, path.basename(safe), 'SELECT 1;');
    writeMigration(root, path.basename(risky), 'CREATE INDEX CONCURRENTLY idx ON public.example (id);');
    writeManifest(root, [manifestEntry('supabase/migrations/stale.sql'), manifestEntry(safe)]);

    expect(runGuard(root).stderr.trim().split(/\r?\n/)).toEqual([
      `[migration-dry-run] ${risky}: missing migration dry-run manifest entry for out-of-transaction (CREATE INDEX CONCURRENTLY)`,
      '[migration-dry-run] supabase/migrations/stale.sql: stale migration dry-run manifest entry',
      `[migration-dry-run] ${safe}: transaction-safe migration must not have a dry-run manifest entry`,
    ]);
  });

  it('preserves successful CLI text and documents the realpath race boundary', () => {
    const root = createMigrationRoot();
    writeMigration(root, '20260101000000_safe.sql', 'SELECT 1;');
    writeManifest(root, []);

    const result = runGuard(root, path.join(root, 'scripts-migration-dry-run-manifest.json'), false);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      '[migration-dry-run] checked 1 migrations; 1 transaction-safe, 0 require data-safety export',
    );
    expect(readFileSync(scriptPath, 'utf8')).toContain(
      'Realpath-before-read reduces static link escapes but is not race-free.',
    );
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

  it('rejects DROP INDEX CONCURRENTLY because Supabase CLI db push wraps it in a transaction', () => {
    const root = createMigrationRoot();
    writeMigration(root, '20260102000000_drop_concurrent_index.sql', `
DROP INDEX CONCURRENTLY IF EXISTS public.idx_example_safe_id;
`);
    writeManifest(root, []);

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'DROP INDEX CONCURRENTLY is incompatible with Supabase CLI db push',
    );
    expect(result.stderr).toContain('SET LOCAL lock_timeout');
  });

  it('accepts a fail-fast transactional index drop', () => {
    const root = createMigrationRoot();
    writeMigration(root, '20260102000000_drop_index_fail_fast.sql', `
SET LOCAL lock_timeout = '2s';
DROP INDEX IF EXISTS public.idx_example_safe_id;
SET LOCAL lock_timeout = DEFAULT;
`);
    writeManifest(root, []);

    const result = runGuard(root);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.summary).toMatchObject({
      transactionSafe: 1,
      outOfTransaction: 0,
      requiresDataSafetyExport: 0,
    });
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
