import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716002100_full_project_aggregate_rpc_retirement.sql';
const initPath = 'scripts/init-supabase.sql';
const retirementMarker =
  '-- Legacy full-project aggregate RPC retired after paginated loader convergence.';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(source: string): string {
  return source.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('full project aggregate RPC retirement', () => {
  it('removes get_full_project_data from every Data API role', () => {
    const migration = normalize(read(migrationPath));
    const init = read(initPath);
    const retirementStart = init.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(retirementStart >= 0 ? init.slice(retirementStart) : '');
    const revoke =
      'revoke all on function public.get_full_project_data(uuid) from public, anon, authenticated, service_role;';

    for (const sql of [migration, finalInit]) {
      expect(sql).toContain(revoke);
      expect(sql).not.toContain(
        'grant execute on function public.get_full_project_data(uuid) to authenticated;',
      );
    }
    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it('removes the unsafe feature path and preserves complete segmented loading', () => {
    const loader = read('src/app/core/services/sync/project-detail-loader.service.ts');
    const featureFlags = read('src/config/feature-flags.config.ts');
    const taskLoader = read('src/app/core/services/sync/project-task-data.service.ts');
    const modelTypes = read('src/models/supabase-types.ts');
    const clientTypes = read('src/types/supabase.ts');
    const requestHelpers = read('src/services/supabase-fetch-request.helpers.ts');

    expect(loader).not.toContain("client.rpc('get_full_project_data'");
    expect(loader).not.toContain('batchRpcUnavailable');
    expect(loader).not.toContain('batchRpcTransientCooldownUntil');
    expect(loader).not.toContain('callFullProjectRpcWithRetry');
    expect(loader).not.toContain('FEATURE_FLAGS');
    expect(featureFlags).not.toContain('PROJECT_FULL_DATA_RPC_V1');
    expect(modelTypes).not.toContain('get_full_project_data:');
    expect(clientTypes).not.toContain('get_full_project_data:');
    expect(requestHelpers).not.toContain('get_full_project_data');
    expect(loader).toMatch(
      /loadFullProjectOptimized[\s\S]*?return this\.loadFullProject\(projectId, expectedUserId, dependencies\);/,
    );
    expect(taskLoader).toContain('fetchAllSupabaseKeysetPagesByCursor<');
    expect(taskLoader).toContain('buildTaskCreatedKeysetOrFilter(cursor)');
    expect(taskLoader).toContain('readCursor: readTaskCreatedPageCursor');
    expect(taskLoader).not.toContain('fetchAllSupabasePages<TaskRow>');
    expect(loader).toContain('fetchAllSupabaseKeysetPagesByCursor<');
    expect(loader).toContain("query.gt('id', cursor.id)");
    expect(loader).toContain('this.taskData.pullTasksThrottled(');
  });
});
