import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, expect, it } from 'vitest';

import {
  CURRENT_SUPABASE_INIT_VERSION,
  isSupabaseInitVersionAtLeast,
} from './supabase-init-version.spec-helpers';

export interface TableEvent {
  action: 'create' | 'drop' | 'rename';
  table: string;
  targetTable?: string;
}

interface ViewPrivilegeState {
  view: string;
  public: string[];
  anon: string[];
  authenticated: string[];
}

export interface SchemaCoverageReport {
  generatedTypeTables: string[];
  generatedTypeTableColumns: Record<string, string[]>;
  generatedTypeNotNullColumns: Record<string, string[]>;
  generatedTypeRequiredInsertColumns: Record<string, string[]>;
  generatedTypeViews: string[];
  activeDatabaseTableRefs: Record<string, string[]>;
  migrationReplayTables: string[];
  migrationReplayTableColumns: Record<string, string[]>;
  migrationReplayNotNullColumns: Record<string, string[]>;
  migrationReplayRequiredInsertColumns: Record<string, string[]>;
  migrationReplayViews: string[];
  freshInitTables: string[];
  freshInitTableColumns: Record<string, string[]>;
  freshInitNotNullColumns: Record<string, string[]>;
  freshInitRequiredInsertColumns: Record<string, string[]>;
  freshInitViews: string[];
  activeRefsMissingFromFreshInit: string[];
  activeRefsMissingFromGeneratedTypes: string[];
  generatedTypesMissingFromFreshInit: string[];
  freshInitMissingFromGeneratedTypes: string[];
  migrationReplayMissingFromFreshInit: string[];
  freshInitMissingFromMigrationReplay: string[];
  generatedColumnsMissingFromFreshInit: string[];
  freshInitColumnsMissingFromGeneratedTypes: string[];
  migrationReplayColumnsMissingFromFreshInit: string[];
  freshInitColumnsMissingFromMigrationReplay: string[];
  generatedNotNullMissingFromFreshInit: string[];
  freshInitNotNullMissingFromGeneratedTypes: string[];
  migrationReplayNotNullMissingFromFreshInit: string[];
  freshInitNotNullMissingFromMigrationReplay: string[];
  generatedTypeRequiredInsertAheadOfFreshInit: string[];
  freshInitRequiredInsertAheadOfGeneratedTypes: string[];
  migrationReplayRequiredInsertAheadOfFreshInit: string[];
  freshInitRequiredInsertAheadOfMigrationReplay: string[];
  generatedViewsMissingFromFreshInit: string[];
  freshInitViewsMissingFromGeneratedTypes: string[];
  migrationReplayViewsMissingFromFreshInit: string[];
  freshInitViewsMissingFromMigrationReplay: string[];
  migrationReplayNonSecurityInvokerViews: string[];
  freshInitNonSecurityInvokerViews: string[];
  migrationReplayViewPrivileges: ViewPrivilegeState[];
  freshInitViewPrivileges: ViewPrivilegeState[];
  migrationReplayUnsafeViewPrivileges: string[];
  freshInitUnsafeViewPrivileges: string[];
  unindexedForeignKeys: string[];
  unindexedRlsPolicyColumns: string[];
  unforcedRlsTables: string[];
  freshInitRedundantIndexes: Array<{ table: string; indexes: string[] }>;
  migrationReplayRedundantIndexes: Array<{ table: string; indexes: string[] }>;
}

