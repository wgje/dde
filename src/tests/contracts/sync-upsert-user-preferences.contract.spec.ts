import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20260615020000_sync_upsert_user_preferences_rpc.sql';
const initScriptPath = 'scripts/init-supabase.sql';

function readSql(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function getFunctionSection(sql: string, functionName: string): string {
  const pattern = new RegExp(
    String.raw`CREATE OR REPLACE FUNCTION public\.${functionName}\(payload JSONB\)[\s\S]*?\n\$\$;`,
  );
  const match = sql.match(pattern);

  expect(match, `function ${functionName} not found`).not.toBeNull();

  return match?.[0] ?? '';
}

describe('sync_upsert_user_preferences RPC contract', () => {
  it('adds an idempotent authenticated-only user preference RPC migration', () => {
    const sql = readSql(migrationPath);
    const section = normalize(getFunctionSection(sql, 'sync_upsert_user_preferences'));

    expect(section).toContain('SECURITY DEFINER');
    expect(section).toContain('SET search_path = pg_catalog, pg_temp');
    expect(section).toContain("v_user UUID := auth.uid()");
    expect(section).toContain("v_target_user UUID := (payload->>'user_id')::UUID");
    expect(section).toContain("v_base_updated_at TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ");
    expect(section).toContain('v_target_user IS DISTINCT FROM v_user');
    expect(section).toContain('PERFORM pg_advisory_xact_lock');
    expect(section).toContain('FROM public.user_preferences WHERE user_id = v_target_user FOR UPDATE');
    expect(section).toContain("jsonb_build_object( 'status', 'remote-newer'");
    expect(section).toContain("'remote_updated_at', v_existing_preferences.updated_at");
    expect(section).toContain('FROM public.sync_operation_log');
    expect(section).toContain('operation_id owned by other user');
    expect(section).toContain('FROM public.sync_protocol_state WHERE scope =');
    expect(section).toContain("'client-version-rejected'");
    expect(section).toContain('INSERT INTO public.user_preferences AS prefs');
    expect(section).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(section).toContain("theme = CASE WHEN v_preferences ? 'theme'");
    expect(section).toContain("color_mode = CASE WHEN v_preferences ? 'color_mode'");
    expect(section).toContain("focus_preferences = CASE WHEN v_preferences ? 'focus_preferences'");
    expect(section).toContain("'user_id', v_target_user");
    expect(section).not.toContain('dock_snapshot');

    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences(JSONB) FROM PUBLIC, anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sync_upsert_user_preferences(JSONB) TO authenticated;');
  });

  it('keeps fresh bootstrap aligned with the user preference sync RPC migration', () => {
    const sql = readSql(initScriptPath);
    const section = normalize(getFunctionSection(sql, 'sync_upsert_user_preferences'));

    expect(section).toContain("v_base_updated_at TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ");
    expect(section).toContain('FROM public.user_preferences WHERE user_id = v_target_user FOR UPDATE');
    expect(section).toContain("jsonb_build_object( 'status', 'remote-newer'");
    expect(section).toContain('INSERT INTO public.user_preferences AS prefs');
    expect(section).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(section).toContain("auto_resolve_conflicts = CASE WHEN v_preferences ? 'auto_resolve_conflicts'");
    expect(section).toContain("last_backup_proof_at = CASE WHEN v_preferences ? 'last_backup_proof_at'");
    expect(section).not.toContain('dock_snapshot');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_upsert_user_preferences(JSONB) FROM PUBLIC, anon;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sync_upsert_user_preferences(JSONB) TO authenticated;');
    expect(sql).toContain('COMMENT ON FUNCTION public.sync_upsert_user_preferences(JSONB)');
  });
});
