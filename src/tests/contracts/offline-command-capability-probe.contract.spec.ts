import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261114030125_sync_command_capability_probe.sql';

describe('offline command capability probe migration', () => {
  it('adds an explicit fail-closed capability response without changing legacy protocol fields', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS capabilities JSONB');
    expect(sql).toContain("'capabilities', CASE");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.sync_check_protocol() FROM PUBLIC, anon");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sync_check_protocol() TO authenticated');
    expect(sql).toContain('Empty capabilities keep the new command path in shadow mode');
  });
});