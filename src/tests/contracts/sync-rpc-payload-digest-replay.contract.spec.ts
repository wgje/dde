import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const taskMigrationPath = 'supabase/migrations/20260606051000_sync_upsert_task_stale_result.sql';
const userPreferencesMigrationPath = 'supabase/migrations/20260615020000_sync_upsert_user_preferences_rpc.sql';
const focusConsoleMigrationPath = 'supabase/migrations/20260615030000_sync_upsert_focus_console_rpcs.sql';
const replayGuardForwardMigrationPath = 'supabase/migrations/20260628193000_sync_rpc_payload_digest_replay_guard.sql';
const replayDigestStabilityMigrationPath = 'supabase/migrations/20260726000000_sync_rpc_replay_digest_stability.sql';
const bootstrapPath = 'scripts/init-supabase.sql';

const syncMutationFunctions = [
  'sync_upsert_task',
  'sync_upsert_connection',
  'sync_upsert_blackbox_entry',
  'sync_upsert_project',
  'sync_upsert_user_preferences',
  'sync_upsert_focus_session',
  'sync_upsert_routine_task',
  'sync_increment_routine_completion',
  'sync_delete_project',
  'sync_delete_tasks',
] as const;

const delegatedSyncMutationFunctions = syncMutationFunctions.filter(
  functionName => functionName !== 'sync_delete_project',
);

const replayVolatilePayloadFields = [
  'operation_id',
  'operationId',
  'protocol_version',
  'client_git_sha',
  'client_origin',
  'deployment_epoch',
  'deployment_target',
] as const;

function readSql(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ');
}

function getFunctionSection(sql: string, functionName: string): string {
  const matches = getFunctionSections(sql, functionName);

  expect(matches, `function ${functionName} not found`).not.toHaveLength(0);

  return matches[0] ?? '';
}

function getLastFunctionSection(sql: string, functionName: string): string {
  const matches = getFunctionSections(sql, functionName);

  expect(matches, `function ${functionName} not found`).not.toHaveLength(0);

  return matches.at(-1) ?? '';
}

function getFunctionSections(sql: string, functionName: string): string[] {
  const pattern = new RegExp(
    String.raw`CREATE OR REPLACE FUNCTION public\.${functionName}\(payload JSONB\)[\s\S]*?\n\$\$;`,
    'g',
  );
  return [...sql.matchAll(pattern)].map(match => match[0]);
}

function expectPayloadDigestReplayGuard(sql: string, functionName: string): void {
  const section = normalize(getFunctionSection(sql, functionName));

  expect(section).toContain('v_payload_digest TEXT := encode(extensions.digest(payload::TEXT,');
  expect(section).toContain("set_config('app.payload_digest', v_payload_digest, true)");
  expect(section).toContain('SELECT user_id, payload_digest, result_payload, status, reject_reason');
  expect(section).toMatch(
    /IF FOUND THEN[\s\S]*?v_log_existing\.payload_digest IS NOT NULL[\s\S]*?v_log_existing\.payload_digest IS DISTINCT FROM v_payload_digest[\s\S]*?'operation_id_payload_mismatch'[\s\S]*?RETURN COALESCE/,
  );
}

function expectStableReplayDigest(section: string): void {
  const normalized = normalize(section);

  expect(normalized).toContain(
    'public.sync_resolve_operation_replay(v_op_id, v_user, payload)',
  );
}

