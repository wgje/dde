import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260716000100_attachment_scans_due_claim_index.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('attachment scan due-claim index performance', () => {
  it('preserves the existing due-status truth table when flattening the SQL predicate', () => {
    const statuses = ['clean', 'failed', 'scanning', 'pending', 'quarantined'];
    for (const status of statuses) {
      for (const stale of [false, true]) {
        const original = ['clean', 'failed'].includes(status)
          || status === 'scanning' && stale;
        const flattened = ['clean', 'failed', 'scanning'].includes(status)
          && (status !== 'scanning' || stale);

        expect(flattened, `${status}:${stale}`).toBe(original);
      }
    }
  });

  it('keeps fresh-init aligned with the ordered queue claim', () => {
    const initSource = read(initPath);
    const init = normalize(initSource);

    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
    expect(init).toContain(
      "create index if not exists idx_attachment_scans_due_claim on public.attachment_scans (next_rescan_at, id) where status in ('clean', 'failed', 'scanning');",
    );
    expect(init).not.toContain(
      'create index if not exists idx_attachment_scans_next_rescan',
    );
    expect(init).toContain(
      "and scans.status in ('clean', 'failed', 'scanning') and ( scans.status <> 'scanning' or scans.rescan_started_at is null or scans.rescan_started_at <= now() - make_interval(secs => greatest(p_stale_after_seconds, 1)) ) order by scans.next_rescan_at asc, scans.id asc for update of scans skip locked",
    );
  });

  it('bounds lock waits before creating and dropping the due-claim indexes', () => {
    const migration = normalize(read(migrationPath));
    const functionIndex = migration.indexOf(
      'create or replace function public.claim_due_attachment_scan_rescans',
    );
    const lockTimeout = migration.indexOf("set local lock_timeout = '2s';");
    const createIndex = migration.indexOf(
      'create index if not exists idx_attachment_scans_due_claim',
    );
    const dropIndex = migration.indexOf(
      'drop index if exists public.idx_attachment_scans_next_rescan;',
    );
    const resetLockTimeout = migration.indexOf('set local lock_timeout = default;');

    expect(functionIndex).toBeGreaterThanOrEqual(0);
    expect(lockTimeout).toBeGreaterThan(functionIndex);
    expect(createIndex).toBeGreaterThan(lockTimeout);
    expect(dropIndex).toBeGreaterThan(createIndex);
    expect(resetLockTimeout).toBeGreaterThan(dropIndex);
    expect(migration).toContain(
      "on public.attachment_scans (next_rescan_at, id) where status in ('clean', 'failed', 'scanning');",
    );
    expect(migration).toContain(
      "and scans.status in ('clean', 'failed', 'scanning') and ( scans.status <> 'scanning' or scans.rescan_started_at is null or scans.rescan_started_at <= now() - make_interval(secs => greatest(p_stale_after_seconds, 1)) )",
    );
    expect(migration).not.toContain('create index concurrently if not exists idx_attachment_scans_due_claim');
    expect(migration).not.toContain(
      'drop index concurrently if exists public.idx_attachment_scans_next_rescan',
    );
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('registers the transaction-safe migration and manifest absence', () => {
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        reason: string;
        rollbackStrategy: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    const entry = manifest.entries.find(item => item.path === migrationPath);

    expect(entry).toBeUndefined();
  });
});
