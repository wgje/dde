import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayAgentSyncFieldQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess } = context;

  it('queries AGENTS required sync fields against Supabase select field sources', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'sync-required-field', ['--limit', '30']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:AGENTS.md:hard-rule-keyword:5.2 Offline-first:content',
        kind: 'variable',
        name: 'content',
        filePath: 'AGENTS.md',
        metadata: expect.objectContaining({
          relation: 'hard-rule-keyword',
          keywordMapping: 'hard-rule-keyword',
          matchedNeedle: 'content',
        }),
      }),
      expect.objectContaining({
        id: 'property:src/config/field-select.config.ts:FIELD_SELECT_CONFIG.TASK_LIST_FIELDS.content',
        kind: 'property',
        name: 'content',
        qualifiedName: 'FIELD_SELECT_CONFIG.TASK_LIST_FIELDS::content',
        filePath: 'src/config/field-select.config.ts',
        metadata: expect.objectContaining({
          relation: 'supabase-select-field',
          table: 'tasks',
          field: 'content',
          selectConfig: 'FIELD_SELECT_CONFIG.TASK_LIST_FIELDS',
        }),
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: 'variable:AGENTS.md:hard-rule-keyword:5.2 Offline-first:content',
        target: 'property:src/config/field-select.config.ts:FIELD_SELECT_CONFIG.TASK_LIST_FIELDS.content',
        metadata: expect.objectContaining({
          relation: 'sync-required-field',
          field: 'content',
          table: 'tasks',
          requiredBy: 'AGENTS.md',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: 'method:src/app/core/services/sync/task-sync-query.service.ts:TaskSyncQueryService.loadTaskRows',
        target: 'property:src/config/field-select.config.ts:FIELD_SELECT_CONFIG.TASK_LIST_FIELDS.content',
        metadata: expect.objectContaining({
          relation: 'supabase-select-field',
          field: 'content',
          table: 'tasks',
          selectConfig: 'FIELD_SELECT_CONFIG.TASK_LIST_FIELDS',
        }),
      }),
    ]));
    expect(response.relationshipGroups.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'content',
        target: 'content',
        relation: 'sync-required-field',
        field: 'content',
      }),
    ]));
    expect(response.markdown).toContain('relation: sync-required-field');
  });

  it('keeps AGENTS sync-rule keyword anchors separate from same-name project symbols', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'sync-rule-keyword', ['--limit', '40']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    const updatedAtEdges = response.edges.filter((edge: { metadata?: { keyword?: string } }) => (
      edge.metadata?.keyword === 'updated_at'
    ));
    expect(updatedAtEdges).toHaveLength(1);
    expect(updatedAtEdges[0]).toEqual(expect.objectContaining({
      target: expect.stringContaining('AGENTS.md'),
    }));
    expect(updatedAtEdges[0].target).not.toContain('src/app/features/sample/sync-column-collision.ts');
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'updated_at',
        filePath: 'AGENTS.md',
        startLine: 9,
        metadata: expect.objectContaining({
          relation: 'sync-rule-keyword',
          ownerHeading: '5.2 Offline-first',
          rule: 'Read path',
        }),
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'updated_at',
        filePath: 'src/app/features/sample/sync-column-collision.ts',
      }),
    ]));
  });
}
