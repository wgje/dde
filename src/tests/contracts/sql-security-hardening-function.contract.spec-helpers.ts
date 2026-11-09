import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

interface SqlSecurityHardeningFunctionContractSpecContext {
  readSql: (relativePath: string) => string;
  getSection: (sql: string, startMarker: string, endMarker: string) => string;
  expectSecurityDefinerFunctionsSetSearchPath: (relativePath: string) => void;
  listTopLevelMigrationPaths: () => string[];
}

export function registerSqlSecurityHardeningFunctionContractSpecs(
  context: SqlSecurityHardeningFunctionContractSpecContext,
): void {
  const {
    readSql,
    getSection,
    expectSecurityDefinerFunctionsSetSearchPath,
    listTopLevelMigrationPaths,
  } = context;

  it('dashboard stats RPC must respect caller RLS instead of bypassing it as a public SECURITY DEFINER', () => {
    const migrationPath =
      'supabase/migrations/20260715013000_dashboard_stats_security_invoker.sql';
    const migrationExists = fs.existsSync(path.join(process.cwd(), migrationPath));
    expect(migrationExists).toBe(true);
    if (!migrationExists) return;

    const migration = readSql(migrationPath);
    const initSql = readSql('scripts/init-supabase.sql');
    const initSection = getSection(
      initSql,
      'CREATE OR REPLACE FUNCTION public.get_dashboard_stats()',
      '-- 添加函数注释',
    );

    expect(initSection).toContain('SECURITY INVOKER');
    expect(initSection).not.toContain('SECURITY DEFINER');
    expect(migration).toContain(
      'ALTER FUNCTION public.get_dashboard_stats() SECURITY INVOKER;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.get_dashboard_stats() FROM PUBLIC, anon;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO authenticated;',
    );
  });

  it('sync watermark RPCs must aggregate inside authenticated RLS boundaries', () => {
    const migrationPath =
      'supabase/migrations/20260715013500_sync_watermarks_security_invoker.sql';
    const migrationExists = fs.existsSync(path.join(process.cwd(), migrationPath));
    expect(migrationExists).toBe(true);
    if (!migrationExists) return;

    const migration = readSql(migrationPath);
    const initSql = readSql('scripts/init-supabase.sql');
    const functions: Array<[string, string]> = [
      ['get_project_sync_watermark', 'UUID'],
      ['get_user_projects_watermark', ''],
      ['get_black_box_sync_watermark', ''],
    ];

    for (const [functionName, signature] of functions) {
      const section = getSection(
        initSql,
        `CREATE OR REPLACE FUNCTION public.${functionName}(`,
        `REVOKE ALL ON FUNCTION public.${functionName}`,
      );
      const argumentList = signature ? `(${signature})` : '()';

      expect(section, functionName).toContain('SECURITY INVOKER');
      expect(section, functionName).not.toContain('SECURITY DEFINER');
      expect(migration).toContain(
        `ALTER FUNCTION public.${functionName}${argumentList} SECURITY INVOKER;`,
      );
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.${functionName}${argumentList} TO authenticated;`,
      );
    }
  });

  it('remaining authenticated read-only RPCs must run as stable invokers inside table RLS', () => {
    const migrationPath =
      'supabase/migrations/20260715014500_read_only_rpc_security_invoker.sql';
    const migrationExists = fs.existsSync(path.join(process.cwd(), migrationPath));
    expect(migrationExists).toBe(true);
    if (!migrationExists) return;

    const migration = readSql(migrationPath);
    const initSql = readSql('scripts/init-supabase.sql');
    const normalizedGrant = [
      'GRANT SELECT ON TABLE',
      'public.projects,',
      'public.tasks,',
      'public.connections,',
      'public.task_tombstones,',
      'public.connection_tombstones,',
      'public.black_box_entries',
      'TO authenticated;',
    ].join(' ');
    const functions: Array<[string, string]> = [
      ['get_accessible_project_probe', 'UUID'],
      ['get_resume_recovery_probe', 'UUID'],
      ['batch_get_tombstones', 'UUID[]'],
    ];

    for (const sql of [migration, initSql]) {
      expect(sql.replace(/\s+/g, ' ')).toContain(normalizedGrant);
    }

    for (const [functionName, signature] of functions) {
      const section = getSection(
        initSql,
        `CREATE OR REPLACE FUNCTION public.${functionName}(`,
        `COMMENT ON FUNCTION public.${functionName}`,
      );
      const argumentList = `(${signature})`;

      expect(section, functionName).toContain('STABLE');
      expect(section, functionName).toContain('SECURITY INVOKER');
      expect(section, functionName).not.toContain('SECURITY DEFINER');
      expect(migration).toContain(
        `ALTER FUNCTION public.${functionName}${argumentList} SECURITY INVOKER;`,
      );
      expect(migration).toContain(
        `ALTER FUNCTION public.${functionName}${argumentList} STABLE;`,
      );
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.${functionName}${argumentList} FROM PUBLIC, anon;`,
      );
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.${functionName}${argumentList} TO authenticated;`,
      );
    }
  });

  it('historical legacy mutation transition must remove authenticated callers before owner-only convergence', () => {
    const migrationPath =
      'supabase/migrations/20260715015500_legacy_mutation_rpc_retirement.sql';
    const migrationExists = fs.existsSync(path.join(process.cwd(), migrationPath));
    expect(migrationExists).toBe(true);
    if (!migrationExists) return;

    const migration = readSql(migrationPath);
    const initSql = readSql('scripts/init-supabase.sql');
    const retirementMarker = '-- Legacy mutation RPCs retired after sync CAS coverage.';
    const retirementStart = initSql.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalRetirementSection = initSql.slice(retirementStart);
    const retiredFunctions: Array<[string, string]> = [
      ['batch_upsert_tasks', 'jsonb[], uuid'],
      ['purge_tasks_v3', 'uuid, uuid[]'],
      ['increment_routine_completion', 'uuid, uuid, date'],
    ];

    for (const [functionName, signature] of retiredFunctions) {
      const argumentList = `(${signature})`;
      for (const sql of [migration, finalRetirementSection]) {
        expect(sql).toContain(
          `REVOKE ALL ON FUNCTION public.${functionName}${argumentList} FROM PUBLIC, anon, authenticated;`,
        );
        expect(sql).toContain(
          `GRANT EXECUTE ON FUNCTION public.${functionName}${argumentList} TO service_role;`,
        );
      }
    }

    const collectRuntimeTypeScript = (relativeDir: string): string[] => {
      const absoluteDir = path.join(process.cwd(), relativeDir);
      if (!fs.existsSync(absoluteDir)) return [];

      return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
        const relativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) return collectRuntimeTypeScript(relativePath);
        const normalizedPath = relativePath.replaceAll('\\', '/');
        if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
        if (
          normalizedPath.includes('/tests/')
          || normalizedPath.includes('.spec.')
          || normalizedPath.includes('.test.')
          || normalizedPath.includes('spec-helpers')
        ) {
          return [];
        }
        return [relativePath];
      });
    };
    const runtimeFiles = [
      ...collectRuntimeTypeScript('src'),
      ...collectRuntimeTypeScript('supabase/functions'),
    ];
    const runtimeSources = runtimeFiles.map(relativePath => ({
      relativePath,
      source: readSql(relativePath),
    }));

    for (const [functionName] of retiredFunctions) {
      const directRpcPattern = new RegExp(`\\.rpc\\(\\s*['"]${functionName}['"]`);
      const directCallers = runtimeSources
        .filter(({ source }) => directRpcPattern.test(source))
        .map(({ relativePath }) => relativePath);
      expect(directCallers, `${functionName} must not have production RPC callers`).toEqual([]);
    }

    expect(initSql).toContain('PERFORM public.batch_upsert_tasks(ARRAY[v_task_for_write], v_project_id)');
    expect(initSql).toContain('FROM public.purge_tasks_v3(v_project_id, v_task_ids)');
    expect(initSql).toContain('v_deleted_count := public.safe_delete_tasks(v_task_ids, v_project_id);');
  });

  it('safe_delete_tasks historical transition must remove authenticated callers', () => {
    const migrationPath =
      'supabase/migrations/20260715016000_safe_delete_tasks_retirement.sql';
    const migrationExists = fs.existsSync(path.join(process.cwd(), migrationPath));
    expect(migrationExists).toBe(true);
    if (!migrationExists) return;

    const migration = readSql(migrationPath);
    const initSql = readSql('scripts/init-supabase.sql');
    const retirementMarker = '-- Legacy safe_delete_tasks RPC retired after guarded sync delete coverage.';
    const retirementStart = initSql.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalRetirementSection = initSql.slice(retirementStart);
    const revoke =
      'REVOKE ALL ON FUNCTION public.safe_delete_tasks(uuid[], uuid) FROM PUBLIC, anon, authenticated;';
    const grant =
      'GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO service_role;';

    for (const sql of [migration, finalRetirementSection]) {
      expect(sql).toContain(revoke);
      expect(sql).toContain(grant);
      expect(sql).not.toContain(
        'GRANT EXECUTE ON FUNCTION public.safe_delete_tasks(uuid[], uuid) TO authenticated;',
      );
    }

    const collectRuntimeTypeScript = (relativeDir: string): string[] => {
      const absoluteDir = path.join(process.cwd(), relativeDir);
      if (!fs.existsSync(absoluteDir)) return [];

      return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
        const relativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) return collectRuntimeTypeScript(relativePath);
        const normalizedPath = relativePath.replaceAll('\\', '/');
        if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
        if (
          normalizedPath.includes('/tests/')
          || normalizedPath.includes('.spec.')
          || normalizedPath.includes('.test.')
          || normalizedPath.includes('spec-helpers')
        ) {
          return [];
        }
        return [relativePath];
      });
    };
    const runtimeFiles = [
      ...collectRuntimeTypeScript('src'),
      ...collectRuntimeTypeScript('supabase/functions'),
    ];
    const directRpcPattern = /\.rpc\(\s*['"]safe_delete_tasks['"]/;
    const directCallers = runtimeFiles.filter(relativePath =>
      directRpcPattern.test(readSql(relativePath))
    );

    expect(directCallers, 'safe_delete_tasks must not have production RPC callers').toEqual([]);
    expect(initSql).toContain('v_deleted_count := public.safe_delete_tasks(v_task_ids, v_project_id);');
  });

  it('purge_tasks_v2 historical transition must remove authenticated callers', () => {
    const migrationPath =
      'supabase/migrations/20260715016500_purge_tasks_v2_retirement.sql';
    const migrationExists = fs.existsSync(path.join(process.cwd(), migrationPath));
    expect(migrationExists).toBe(true);
    if (!migrationExists) return;

    const migration = readSql(migrationPath);
    const initSql = readSql('scripts/init-supabase.sql');
    const retirementMarker = '-- Legacy purge_tasks_v2 RPC retired after guarded sync purge coverage.';
    const retirementStart = initSql.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalRetirementSection = initSql.slice(retirementStart);
    const revoke =
      'REVOKE ALL ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) FROM PUBLIC, anon, authenticated;';
    const grant =
      'GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO service_role;';

    for (const sql of [migration, finalRetirementSection]) {
      expect(sql).toContain(revoke);
      expect(sql).toContain(grant);
      expect(sql).not.toContain(
        'GRANT EXECUTE ON FUNCTION public.purge_tasks_v2(uuid, uuid[]) TO authenticated;',
      );
    }

    const collectRuntimeTypeScript = (relativeDir: string): string[] => {
      const absoluteDir = path.join(process.cwd(), relativeDir);
      if (!fs.existsSync(absoluteDir)) return [];

      return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
        const relativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) return collectRuntimeTypeScript(relativePath);
        const normalizedPath = relativePath.replaceAll('\\', '/');
        if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
        if (
          normalizedPath.includes('/tests/')
          || normalizedPath.includes('.spec.')
          || normalizedPath.includes('.test.')
          || normalizedPath.includes('spec-helpers')
        ) {
          return [];
        }
        return [relativePath];
      });
    };
    const runtimeFiles = [
      ...collectRuntimeTypeScript('src'),
      ...collectRuntimeTypeScript('supabase/functions'),
    ];
    const directRpcPattern = /\.rpc\(\s*['"]purge_tasks_v2['"]/;
    const directCallers = runtimeFiles.filter(relativePath =>
      directRpcPattern.test(readSql(relativePath))
    );

    expect(directCallers, 'purge_tasks_v2 must not have production RPC callers').toEqual([]);
  });

  it('legacy attachment mutation transition must remove authenticated callers', () => {
    const migrationPath =
      'supabase/migrations/20260715017100_legacy_attachment_mutation_rpc_retirement.sql';
    const migrationExists = fs.existsSync(path.join(process.cwd(), migrationPath));
    expect(migrationExists).toBe(true);
    if (!migrationExists) return;

    const migration = readSql(migrationPath);
    const initSql = readSql('scripts/init-supabase.sql');
    const retirementMarker =
      '-- Legacy attachment mutation RPCs retired after durable attachment sync coverage.';
    const retirementStart = initSql.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalRetirementSection = initSql.slice(retirementStart);
    const retiredFunctions: Array<[string, string]> = [
      ['append_task_attachment', 'uuid, jsonb'],
      ['remove_task_attachment', 'uuid, text'],
    ];

    for (const [functionName, signature] of retiredFunctions) {
      const argumentList = `(${signature})`;
      for (const sql of [migration, finalRetirementSection]) {
        expect(sql).toContain(
          `REVOKE ALL ON FUNCTION public.${functionName}${argumentList} FROM PUBLIC, anon, authenticated;`,
        );
        expect(sql).toContain(
          `GRANT EXECUTE ON FUNCTION public.${functionName}${argumentList} TO service_role;`,
        );
        expect(sql).not.toContain(
          `GRANT EXECUTE ON FUNCTION public.${functionName}${argumentList} TO authenticated;`,
        );
      }
    }

    const collectRuntimeTypeScript = (relativeDir: string): string[] => {
      const absoluteDir = path.join(process.cwd(), relativeDir);
      if (!fs.existsSync(absoluteDir)) return [];

      return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap(entry => {
        const relativePath = path.join(relativeDir, entry.name);
        if (entry.isDirectory()) return collectRuntimeTypeScript(relativePath);
        const normalizedPath = relativePath.replaceAll('\\', '/');
        if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
        if (
          normalizedPath.includes('/tests/')
          || normalizedPath.includes('.spec.')
          || normalizedPath.includes('.test.')
          || normalizedPath.includes('spec-helpers')
        ) {
          return [];
        }
        return [relativePath];
      });
    };
    const runtimeFiles = [
      ...collectRuntimeTypeScript('src'),
      ...collectRuntimeTypeScript('supabase/functions'),
    ];
    const runtimeSources = runtimeFiles.map(relativePath => ({
      relativePath,
      source: readSql(relativePath),
    }));

    for (const [functionName] of retiredFunctions) {
      const directRpcPattern = new RegExp(`\\.rpc\\(\\s*['"]${functionName}['"]`);
      const directCallers = runtimeSources
        .filter(({ source }) => directRpcPattern.test(source))
        .map(({ relativePath }) => relativePath);
      expect(directCallers, `${functionName} must not have production RPC callers`).toEqual([]);
    }

    expect(initSql).toContain('CREATE OR REPLACE FUNCTION public.claim_task_attachment_cleanup(');
    expect(initSql).toContain('CREATE OR REPLACE FUNCTION public.sync_upsert_task(');
  });

  it('legacy task repository compatibility surfaces must remain read-only', () => {
    const repositorySource = readSql('src/services/task-repository.service.ts');
    const batchRepositorySource = readSql('src/services/task-repository-batch.service.ts');

    for (const source of [repositorySource, batchRepositorySource]) {
      expect(source).not.toMatch(/\.(?:insert|upsert|update|delete)\s*\(/);
      expect(source).toContain('sync_upsert_task');
      expect(source).toContain('sync_delete_tasks');
      expect(source).toContain('sync_upsert_connection');
    }
    expect(repositorySource).toContain('durable attachment outbox');
  });

  it('sync mutation surfaces must not regain direct table mutations', () => {
    for (const relativePath of [
      'src/app/core/services/sync/task-sync-push.service.ts',
      'src/app/core/services/sync/task-sync-position.service.ts',
      'src/app/core/services/sync/task-sync-delete.service.ts',
      'src/app/core/services/sync/task-sync-delete.helpers.ts',
      'src/app/core/services/sync/project-push.service.ts',
      'src/app/core/services/sync/connection-sync-operations.service.ts',
    ]) {
      expect(readSql(relativePath), relativePath)
        .not.toMatch(/\.(?:insert|upsert|update|delete)\s*\(/);
    }
  });

  it('active read views must expose only SELECT to authenticated users', () => {
    for (const relativePath of [
      'scripts/init-supabase.sql',
      'supabase/migrations/20260315200000_consolidated_focus_console_and_security.sql',
    ]) {
      const sql = readSql(relativePath);

      for (const viewName of ['active_tasks', 'active_connections']) {
        expect(sql).toContain(`REVOKE INSERT, UPDATE, DELETE ON TABLE public.${viewName} FROM authenticated`);
        expect(sql).toContain(`GRANT SELECT ON TABLE public.${viewName} TO authenticated`);
        expect(sql).not.toContain(`GRANT ALL ON TABLE public.${viewName} TO authenticated`);
      }
    }

    const attentionSql = readSql('supabase/migrations/20260605062000_task_attention_meta.sql');
    expect(attentionSql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.active_tasks FROM authenticated');
    expect(attentionSql).toContain('GRANT SELECT ON TABLE public.active_tasks TO authenticated');
    expect(attentionSql).not.toContain('GRANT ALL ON TABLE public.active_tasks TO authenticated');
  });

  it('active_connections 权限加固必须有前向迁移覆盖已部署数据库', () => {
    const sql = readSql('supabase/migrations/20260609020100_active_connections_view_permissions.sql');

    expect(sql).toContain('REVOKE ALL ON TABLE public.active_connections FROM anon');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.active_connections FROM authenticated');
    expect(sql).toContain('GRANT SELECT ON TABLE public.active_connections TO authenticated');
    expect(sql).toContain('GRANT ALL ON TABLE public.active_connections TO service_role');
    expect(sql).not.toContain('GRANT ALL ON TABLE public.active_connections TO authenticated');
  });

  it('新增部署脚本和迁移不得再向 authenticated 授予裸 GRANT ALL', () => {
    const legacyGrantAllBaselines = new Set([
      'supabase/migrations/20260126074130_remote_commit.sql',
      'supabase/migrations/20260315200000_consolidated_focus_console_and_security.sql',
    ]);
    const grantAllAuthenticatedPattern =
      /\bGRANT\s+ALL\b[\s\S]*?\bTO\s+[^;]*"?authenticated"?\b/i;
    const offenders: Array<{ file: string; statement: string }> = [];

    for (const relativePath of ['scripts/init-supabase.sql', ...listTopLevelMigrationPaths()]) {
      if (legacyGrantAllBaselines.has(relativePath)) continue;

      const statements = readSql(relativePath).split(';');
      for (const statement of statements) {
        if (!grantAllAuthenticatedPattern.test(statement)) continue;

        offenders.push({
          file: relativePath,
          statement: statement.replace(/\s+/g, ' ').trim(),
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('Supabase migration versions must stay unique', () => {
    const migrationDir = path.join(process.cwd(), 'supabase/migrations');
    const files = fs.readdirSync(migrationDir).filter(file => file.endsWith('.sql'));
    const versions = files.map(file => file.slice(0, 14));
    const duplicates = versions.filter((version, index) => versions.indexOf(version) !== index);

    expect(new Set(duplicates)).toEqual(new Set());
  });

  it('当前部署脚本和新增加固迁移的 SECURITY DEFINER 函数必须固定 search_path', () => {
    for (const relativePath of [
      'scripts/init-supabase.sql',
      'supabase/migrations/20260531120000_database_hardening_dr_controls.sql',
      'supabase/migrations/20260531123000_advisor_followup_rls_and_function_exposure.sql',
      'supabase/migrations/20260531125000_quarantine_digest_and_audit_origin_hardening.sql',
      'supabase/migrations/20260606050000_security_sync_followup.sql',
      'supabase/migrations/20260606051000_sync_upsert_task_stale_result.sql',
      'supabase/migrations/20260606052000_transcription_quota_and_cleanup_hardening.sql',
    ]) {
      expectSecurityDefinerFunctionsSetSearchPath(relativePath);
    }
  });
}
