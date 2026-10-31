import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const querySourcePath = 'supabase/functions/virus-scan/index.ts';
const migrationPath =
  'supabase/migrations/20260716000000_tasks_attachments_containment_gin_index.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('attachment rescan JSONB containment index performance', () => {
  it('locates a scan file with the JSONB containment operator supported by GIN', () => {
    const source = normalize(read(querySourcePath));

    expect(source).toContain(
      ".contains('attachments', json.stringify([{ scanmetadata: { fileid } }]))",
    );
    expect(source).toContain(".eq('projects.owner_id', userid)");
    expect(source).toContain('.limit(2)');
  });

  it('keeps the fresh-init schema aligned with the containment query', () => {
    const initSource = read(initPath);
    const init = normalize(initSource);

    expect(initSource).toContain('--   7.17.0 (2026-07-16): 附件重扫反查索引：');
    expect(init).toContain(
      'create index if not exists idx_tasks_attachments_containment_gin on public.tasks using gin (attachments jsonb_path_ops);',
    );
  });

  it('creates the JSONB path-ops index concurrently without a transaction wrapper', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain(
      'create index concurrently if not exists idx_tasks_attachments_containment_gin on public.tasks using gin (attachments jsonb_path_ops);',
    );
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
  });

  it('registers the concurrent migration and exact rollback command', () => {
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
      'DROP INDEX CONCURRENTLY IF EXISTS public.idx_tasks_attachments_containment_gin',
    );
  });
});
