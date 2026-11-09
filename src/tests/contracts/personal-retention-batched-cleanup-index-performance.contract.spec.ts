import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const initPath = 'scripts/init-supabase.sql';
const indexMigrationPath =
  'supabase/migrations/20260716000200_personal_retention_cleanup_indexes.sql';
const cleanupMigrationPath =
  'supabase/migrations/20260716000300_personal_retention_batched_cleanup.sql';
const migrationManifestPath = 'scripts/migration-dry-run-manifest.json';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function cleanupFunction(source: string): string {
  const start = source.indexOf(
    'CREATE OR REPLACE FUNCTION public.cleanup_personal_retention_artifacts()',
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(
    'REVOKE ALL ON FUNCTION public.cleanup_personal_retention_artifacts()',
    start,
  );
  expect(end).toBeGreaterThan(start);
  return normalize(source.slice(start, end));
}

describe('personal retention batched cleanup index performance', () => {
  it('creates only the three missing retention indexes in transaction-safe form', () => {
    const migration = normalize(read(indexMigrationPath));

    expect(migration).toContain(
      'create index if not exists idx_focus_sessions_ended_retention on public.focus_sessions (updated_at) where ended_at is not null;',
    );
    expect(migration).toContain(
      'create index if not exists idx_transcription_usage_created_at on public.transcription_usage (created_at);',
    );
    expect(migration).toContain(
      'create index if not exists idx_task_tombstones_deleted_at on public.task_tombstones (deleted_at);',
    );
    expect(migration).not.toContain('idx_connection_tombstones_deleted_at');
    expect(migration).not.toContain('concurrently');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
    expect(migration).toContain("set local lock_timeout = '2s';");
    expect(migration).toContain("set local statement_timeout = '30s';");
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).toContain('set local statement_timeout = default;');
  });

  it('bounds every retention delete with skip-locked ctid batches', () => {
    const migration = cleanupFunction(read(cleanupMigrationPath));

    expect(migration).toContain('v_batch_size constant integer := 10000;');
    expect(migration).toContain(
      "from public.focus_sessions as sessions where sessions.ended_at is not null and sessions.updated_at < now() - interval '30 days' order by sessions.updated_at for update of sessions skip locked limit v_batch_size",
    );
    expect(migration).toContain(
      "from public.transcription_usage as usage where usage.created_at < now() - interval '90 days' order by usage.created_at for update of usage skip locked limit v_batch_size",
    );
    expect(migration).toContain(
      "from public.task_tombstones as tombstones where tombstones.deleted_at < now() - interval '30 days' order by tombstones.deleted_at for update of tombstones skip locked limit v_batch_size",
    );
    expect(migration).toContain(
      "from public.connection_tombstones as tombstones where tombstones.deleted_at < now() - interval '30 days' order by tombstones.deleted_at for update of tombstones skip locked limit v_batch_size",
    );
    expect(migration.match(/where \w+\.ctid in \(select ctid from expired_\w+\)/g)).toHaveLength(4);
    expect(migration.match(/returning 1/g)).toHaveLength(4);
    expect(migration).toContain("set search_path = ''");
  });

  it('keeps fresh-init aligned with the indexed bounded cleanup', () => {
    const initSource = read(initPath);
    const init = normalize(initSource);
    const cleanup = cleanupFunction(initSource);

    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
    expect(init).toContain(
      'create index if not exists idx_focus_sessions_ended_retention on public.focus_sessions (updated_at) where ended_at is not null;',
    );
    expect(init).toContain(
      'create index if not exists idx_transcription_usage_created_at on public.transcription_usage (created_at);',
    );
    expect(init).toContain(
      'create index if not exists idx_task_tombstones_deleted_at on public.task_tombstones (deleted_at);',
    );
    expect(cleanup).toContain('v_batch_size constant integer := 10000;');
    expect(cleanup.match(/for update of \w+ skip locked limit v_batch_size/g)).toHaveLength(4);
    expect(cleanup.match(/where \w+\.ctid in \(select ctid from expired_\w+\)/g)).toHaveLength(4);
  });

  it('does not register the transaction-safe index migration in the dry-run manifest', () => {
    const manifest = JSON.parse(read(migrationManifestPath)) as {
      entries: Array<{
        path: string;
        category: string;
        reason: string;
        rollbackStrategy: string;
        requiresDataSafetyExport: boolean;
      }>;
    };
    const entry = manifest.entries.find(item => item.path === indexMigrationPath);

    expect(entry).toBeUndefined();
    expect(manifest.entries.some(item => item.path === indexMigrationPath)).toBe(false);
  });
});