export interface SchemaCoverageModule {
  analyzeRepositorySchemaCoverage(root: string): SchemaCoverageReport;
  applyPublicTableEvents(events: TableEvent[]): string[];
  extractDatabaseTableReferences(source: string, filePath?: string): string[];
  extractGeneratedPublicTables(source: string, filePath?: string): string[];
  extractGeneratedPublicTableColumns(source: string, filePath?: string): Record<string, string[]>;
  extractGeneratedPublicNotNullColumns(source: string, filePath?: string): Record<string, string[]>;
  extractGeneratedPublicRequiredInsertColumns(source: string, filePath?: string): Record<string, string[]>;
  extractGeneratedPublicViews(source: string, filePath?: string): string[];
  extractPublicTableColumns(source: string): Record<string, string[]>;
  extractPublicNotNullColumns(source: string): Record<string, string[]>;
  extractPublicRequiredInsertColumns(source: string): Record<string, string[]>;
  extractPublicTableEvents(source: string): TableEvent[];
  extractPublicViewState(source: string): Array<{
    view: string;
    securityInvoker: boolean;
  }>;
  extractPublicViewPrivilegeState(source: string): ViewPrivilegeState[];
  extractUnindexedPublicForeignKeys(source: string): string[];
  extractUnindexedPublicRlsPolicyColumns(source: string): string[];
  extractUnforcedPublicRlsTables(source: string): string[];
  extractRedundantPublicIndexes(source: string): Array<{
    table: string;
    indexes: string[];
  }>;
}

export interface RpcFunctionCoverageReport {
  freshInitRpcDeclarations: {
    indeterminate: string[];
    missing: string[];
    present: string[];
  };
  missingFromFreshInit: string[];
  missingFromGeneratedTypes: string[];
  references: Array<{ kind: 'direct-rpc' | 'sync-rpc-transport'; name: string }>;
  rpcNames: string[];
  unresolvedDynamicSites: Array<{ reason: string }>;
}

export interface RpcFunctionCoverageModule {
  analyzeRepositoryRpcFunctionCoverage(root: string): RpcFunctionCoverageReport;
}

interface CoverageManifest {
  freshInitOmissions: Record<string, string>;
  generatedTypesAheadOfFreshInit: Record<string, string>;
  freshInitAheadOfGeneratedTypes: Record<string, string>;
  generatedTypeColumnsAheadOfFreshInit: Record<string, string>;
  freshInitColumnsAheadOfGeneratedTypes: Record<string, string>;
  migrationReplayColumnsAheadOfFreshInit: Record<string, string>;
  freshInitColumnsAheadOfMigrationReplay: Record<string, string>;
  generatedTypeNotNullAheadOfFreshInit: Record<string, string>;
  freshInitNotNullAheadOfGeneratedTypes: Record<string, string>;
  migrationReplayNotNullAheadOfFreshInit: Record<string, string>;
  freshInitNotNullAheadOfMigrationReplay: Record<string, string>;
  generatedTypeRequiredInsertAheadOfFreshInit: Record<string, string>;
  freshInitRequiredInsertAheadOfGeneratedTypes: Record<string, string>;
  migrationReplayRequiredInsertAheadOfFreshInit: Record<string, string>;
  freshInitRequiredInsertAheadOfMigrationReplay: Record<string, string>;
  freshInitRpcFunctionsAheadOfGeneratedTypes: Record<string, string>;
}

export interface SupabaseFreshInitRepositorySpecContext {
  coverage: SchemaCoverageModule;
  rpcCoverage: RpcFunctionCoverageModule;
}

const projectRoot = process.cwd();
const validatorPath = path.join(projectRoot, 'scripts', 'validate-supabase-schema-coverage.cjs');
const redundantIndexMigrationPath = path.join(
  projectRoot,
  'supabase',
  'migrations',
  '20260716015618_redundant_index_convergence.sql',
);
const manifest = JSON.parse(readFileSync(
  path.join(projectRoot, 'scripts', 'supabase-schema-coverage-manifest.json'),
  'utf8',
)) as CoverageManifest;

