import { expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import {
  writeOverlayFixture,
} from './codegraph-nanoflow-overlay-query-policies-data-fixtures';

export function registerCodegraphOverlaySupabasePolicyConstraintDataQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    makeFixture,
    queryOverlay,
    expectSpawnSuccess,
    tempRoots,
    writeFile,
  } = context;

  it('queries Supabase migration constraint validation as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-constraint-validation', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'migration-constraint-validation'
    ))).toBe(true);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'variable:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:tasks_content_length_check',
        kind: 'variable',
        name: 'tasks_content_length_check',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
      }),
    ]));
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'tasks_content_length_check',
          relation: 'migration-constraint-validation',
          constraintName: 'tasks_content_length_check',
          table: 'public.tasks',
        }),
      ]),
    });
    expect(response.markdown).toContain('relation: migration-constraint-validation');
    expect(response.markdown).toContain('tasks_content_length_check');
  });

  it('includes validation statement code blocks for strict native migration constraint validation queries', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'migration-constraint-validation', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThan(0);
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'file',
        content: expect.stringContaining('validate constraint "tasks_content_length_check"'),
      }),
    ]));
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      nodeKind: 'file',
      content: expect.stringContaining('validate constraint'),
    }));
  });

  it('targets same-name migration constraint validations by table scope', () => {
    const root = makeFixture();
    const migrationFile = 'supabase/migrations/20260614025000_same_name_constraint_validation.sql';
    writeFile(
      root,
      migrationFile,
      [
        'alter table public.alpha add constraint shared_check check (id is not null) not valid;',
        'alter table public.beta add constraint shared_check check (id is not null) not valid;',
        'alter table public.beta validate constraint shared_check;',
        '',
      ].join('\n'),
    );

    const result = queryOverlay(root, 'migration-constraint-validation', ['--limit', '50', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `variable:${migrationFile}:constraint:shared_check:public.beta:2`,
        kind: 'variable',
        name: 'shared_check',
        filePath: migrationFile,
      }),
    ]));
    expect(response.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'references',
        source: `file:${migrationFile}:20260614025000_same_name_constraint_validation.sql`,
        target: `variable:${migrationFile}:constraint:shared_check:public.beta:2`,
      }),
    ]));
  });

  it('keeps validation statement code blocks within the native code block budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-validation-codeblock-budget-'));
    tempRoots.push(root);
    const migrationFile = 'supabase/migrations/20260614010000_validate_constraints.sql';
    const constraintNames = [
      'alpha_check',
      'beta_check',
      'gamma_check',
      'delta_check',
      'epsilon_check',
      'zeta_check',
    ];
    writeFile(
      root,
      migrationFile,
      [
        ...constraintNames.map(name => `alter table public.tasks validate constraint ${name};`),
        '',
      ].join('\n'),
    );
    const fileNode = {
      id: `file:${migrationFile}`,
      kind: 'file',
      name: '20260614010000_validate_constraints.sql',
      qualifiedName: migrationFile,
      filePath: migrationFile,
      language: 'unknown',
      startLine: 1,
      endLine: constraintNames.length,
    };
    const constraintNodes = constraintNames.map((name, index) => ({
      id: `variable:${migrationFile}:${name}`,
      kind: 'variable',
      name,
      qualifiedName: name,
      filePath: migrationFile,
      language: 'unknown',
      startLine: index + 1,
      endLine: index + 1,
    }));
    writeOverlayFixture(root, {
      nodes: [fileNode, ...constraintNodes],
      edges: constraintNames.map((name, index) => ({
        source: fileNode.id,
        target: constraintNodes[index].id,
        kind: 'references',
        line: index + 1,
        column: 0,
        metadata: {
          relation: 'migration-constraint-validation',
          constraintName: name,
          table: 'public.tasks',
        },
      })),
    });

    const result = queryOverlay(root, 'migration-constraint-validation', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBe(constraintNames.length);
    expect(response.codeBlocks.length).toBeLessThanOrEqual(5);
    expect(response.codeBlocks.every((block: { content?: string }) => (
      block.content?.includes('validate constraint')
    ))).toBe(true);
  });
}
