import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = 'supabase/migrations/20261128100000_offline_command_receipt_identity.sql';
const read = () => fs.readFileSync(path.join(process.cwd(), migrationPath), 'utf8');

describe('offline command receipt identity migration', () => {
  it('binds existing and concurrent duplicate operations to identity and SHA-256 before replay', () => {
    const sql = read();
    expect(sql.match(/v_existing_identity IS DISTINCT FROM v_command_identity/g)).toHaveLength(2);
    expect(sql.match(/v_existing\.command_digest IS DISTINCT FROM v_command_digest/g)).toHaveLength(2);
    expect(sql).toContain("encode(extensions.digest(v_command_identity::TEXT, 'sha256'), 'hex')");
    expect(sql).toContain("'reason', 'operation_id_command_mismatch'");
    expect(sql).toContain('field_versions, envelope, status, command_digest');
  });

  it('does not backfill identity for historical receipts and refuses to treat them as a domain ACK', () => {
    const sql = read();
    expect(sql).not.toMatch(/UPDATE\s+public\.sync_command_log/i);
    expect(sql).toContain("'reason', 'command-receipt-identity-unverified'");
    expect(sql).toContain("'appliedToDomainTables', v_command_identity IS NOT NULL AND v_command_digest IS NOT NULL");
    expect(sql).toContain('WHERE c.operation_id = v_operation_id AND c.user_id = v_user');
  });

  it('keeps business identity while excluding deployment and result metadata', () => {
    const sql = read();
    const identityFunction = sql.slice(sql.indexOf('AS $identity$'), sql.indexOf('$identity$;'));
    for (const key of ['ownerUserId', 'entityType', 'entityId', 'command', 'intent', 'normalizedResultPatch', 'fieldVersions', 'logicalClock', 'dependencyOperationIds']) {
      expect(identityFunction).toContain(`'${key}'`);
    }
    for (const key of ['protocol_version', 'deployment_epoch', 'client_git_sha', 'client_origin', 'status', 'createdAtIso', 'remoteResult']) {
      expect(identityFunction).not.toContain(`'${key}'`);
    }
    expect(sql).toContain("IF payload->>'ownerUserId' IS DISTINCT FROM v_user::TEXT THEN");
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_offline_command_identity(JSONB, UUID) FROM PUBLIC, anon');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sync_get_offline_command_status(JSONB) FROM PUBLIC, anon');
  });
});