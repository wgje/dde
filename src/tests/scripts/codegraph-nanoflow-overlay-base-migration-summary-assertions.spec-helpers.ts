import { expect } from 'vitest';

type ParsedOverlay = ReturnType<typeof JSON.parse>;

export function assertBaseOverlayMigrationSummary(overlay: ParsedOverlay): void {
  const migration = overlay.supabase.migrations.find(
    (entry: { name?: string }) =>
      entry.name === '20260609020000_drop_entity_uuid_defaults.sql',
  );

  expect(migration).toEqual(expect.objectContaining({
    name: '20260609020000_drop_entity_uuid_defaults.sql',
    file: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
    riskTags: ['client-id-policy', 'rls-policy', 'sync-lww', 'secret-safety'],
    policies: ['tasks owner', 'tasks editor', 'tasks insert owner', 'attachments owner upload'],
    tests: ['src/tests/contracts/drop-entity-uuid-defaults.contract.spec.ts'],
  }));
  expect(migration?.affectedTables).toHaveLength(4);
  expect(migration?.affectedTables).toEqual(expect.arrayContaining([
    'public.tasks',
    'tasks',
    'storage.objects',
    'public.projects',
  ]));

  expect(migration?.constraintDetails).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: 'tasks_create_project_fk',
      constraintType: 'foreign-key',
      constraintSource: 'create-table',
      columns: ['project_id'],
      referencedTable: 'public.projects',
      referencedColumns: ['id'],
      onDelete: 'cascade',
    }),
    expect.objectContaining({
      name: 'tasks_project_fk',
      constraintType: 'foreign-key',
      constraintSource: 'alter-table',
      columns: ['project_id'],
      referencedTable: 'public.projects',
      referencedColumns: ['id'],
      onDelete: 'cascade',
      notValid: true,
    }),
  ]));

  expect(migration?.constraintValidationDetails).toEqual([
    {
      name: 'tasks_content_length_check',
      table: 'public.tasks',
      line: 17,
    },
  ]);

  expect(migration?.rlsDetails).toEqual([
    {
      table: 'public.tasks',
      action: 'enable',
      line: 10,
    },
    {
      table: 'public.tasks',
      action: 'force',
      line: 49,
    },
    {
      table: 'public.projects',
      action: 'disable',
      line: 50,
    },
    {
      table: 'public.projects',
      action: 'no-force',
      line: 51,
    },
  ]);
}
