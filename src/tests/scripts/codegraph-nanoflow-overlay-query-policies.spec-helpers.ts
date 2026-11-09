import { expect, it } from 'vitest';

import { registerCodegraphOverlaySupabasePolicyDataQuerySpecs } from './codegraph-nanoflow-overlay-query-policies-data.spec-helpers';
import { registerCodegraphOverlaySupabasePolicyPrivilegeQuerySpecs } from './codegraph-nanoflow-overlay-query-policies-privileges.spec-helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlaySupabasePolicyQuerySpecs(context: CodegraphOverlaySpecContext): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess } = context;

  it('queries Supabase policy command details as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'policy-command', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'policy-command'
    ))).toBe(true);
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks owner',
          relation: 'policy-command',
          command: 'select',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks insert owner',
          relation: 'policy-command',
          command: 'insert',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks editor',
          relation: 'policy-command',
          command: 'all',
        }),
      ]),
    });
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'tasks owner',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({ relation: 'policy' }),
      }),
    ]));
    expect(response.markdown).toContain('## Exploration: policy-command');
    expect(response.markdown).toContain('tasks insert owner');
  });

  it('queries Supabase policy type details without resolving SQL keywords as symbols', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'policy-type', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'policy-type'
    ))).toBe(true);
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks editor',
          relation: 'policy-type',
          type: 'restrictive',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks owner',
          relation: 'policy-type',
          type: 'permissive',
        }),
      ]),
    });
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'restrictive' }),
      expect.objectContaining({ name: 'permissive' }),
    ]));
    expect(response.markdown).toContain('policy-type');
  });

  it('queries Supabase migration indexes as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-index', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'migration-index'
    ))).toBe(true);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_idx',
        kind: 'variable',
        name: 'tasks_content_idx',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-index',
          table: 'public.tasks',
          columns: ['content'],
        }),
      }),
    ]));
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_content_idx',
          relation: 'migration-index',
          indexName: 'tasks_content_idx',
          table: 'public.tasks',
        }),
      ]),
    });
    expect(response.markdown).toContain('relation: migration-index');
    expect(response.markdown).toContain('tasks_content_idx');
  });

  it('queries Supabase migration constraints as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-constraint', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'migration-constraint'
    ))).toBe(true);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_length_check',
        kind: 'variable',
        name: 'tasks_content_length_check',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'check',
          expression: 'char_length(content) <= 1000',
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_project_fk',
        kind: 'variable',
        name: 'tasks_project_fk',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          columns: ['project_id'],
          referencedTable: 'public.projects',
          referencedColumns: ['id'],
          onDelete: 'cascade',
          notValid: true,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_owner_fk',
        kind: 'variable',
        name: 'tasks_owner_fk',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          columns: ['user_id'],
          referencedTable: 'auth.users',
          referencedColumns: [],
          onUpdate: 'restrict',
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_deferred_parent_fk',
        kind: 'variable',
        name: 'tasks_deferred_parent_fk',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          columns: ['parent_id'],
          referencedTable: 'public.tasks',
          referencedColumns: ['id'],
          matchType: 'full',
          onDelete: 'set-null',
          onUpdate: 'cascade',
          deferrable: true,
          initially: 'deferred',
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_action_columns_fk',
        kind: 'variable',
        name: 'tasks_action_columns_fk',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          columns: ['parent_id', 'project_id'],
          referencedTable: 'public.tasks',
          referencedColumns: ['id', 'project_id'],
          onDelete: 'set-null',
          onDeleteColumns: ['parent_id'],
          onUpdate: 'set-default',
          onUpdateColumns: ['project_id'],
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_create_content_check',
        kind: 'variable',
        name: 'tasks_create_content_check',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'check',
          constraintSource: 'create-table',
          expression: "content <> ''",
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_create_unique',
        kind: 'variable',
        name: 'tasks_create_unique',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'unique',
          constraintSource: 'create-table',
          columns: ['content', 'updated_at'],
          nullsDistinct: false,
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_create_project_fk',
        kind: 'variable',
        name: 'tasks_create_project_fk',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          constraintSource: 'create-table',
          columns: ['project_id'],
          referencedTable: 'public.projects',
          referencedColumns: ['id'],
          onDelete: 'cascade',
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_create_exclude',
        kind: 'variable',
        name: 'tasks_create_exclude',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'exclude',
          constraintSource: 'create-table',
          indexMethod: 'gist',
          excludeElements: ['content with ='],
          predicate: 'deleted_at is null',
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_unique',
        kind: 'variable',
        name: 'tasks_content_unique',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'unique',
          columns: ['content', 'user_id'],
          nullsDistinct: false,
          deferrable: true,
          initially: 'immediate',
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_local_pk',
        kind: 'variable',
        name: 'tasks_local_pk',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'primary-key',
          columns: ['id', 'user_id'],
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_exclude',
        kind: 'variable',
        name: 'tasks_content_exclude',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'exclude',
          indexMethod: 'gist',
          excludeElements: ['content with ='],
          predicate: 'deleted_at is null',
          notValid: false,
        }),
      }),
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_existing_unique',
        kind: 'variable',
        name: 'tasks_content_existing_unique',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          table: 'public.tasks',
          constraintType: 'unique',
          usingIndex: 'tasks_content_idx',
          deferrable: false,
          notValid: false,
        }),
      }),
    ]));
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_content_length_check',
          relation: 'migration-constraint',
          constraintName: 'tasks_content_length_check',
          table: 'public.tasks',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_project_fk',
          relation: 'migration-constraint',
          constraintName: 'tasks_project_fk',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          referencedTable: 'public.projects',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_owner_fk',
          relation: 'migration-constraint',
          constraintName: 'tasks_owner_fk',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          referencedTable: 'auth.users',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_deferred_parent_fk',
          relation: 'migration-constraint',
          constraintName: 'tasks_deferred_parent_fk',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          referencedTable: 'public.tasks',
          matchType: 'full',
          deferrable: true,
          initially: 'deferred',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_action_columns_fk',
          relation: 'migration-constraint',
          constraintName: 'tasks_action_columns_fk',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          referencedTable: 'public.tasks',
          onDelete: 'set-null',
          onDeleteColumns: ['parent_id'],
          onUpdate: 'set-default',
          onUpdateColumns: ['project_id'],
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_create_content_check',
          relation: 'migration-constraint',
          constraintName: 'tasks_create_content_check',
          table: 'public.tasks',
          constraintType: 'check',
          constraintSource: 'create-table',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_create_unique',
          relation: 'migration-constraint',
          constraintName: 'tasks_create_unique',
          table: 'public.tasks',
          constraintType: 'unique',
          constraintSource: 'create-table',
          nullsDistinct: false,
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_create_project_fk',
          relation: 'migration-constraint',
          constraintName: 'tasks_create_project_fk',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          constraintSource: 'create-table',
          referencedTable: 'public.projects',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_create_exclude',
          relation: 'migration-constraint',
          constraintName: 'tasks_create_exclude',
          table: 'public.tasks',
          constraintType: 'exclude',
          constraintSource: 'create-table',
          indexMethod: 'gist',
          predicate: 'deleted_at is null',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_content_unique',
          relation: 'migration-constraint',
          constraintName: 'tasks_content_unique',
          table: 'public.tasks',
          constraintType: 'unique',
          nullsDistinct: false,
          deferrable: true,
          initially: 'immediate',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_local_pk',
          relation: 'migration-constraint',
          constraintName: 'tasks_local_pk',
          table: 'public.tasks',
          constraintType: 'primary-key',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_content_exclude',
          relation: 'migration-constraint',
          constraintName: 'tasks_content_exclude',
          table: 'public.tasks',
          constraintType: 'exclude',
          indexMethod: 'gist',
          predicate: 'deleted_at is null',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_content_existing_unique',
          relation: 'migration-constraint',
          constraintName: 'tasks_content_existing_unique',
          table: 'public.tasks',
          constraintType: 'unique',
          usingIndex: 'tasks_content_idx',
          deferrable: false,
        }),
      ]),
    });
    expect(response.markdown).toContain('relation: migration-constraint');
    expect(response.markdown).toContain('tasks_content_length_check');
    expect(response.markdown).toContain('tasks_project_fk');
    expect(response.markdown).toContain('tasks_owner_fk');
    expect(response.markdown).toContain('tasks_deferred_parent_fk');
    expect(response.markdown).toContain('tasks_action_columns_fk');
    expect(response.markdown).toContain('tasks_create_content_check');
    expect(response.markdown).toContain('tasks_create_unique');
    expect(response.markdown).toContain('tasks_create_project_fk');
    expect(response.markdown).toContain('tasks_create_exclude');
    expect(response.markdown).toContain('tasks_content_unique');
    expect(response.markdown).toContain('tasks_local_pk');
    expect(response.markdown).toContain('tasks_content_exclude');
    expect(response.markdown).toContain('tasks_content_existing_unique');
  });

  registerCodegraphOverlaySupabasePolicyPrivilegeQuerySpecs(context);
  registerCodegraphOverlaySupabasePolicyDataQuerySpecs(context);
}