describe('sync RPC payload digest replay guard contract', () => {
  it('latest task upsert rejects operationId replay with a different payload digest', () => {
    expectPayloadDigestReplayGuard(readSql(taskMigrationPath), 'sync_upsert_task');
  });

  it('user preference upsert rejects operationId replay with a different payload digest', () => {
    expectPayloadDigestReplayGuard(readSql(userPreferencesMigrationPath), 'sync_upsert_user_preferences');
  });

  it('focus console RPCs reject operationId replay with a different payload digest', () => {
    const sql = readSql(focusConsoleMigrationPath);

    for (const functionName of [
      'sync_upsert_focus_session',
      'sync_upsert_routine_task',
      'sync_increment_routine_completion',
    ]) {
      expectPayloadDigestReplayGuard(sql, functionName);
    }
  });

  it('fresh bootstrap keeps payload digest replay guards aligned with sync RPC migrations', () => {
    const sql = readSql(bootstrapPath);

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
      'sync_upsert_user_preferences',
      'sync_upsert_focus_session',
      'sync_upsert_routine_task',
      'sync_increment_routine_completion',
      'sync_delete_project',
      'sync_delete_tasks',
    ]) {
      expectPayloadDigestReplayGuard(sql, functionName);
    }
  });

  it('fresh bootstrap fills operation log payload digests from the active RPC transaction', () => {
    const sql = normalize(readSql(bootstrapPath));

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_operation_log_fill_payload_digest()');
    expect(sql).toContain("NULLIF(current_setting('app.payload_digest', true), '')");
    expect(sql).toContain('NEW.payload_digest := v_payload_digest');
    expect(sql).toContain('CREATE TRIGGER sync_operation_log_fill_payload_digest');
  });

  it('forward migration protects already deployed sync RPCs with digest-aware wrappers', () => {
    const rawSql = readSql(replayGuardForwardMigrationPath);
    const sql = normalize(rawSql);

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sync_operation_log_fill_payload_digest()');
    expect(sql).toContain('CREATE TRIGGER sync_operation_log_fill_payload_digest');

    for (const functionName of [
      'sync_upsert_task',
      'sync_upsert_connection',
      'sync_upsert_blackbox_entry',
      'sync_upsert_project',
      'sync_upsert_user_preferences',
      'sync_upsert_focus_session',
      'sync_upsert_routine_task',
      'sync_increment_routine_completion',
      'sync_delete_project',
      'sync_delete_tasks',
    ]) {
      expectPayloadDigestReplayGuard(rawSql, functionName);
      expect(sql).toContain(`ALTER FUNCTION public.${functionName}(JSONB) RENAME TO ${functionName}__unguarded_20260628`);
      expect(sql).toContain(`public.${functionName}__unguarded_20260628(payload)`);
    }
  });

  it('ignores deployment envelope drift when hashing a logical replay payload', () => {
    const absolutePath = path.join(process.cwd(), replayDigestStabilityMigrationPath);
    expect(
      fs.existsSync(absolutePath),
      `${replayDigestStabilityMigrationPath} must close upgrade-time replay drift`,
    ).toBe(true);
    if (!fs.existsSync(absolutePath)) return;

    const sql = normalize(readSql(replayDigestStabilityMigrationPath));
    const helper = sql.match(
      /CREATE OR REPLACE FUNCTION public\.sync_rpc_replay_payload_digest\(p_payload JSONB\)[\s\S]*?\$\$;/,
    )?.[0] ?? '';

    expect(helper).not.toBe('');
    expect(helper).toContain("COALESCE(p_payload, '{}'::JSONB)");
    expect(helper).toContain("extensions.digest(");
    for (const field of replayVolatilePayloadFields) {
      expect(helper).toContain(`- '${field}'`);
    }
  });

  it('moves every deployed sync mutation RPC onto the stable replay digest', () => {
    const absolutePath = path.join(process.cwd(), replayDigestStabilityMigrationPath);
    expect(
      fs.existsSync(absolutePath),
      `${replayDigestStabilityMigrationPath} must redefine the deployed RPC boundary`,
    ).toBe(true);
    if (!fs.existsSync(absolutePath)) return;

    const sql = readSql(replayDigestStabilityMigrationPath);
    for (const functionName of syncMutationFunctions) {
      expectStableReplayDigest(getLastFunctionSection(sql, functionName));
    }
  });

  it('keeps legacy operation-log rows replayable while ratcheting new rows', () => {
    const absolutePath = path.join(process.cwd(), replayDigestStabilityMigrationPath);
    expect(
      fs.existsSync(absolutePath),
      `${replayDigestStabilityMigrationPath} must preserve pre-migration replay rows`,
    ).toBe(true);
    if (!fs.existsSync(absolutePath)) return;

    const sql = normalize(readSql(replayDigestStabilityMigrationPath));
    const resolver = sql.match(
      /CREATE OR REPLACE FUNCTION public\.sync_resolve_operation_replay\([\s\S]*?\$\$;/,
    )?.[0] ?? '';

    expect(sql).toContain(
      'ALTER TABLE public.sync_operation_log ADD COLUMN IF NOT EXISTS replay_payload_digest TEXT',
    );
    expect(sql).toContain(
      "NULLIF(current_setting('app.replay_payload_digest', true), '')",
    );
    expect(sql).toContain('NEW.replay_payload_digest := v_replay_payload_digest');
    expect(resolver).not.toBe('');
    expect(resolver).toContain(
      'SELECT user_id, payload_digest, replay_payload_digest, result_payload, status, reject_reason',
    );
    expect(resolver).toContain(
      "v_payload_digest TEXT := encode(extensions.digest(p_payload::TEXT, 'sha256'), 'hex')",
    );
    expect(resolver).toContain(
      'v_replay_payload_digest TEXT := public.sync_rpc_replay_payload_digest(p_payload)',
    );
    expect(resolver).toContain(
      "set_config('app.replay_payload_digest', v_replay_payload_digest, true)",
    );
    expect(resolver).toMatch(
      /replay_payload_digest IS NOT NULL[\s\S]*?replay_payload_digest IS DISTINCT FROM v_replay_payload_digest[\s\S]*?operation_id_payload_mismatch/,
    );
    expect(resolver).toMatch(
      /replay_payload_digest IS NULL[\s\S]*?payload_digest IS NOT DISTINCT FROM v_payload_digest[\s\S]*?UPDATE public\.sync_operation_log[\s\S]*?replay_payload_digest = v_replay_payload_digest/,
    );
    expect(resolver).not.toMatch(
      /payload_digest IS DISTINCT FROM p_payload_digest[\s\S]*?operation_id_payload_mismatch/,
    );
  });

  it('serializes first-use operationId resolution before reading the operation log', () => {
    for (const relativePath of [replayDigestStabilityMigrationPath, bootstrapPath]) {
      const sql = readSql(relativePath);
      const resolver = normalize(
        [...sql.matchAll(
          /CREATE OR REPLACE FUNCTION public\.sync_resolve_operation_replay\([\s\S]*?\$\$;/g,
        )].at(-1)?.[0] ?? '',
      );

      const nullGuardIndex = resolver.indexOf(
        'IF p_operation_id IS NULL OR p_user_id IS NULL THEN',
      );
      const lockIndex = resolver.indexOf(
        'PERFORM pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtextextended(p_operation_id::TEXT, 0) );',
      );
      const operationLogReadIndex = resolver.indexOf(
        'SELECT user_id, payload_digest, replay_payload_digest, result_payload, status, reject_reason',
      );

      expect(resolver, `${relativePath} must define the replay resolver`).not.toBe('');
      expect(nullGuardIndex).toBeGreaterThanOrEqual(0);
      expect(lockIndex).toBeGreaterThan(nullGuardIndex);
      expect(operationLogReadIndex).toBeGreaterThan(lockIndex);
    }
  });

  it('resolves historical task-delete replays before enforcing the current batch bound', () => {
    for (const relativePath of [replayDigestStabilityMigrationPath, bootstrapPath]) {
      const section = normalize(
        getLastFunctionSection(readSql(relativePath), 'sync_delete_tasks'),
      );
      const replayIndex = section.indexOf(
        'v_replay_result := public.sync_resolve_operation_replay(v_op_id, v_user, payload)',
      );
      const shapeValidationIndex = section.indexOf("IF payload ? 'task_ids'");
      const batchValidationIndex = section.indexOf(
        "IF jsonb_array_length(COALESCE(payload->'task_ids', '[]'::JSONB)) > v_max_task_ids",
      );

      expect(replayIndex).toBeGreaterThanOrEqual(0);
      expect(shapeValidationIndex).toBeGreaterThan(replayIndex);
      expect(batchValidationIndex).toBeGreaterThan(replayIndex);
    }
  });

  it('keeps fresh bootstrap final RPC definitions on the stable replay digest', () => {
    const sql = readSql(bootstrapPath);

    expect(normalize(sql)).toContain(
      'CREATE OR REPLACE FUNCTION public.sync_rpc_replay_payload_digest(p_payload JSONB)',
    );
    for (const functionName of syncMutationFunctions) {
      expectStableReplayDigest(getLastFunctionSection(sql, functionName));
    }
  });

  it('materializes every fresh-bootstrap stable-wrapper delegation target', () => {
    const sql = normalize(readSql(bootstrapPath));

    expect(sql).toContain('v_source_definition := pg_get_functiondef(v_source)');

    for (const functionName of delegatedSyncMutationFunctions) {
      const targetName = `${functionName}__unguarded_20260628`;
      expect(sql).toContain(
        `to_regprocedure('public.${targetName}(jsonb)')`,
      );
      expect(sql).toContain(
        `to_regprocedure('public.${functionName}(jsonb)')`,
      );
      expect(sql).toContain(
        `position('${targetName}' IN v_source_definition) > 0`,
      );
      expect(sql).toContain(
        `Cannot materialize public.${targetName}(JSONB): source public.${functionName}(JSONB) is missing`,
      );
      expect(sql).toContain(
        `Cannot materialize public.${targetName}(JSONB): source already references the missing delegation target`,
      );
      expect(sql).toContain(
        `ALTER FUNCTION public.${functionName}(JSONB) RENAME TO ${targetName}`,
      );
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${targetName}(JSONB) FROM PUBLIC, anon, authenticated`,
      );
    }
  });
});
