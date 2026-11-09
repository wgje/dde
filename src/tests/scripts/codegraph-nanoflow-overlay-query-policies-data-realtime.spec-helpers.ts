import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlaySupabasePolicyRealtimeViewDataQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const {
    makeFixture,
    queryOverlay,
    expectSpawnSuccess,
  } = context;

  it('queries Supabase migration realtime publications as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-realtime-publication', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'migration-realtime-publication'
    ))).toBe(true);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-realtime-publication:supabase_realtime:add:public.tasks:56',
        kind: 'variable',
        name: 'supabase_realtime add public.tasks',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-realtime-publication',
          publication: 'supabase_realtime',
          action: 'add',
          table: 'public.tasks',
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-realtime-publication:supabase_realtime:add:public.projects:56',
        kind: 'variable',
        name: 'supabase_realtime add public.projects',
        metadata: expect.objectContaining({
          relation: 'migration-realtime-publication',
          action: 'add',
          table: 'public.projects',
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-realtime-publication:supabase_realtime:drop:public.projects:57',
        kind: 'variable',
        name: 'supabase_realtime drop public.projects',
        metadata: expect.objectContaining({
          relation: 'migration-realtime-publication',
          action: 'drop',
          table: 'public.projects',
        }),
      }),
    ]));
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'supabase_realtime add public.tasks',
          relation: 'migration-realtime-publication',
          publication: 'supabase_realtime',
          action: 'add',
          table: 'public.tasks',
        }),
      ]),
    });
    expect(response.markdown).toContain('relation: migration-realtime-publication');
    expect(response.markdown).toContain('table: public.tasks');
  });

  it('includes publication statement code blocks for strict native realtime publication queries', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-realtime-publication', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThan(0);
    // 同一 ALTER PUBLICATION 语句上的多个 per-table 节点按源码范围去重成一个 code block。
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        content: expect.stringContaining('alter publication supabase_realtime add table public.tasks, public.projects;'),
      }),
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'supabase_realtime drop public.projects',
        content: expect.stringContaining('alter publication supabase_realtime drop table only public.projects;'),
      }),
    ]));
  });

  it('queries Supabase migration views as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-view', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'migration-view'
    ))).toBe(true);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-view:public.active_tasks:52',
        kind: 'variable',
        name: 'public.active_tasks',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        signature: 'view public.active_tasks',
        metadata: expect.objectContaining({
          relation: 'migration-view',
          view: 'public.active_tasks',
          materialized: false,
          orReplace: true,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-view:public.task_stats:54',
        kind: 'variable',
        name: 'public.task_stats',
        signature: 'materialized view public.task_stats',
        metadata: expect.objectContaining({
          relation: 'migration-view',
          view: 'public.task_stats',
          materialized: true,
          orReplace: false,
        }),
      }),
    ]));
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'public.active_tasks',
          relation: 'migration-view',
          view: 'public.active_tasks',
        }),
      ]),
    });
    expect(response.markdown).toContain('relation: migration-view');
  });

  it('includes view statement code blocks for strict native migration view queries', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-view', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThan(0);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'public.active_tasks',
        content: expect.stringContaining('create or replace view public.active_tasks as'),
      }),
    ]));
  });
}