export function normalizeSql(source: string): string {
  return source.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sortedKeys(record: Record<string, string>): string[] {
  return Object.keys(record).sort();
}

export function registerSupabaseFreshInitRepositorySpecs(
  context: SupabaseFreshInitRepositorySpecContext,
): void {
  const { coverage, rpcCoverage } = context;
  let repositoryReport: SchemaCoverageReport;
  let rpcReport: RpcFunctionCoverageReport;

  beforeAll(() => {
    repositoryReport = coverage.analyzeRepositorySchemaCoverage(projectRoot);
    rpcReport = rpcCoverage.analyzeRepositoryRpcFunctionCoverage(projectRoot);
  }, 10_000);

  it('validates canonical replacements before short-lock redundant index convergence', () => {
    const migration = normalizeSql(readFileSync(redundantIndexMigrationPath, 'utf8'));
    const initSource = readFileSync(path.join(projectRoot, 'scripts', 'init-supabase.sql'), 'utf8');
    const init = normalizeSql(initSource);
    const migrationManifest = JSON.parse(readFileSync(
      path.join(projectRoot, 'scripts', 'migration-dry-run-manifest.json'),
      'utf8',
    )) as { entries: Array<{ path: string }> };

    expect(migration).toContain(
      "('idx_connections_deleted_at_cleanup', 'connections', array['deleted_at']::name[], true)",
    );
    expect(migration).toContain(
      "('idx_connections_project', 'connections', array['project_id']::name[], false)",
    );
    expect(migration).toContain(
      "('idx_tasks_deleted_cleanup', 'tasks', array['deleted_at']::name[], true)",
    );
    expect(migration).toContain(
      "to_regclass(format('%i.%i', 'public', target.index_name))",
    );
    expect(migration).toContain("to_regclass('public.task_tombstones')");
    expect(migration).toContain('index_row.indisvalid');
    expect(migration).toContain('index_row.indisready');
    expect(migration).toContain('index_row.indisprimary');
    expect(migration).toContain("access_method.amname = 'btree'");
    expect(migration).toContain('index_row.indnkeyatts = 1');
    expect(migration).toContain(
      'array_agg(attribute_row.attname order by key_column.ordinality)',
    );
    expect(migration).toContain(
      "predicate_sql is null or predicate_sql not ilike '%deleted_at%is not null%'",
    );
    expect(migration).toContain("set local lock_timeout = '2s';");
    for (const legacyIndex of [
      'idx_connections_deleted_cleanup',
      'idx_connections_project_id',
      'idx_task_tombstones_task_id',
      'idx_tasks_deleted_at',
    ]) {
      expect(migration).toContain(`drop index if exists public.${legacyIndex};`);
    }
    expect(migration).toContain('set local lock_timeout = default;');
    expect(migration).not.toContain('drop index concurrently');
    expect(migration).not.toContain('begin;');
    expect(migration).not.toContain('commit;');

    expect(init).toContain(
      '-- final convergence: 20260716015618 redundant index convergence',
    );
    expect(isSupabaseInitVersionAtLeast(CURRENT_SUPABASE_INIT_VERSION, '7.50.0')).toBe(true);
    expect(initSource).toContain(`-- 版本: ${CURRENT_SUPABASE_INIT_VERSION}`);
    expect(
      migrationManifest.entries.find(entry =>
        entry.path.endsWith('20260716015618_redundant_index_convergence.sql')
      ),
    ).toBeUndefined();
  });

  it('detects direct auth.uid policy columns without indexes and ignores qualified join columns', () => {
    expect(coverage.extractUnindexedPublicRlsPolicyColumns).toBeTypeOf('function');
    if (!coverage.extractUnindexedPublicRlsPolicyColumns) return;

    const source = `
      CREATE TABLE public.documents (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        owner_id uuid NOT NULL,
        dropped_policy_owner_id uuid NOT NULL,
        dropped_index_owner_id uuid NOT NULL
      );
      CREATE INDEX documents_user_id_idx ON public.documents (user_id, id);
      CREATE INDEX documents_dropped_owner_idx ON public.documents (dropped_index_owner_id);

      CREATE POLICY documents_user_select ON public.documents
        FOR SELECT USING ((SELECT auth.uid()) = user_id);
      CREATE POLICY documents_owner_select ON public.documents
        FOR SELECT USING (owner_id = (SELECT auth.uid()));
      CREATE POLICY documents_qualified_join ON public.documents
        FOR SELECT USING (
          EXISTS (
            SELECT 1 FROM public.projects project_row
            WHERE project_row.owner_id = auth.uid()
          )
        );
      CREATE POLICY documents_dropped_policy ON public.documents
        FOR SELECT USING (dropped_policy_owner_id = auth.uid());
      DROP POLICY documents_dropped_policy ON public.documents;
      CREATE POLICY documents_dropped_index ON public.documents
        FOR SELECT USING (auth.uid() = dropped_index_owner_id);
      DROP INDEX public.documents_dropped_owner_idx;
    `;

    expect(coverage.extractUnindexedPublicRlsPolicyColumns(source)).toEqual([
      'documents.dropped_index_owner_id',
      'documents.owner_id',
    ]);
  });

  it('tracks enabled and forced RLS state across disable, no-force, rename, and drop lifecycle', () => {
    const source = `
      CREATE TABLE public.forced_rows (id uuid PRIMARY KEY);
      ALTER TABLE public.forced_rows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.forced_rows FORCE ROW LEVEL SECURITY;

      CREATE TABLE public.disabled_rows (id uuid PRIMARY KEY);
      ALTER TABLE public.disabled_rows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.disabled_rows FORCE ROW LEVEL SECURITY;
      ALTER TABLE public.disabled_rows DISABLE ROW LEVEL SECURITY;

      CREATE TABLE public.no_force_rows (id uuid PRIMARY KEY);
      ALTER TABLE public.no_force_rows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.no_force_rows FORCE ROW LEVEL SECURITY;
      ALTER TABLE public.no_force_rows NO FORCE ROW LEVEL SECURITY;

      CREATE TABLE public.old_unforced_rows (id uuid PRIMARY KEY);
      ALTER TABLE public.old_unforced_rows ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.old_unforced_rows RENAME TO renamed_unforced_rows;

      CREATE TABLE public.dropped_unforced_rows (id uuid PRIMARY KEY);
      ALTER TABLE public.dropped_unforced_rows ENABLE ROW LEVEL SECURITY;
      DROP TABLE public.dropped_unforced_rows;
    `;

    expect(coverage.extractUnforcedPublicRlsTables(source)).toEqual([
      'no_force_rows',
      'renamed_unforced_rows',
    ]);
  });

  it('keeps active database references and fresh-init aligned with migration replay', () => {
    expect(repositoryReport.activeRefsMissingFromFreshInit).toEqual([]);
    expect(repositoryReport.freshInitMissingFromMigrationReplay).toEqual([]);
    expect(repositoryReport.migrationReplayMissingFromFreshInit).toEqual(
      sortedKeys(manifest.freshInitOmissions),
    );
    expect(repositoryReport.unindexedForeignKeys).toEqual([]);
    expect(repositoryReport.unindexedRlsPolicyColumns).toEqual([]);
    expect(repositoryReport.unforcedRlsTables).toEqual([]);
    expect(repositoryReport.freshInitRedundantIndexes).toEqual([]);
    expect(repositoryReport.migrationReplayRedundantIndexes).toEqual([]);
  });

  it('keeps the static RPC denominator aligned with fresh-init and generated-type drift', () => {
    expect(rpcReport.references).toHaveLength(32);
    expect(rpcReport.rpcNames).toHaveLength(31);
    expect(rpcReport.unresolvedDynamicSites).toEqual([]);
    expect(rpcReport.missingFromFreshInit).toEqual([]);
    expect(rpcReport.freshInitRpcDeclarations.indeterminate).toEqual([]);
    expect(rpcReport.missingFromGeneratedTypes).toEqual(
      sortedKeys(manifest.freshInitRpcFunctionsAheadOfGeneratedTypes),
    );
    expect(rpcReport.missingFromGeneratedTypes).toHaveLength(10);
  });

  it('keeps shared table columns aligned after replay convergence', () => {
    expect(repositoryReport.generatedColumnsMissingFromFreshInit).toEqual([]);
    expect(repositoryReport.freshInitColumnsMissingFromGeneratedTypes).toEqual([
      'external_source_links.operation_id',
      'tasks.attention_meta',
    ]);
    expect(repositoryReport.migrationReplayColumnsMissingFromFreshInit).toEqual([]);
    expect(repositoryReport.freshInitColumnsMissingFromMigrationReplay).toEqual([]);

    expect(sortedKeys(manifest.generatedTypeColumnsAheadOfFreshInit)).toEqual([]);
    expect(sortedKeys(manifest.freshInitColumnsAheadOfGeneratedTypes)).toEqual([
      'external_source_links.operation_id',
      'tasks.attention_meta',
    ]);
    expect(sortedKeys(manifest.migrationReplayColumnsAheadOfFreshInit)).toEqual([]);
    expect(sortedKeys(manifest.freshInitColumnsAheadOfMigrationReplay)).toEqual([]);
  });

  it('keeps shared-column NOT NULL contracts aligned or explicitly pending Preview replay', () => {
    expect(repositoryReport.generatedNotNullMissingFromFreshInit).toEqual([]);
    expect(repositoryReport.freshInitNotNullMissingFromGeneratedTypes).toEqual([
      'black_box_entries.user_id',
      'tasks.created_at',
      'transcription_usage.user_id',
    ]);
    expect(repositoryReport.migrationReplayNotNullMissingFromFreshInit).toEqual([]);
    expect(repositoryReport.freshInitNotNullMissingFromMigrationReplay).toEqual([]);

    expect(sortedKeys(manifest.generatedTypeNotNullAheadOfFreshInit)).toEqual([]);
    expect(sortedKeys(manifest.freshInitNotNullAheadOfGeneratedTypes)).toEqual([
      'black_box_entries.user_id',
      'tasks.created_at',
      'transcription_usage.user_id',
    ]);
    expect(sortedKeys(manifest.migrationReplayNotNullAheadOfFreshInit)).toEqual([]);
    expect(sortedKeys(manifest.freshInitNotNullAheadOfMigrationReplay)).toEqual([]);
  });

  it('keeps required Insert contracts aligned or explicitly pending Preview type regeneration', () => {
    expect(repositoryReport.generatedTypeRequiredInsertAheadOfFreshInit).toEqual([]);
    expect(repositoryReport.freshInitRequiredInsertAheadOfGeneratedTypes).toEqual([
      'black_box_entries.user_id',
      'transcription_usage.user_id',
    ]);
    expect(repositoryReport.migrationReplayRequiredInsertAheadOfFreshInit).toEqual([]);
    expect(repositoryReport.freshInitRequiredInsertAheadOfMigrationReplay).toEqual([]);

    expect(sortedKeys(manifest.generatedTypeRequiredInsertAheadOfFreshInit)).toEqual([]);
    expect(sortedKeys(manifest.freshInitRequiredInsertAheadOfGeneratedTypes)).toEqual([
      'black_box_entries.user_id',
      'transcription_usage.user_id',
    ]);
    expect(sortedKeys(manifest.migrationReplayRequiredInsertAheadOfFreshInit)).toEqual([]);
    expect(sortedKeys(manifest.freshInitRequiredInsertAheadOfMigrationReplay)).toEqual([]);
  });

  it('keeps generated, migration-replay, and fresh-init views aligned and security-invoker safe', () => {
    const expectedPublicViews = [
      'active_connections',
      'active_tasks',
      'project_structure_audit',
      'stage_null_recovery_diagnostics',
    ];

    expect(repositoryReport.generatedTypeViews).toEqual(expectedPublicViews);
    expect(repositoryReport.migrationReplayViews).toEqual(expectedPublicViews);
    expect(repositoryReport.freshInitViews).toEqual(expectedPublicViews);
    expect(repositoryReport.generatedViewsMissingFromFreshInit).toEqual([]);
    expect(repositoryReport.freshInitViewsMissingFromGeneratedTypes).toEqual([]);
    expect(repositoryReport.migrationReplayViewsMissingFromFreshInit).toEqual([]);
    expect(repositoryReport.freshInitViewsMissingFromMigrationReplay).toEqual([]);
    expect(repositoryReport.migrationReplayNonSecurityInvokerViews).toEqual([]);
    expect(repositoryReport.freshInitNonSecurityInvokerViews).toEqual([]);
    const expectedViewPrivileges = expectedPublicViews.map(view => ({
      view,
      public: [],
      anon: [],
      authenticated: ['select'],
    }));
    expect(repositoryReport.migrationReplayViewPrivileges).toEqual(expectedViewPrivileges);
    expect(repositoryReport.freshInitViewPrivileges).toEqual(expectedViewPrivileges);
    expect(repositoryReport.migrationReplayUnsafeViewPrivileges).toEqual([]);
    expect(repositoryReport.freshInitUnsafeViewPrivileges).toEqual([]);
  });

  it('makes temporary generated-type drift explicit until Preview replay regenerates types', () => {
    expect(repositoryReport.generatedTypesMissingFromFreshInit).toEqual(
      sortedKeys(manifest.generatedTypesAheadOfFreshInit),
    );
    expect(repositoryReport.freshInitMissingFromGeneratedTypes).toEqual(
      sortedKeys(manifest.freshInitAheadOfGeneratedTypes),
    );
    expect(
      repositoryReport.activeRefsMissingFromGeneratedTypes.filter(
        table => !(table in manifest.freshInitAheadOfGeneratedTypes),
      ),
    ).toEqual([]);
  });

  it('requires every schema-drift exception to explain why it exists', () => {
    const manifestGroups: readonly Record<string, string>[] = Object.values(manifest);
    for (const group of manifestGroups) {
      for (const [table, reason] of Object.entries(group)) {
        expect(reason.trim().length, `${table} must have a concrete drift reason`).toBeGreaterThan(20);
      }
    }
  });

  it('exposes the coverage audit as a standalone quality guard', () => {
    const result = spawnSync(process.execPath, [validatorPath], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Supabase schema coverage: passed');
    expect(result.stdout).toContain('- unforced RLS tables: 0');
    expect(result.stdout).toContain('- generated public views: 4');
    expect(result.stdout).toContain('- migration replay views: 4');
    expect(result.stdout).toContain('- fresh-init views: 4');
    expect(result.stdout).toContain('- generated columns missing from fresh-init: 0');
    expect(result.stdout).toContain('- fresh-init columns missing from generated types: 2');
    expect(result.stdout).toContain('- migration replay columns missing from fresh-init: 0');
    expect(result.stdout).toContain('- fresh-init columns missing from migration replay: 0');
    expect(result.stdout).toContain('- generated NOT NULL columns missing from fresh-init: 0');
    expect(result.stdout).toContain('- fresh-init NOT NULL columns missing from generated types: 3');
    expect(result.stdout).toContain('- migration replay NOT NULL columns missing from fresh-init: 0');
    expect(result.stdout).toContain('- fresh-init NOT NULL columns missing from migration replay: 0');
    expect(result.stdout).toContain('- migration replay non-security-invoker views: 0');
    expect(result.stdout).toContain('- fresh-init non-security-invoker views: 0');
    expect(result.stdout).toContain('- migration replay unsafe view privilege states: 0');
    expect(result.stdout).toContain('- fresh-init unsafe view privilege states: 0');
    expect(result.stdout).toContain('- fresh-init redundant index groups: 0');
    expect(result.stdout).toContain('- migration replay redundant index groups: 0');
    expect(result.stdout).toContain('- production RPC reference sites: 32');
    expect(result.stdout).toContain('- production RPC function names: 31');
    expect(result.stdout).toContain('- fresh-init RPC functions missing: 0');
    expect(result.stdout).toContain('- generated RPC function types missing: 10');

    const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['quality:guard:supabase-schema-coverage']).toBe(
      'node scripts/validate-supabase-schema-coverage.cjs',
    );
  }, 10_000);
}
