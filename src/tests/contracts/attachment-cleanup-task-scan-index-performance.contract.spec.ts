import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const querySourcePath = 'supabase/functions/cleanup-attachments/index.ts';
const migrationPath =
  'supabase/migrations/20260715019300_tasks_nonempty_attachments_scan_index.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('attachment cleanup task scan index performance', () => {
  it('filters SQL NULL and empty JSON arrays before the id keyset scan', () => {
    const source = normalize(read(querySourcePath));
    const notNullIndex = source.indexOf('.not("attachments", "is", null)');
    const nonEmptyIndex = source.indexOf('.neq("attachments", "[]")');

    expect(source).toContain('neq(column: string, value: unknown): cleanuptaskquerybuilder');
    expect(notNullIndex).toBeGreaterThanOrEqual(0);
    expect(nonEmptyIndex).toBeGreaterThan(notNullIndex);
    expect(source).toContain('query = query.gt("id", aftertaskid)');
    expect(source).toContain('.order("id", { ascending: true })');
    expect(source).toContain('.limit(max_tasks_per_run)');
  });

  it('serializes the empty JSON array as a PostgREST JSON literal, not an empty value', () => {
    const result = spawnSync(process.execPath, ['-e', `
      const { createClient } = require('@supabase/supabase-js');
      const client = createClient('http://127.0.0.1:54321', 'contract-anon-key', {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const query = client
        .from('tasks')
        .select('id')
        .not('attachments', 'is', null)
        .neq('attachments', '[]');
      console.log(JSON.stringify(query.url.searchParams.getAll('attachments')));
    `], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([
      'not.is.null',
      'neq.[]',
    ]);
  }, 15_000);

  it('keeps the fresh-init index small and aligned with the exact query predicate', () => {
    const initSource = read(initPath);
    const init = normalize(initSource);

    expect(initSource).toContain('--   7.16.0 (2026-07-15): 附件任务扫描收敛：');
    expect(init).toContain(
      "create index if not exists idx_tasks_nonempty_attachments_id on public.tasks (id) where attachments is not null and attachments <> '[]'::jsonb;",
    );
    expect(init).not.toContain(
      'idx_tasks_nonempty_attachments_id on public.tasks (id) include',
    );
  });

  it('creates the partial index concurrently without a transaction wrapper', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain(
      "create index concurrently if not exists idx_tasks_nonempty_attachments_id on public.tasks (id) where attachments is not null and attachments <> '[]'::jsonb;",
    );
    expect(migration).not.toContain('include (attachments)');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('registers the concurrent migration and its rollback command', () => {
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

    expect(entry).toEqual(expect.objectContaining({
      path: migrationPath,
      category: 'out-of-transaction',
      requiresDataSafetyExport: true,
    }));
    expect(entry?.reason).toContain('CREATE INDEX CONCURRENTLY');
    expect(entry?.rollbackStrategy).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS public.idx_tasks_nonempty_attachments_id',
    );
  });
});
