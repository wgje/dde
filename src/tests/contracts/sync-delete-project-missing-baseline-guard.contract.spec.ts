import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260714040000_sync_delete_project_missing_baseline_guard.sql';
const latestMigrationPath =
  'supabase/migrations/20260726000000_sync_rpc_replay_digest_stability.sql';
const initScriptPath = 'scripts/init-supabase.sql';

const legacySoftDeleteRevoke =
  'REVOKE ALL ON FUNCTION public.soft_delete_project(uuid) FROM PUBLIC, anon, authenticated;';
const legacySoftDeleteServiceRoleGrant =
  'GRANT EXECUTE ON FUNCTION public.soft_delete_project(uuid) TO service_role;';
const legacySoftDeleteAuthenticatedGrant =
  'GRANT EXECUTE ON FUNCTION public.soft_delete_project(uuid) TO authenticated;';

function readSql(filePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), filePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function getFunctionSection(sql: string): string {
  const marker = 'CREATE OR REPLACE FUNCTION public.sync_delete_project(payload JSONB)';
  const startIndex = sql.lastIndexOf(marker);
  expect(startIndex, 'sync_delete_project function not found').toBeGreaterThanOrEqual(0);

  const endIndex = sql.indexOf('\n$$;', startIndex);
  expect(endIndex, 'sync_delete_project function is not terminated').toBeGreaterThan(startIndex);
  return normalize(sql.slice(startIndex, endIndex + 4));
}

