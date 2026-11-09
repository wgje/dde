import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAgentPredicateQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess } = context;

  it('queries AGENTS incremental sync predicates against Supabase filter sources', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'supabase-incremental-predicate', ['--limit', '30']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:updated_at',
        kind: 'variable',
        name: 'updated_at',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          ownerHeading: '5.2 Offline-first',
          rule: 'Read path',
        }),
      }),
      expect.objectContaining({
        id: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:last_sync_time',
        kind: 'variable',
        name: 'last_sync_time',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          ownerHeading: '5.2 Offline-first',
          rule: 'Read path',
        }),
      }),
      expect.objectContaining({
        id: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gte:TaskSyncQueryService.loadTaskRows',
        kind: 'variable',
        name: 'updated_at > last_sync_time',
        filePath: 'src/app/core/services/sync/task-sync-query.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-incremental-predicate',
          table: 'tasks',
          column: 'updated_at',
          operator: 'gte',
          cursor: 'lastSyncTime',
        }),
      }),
      expect.objectContaining({
        id: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gt:TaskSyncQueryService.hasTaskUpdates',
        kind: 'variable',
        name: 'updated_at > last_sync_time',
        filePath: 'src/app/core/services/sync/task-sync-query.service.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-incremental-predicate',
          table: 'tasks',
          column: 'updated_at',
          operator: 'gt',
          cursor: 'since',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/app/core/services/sync/task-sync-query.service.ts:TaskSyncQueryService.loadTaskRows',
        target: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gte:TaskSyncQueryService.loadTaskRows',
        metadata: expect.objectContaining({
          relation: 'supabase-incremental-predicate',
          table: 'tasks',
          column: 'updated_at',
          operator: 'gte',
          cursor: 'lastSyncTime',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/app/core/services/sync/task-sync-query.service.ts:TaskSyncQueryService.hasTaskUpdates',
        target: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gt:TaskSyncQueryService.hasTaskUpdates',
        metadata: expect.objectContaining({
          relation: 'supabase-incremental-predicate',
          table: 'tasks',
          column: 'updated_at',
          operator: 'gt',
          cursor: 'since',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:updated_at',
        target: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gte:TaskSyncQueryService.loadTaskRows',
        metadata: expect.objectContaining({
          relation: 'sync-required-predicate',
          table: 'tasks',
          column: 'updated_at',
          requiredBy: 'AGENTS.md',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:last_sync_time',
        target: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gte:TaskSyncQueryService.loadTaskRows',
        metadata: expect.objectContaining({
          relation: 'sync-required-predicate',
          table: 'tasks',
          column: 'updated_at',
          requiredBy: 'AGENTS.md',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:last_sync_time',
        target: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gt:TaskSyncQueryService.hasTaskUpdates',
        metadata: expect.objectContaining({
          relation: 'sync-required-predicate',
          table: 'tasks',
          column: 'updated_at',
          operator: 'gt',
          cursor: 'since',
          requiredBy: 'AGENTS.md',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'loadTaskRows',
        target: 'updated_at > last_sync_time',
        relation: 'supabase-incremental-predicate',
      }),
      expect.objectContaining({
        source: 'updated_at',
        target: 'updated_at > last_sync_time',
        relation: 'sync-required-predicate',
      }),
      expect.objectContaining({
        source: 'last_sync_time',
        target: 'updated_at > last_sync_time',
        relation: 'sync-required-predicate',
      }),
    ]));
    expect(response.markdown).toContain('relation: supabase-incremental-predicate');
    expect(response.markdown).toContain('relation: sync-required-predicate');

    const requiredResult = queryOverlay(root, 'sync-required-predicate', ['--limit', '30']);
    expectSpawnSuccess(requiredResult);
    const requiredResponse = JSON.parse(requiredResult.stdout);
    expect(requiredResponse.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:last_sync_time',
        target: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gt:TaskSyncQueryService.hasTaskUpdates',
        metadata: expect.objectContaining({
          relation: 'sync-required-predicate',
          cursor: 'since',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/app/core/services/sync/task-sync-query.service.ts:TaskSyncQueryService.hasTaskUpdates',
        target: 'variable:src/app/core/services/sync/task-sync-query.service.ts:supabase-incremental-predicate:tasks:updated_at:gt:TaskSyncQueryService.hasTaskUpdates',
        metadata: expect.objectContaining({
          relation: 'supabase-incremental-predicate',
          cursor: 'since',
        }),
      }),
    ]));
    expect(requiredResponse.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'hasTaskUpdates',
        target: 'updated_at > last_sync_time',
        relation: 'supabase-incremental-predicate',
      }),
    ]));
    expect(requiredResponse.markdown).toContain('relation: supabase-incremental-predicate');
  });
}
