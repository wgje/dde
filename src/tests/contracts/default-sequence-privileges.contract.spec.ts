import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SUPABASE_INIT_VERSION } from './supabase-init-version.spec-helpers';

const migrationPath =
  'supabase/migrations/20260716001200_default_sequence_privileges.sql';
const initPath = 'scripts/init-supabase.sql';

const expectedDefaultDeny =
  'alter default privileges for role postgres in schema public revoke all on sequences from public, anon, authenticated, service_role;';
const expectedExistingRevoke =
  'revoke all on all sequences in schema public from public, anon, authenticated, service_role;';
const expectedServiceGrant =
  'grant all on all sequences in schema public to service_role;';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.readFileSync(absolutePath, 'utf8');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('default sequence privilege contract', () => {
  it('makes sequence exposure opt-in while preserving service-role access to existing identities', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const init = normalize(initSource);

    for (const sql of [migration, init]) {
      expect(sql).toContain(expectedDefaultDeny);
      expect(sql).toContain(expectedExistingRevoke);
      expect(sql).toContain(expectedServiceGrant);
    }
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');
    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
  });
});
