import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715004350_connection_tombstone_keyset_pagination.sql';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('connection tombstone pagination index contract', () => {
  it('uses a composite index matching the keyset filter and order', () => {
    const expected = /create index if not exists idx_connection_tombstones_project_deleted_connection on public\.connection_tombstones\s*\(project_id, deleted_at, connection_id\);/;

    expect(normalize(read(initPath))).toMatch(expected);
    expect(normalize(read(migrationPath))).toMatch(expected);
  });

  it('removes the redundant project-only index in the forward migration', () => {
    const migration = normalize(read(migrationPath));
    const init = normalize(read(initPath));

    expect(migration).toContain(
      'drop index if exists public.idx_connection_tombstones_project_id;',
    );
    expect(init).not.toContain(
      'create index if not exists idx_connection_tombstones_project_id on public.connection_tombstones(project_id);',
    );
  });
});
