import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath =
  'supabase/migrations/20260716002300_bounded_project_head_keyset_rpc.sql';
const initPath = 'scripts/init-supabase.sql';
const retirementMarker =
  '-- Legacy unbounded project-head RPC retired after bounded keyset convergence.';

function read(relativePath: string): string {
  const absolutePath = path.join(process.cwd(), relativePath);
  expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
}

function normalize(source: string): string {
  return source.replace(/--[^\r\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

describe('bounded project-head keyset RPC', () => {
  it('creates a bounded composite-cursor page and retires the unbounded RPC', () => {
    const migration = normalize(read(migrationPath));
    const initSource = read(initPath);
    const retirementStart = initSource.lastIndexOf(retirementMarker);
    expect(retirementStart).toBeGreaterThanOrEqual(0);
    const finalInit = normalize(retirementStart >= 0 ? initSource.slice(retirementStart) : '');
    const activeSignature =
      'public.list_project_heads_page(timestamptz, timestamptz, timestamptz, uuid, integer)';
    const retiredSignature = 'public.list_project_heads_since(timestamptz)';

    for (const sql of [migration, finalInit]) {
      expect(sql).toContain('create or replace function public.list_project_heads_page(');
      expect(sql).toContain(
        'p_since timestamptz, p_until timestamptz, p_after_updated_at timestamptz, p_after_project_id uuid, p_limit integer',
      );
      expect(sql).toContain('order by pc.updated_at asc, pc.project_id asc');
      expect(sql).toContain('(pc.updated_at, pc.project_id) > (p_after_updated_at, p_after_project_id)');
      expect(sql).toContain('pc.updated_at <= p_until');
      expect(sql).toContain('limit p_limit');
      expect(sql).toContain(
        `revoke all on function ${activeSignature} from public, anon, authenticated, service_role;`,
      );
      expect(sql).toContain(`grant execute on function ${activeSignature} to authenticated;`);
      expect(sql).toContain(
        `revoke all on function ${retiredSignature} from public, anon, authenticated, service_role;`,
      );
      expect(sql).not.toContain(`grant execute on function ${retiredSignature} to authenticated;`);
    }
    expect(migration).toContain("errcode = '22023'");
    expect(migration).toContain("notify pgrst, 'reload schema';");
  });

  it('uses the bounded RPC from the client and keeps page failures distinct from empty pages', () => {
    const probe = read('src/app/core/services/sync/project-sync-probe.service.ts');
    const refresh = read('src/services/sync-coordinator-project-refresh.service.ts');
    const types = read('src/models/supabase-types.ts');

    expect(probe).toContain('export const PROJECT_HEAD_PAGE_SIZE = 100;');
    expect(probe).toContain("client.rpc('list_project_heads_page'");
    expect(probe).not.toContain("client.rpc('list_project_heads_since'");
    expect(probe).toContain('p_after_updated_at: afterUpdatedAt');
    expect(probe).toContain('p_after_project_id: afterProjectId');
    expect(probe).toContain('p_until: upperWatermark');
    expect(probe).toContain('return null;');
    expect(refresh).toContain('if (changedProjects === null)');
    expect(types).toContain('list_project_heads_page:');
    expect(types).not.toContain('list_project_heads_since:');
  });
});
