import { expect } from 'vitest';

type ParsedOverlay = ReturnType<typeof JSON.parse>;

export function assertBaseOverlayMigrationGraph(overlay: ParsedOverlay): void {
    const migrationFileId = 'file:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:20260609020000_drop_entity_uuid_defaults.sql';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationFileId,
      kind: 'file',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      metadata: expect.objectContaining({ platform: 'supabase-migration' }),
    }));
    const migrationFunctionId = 'function:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:public.touch_updated_at';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationFunctionId,
      kind: 'function',
      name: 'public.touch_updated_at',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 24,
      metadata: expect.objectContaining({
        relation: 'sql-function',
        returnType: 'trigger',
        language: 'plpgsql',
        security: 'definer',
      }),
    }));
    const migrationPolicyId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks owner';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationPolicyId,
      kind: 'variable',
      name: 'tasks owner',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 11,
      metadata: expect.objectContaining({
        relation: 'policy',
        table: 'public.tasks',
        command: 'select',
        type: 'permissive',
      }),
    }));
    const migrationTriggerId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_touch:public.tasks:35';
    const duplicateNameTriggerId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_touch:public.projects:36';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationTriggerId,
      kind: 'variable',
      name: 'tasks_touch',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 35,
      signature: 'trigger tasks_touch on public.tasks',
      metadata: expect.objectContaining({
        relation: 'trigger',
        table: 'public.tasks',
        timing: 'before',
        events: ['update'],
        functionName: 'public.touch_updated_at',
      }),
    }));
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: duplicateNameTriggerId,
      kind: 'variable',
      name: 'tasks_touch',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 36,
      signature: 'trigger tasks_touch on public.projects',
      metadata: expect.objectContaining({
        relation: 'trigger',
        table: 'public.projects',
        timing: 'before',
        events: ['update'],
        functionName: 'public.touch_updated_at',
      }),
    }));
    expect(overlay.graph.nodes.filter((node: { metadata?: { relation?: string }; name?: string }) => (
      node.metadata?.relation === 'trigger' && node.name === 'tasks_touch'
    ))).toHaveLength(2);
    const migrationRlsEnableId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-rls:public.tasks:enable:10';
    const migrationRlsForceId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-rls:public.tasks:force:49';
    const migrationRlsDisableId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-rls:public.projects:disable:50';
    const migrationRlsNoForceId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:migration-rls:public.projects:no-force:51';
    expect(overlay.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: migrationRlsEnableId,
        kind: 'variable',
        name: 'public.tasks rls enable',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        startLine: 10,
        signature: 'rls enable on public.tasks',
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.tasks',
          action: 'enable',
        }),
      }),
      expect.objectContaining({
        id: migrationRlsForceId,
        kind: 'variable',
        name: 'public.tasks rls force',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        startLine: 49,
        signature: 'rls force on public.tasks',
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.tasks',
          action: 'force',
        }),
      }),
      expect.objectContaining({
        id: migrationRlsDisableId,
        kind: 'variable',
        name: 'public.projects rls disable',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        startLine: 50,
        signature: 'rls disable on public.projects',
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.projects',
          action: 'disable',
        }),
      }),
      expect.objectContaining({
        id: migrationRlsNoForceId,
        kind: 'variable',
        name: 'public.projects rls no-force',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        startLine: 51,
        signature: 'rls no-force on public.projects',
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.projects',
          action: 'no-force',
        }),
      }),
    ]));
    const migrationIndexId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_idx';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationIndexId,
      kind: 'variable',
      name: 'tasks_content_idx',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 15,
      signature: 'index tasks_content_idx on public.tasks (content)',
      metadata: expect.objectContaining({
        relation: 'migration-index',
        table: 'public.tasks',
        columns: ['content'],
        unique: false,
        concurrently: false,
      }),
    }));
    const createTableCheckConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_create_content_check';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: createTableCheckConstraintId,
      kind: 'variable',
      name: 'tasks_create_content_check',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 5,
      signature: 'constraint tasks_create_content_check on public.tasks check',
      metadata: expect.objectContaining({
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'check',
        expression: "content <> ''",
        notValid: false,
      }),
    }));
    const createTableUniqueConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_create_unique';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: createTableUniqueConstraintId,
      kind: 'variable',
      name: 'tasks_create_unique',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 6,
      signature: 'constraint tasks_create_unique on public.tasks unique',
      metadata: expect.objectContaining({
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'unique',
        columns: ['content', 'updated_at'],
        nullsDistinct: false,
        notValid: false,
      }),
    }));
    const createTableForeignKeyConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_create_project_fk';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: createTableForeignKeyConstraintId,
      kind: 'variable',
      name: 'tasks_create_project_fk',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 7,
      signature: 'constraint tasks_create_project_fk on public.tasks foreign-key',
      metadata: expect.objectContaining({
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'foreign-key',
        columns: ['project_id'],
        referencedTable: 'public.projects',
        referencedColumns: ['id'],
        onDelete: 'cascade',
        notValid: false,
      }),
    }));
    const createTableExcludeConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_create_exclude';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: createTableExcludeConstraintId,
      kind: 'variable',
      name: 'tasks_create_exclude',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 8,
      signature: 'constraint tasks_create_exclude on public.tasks exclude',
      metadata: expect.objectContaining({
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'exclude',
        indexMethod: 'gist',
        excludeElements: ['content with ='],
        predicate: 'deleted_at is null',
        notValid: false,
      }),
    }));
    const migrationConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_length_check';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationConstraintId,
      kind: 'variable',
      name: 'tasks_content_length_check',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 16,
      signature: 'constraint tasks_content_length_check on public.tasks check',
      metadata: expect.objectContaining({
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'check',
        expression: 'char_length(content) <= 1000',
        notValid: true,
      }),
    }));
    const migrationForeignKeyConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_project_fk';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationForeignKeyConstraintId,
      kind: 'variable',
      name: 'tasks_project_fk',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 18,
      signature: 'constraint tasks_project_fk on public.tasks foreign-key',
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
    }));
    const migrationForeignKeyWithoutReferencedColumnsId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_owner_fk';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationForeignKeyWithoutReferencedColumnsId,
      kind: 'variable',
      name: 'tasks_owner_fk',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 19,
      signature: 'constraint tasks_owner_fk on public.tasks foreign-key',
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
    }));
    const migrationDeferredForeignKeyConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_deferred_parent_fk';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationDeferredForeignKeyConstraintId,
      kind: 'variable',
      name: 'tasks_deferred_parent_fk',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 20,
      signature: 'constraint tasks_deferred_parent_fk on public.tasks foreign-key',
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
    }));
    const migrationForeignKeyActionColumnsId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_action_columns_fk';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationForeignKeyActionColumnsId,
      kind: 'variable',
      name: 'tasks_action_columns_fk',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 21,
      signature: 'constraint tasks_action_columns_fk on public.tasks foreign-key',
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
    }));
    const migrationUniqueConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_unique';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationUniqueConstraintId,
      kind: 'variable',
      name: 'tasks_content_unique',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 45,
      signature: 'constraint tasks_content_unique on public.tasks unique',
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
    }));
    const migrationPrimaryKeyConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_local_pk';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationPrimaryKeyConstraintId,
      kind: 'variable',
      name: 'tasks_local_pk',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 46,
      signature: 'constraint tasks_local_pk on public.tasks primary-key',
      metadata: expect.objectContaining({
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'primary-key',
        columns: ['id', 'user_id'],
        notValid: false,
      }),
    }));
    const migrationExcludeConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_exclude';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationExcludeConstraintId,
      kind: 'variable',
      name: 'tasks_content_exclude',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 47,
      signature: 'constraint tasks_content_exclude on public.tasks exclude',
      metadata: expect.objectContaining({
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'exclude',
        indexMethod: 'gist',
        excludeElements: ['content with ='],
        predicate: 'deleted_at is null',
        notValid: false,
      }),
    }));
    const migrationUsingIndexConstraintId = 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_existing_unique';
    expect(overlay.graph.nodes).toContainEqual(expect.objectContaining({
      id: migrationUsingIndexConstraintId,
      kind: 'variable',
      name: 'tasks_content_existing_unique',
      filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      startLine: 48,
      signature: 'constraint tasks_content_existing_unique on public.tasks unique',
      metadata: expect.objectContaining({
        relation: 'migration-constraint',
        table: 'public.tasks',
        constraintType: 'unique',
        usingIndex: 'tasks_content_idx',
        deferrable: false,
        notValid: false,
      }),
    }));
    expect(overlay.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        metadata: expect.objectContaining({ relation: 'table' }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationFunctionId,
        metadata: expect.objectContaining({
          relation: 'sql-function',
          functionName: 'public.touch_updated_at',
          returnType: 'trigger',
          language: 'plpgsql',
          security: 'definer',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationTriggerId,
        metadata: expect.objectContaining({
          relation: 'trigger',
          trigger: 'tasks_touch',
          table: 'public.tasks',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        metadata: expect.objectContaining({
          relation: 'trigger-function',
          trigger: 'tasks_touch',
          functionName: 'public.touch_updated_at',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationRlsEnableId,
        line: 10,
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.tasks',
          action: 'enable',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationRlsForceId,
        line: 49,
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.tasks',
          action: 'force',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationRlsDisableId,
        line: 50,
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.projects',
          action: 'disable',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationRlsNoForceId,
        line: 51,
        metadata: expect.objectContaining({
          relation: 'migration-rls',
          table: 'public.projects',
          action: 'no-force',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationIndexId,
        metadata: expect.objectContaining({
          relation: 'migration-index',
          indexName: 'tasks_content_idx',
          table: 'public.tasks',
          columns: ['content'],
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: createTableCheckConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_create_content_check',
          table: 'public.tasks',
          constraintType: 'check',
          expression: "content <> ''",
          notValid: false,
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: createTableUniqueConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_create_unique',
          table: 'public.tasks',
          constraintType: 'unique',
          columns: ['content', 'updated_at'],
          nullsDistinct: false,
          notValid: false,
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: createTableForeignKeyConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_create_project_fk',
          table: 'public.tasks',
          constraintType: 'foreign-key',
          columns: ['project_id'],
          referencedTable: 'public.projects',
          referencedColumns: ['id'],
          onDelete: 'cascade',
          notValid: false,
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: createTableExcludeConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_create_exclude',
          table: 'public.tasks',
          constraintType: 'exclude',
          indexMethod: 'gist',
          excludeElements: ['content with ='],
          predicate: 'deleted_at is null',
          notValid: false,
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_content_length_check',
          table: 'public.tasks',
          constraintType: 'check',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationForeignKeyConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_project_fk',
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
        kind: 'references',
        source: migrationFileId,
        target: migrationForeignKeyWithoutReferencedColumnsId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_owner_fk',
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
        kind: 'references',
        source: migrationFileId,
        target: migrationDeferredForeignKeyConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_deferred_parent_fk',
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
        kind: 'references',
        source: migrationFileId,
        target: migrationForeignKeyActionColumnsId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_action_columns_fk',
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
        kind: 'references',
        source: migrationFileId,
        target: migrationUniqueConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_content_unique',
          table: 'public.tasks',
          constraintType: 'unique',
          columns: ['content', 'user_id'],
          nullsDistinct: false,
          deferrable: true,
          initially: 'immediate',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationPrimaryKeyConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_local_pk',
          table: 'public.tasks',
          constraintType: 'primary-key',
          columns: ['id', 'user_id'],
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationExcludeConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_content_exclude',
          table: 'public.tasks',
          constraintType: 'exclude',
          indexMethod: 'gist',
          excludeElements: ['content with ='],
          predicate: 'deleted_at is null',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationUsingIndexConstraintId,
        metadata: expect.objectContaining({
          relation: 'migration-constraint',
          constraintName: 'tasks_content_existing_unique',
          table: 'public.tasks',
          constraintType: 'unique',
          usingIndex: 'tasks_content_idx',
          deferrable: false,
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: migrationConstraintId,
        line: 17,
        metadata: expect.objectContaining({
          relation: 'migration-constraint-validation',
          constraintName: 'tasks_content_length_check',
          table: 'public.tasks',
        }),
      }),
      expect.objectContaining({ kind: 'decorates', source: migrationFileId, metadata: expect.objectContaining({ relation: 'policy' }) }),
      expect.objectContaining({ kind: 'references', source: migrationFileId, metadata: expect.objectContaining({ relation: 'policy-command', command: 'select' }) }),
      expect.objectContaining({ kind: 'references', source: migrationFileId, metadata: expect.objectContaining({ relation: 'policy-command', command: 'all' }) }),
      expect.objectContaining({ kind: 'references', source: migrationFileId, metadata: expect.objectContaining({ relation: 'policy-type', type: 'restrictive' }) }),
      expect.objectContaining({ kind: 'references', source: migrationFileId, metadata: expect.objectContaining({ relation: 'policy-role', role: 'authenticated' }) }),
      expect.objectContaining({ kind: 'references', source: migrationFileId, metadata: expect.objectContaining({ relation: 'policy-using' }) }),
      expect.objectContaining({ kind: 'references', source: migrationFileId, metadata: expect.objectContaining({ relation: 'policy-with-check' }) }),
      expect.objectContaining({ kind: 'decorates', source: migrationFileId, metadata: expect.objectContaining({ relation: 'risk-tag' }) }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        metadata: expect.objectContaining({
          relation: 'privilege-revoke',
          action: 'revoke',
          privilege: 'truncate',
          objectType: 'table',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        metadata: expect.objectContaining({
          relation: 'privilege-object',
          action: 'revoke',
          objectType: 'table',
          objectName: 'public.tasks',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        metadata: expect.objectContaining({
          relation: 'privilege-object',
          action: 'revoke',
          objectType: 'function',
          objectName: 'public.append_task_attachment(p_task_id uuid, p_attachment jsonb)',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        metadata: expect.objectContaining({
          relation: 'privilege-role',
          action: 'revoke',
          role: 'authenticated',
        }),
      }),
      expect.objectContaining({
        kind: 'references',
        source: migrationFileId,
        target: 'file:src/tests/contracts/drop-entity-uuid-defaults.contract.spec.ts:src/tests/contracts/drop-entity-uuid-defaults.contract.spec.ts',
        metadata: expect.objectContaining({
          relation: 'test',
          testMapping: 'filename-reference',
          matchedNeedle: '20260609020000_drop_entity_uuid_defaults.sql',
        }),
      }),
    ]));
    expect(overlay.graph.edges.filter((edge: { source: string }) => edge.source.startsWith('variable:supabase/migrations/'))).toEqual([]);
}
