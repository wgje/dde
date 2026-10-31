import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  normalizeSql,
  type SchemaCoverageModule,
} from './supabase-fresh-init-table-coverage-repository.spec-helpers';

import {
  buildWidgetWebhookSigningMessage,
  normalizeWidgetLimitNumber,
  normalizeWidgetWebhookSecret,
} from '../../../supabase/functions/_shared/widget-normalization.ts';

const require = createRequire(import.meta.url);
const coverage = require('../../../scripts/lib/supabase-schema-coverage.cjs') as SchemaCoverageModule;

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function readModelDatabaseTypes(): string {
  return [
    'src/models/supabase-types.ts',
    'src/models/supabase-auxiliary-types.ts',
  ]
    .map(readText)
    .join('\n');
}

function expectTypeScriptToParse(relativePath: string): void {
  const content = readText(relativePath);
  const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diagnostics = (
    (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  ).filter((diagnostic: ts.Diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

  expect(diagnostics, `${relativePath} should be syntactically valid TypeScript`).toHaveLength(0);
}

function extractFunctionSource(sourceText: string, functionName: string): string {
  const asyncStart = sourceText.indexOf(`async function ${functionName}`);
  const start = asyncStart >= 0
    ? asyncStart
    : sourceText.indexOf(`function ${functionName}`);
  expect(start, `Function ${functionName} should exist`).toBeGreaterThanOrEqual(0);

  const bodyStart = sourceText.indexOf('{', start);
  expect(bodyStart, `Function ${functionName} should have a body`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return sourceText.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Failed to extract function ${functionName}`);
}

function loadWidgetSummaryFocusHelpers(): {
  toFocusSessionState: (value: unknown) => unknown;
  pickPrimaryFocusSlot: (value: unknown) => { taskId?: string | null } | null;
} {
  const sourceText = readText('supabase/functions/widget-summary/index.ts');
  const functionNames = [
    'isPlainObject',
    'toSlotList',
    'isMasterSlot',
    'toStringArray',
    'toDockEntryList',
    'mapDockEntryToFocusSlot',
    'applyMainTaskHint',
    'isCommandCenterEntry',
    'toLegacyFocusStateFromDockSnapshot',
    'toFocusSessionState',
    'resolveCommandCenterSlots',
    'pickPrimaryFocusSlot',
    'isRenderableFocusSlot',
  ];
  const snippet = functionNames
    .map(name => extractFunctionSource(sourceText, name))
    .join('\n\n');
  const transpiled = ts.transpileModule(
    `${snippet}\nmodule.exports = { toFocusSessionState, pickPrimaryFocusSlot };`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;

  const module = { exports: {} as Record<string, unknown> };
  const evaluator = new Function('module', 'exports', transpiled);
  evaluator(module, module.exports);

  return module.exports as {
    toFocusSessionState: (value: unknown) => unknown;
    pickPrimaryFocusSlot: (value: unknown) => { taskId?: string | null } | null;
  };
}

interface WidgetSummaryRowsResult<Row> {
  data: Row[] | null;
  error: unknown | null;
}

type WidgetSummaryKnownIdCollector = <Row>(
  ids: readonly string[],
  loadChunk: (chunk: string[]) => PromiseLike<WidgetSummaryRowsResult<Row>>,
) => Promise<WidgetSummaryRowsResult<Row>>;

function loadWidgetSummaryKnownIdCollector(): WidgetSummaryKnownIdCollector {
  const sourceText = readText('supabase/functions/widget-summary/index.ts');
  const snippet = extractFunctionSource(sourceText, 'collectWidgetSummaryRowsById');
  const transpiled = ts.transpileModule(
    `const WIDGET_SUMMARY_POSTGREST_ID_CHUNK_SIZE = 100;\n${snippet}\nmodule.exports = { collectWidgetSummaryRowsById };`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;

  const module = { exports: {} as Record<string, unknown> };
  const evaluator = new Function('module', 'exports', transpiled);
  evaluator(module, module.exports);

  return (module.exports as { collectWidgetSummaryRowsById: WidgetSummaryKnownIdCollector })
    .collectWidgetSummaryRowsById;
}

describe('Widget backend foundation contract', () => {
  it('supabase config must keep widget auth split on function-level verification', () => {
    const config = readText('supabase/config.toml');

    expect(config).toMatch(/\[functions\.widget-register\][\s\S]*?verify_jwt = false/);
    expect(config).toMatch(/\[functions\.widget-summary\][\s\S]*?verify_jwt = false/);
    expect(config).toMatch(/\[functions\.widget-notify\][\s\S]*?verify_jwt = false/);
    expect(config).toMatch(/\[functions\.widget-black-box-action\][\s\S]*?verify_jwt = false/);
    expect(config).toMatch(/\[functions\.widget-focus-action\][\s\S]*?verify_jwt = false/);
  });

  it('migration and init script must define widget backend tables, rate limits, and kill switch config', () => {
    const migration = readText('supabase/migrations/20260413020054_widget_backend_foundation.sql');
    const androidOnlyRetirementMigration = readText('supabase/migrations/20260427163000_reconcile_remote_migration_drift.sql');
    const capabilityRulesBackfillMigration = readText('supabase/migrations/20260427163000_reconcile_remote_migration_drift.sql');
    const notifyTriggerMigration = readText('supabase/migrations/20260413020931_widget_notify_webhook_hmac.sql');
    const notifyReplayFixMigration = readText('supabase/migrations/20260413113000_widget_notify_hmac_replay_fix.sql');
    const notifySecretNormalizationMigration = readText('supabase/migrations/20260413120000_widget_notify_secret_normalization.sql');
    const notifyLimitsBackfillMigration = readText('supabase/migrations/20260413121000_widget_notify_limits_backfill.sql');
    const tokenHashAndNotifyScopeMigration = readText('supabase/migrations/20260427163000_reconcile_remote_migration_drift.sql');
    const gateReadAlignmentMigration = readText('supabase/migrations/20260426110000_widget_gate_read_alignment.sql');
    const gateReadCooldownRestoreMigration = readText('supabase/migrations/20260501143000_widget_gate_read_cooldown_restore.sql');
    const initSql = readText('scripts/init-supabase.sql');

    for (const sql of [migration, initSql]) {
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.widget_devices');
      expect(sql).toContain('binding_generation INTEGER NOT NULL DEFAULT 1');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.widget_instances');
      expect(sql).toContain("config_scope TEXT NOT NULL DEFAULT 'global-summary'");
      expect(sql).toContain('UNIQUE (device_id, host_instance_id)');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.widget_request_rate_limits');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.widget_notify_events');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.widget_notify_throttle');
      expect(sql).toContain('CREATE OR REPLACE FUNCTION public.consume_widget_rate_limit(');
      expect(sql).toContain("'widget_capabilities'");
      expect(sql).toContain("'widget_limits'");
      expect(sql).toContain('GRANT ALL ON TABLE public.widget_devices TO service_role');
      expect(sql).toContain('GRANT ALL ON TABLE public.widget_instances TO service_role');
      expect(sql).toContain('GRANT ALL ON TABLE public.widget_request_rate_limits TO service_role');
      expect(sql).toContain('GRANT ALL ON TABLE public.widget_notify_events TO service_role');
      expect(sql).toContain('GRANT ALL ON TABLE public.widget_notify_throttle TO service_role');
    }

    expect(initSql).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.widget_devices TO authenticated');
    expect(initSql).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.widget_instances TO authenticated');
    expect(notifyTriggerMigration).toContain('CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()');
    expect(notifyTriggerMigration).toContain("x-widget-webhook-signature");
    expect(notifyTriggerMigration).toContain('net.http_post(');
    expect(notifyTriggerMigration).toContain('widget_notify_focus_session_change');
    expect(notifyTriggerMigration).toContain('widget_notify_black_box_change');
    expect(notifyReplayFixMigration).toContain('CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()');
    expect(notifyReplayFixMigration).toContain("v_event_id || '.' || v_timestamp || '.' || v_payload::text");
    expect(notifyReplayFixMigration).toContain('SET search_path = pg_catalog, vault, extensions');
    expect(notifyReplayFixMigration).toContain('extensions.gen_random_uuid()');
    expect(notifyReplayFixMigration).toContain('extensions.hmac(');
    expect(notifySecretNormalizationMigration).toContain("regexp_replace(trim(public.get_vault_secret('widget_notify_webhook_secret')), '^v1,whsec_', '')");
    expect(notifyLimitsBackfillMigration).toContain("'widget_limits'");
    expect(notifyLimitsBackfillMigration).toContain("'notifyUserPerMinute', 120");
    expect(notifyLimitsBackfillMigration).toContain("'notifyIpPerMinute', 600");
    expect(tokenHashAndNotifyScopeMigration).toContain('ADD COLUMN IF NOT EXISTS token_hash TEXT');
    expect(tokenHashAndNotifyScopeMigration).toContain('idx_widget_devices_token_hash');
    expect(tokenHashAndNotifyScopeMigration).toContain('widget_notify_task_change');
    expect(tokenHashAndNotifyScopeMigration).toContain('widget_notify_project_change');
    expect(notifyLimitsBackfillMigration).toContain('ON CONFLICT (key) DO UPDATE');
    expect(androidOnlyRetirementMigration).toContain('widget_devices_legacy_retired');
    expect(androidOnlyRetirementMigration).toContain('widget_instances_legacy_retired');
    expect(androidOnlyRetirementMigration).toContain('desktop-widget-retired');
    expect(androidOnlyRetirementMigration).toContain('ALTER TABLE public.widget_devices_legacy_retired ENABLE ROW LEVEL SECURITY');
    expect(androidOnlyRetirementMigration).toContain('GRANT SELECT ON TABLE public.widget_devices_legacy_retired TO service_role');
    expect(androidOnlyRetirementMigration).toContain('ALTER TABLE public.widget_instances_legacy_retired ENABLE ROW LEVEL SECURITY');
    expect(androidOnlyRetirementMigration).toContain('GRANT SELECT ON TABLE public.widget_instances_legacy_retired TO service_role');
    expect(androidOnlyRetirementMigration).toContain('DELETE FROM public.widget_devices');
    expect(androidOnlyRetirementMigration).toContain('DELETE FROM public.widget_instances');
    expect(androidOnlyRetirementMigration).toContain("CHECK (platform IN ('android-widget'))");
    expect(migration).toContain("'rules', jsonb_build_array()");
    expect(initSql).toContain("'rules', jsonb_build_array()");
    expect(capabilityRulesBackfillMigration).toContain("'widget_capabilities'");
    expect(capabilityRulesBackfillMigration).toContain("'rules', jsonb_build_array()");
    expect(capabilityRulesBackfillMigration).toContain("ON CONFLICT (key) DO UPDATE");
    expect(capabilityRulesBackfillMigration).toContain('REVOKE ALL ON FUNCTION public.cleanup_old_deleted_tasks() FROM PUBLIC, anon, authenticated');
    expect(capabilityRulesBackfillMigration).toContain('GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_tasks() TO service_role');
    expect(capabilityRulesBackfillMigration).toContain('REVOKE ALL ON FUNCTION public.cleanup_old_deleted_connections() FROM PUBLIC, anon, authenticated');
    expect(capabilityRulesBackfillMigration).toContain('GRANT EXECUTE ON FUNCTION public.cleanup_old_deleted_connections() TO service_role');
    expect(initSql).toContain('CREATE OR REPLACE FUNCTION public.invoke_widget_notify_webhook()');
    expect(initSql).toContain("v_event_id || '.' || v_timestamp || '.' || v_payload::text");
    expect(initSql).toContain("regexp_replace(trim(public.get_vault_secret('widget_notify_webhook_secret')), '^v1,whsec_', '')");
    expect(initSql).toContain("'notifyUserPerMinute', 120");
    expect(initSql).toContain("'notifyIpPerMinute', 600");
    expect(initSql).toContain('token_hash TEXT');
    expect(initSql).toContain('idx_widget_devices_token_hash');
    expect(initSql).toContain('widget_notify_focus_session_change');
    expect(initSql).toContain('widget_notify_black_box_change');
    expect(initSql).toContain('widget_notify_task_change');
    expect(initSql).toContain('widget_notify_project_change');
    for (const sql of [initSql, gateReadAlignmentMigration, gateReadCooldownRestoreMigration]) {
      const normalized = sql.toLowerCase();
      expect(normalized).toContain('unreadblackboxcount');
      expect(normalized).toContain('is_completed = false');
    }
    expect(gateReadCooldownRestoreMigration.toLowerCase()).toContain('v_gate_read_cooldown_cutoff');
    expect(gateReadCooldownRestoreMigration.toLowerCase()).toContain('is_read = false or updated_at <=');
    expect(gateReadCooldownRestoreMigration).toContain("interval '30 minutes'");
    expect(gateReadCooldownRestoreMigration).toContain('v_next_gate_review_at');
    expect(gateReadCooldownRestoreMigration).toContain("min(updated_at + interval '30 minutes')");
    expect(gateReadCooldownRestoreMigration).toContain("'nextGateReviewAt', v_next_gate_review_at");
    expect(initSql.toLowerCase()).toContain('v_gate_read_cooldown_cutoff');
    expect(initSql).toContain("'nextGateReviewAt', v_next_gate_review_at");
  });

  it('database type files must include widget tables and rate limit RPC', () => {
    const databaseTypes = readText('src/types/supabase.ts');
    const modelTypes = readModelDatabaseTypes();

    for (const content of [databaseTypes, modelTypes]) {
      expect(content).toContain('widget_devices');
      expect(content).toContain('widget_instances');
      expect(content).toContain('widget_request_rate_limits');
      expect(content).toContain('widget_notify_events');
      expect(content).toContain('widget_notify_throttle');
      expect(content).toContain('consume_widget_rate_limit');
      expect(content).toContain('binding_generation');
      expect(content).toContain('token_hash');
    }
  });

  it('widget legacy retired archive tables must converge existing id indexes into primary keys without relaxing service-role-only hardening', () => {
    const androidOnlyRetirementMigration = readText('supabase/migrations/20260427163000_reconcile_remote_migration_drift.sql');
    const securityHardeningCompatMigration = readText('supabase/migrations/20260427170000_security_hardening_compat.sql');
    const advisorFollowupMigration = readText(
      'supabase/migrations/20260531123000_advisor_followup_rls_and_function_exposure.sql',
    );
    const retiredPrimaryKeyConvergenceMigration = readText(
      'supabase/migrations/20260728000100_widget_legacy_retired_primary_keys.sql',
    );
    const finalMigrationChain = [
      androidOnlyRetirementMigration,
      securityHardeningCompatMigration,
      advisorFollowupMigration,
      retiredPrimaryKeyConvergenceMigration,
    ].join('\n');
    const normalizedFinalMigrationChain = normalizeSql(finalMigrationChain);
    const retiredArchivePreConvergenceSchema = `
      CREATE TABLE public.widget_devices_legacy_retired (
        id uuid,
        retired_at timestamptz NOT NULL DEFAULT now(),
        retirement_reason text
      );
      CREATE UNIQUE INDEX idx_widget_devices_legacy_retired_id
        ON public.widget_devices_legacy_retired (id);
      CREATE TABLE public.widget_instances_legacy_retired (
        id uuid,
        retired_at timestamptz NOT NULL DEFAULT now(),
        retirement_reason text
      );
      CREATE UNIQUE INDEX idx_widget_instances_legacy_retired_id
        ON public.widget_instances_legacy_retired (id);
    `;
    const replayNotNullColumns = coverage.extractPublicNotNullColumns(
      `${retiredArchivePreConvergenceSchema}\n${retiredPrimaryKeyConvergenceMigration}`,
    );

    expect(retiredPrimaryKeyConvergenceMigration).toContain(
      'ALTER TABLE public.widget_devices_legacy_retired',
    );
    expect(retiredPrimaryKeyConvergenceMigration).toContain('ALTER COLUMN id SET NOT NULL');
    expect(retiredPrimaryKeyConvergenceMigration).toMatch(
      /ADD CONSTRAINT widget_devices_legacy_retired_pkey\s+PRIMARY KEY USING INDEX idx_widget_devices_legacy_retired_id/,
    );
    expect(retiredPrimaryKeyConvergenceMigration).toMatch(
      /ADD CONSTRAINT widget_instances_legacy_retired_pkey\s+PRIMARY KEY USING INDEX idx_widget_instances_legacy_retired_id/,
    );
    expect(retiredPrimaryKeyConvergenceMigration).not.toMatch(/\bCREATE\s+UNIQUE\s+INDEX\b/i);
    expect(retiredPrimaryKeyConvergenceMigration).not.toMatch(/\bCONCURRENTLY\b/i);
    expect(retiredPrimaryKeyConvergenceMigration).not.toContain(
      'INSERT INTO public.widget_devices_legacy_retired',
    );
    expect(retiredPrimaryKeyConvergenceMigration).not.toContain(
      'INSERT INTO public.widget_instances_legacy_retired',
    );
    expect(retiredPrimaryKeyConvergenceMigration).not.toContain(
      'UPDATE public.widget_devices_legacy_retired',
    );
    expect(retiredPrimaryKeyConvergenceMigration).not.toContain(
      'UPDATE public.widget_instances_legacy_retired',
    );
    expect(retiredPrimaryKeyConvergenceMigration).not.toContain(
      'DELETE FROM public.widget_devices_legacy_retired',
    );
    expect(retiredPrimaryKeyConvergenceMigration).not.toContain(
      'DELETE FROM public.widget_instances_legacy_retired',
    );
    expect(replayNotNullColumns.widget_devices_legacy_retired).toEqual(['id', 'retired_at']);
    expect(replayNotNullColumns.widget_instances_legacy_retired).toEqual(['id', 'retired_at']);

    expect(finalMigrationChain).toContain(
      'ALTER TABLE public.widget_devices_legacy_retired ENABLE ROW LEVEL SECURITY;',
    );
    expect(finalMigrationChain).toContain(
      'ALTER TABLE public.widget_devices_legacy_retired FORCE ROW LEVEL SECURITY;',
    );
    expect(finalMigrationChain).toContain(
      'ALTER TABLE public.widget_instances_legacy_retired ENABLE ROW LEVEL SECURITY;',
    );
    expect(finalMigrationChain).toContain(
      'ALTER TABLE public.widget_instances_legacy_retired FORCE ROW LEVEL SECURITY;',
    );
    expect(advisorFollowupMigration).toContain("'widget_devices_legacy_retired'");
    expect(advisorFollowupMigration).toContain("'widget_instances_legacy_retired'");
    expect(normalizedFinalMigrationChain).toContain(
      "execute format('revoke all on public.%i from public, anon, authenticated', v_table);",
    );
    expect(normalizedFinalMigrationChain).toContain(
      "execute format('grant all on public.%i to service_role', v_table);",
    );
    expect(normalizedFinalMigrationChain).toContain(
      "create policy %i on public.%i for all to service_role using (true) with check (true)",
    );
    expect(finalMigrationChain).toContain(
      'REVOKE ALL ON TABLE public.widget_devices_legacy_retired FROM PUBLIC, anon, authenticated;',
    );
    expect(finalMigrationChain).toContain(
      'REVOKE ALL ON TABLE public.widget_instances_legacy_retired FROM PUBLIC, anon, authenticated;',
    );
    expect(finalMigrationChain).not.toContain(
      'GRANT SELECT ON TABLE public.widget_devices_legacy_retired TO authenticated;',
    );
    expect(finalMigrationChain).not.toContain(
      'GRANT SELECT ON TABLE public.widget_instances_legacy_retired TO authenticated;',
    );
    expect(finalMigrationChain).not.toContain(
      'GRANT SELECT ON TABLE public.widget_devices_legacy_retired TO anon;',
    );
    expect(finalMigrationChain).not.toContain(
      'GRANT SELECT ON TABLE public.widget_instances_legacy_retired TO anon;',
    );
  });

  it('widget runtime helpers must preserve notify zero limits and signing normalization semantics', () => {
    expect(normalizeWidgetLimitNumber(0, 120, true)).toBe(0);
    expect(normalizeWidgetLimitNumber(0, 120)).toBe(120);
    expect(normalizeWidgetLimitNumber(-1, 120, true)).toBe(120);
    expect(normalizeWidgetLimitNumber(19.8, 120, true)).toBe(19);
    expect(normalizeWidgetWebhookSecret(' v1,whsec_secret-value ')).toBe('secret-value');
    expect(normalizeWidgetWebhookSecret(' plain-secret ')).toBe('plain-secret');
    expect(normalizeWidgetWebhookSecret('   ')).toBeNull();
    expect(buildWidgetWebhookSigningMessage('event-1', '1700000000', '{"ok":true}')).toBe('event-1.1700000000.{"ok":true}');
  });

  it('widget summary known-ID collector chunks 1001 UUIDs without loss or duplication', async () => {
    const collectWidgetSummaryRowsById = loadWidgetSummaryKnownIdCollector();
    const ids = Array.from(
      { length: 1001 },
      (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    const requestedChunks: string[][] = [];

    const result = await collectWidgetSummaryRowsById(ids, async chunk => {
      requestedChunks.push([...chunk]);
      return {
        data: chunk.map(id => ({ id })),
        error: null,
      };
    });

    expect(requestedChunks).toHaveLength(11);
    expect(requestedChunks.every(chunk => chunk.length <= 100)).toBe(true);
    expect(requestedChunks.flat()).toEqual(ids);
    expect(result.error).toBeNull();
    expect(result.data?.map(row => row.id)).toEqual(ids);
    expect(new Set(result.data?.map(row => row.id)).size).toBe(ids.length);
  });

  it('widget summary known-ID collector fails closed on the first chunk error', async () => {
    const collectWidgetSummaryRowsById = loadWidgetSummaryKnownIdCollector();
    const ids = Array.from(
      { length: 201 },
      (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    const exactError = { code: 'PGRST_TEST', message: 'chunk 2 failed' };
    const requestedChunks: string[][] = [];

    const result = await collectWidgetSummaryRowsById(ids, async chunk => {
      requestedChunks.push([...chunk]);
      if (requestedChunks.length === 2) {
        return { data: null, error: exactError };
      }
      return {
        data: chunk.map(id => ({ id })),
        error: null,
      };
    });

    expect(requestedChunks).toHaveLength(2);
    expect(result.data).toBeNull();
    expect(result.error).toBe(exactError);
  });

  it('widget summary hydration bounds known-ID queries and filters accessible projects in memory', () => {
    const summaryFn = readText('supabase/functions/widget-summary/index.ts');

    expect.soft(summaryFn).not.toContain(".in('id', taskIds)");
    expect.soft(summaryFn).not.toContain(".in('project_id', accessibleProjectIds)");
    expect.soft(summaryFn).not.toContain(".in('id', projectIds)");
    expect.soft(summaryFn).toContain('const WIDGET_SUMMARY_POSTGREST_ID_CHUNK_SIZE = 100;');
    expect.soft(summaryFn).toMatch(
      /collectWidgetSummaryRowsById<TaskRow>\(\s*taskIds,[\s\S]*?\.from\('tasks'\)[\s\S]*?\.in\('id', chunk\)[\s\S]*?\.is\('deleted_at', null\)/,
    );
    expect.soft(summaryFn).toMatch(
      /collectWidgetSummaryRowsById<ProjectRow>\(\s*projectIds,[\s\S]*?\.from\('projects'\)[\s\S]*?\.in\('id', chunk\)[\s\S]*?\.eq\('owner_id', device\.user_id\)[\s\S]*?\.is\('deleted_at', null\)/,
    );
    expect.soft(summaryFn).toContain('const accessibleProjectIdSet = new Set(accessibleProjectIds);');
    expect.soft(summaryFn).toContain('if (!accessibleProjectIdSet.has(row.project_id)) continue;');
  });

  it('widget action and notify functions must cap request bodies before parsing', () => {
    const shared = readText('supabase/functions/_shared/widget-common.ts');
    const summaryFn = readText('supabase/functions/widget-summary/index.ts');
    const notifyFn = readText('supabase/functions/widget-notify/index.ts');
    const focusActionFn = readText('supabase/functions/widget-focus-action/index.ts');
    const blackBoxActionFn = readText('supabase/functions/widget-black-box-action/index.ts');

    expect(shared).toContain('DEFAULT_WIDGET_REQUEST_BODY_MAX_BYTES');
    expect(shared).toContain('WidgetRequestBodyTooLargeError');
    expect(shared).toContain('export async function readWidgetRequestText');
    expect(shared).toContain('export async function readWidgetRequestJson');
    expect(shared).toContain("req.headers.get('content-length')");
    expect(shared).toContain('totalBytes > maxBytes');

    for (const source of [summaryFn, notifyFn, focusActionFn]) {
      expect(source).not.toContain('await req.text()');
      expect(source).not.toContain('await req.json()');
      expect(source).toContain('REQUEST_BODY_TOO_LARGE');
    }

    expect(summaryFn).toContain('readWidgetRequestText(req)');
    expect(notifyFn).toContain('readWidgetRequestText(req)');
    expect(focusActionFn).toContain('readWidgetRequestJson<RequestBody>(req)');

    expect(blackBoxActionFn).not.toContain('await req.json()');
    expect(blackBoxActionFn).toContain('MAX_WIDGET_REQUEST_BODY_BYTES');
    expect(blackBoxActionFn).toContain('readRequestJsonWithLimit<RequestBody>(req)');
    expect(blackBoxActionFn).toContain('REQUEST_BODY_TOO_LARGE');
  });

  it('widget register must use the shared bounded JSON reader', () => {
    const registerFn = readText('supabase/functions/widget-register/index.ts');

    expect(registerFn).toContain('readWidgetRequestJson');
    expect(registerFn).toContain('isWidgetRequestBodyTooLargeError');
    expect(registerFn).not.toContain('await req.json()');
    expect(registerFn).toContain('body = await readWidgetRequestJson<WidgetRegisterRequest>(req)');
    expect(registerFn).toContain("code: 'REQUEST_BODY_TOO_LARGE'");
  });

  it('widget register must reject stale binding generation writes before mutating device rows', () => {
    const registerFn = readText('supabase/functions/widget-register/index.ts');

    expect(registerFn).toContain('expectedBindingGeneration');
    expect(registerFn).toContain("code: 'STALE_BINDING_GENERATION'");
    expect(registerFn).toContain("code: 'INVALID_BINDING_GENERATION'");
    expect(registerFn).toContain(".eq('binding_generation',");
    expect(registerFn).toContain('buildStaleBindingGenerationPayload(');
  });

  it('widget edge functions must preserve auth split, binding generation checks, and private no-store responses', () => {
    const registerFn = readText('supabase/functions/widget-register/index.ts');
    const summaryFn = readText('supabase/functions/widget-summary/index.ts');
    const notifyFn = readText('supabase/functions/widget-notify/index.ts');
    const focusActionFn = readText('supabase/functions/widget-focus-action/index.ts');
    const focusReorderHelper = readText('supabase/functions/widget-focus-action/focus-reorder.ts');
    const shared = readText('supabase/functions/_shared/widget-common.ts');
    const bindingService = readText('src/services/widget-binding.service.ts');

    expectTypeScriptToParse('supabase/functions/_shared/widget-common.ts');
    expectTypeScriptToParse('supabase/functions/widget-register/index.ts');
    expectTypeScriptToParse('supabase/functions/widget-summary/index.ts');
    expectTypeScriptToParse('supabase/functions/widget-notify/index.ts');
    expectTypeScriptToParse('supabase/functions/widget-focus-action/index.ts');
    expectTypeScriptToParse('supabase/functions/widget-focus-action/focus-reorder.ts');

    expect(registerFn).toContain("const action: WidgetRegisterAction = body.action ?? 'register'");
    expect(registerFn).toContain('const auth = await verifyJwtUser(req);');
    expect(registerFn).toContain("code: 'AUTH_REQUIRED'");
    expect(registerFn).toContain('widget-register-user:');
    expect(registerFn).toContain('widget-register-ip:');
    expect(registerFn).toContain('bindingGeneration');
    expect(registerFn).toContain("DEVICE_SECRET_TOO_SHORT");
    expect(registerFn).toContain('summaryPath');
    expect(registerFn).toContain('DEVICE_ALREADY_BOUND');
    expect(registerFn).toContain('DEVICE_INSTALLATION_CONFLICT');
    expect(registerFn).toContain('if (body.pushToken !== undefined) {');
    expect(registerFn).toContain('id: instance.id');
    expect(registerFn).toContain('token_hash: tokenHash');
    expect(registerFn).toContain('evaluateWidgetCapabilities(capabilities');
    expect(registerFn).toContain('extractWidgetClientVersion(body.capabilities ?? null)');
    expect(registerFn).toContain('buildWidgetClientCapabilitiesPatch({');

    expect(summaryFn).toContain("code: 'BINDING_MISMATCH'");
    expect(summaryFn).toContain("code: 'INSTANCE_CONTEXT_REQUIRED'");
    expect(summaryFn).toContain("code: 'INSTANCE_CONTEXT_INVALID'");
    expect(summaryFn).toContain("code: 'INSTANCE_NOT_ACTIVE'");
    expect(summaryFn).toContain("code: 'INSTANCE_BINDING_MISMATCH'");
    expect(summaryFn).toContain('hostInstanceId?: string;');
    expect(summaryFn).toContain('if (!isUuidLike(body.instanceId)) {');
    expect(summaryFn).toContain("error: 'instanceId, hostInstanceId, and platform are required'");
    expect(summaryFn).toContain("sourceState: 'cloud-confirmed'");
    expect(summaryFn).toContain("sourceState: 'cache-only' as WidgetSourceState");
    expect(summaryFn).toContain("trustState: 'provisional'");
    expect(summaryFn).toContain("const ENTRY_QUERY = 'entry=widget&intent=open-workspace'");
    expect(summaryFn).toContain('function buildEntryUrlFromContext(');
    expect(summaryFn).toContain('if (input.forceWorkspaceFallback) {');
    expect(summaryFn).toContain('return buildTaskEntryUrl(input.focusProjectId, input.focusTaskId);');
    expect(summaryFn).toContain('entryUrl,');
    expect(summaryFn).toContain("if (req.method !== 'POST') {");
    expect(summaryFn).toContain("code: 'SCHEMA_MISMATCH'");
    expect(summaryFn).toContain('buildSummaryEnvelope');
    expect(summaryFn).toContain('dockSnapshot.focusSessionState');
    expect(summaryFn).toContain('function isCommandCenterEntry');
    expect(summaryFn).toContain('const entryDerivedState = toLegacyFocusStateFromDockSnapshot(dockSnapshot)');
    expect(summaryFn).toContain('function isMasterSlot(slot: FocusTaskSlotLike | null | undefined): boolean');
    expect(summaryFn).toContain('function applyMainTaskHint(slots: FocusTaskSlotLike[], mainTaskId: string | null): FocusTaskSlotLike[]');
    expect(summaryFn).toContain('item.isMaster === true || item.isMain === true');
    expect(summaryFn).toContain('const commandCenterTasksWithMain = !hasMainSlot && derivedMainSlot');
    expect(summaryFn).toContain('const commandCenterOrderIds = (state.commandCenterOrderIds?.length ?? 0) > 0');
    expect(summaryFn).toContain('mainTaskId');
    expect(summaryFn).toContain("explicitMainEntry?.taskId ?? sessionMainTaskId");
    expect(summaryFn).toContain('.filter(isCommandCenterEntry)');
    expect(summaryFn).toContain("entry.taskId !== mainTaskId && entry.isMain !== true && entry.lane === 'combo-select'");
    expect(summaryFn).toContain('const preAuthIpScopeKey = await sha256Hex');
    expect(summaryFn).toContain('widget-summary-ip:');
    expect(summaryFn).toContain('widget-summary-device:');
    expect(summaryFn).toContain('widget-summary-user:');
    expect(summaryFn).toContain(".eq('token_hash', tokenHash)");
    expect(summaryFn).toContain(".from('widget_instances')");
    expect(summaryFn).toContain(".eq('host_instance_id', body.hostInstanceId)");
    expect(summaryFn).toContain(".eq('owner_id', device.user_id)");
    expect(summaryFn).toContain("client.rpc('widget_summary_wave1'");
    expect(summaryFn).toContain('p_today: todayIsoDate');
    expect(summaryFn).toContain('MAX_BLACK_BOX_PREVIEW_COUNT');
    expect(summaryFn).toContain('pendingBlackBoxCount');
    expect(summaryFn).toContain('unreadBlackBoxCount');
    expect(summaryFn).toContain('nextGateReviewAt');
    expect(summaryFn).toContain('GATE_READ_REAPPEAR_COOLDOWN_MS');
    expect(summaryFn).toContain('function normalizeBlackBoxGateWave');
    expect(summaryFn).toContain('isBlackBoxRowReadCoolingDown');
    expect(summaryFn).toContain('nextReviewAt');
    expect(summaryFn).toContain('dockCountFromTasks');
    expect(summaryFn).toContain('dockTasksWatermark');
    expect(summaryFn).toContain('const cloudUpdatedAt = summaryVersionCursor;');
    expect(summaryFn).toContain('const summarySignature = await sha256Hex(JSON.stringify');
    expect(summaryFn).toContain("failed to update instance last_seen_at");
    expect(summaryFn).toContain('const todayIsoDate = nowIso.slice(0, 10);');
    expect(summaryFn).toContain('projectTitle: focusProject?.title ?? null');
    expect(summaryFn).toContain('gatePreview: {');
    expect(summaryFn).toContain('projectTitle: projectId ? projectMap.get(projectId)?.title ?? null : null');
    expect(summaryFn).toContain('consumeWidgetRateLimit');
    expect(summaryFn).toContain('clientVersion: normalizeOptionalText(parsed.clientVersion, 256) ?? undefined');
    expect(summaryFn).toContain('const baseCapabilities = toPublicWidgetCapabilities(capabilities);');
    expect(summaryFn).toContain('const capabilityDecision = evaluateWidgetCapabilities(capabilities');
    expect(summaryFn).toContain('buildWidgetClientCapabilitiesPatch({');
    expect(notifyFn).toContain("import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';");
    expect(notifyFn).toContain("const webhookSecret = normalizeWidgetWebhookSecret(Deno.env.get('WIDGET_NOTIFY_WEBHOOK_SECRET')");
    expect(notifyFn).toContain("consumeWidgetRateLimit(");
    expect(notifyFn).toContain("beginNotifyEvent");
    expect(notifyFn).toContain("widget_notify_events");
    expect(notifyFn).toContain("widget_notify_throttle");
    expect(notifyFn).toContain("x-widget-webhook-signature");
    expect(notifyFn).toContain("verifyCustomWebhook");
    expect(notifyFn).toContain('buildWidgetWebhookSigningMessage(eventId, timestamp, rawBody)');
    expect(notifyFn).toContain("type: 'widget_dirty'");
    expect(notifyFn).toContain("hasStandardWebhookHeaders");
    expect(notifyFn).toContain('notifyIpPerMinute');
    expect(notifyFn).toContain('notifyUserPerMinute');
    expect(notifyFn).toContain("reason: 'notify-rate-limited'");
    expect(notifyFn).not.toContain('Math.max(limits.notifyIpPerMinute');
    expect(notifyFn).not.toContain('Math.max(limits.notifyUserPerMinute');
    expect(notifyFn).toContain('limits.notifyUserPerMinute === 0');
    expect(notifyFn).toContain('const usesStandardWebhookHeaders = hasStandardWebhookHeaders(req);');
    expect(notifyFn).toContain("table: 'black_box_entries' as const");
    expect(notifyFn).toContain("directTable === 'black_box_entries'");
    expect(notifyFn).toContain("table: 'focus_sessions' as const");
    expect(notifyFn).toContain('const throttleRow = await loadNotifyThrottle(client, userId);');
    expect(notifyFn).toContain("await finishNotifyEvent(client, webhookId, 'provider-unavailable', userId, summaryCursor);");
    expect(notifyFn).toContain('if (usesStandardWebhookHeaders) {');
    expect(notifyFn).toContain('limits.notifyIpPerMinute === 0');
    expect(notifyFn).toContain("normalizeWidgetWebhookSecret(Deno.env.get('WIDGET_NOTIFY_WEBHOOK_SECRET')");
    expect(notifyFn).toContain(".rpc<WidgetDeviceRow[]>('list_widget_notify_devices'");
    expect(notifyFn).toContain('p_limit: WIDGET_NOTIFY_DEVICE_LIMIT');
    expect(notifyFn).toContain("reason: 'push-provider-unavailable'");
    expect(notifyFn).toContain("'internal-error'");
    expect(notifyFn).toContain("STALE_PROCESSING_RECLAIM_MS");
    expect(notifyFn).toContain("existingStatus === 'internal-error'");
    expect(notifyFn).toContain("existingStatus === 'processing'");
    expect(notifyFn).toContain("reclaim widget_notify_event failed");
    expect(notifyFn).toContain(".eq('updated_at', existingUpdatedAt)");
    expect(notifyFn).toContain(".select('webhook_id')");
    expect(notifyFn).toContain("kind: 'retry-later'");
    expect(notifyFn).toContain("reason: 'event-in-progress'");
    expect(notifyFn).toContain("status: 'processing'");
    expect(notifyFn).toContain('.slice(0, WIDGET_NOTIFY_DEVICE_LIMIT);');
    expect(notifyFn).toContain("deliveryMode: 'dry-run'");
    expect(notifyFn).toContain("reason: 'deduped-within-window'");
    expect(notifyFn).toContain("code: 'PUSH_PROVIDER_UNAVAILABLE'");
    expect(notifyFn).toContain("const projectId = asNonEmptyText(payload.record?.project_id, 64)");
    expect(notifyFn).toContain('const deviceDecisions = devices.map((device) => ({');
    expect(notifyFn).toContain('extractWidgetClientVersion(device.capabilities)');
    expect(notifyFn).toContain('const eligibleDevices = deviceDecisions');
    expect(notifyFn.indexOf('const throttleRow = await loadNotifyThrottle(client, userId);')).toBeLessThan(
      notifyFn.indexOf('const notifyUserScopeKey = await sha256Hex(`widget-notify-user:${userId}`);'),
    );
    expect(notifyFn.indexOf('if (!hasConfiguredPushProvider()) {')).toBeLessThan(
      notifyFn.indexOf('const notifyUserScopeKey = await sha256Hex(`widget-notify-user:${userId}`);'),
    );
    expect(notifyFn.indexOf('const devices = await loadActiveAndroidDevices(client, userId);')).toBeLessThan(
      notifyFn.indexOf('if (!hasConfiguredPushProvider()) {'),
    );
    expect(focusActionFn).toContain("action !== 'promote-secondary'");
    expect(focusActionFn).toMatch(
      /action === 'promote-secondary'[\s\S]*?!isUuidLike\([^)]+\)[\s\S]*?'INVALID_TASK_ID'[\s\S]*?'taskId must be a UUID'[\s\S]*?promoteSecondaryTaskToC2\(session\.session_state,/,
    );
    expect(focusActionFn).toContain('const token = getBearerToken(req);');
    expect(focusActionFn).toContain('Missing widget bearer token');
    expect(focusActionFn).toContain(".from('widget_devices')");
    expect(focusActionFn).toContain(".eq('token_hash', tokenHash)");
    expect(focusActionFn).toContain('parseWidgetToken(rawToken)');
    expect(focusActionFn).toContain(".from('focus_sessions')");
    expect(focusActionFn).toContain(".is('ended_at', null)");
    expect(focusActionFn).toContain(".eq('updated_at', session.updated_at)");
    expect(focusActionFn).toContain(".select('id,project_id,updated_at,deleted_at')");
    expect(focusActionFn).toContain('if (taskRow.deleted_at || !taskRow.updated_at) return;');
    expect(focusActionFn).toContain(".eq('updated_at', taskRow.updated_at)");
    expect(focusActionFn).toContain(".is('deleted_at', null)");
    expect(focusActionFn).toContain("'ACTIVE_FOCUS_SESSION_NOT_FOUND'");
    expect(focusActionFn).toContain('withPrivateNoStoreHeaders(corsHeaders)');
    expect(focusReorderHelper).toContain('export function promoteSecondaryTaskToC2');
    expect(focusReorderHelper).toContain('const COMBO_VISIBLE_LIMIT = 3');
    expect(focusReorderHelper).toContain("code: 'ALREADY_FRONT'");
    expect(shared).toContain("'Cache-Control': 'private, no-store, max-age=0'");
    expect(shared).toContain("'Vary': 'Origin, Authorization'");
    expect(shared).toContain("const cfIp = req.headers.get('cf-connecting-ip');");
    expect(shared).toContain("'http://localhost:3020'");
    expect(shared).toContain('notifyUserPerMinute');
    expect(shared).toContain('notifyIpPerMinute');
    expect(shared).toContain('normalizeWidgetLimitNumber(value.notifyUserPerMinute');
    expect(shared).toContain('normalizeWidgetLimitNumber(value.notifyIpPerMinute');
    expect(shared).toContain('function createOpaqueWidgetTokenSeed(): string {');
    expect(shared).toContain('return base64UrlEncode(createOpaqueWidgetTokenSeed());');
    expect(shared).toContain('clientVersionPrefixes');
    expect(shared).toContain('evaluateWidgetCapabilities(');
    expect(shared).toContain('buildWidgetClientCapabilitiesPatch');
    expect(shared).toContain('rolloutBucket');
    expect(registerFn).toContain("'uninstall-instance'");
    expect(registerFn).toContain('INSTANCE_UNINSTALL_FAILED');
    expect(shared).toContain("export type WidgetPlatform = 'android-widget';");
    expect(bindingService).not.toContain('syncWindowsPwaBindings');
    expect(bindingService).not.toContain('navigator.locks?.request');
    expect(bindingService).not.toContain('uninstallWidgetInstance');
    expect(bindingService).not.toContain('writeWidgetTokenToDb');
  });

  it('widget summary focus repair should keep the hinted main slot ahead of stale commandCenterOrderIds', () => {
    const { toFocusSessionState, pickPrimaryFocusSlot } = loadWidgetSummaryFocusHelpers();

    const state = toFocusSessionState({
      version: 7,
      focusMode: true,
      entries: [
        {
          taskId: 'main-task',
          title: 'Main',
          sourceProjectId: 'project-1',
          expectedMinutes: 25,
          status: 'focusing',
          isMain: true,
          lane: 'combo-select',
          sourceKind: 'project-task',
          dockedOrder: 0,
          manualOrder: 0,
        },
        {
          taskId: 'secondary-task',
          title: 'Secondary',
          sourceProjectId: 'project-1',
          expectedMinutes: 10,
          status: 'pending_start',
          isMain: false,
          lane: 'combo-select',
          sourceKind: 'project-task',
          dockedOrder: 1,
          manualOrder: 1,
        },
      ],
      session: {
        mainTaskId: 'main-task',
        comboSelectIds: ['secondary-task'],
        backupIds: [],
      },
      focusSessionState: {
        commandCenterOrderIds: ['secondary-task'],
        commandCenterTasks: [
          {
            taskId: 'secondary-task',
            inlineTitle: 'Secondary',
            sourceProjectId: 'project-1',
            estimatedMinutes: 10,
            focusStatus: 'pending_start',
            isMaster: false,
            isMain: false,
          },
        ],
        comboSelectTasks: [],
        backupTasks: [],
      },
    });

    const primarySlot = pickPrimaryFocusSlot(state);
    expect(primarySlot?.taskId).toBe('main-task');
  });

  it('widget summary should preserve a valid later-main commandCenterOrderIds sequence', () => {
    const { toFocusSessionState, pickPrimaryFocusSlot } = loadWidgetSummaryFocusHelpers();

    const state = toFocusSessionState({
      version: 7,
      focusMode: true,
      entries: [
        {
          taskId: 'main-task',
          title: 'Main',
          sourceProjectId: 'project-1',
          expectedMinutes: 25,
          status: 'pending_start',
          isMain: true,
          lane: 'combo-select',
          sourceKind: 'project-task',
          dockedOrder: 0,
          manualOrder: 0,
        },
        {
          taskId: 'secondary-task',
          title: 'Secondary',
          sourceProjectId: 'project-1',
          expectedMinutes: 10,
          status: 'focusing',
          isMain: false,
          lane: 'combo-select',
          sourceKind: 'project-task',
          dockedOrder: 1,
          manualOrder: 1,
        },
      ],
      session: {
        mainTaskId: 'main-task',
        comboSelectIds: ['secondary-task'],
        backupIds: [],
      },
      focusSessionState: {
        commandCenterOrderIds: ['secondary-task', 'main-task'],
        commandCenterTasks: [
          {
            taskId: 'secondary-task',
            inlineTitle: 'Secondary',
            sourceProjectId: 'project-1',
            estimatedMinutes: 10,
            focusStatus: 'focusing',
            isMaster: false,
            isMain: false,
          },
        ],
        comboSelectTasks: [],
        backupTasks: [],
      },
    });

    const primarySlot = pickPrimaryFocusSlot(state);
    expect(primarySlot?.taskId).toBe('secondary-task');
  });
});
