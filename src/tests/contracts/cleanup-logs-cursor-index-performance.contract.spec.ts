import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const querySourcePath = 'supabase/functions/cleanup-attachments/index.ts';
const createMigrationPath =
  'supabase/migrations/20260715019100_cleanup_logs_attachment_cursor_index.sql';
const cleanupMigrationPath =
  'supabase/migrations/20260715019200_cleanup_logs_cursor_and_privilege_cleanup.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';
const finalMarker =
  '-- FINAL CONVERGENCE: 20260715019200 cleanup logs cursor and privileges';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function finalConvergenceBlock(init: string): string {
  const start = init.lastIndexOf(finalMarker);
  expect(start, `${finalMarker} should exist`).toBeGreaterThanOrEqual(0);
  return init.slice(start);
}

describe('cleanup_logs attachment cursor index performance', () => {
  it('keeps the cursor query on a fixed log type and newest created_at row', () => {
    const source = normalize(read(querySourcePath));

    expect(source).toContain('.from("cleanup_logs")');
    expect(source).toContain('.select("details")');
    expect(source).toContain('.eq("type", "attachment_cleanup")');
    expect(source).toContain('.order("created_at", { ascending: false })');
    expect(source).toContain('.limit(1)');
  });

  it('uses a small partial ordered index instead of the global type index in fresh-init', () => {
    const initSource = read(initPath);
    const init = normalize(initSource);

    expect(initSource).toContain('--   7.15.0 (2026-07-15): cleanup_logs 查询与权限收敛：');
    expect(init).toContain(
      "create index if not exists idx_cleanup_logs_attachment_cursor on public.cleanup_logs (created_at desc) where type = 'attachment_cleanup';",
    );
    expect(init).toContain(
      'create index if not exists idx_cleanup_logs_created_at on public.cleanup_logs(created_at);',
    );
    expect(init).not.toContain('idx_cleanup_logs_type');
    expect(init).not.toContain('include (details)');
  });

  it('creates the replacement concurrently before cleanup', () => {
    const migration = normalize(read(createMigrationPath));

    expect(migration).toContain(
      "create index concurrently if not exists idx_cleanup_logs_attachment_cursor on public.cleanup_logs (created_at desc) where type = 'attachment_cleanup';",
    );
    expect(migration).not.toContain('include (details)');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('validates the replacement before dropping the legacy index and narrows direct privileges', () => {
    const cleanup = normalize(read(cleanupMigrationPath));
    const initFinalBlock = normalize(finalConvergenceBlock(read(initPath)));

    expect(cleanup).toContain("to_regclass('public.idx_cleanup_logs_attachment_cursor')");
    expect(cleanup).toContain('index_row.indisvalid');
    expect(cleanup).toContain('index_row.indisready');
    expect(cleanup).toContain("access_method.amname = 'btree'");
    expect(cleanup).toContain('index_row.indnkeyatts = 1');
    expect(cleanup).toContain("attribute_row.attname = 'created_at'");
    expect(cleanup).toContain('(index_row.indoption[0] & 1) = 1');
    expect(cleanup).toContain("predicate_sql not ilike '%type%attachment_cleanup%'");
    expect(cleanup).toContain("set local lock_timeout = '2s';");
    expect(cleanup).toContain('drop index if exists public.idx_cleanup_logs_type;');
    expect(cleanup).toContain('set local lock_timeout = default;');
    expect(cleanup).not.toContain('drop index concurrently');

    for (const sql of [cleanup, initFinalBlock]) {
      expect(sql).toContain('alter table public.cleanup_logs enable row level security;');
      expect(sql).toContain('alter table public.cleanup_logs force row level security;');
      expect(sql).toContain(
        'revoke all on table public.cleanup_logs from public, anon, authenticated, service_role;',
      );
      expect(sql).toContain(
        'grant select, insert, delete on table public.cleanup_logs to service_role;',
      );
      expect(sql).not.toContain('grant all on table public.cleanup_logs to service_role;');
    }
  });

  it('keeps only concurrent creation in the safety manifest and records rollback SQL', () => {
    const cleanup = normalize(read(cleanupMigrationPath));
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        reason: string;
        rollbackStrategy: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    const createEntry = manifest.entries.find(entry => entry.path === createMigrationPath);
    const cleanupEntry = manifest.entries.find(entry => entry.path === cleanupMigrationPath);

    expect(createEntry).toEqual(expect.objectContaining({
      path: createMigrationPath,
      category: 'out-of-transaction',
      requiresDataSafetyExport: true,
    }));
    expect(createEntry?.reason).toContain('CREATE INDEX CONCURRENTLY');
    expect(createEntry?.rollbackStrategy).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS public.idx_cleanup_logs_attachment_cursor',
    );
    expect(cleanupEntry).toBeUndefined();
    expect(cleanup).toContain(
      'rollback: create index concurrently idx_cleanup_logs_type on public.cleanup_logs(type);',
    );
  });
});