function getBranch(section: string, start: string, end: string): string {
  const startIndex = section.indexOf(start);
  const endIndex = section.indexOf(end, startIndex + start.length);
  expect(startIndex, `branch start not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `branch end not found: ${end}`).toBeGreaterThan(startIndex);
  return section.slice(startIndex, endIndex);
}

function expectPersistedResult(branch: string, expectedResultFields: string[]): void {
  expect(branch).toContain('v_result := jsonb_build_object');
  for (const field of expectedResultFields) {
    expect(branch).toContain(field);
  }
  expect(branch).toContain('payload_digest, result_payload');
  expect(branch).toContain('v_payload_digest, v_result');
  expect(branch).toContain('RETURN v_result');
}

function expectCompleteReplayPersistence(section: string): void {
  const replayCall = section.indexOf(
    'v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload)',
  );
  const replayGuard = section.indexOf('IF v_replay_result IS NOT NULL THEN', replayCall);
  const replayReturn = section.indexOf('RETURN v_replay_result', replayGuard);
  const protocolCheck = section.indexOf(
    'SELECT min_protocol_version, deployment_epoch INTO v_min_protocol, v_min_epoch',
    replayCall,
  );
  expect(replayCall).toBeGreaterThanOrEqual(0);
  expect(replayGuard).toBeGreaterThan(replayCall);
  expect(replayReturn).toBeGreaterThan(replayGuard);
  expect(protocolCheck).toBeGreaterThan(replayReturn);

  expectPersistedResult(
    getBranch(
      section,
      'IF v_protocol < COALESCE(v_min_protocol, 1) OR v_client_epoch < COALESCE(v_min_epoch, 0) THEN',
      'SELECT owner_id, updated_at, deleted_at',
    ),
    [
      "'status', 'client-version-rejected'",
      "'reason', CASE",
      "'minProtocolVersion', v_min_protocol",
      "'deploymentEpoch', COALESCE(v_min_epoch, 0)",
    ],
  );

  expectPersistedResult(
    getBranch(
      section,
      'IF v_existing_owner IS DISTINCT FROM v_user THEN',
      'IF v_existing_deleted IS NULL AND v_base_updated IS NULL THEN',
    ),
    ["'status', 'unauthorized'", "'reason', 'project_not_owned'"],
  );

  expectPersistedResult(
    getBranch(
      section,
      'IF v_existing_deleted IS NULL AND v_base_updated IS NULL THEN',
      'IF v_existing_deleted IS NULL AND v_base_updated IS DISTINCT FROM v_existing_updated THEN',
    ),
    [
      "'status', 'remote-newer'",
      "'operation_id', v_op_id",
      "'project_id', v_project_id",
      "'remote_updated_at', v_existing_updated",
      "'reason', 'missing_base_updated_at'",
    ],
  );

  expectPersistedResult(
    getBranch(
      section,
      'IF v_existing_deleted IS NULL AND v_base_updated IS DISTINCT FROM v_existing_updated THEN',
      'IF v_existing_deleted IS NULL THEN',
    ),
    [
      "'status', 'remote-newer'",
      "'operation_id', v_op_id",
      "'project_id', v_project_id",
      "'remote_updated_at', v_existing_updated",
      "'reason', 'cas_mismatch'",
    ],
  );

  const appliedBranch = section.slice(section.indexOf('IF NOT FOUND THEN'));
  expect(appliedBranch).toContain("'deleted_count', 0");
  expect(appliedBranch).toContain("'updated_at', v_written_updated");
  expect(appliedBranch).toContain('payload_digest, result_payload');
  expect(appliedBranch).toContain('v_payload_digest, v_result');
  expect(appliedBranch).toContain('RETURN v_result');
}

function expectLegacySoftDeletePrivilegeBoundary(sql: string): void {
  expect(sql).toContain(legacySoftDeleteRevoke);
  expect(sql).toContain(legacySoftDeleteServiceRoleGrant);
  expect(sql).not.toContain(legacySoftDeleteAuthenticatedGrant);
}

describe('sync_delete_project missing baseline guard', () => {
  it('rejects an active project delete when base_updated_at is missing', () => {
    const migration = readSql(migrationPath);
    const section = getFunctionSection(migration);

    expect(section).toContain(
      "v_base_updated TIMESTAMPTZ := NULLIF(payload->>'base_updated_at', '')::TIMESTAMPTZ",
    );
    expect(section).toMatch(
      /IF v_existing_deleted IS NULL\s+AND v_base_updated IS NULL\s+THEN/,
    );
    expect(section).toContain("'status', 'remote-newer'");
    expect(section).toContain("'reason', 'missing_base_updated_at'");
    expect(section).toContain("'remote_updated_at', v_existing_updated");
  });

  it('persists the rejection under the same operationId and payload digest', () => {
    const migration = readSql(migrationPath);
    const section = getFunctionSection(migration);

    expect(section).toContain("v_payload_digest TEXT := encode(extensions.digest(payload::TEXT, 'sha256'), 'hex')");
    expect(section).toContain("WHERE operation_id = v_op_id");
    expect(section).toContain("'operation_id_payload_mismatch'");
    expect(section).toMatch(
      /INSERT INTO public\.sync_operation_log[\s\S]*?payload_digest, result_payload[\s\S]*?v_payload_digest, v_result/,
    );
  });

  it('keeps absent or already deleted projects idempotent and preserves the guarded RPC grant', () => {
    const migration = readSql(migrationPath);
    const section = getFunctionSection(migration);

    expect(section).toContain('IF NOT FOUND THEN');
    expect(section).toContain("'deleted_count', 0");
    expect(section).toContain('IF v_existing_deleted IS NULL THEN');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.sync_delete_project(JSONB) FROM PUBLIC, anon;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;',
    );
  });

  it('revokes authenticated access to the legacy delete helper in the latest hardening migration', () => {
    const migration = readSql(migrationPath);
    const section = getFunctionSection(migration);

    expectLegacySoftDeletePrivilegeBoundary(migration);
    expect(section).toContain('PERFORM public.soft_delete_project(v_project_id)');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;',
    );
  });

  it('keeps the same legacy helper privilege boundary in fresh-init SQL', () => {
    const initSql = readSql(initScriptPath);
    const section = getFunctionSection(initSql);

    expectLegacySoftDeletePrivilegeBoundary(initSql);
    expect(section).toContain('PERFORM public.soft_delete_project(v_project_id)');
    expect(initSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.sync_delete_project(JSONB) TO authenticated;',
    );
  });

  it('persists complete terminal results for latest migration replays', () => {
    expectCompleteReplayPersistence(getFunctionSection(readSql(latestMigrationPath)));
  });

  it('persists complete terminal results for fresh-init replays', () => {
    expectCompleteReplayPersistence(getFunctionSection(readSql(initScriptPath)));
  });

  it('keeps the missing-baseline guard in the latest replay migration and fresh-init definition', () => {
    for (const sql of [readSql(latestMigrationPath), readSql(initScriptPath)]) {
      const section = getFunctionSection(sql);
      expect(section).toMatch(/IF v_existing_deleted IS NULL\s+AND v_base_updated IS NULL\s+THEN/);
      expect(section).toContain("'reason', 'missing_base_updated_at'");
      expect(section).toContain("'status', 'remote-newer'");
    }
  });

  it('keeps the fresh-init function structurally identical to the latest migration', () => {
    expect(getFunctionSection(readSql(initScriptPath))).toBe(
      getFunctionSection(readSql(latestMigrationPath)),
    );
  });
});
