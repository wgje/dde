import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const initPath = 'scripts/init-supabase.sql';
const migrationPath =
  'supabase/migrations/20260715003338_pin_current_user_id_search_path.sql';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function currentUserIdFunction(sql: string): string {
  const normalized = normalize(sql);
  const start = normalized.indexOf(
    'create or replace function public.current_user_id()',
  );
  expect(start, 'current_user_id should exist').toBeGreaterThanOrEqual(0);
  const end = normalized.indexOf('$$;', start);
  expect(end, 'current_user_id should terminate').toBeGreaterThan(start);
  return normalized.slice(start, end + '$$;'.length);
}

describe('current_user_id search_path contract', () => {
  it('pins the helper search_path in fresh database initialization', () => {
    const helper = currentUserIdFunction(read(initPath));

    expect(helper).toContain("set search_path to 'pg_catalog', 'public'");
    expect(helper).toContain('select auth.uid()');
  });

  it('repairs existing databases with a forward migration', () => {
    const migration = normalize(read(migrationPath));

    expect(migration).toContain(
      'alter function public.current_user_id() set search_path = pg_catalog, public;',
    );
  });
});
