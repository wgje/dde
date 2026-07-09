import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlaySupabasePolicyPrivilegeQuerySpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { makeFixture, queryOverlay, expectSpawnSuccess, repoRoot, queryScriptPath } = context;
  const queryNativeMarkdown = (root: string, query: string) => spawnSync(process.execPath, [
    queryScriptPath,
    '--root',
    root,
    '--query',
    query,
    '--limit',
    '20',
    '--native-markdown',
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const nativeMarkdownCodeSection = (stdout: string): string => stdout.slice(stdout.indexOf('### Code'));

  it('queries Supabase privilege revokes as focused native relationships', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'privilege-revoke', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'privilege-revoke'
    ))).toBe(true);
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'truncate',
          relation: 'privilege-revoke',
          action: 'revoke',
          objectType: 'table',
          objectName: 'public.tasks',
          role: 'authenticated',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'select',
          relation: 'privilege-revoke',
          action: 'revoke',
          objectType: 'tables-in-schema',
          objectName: 'public',
          role: 'authenticated',
          grantOptionFor: true,
          revokeBehavior: 'restrict',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'usage',
          relation: 'privilege-revoke',
          action: 'revoke',
          objectType: 'schema',
          objectName: 'public',
          role: 'authenticated',
          revokeBehavior: 'cascade',
        }),
      ]),
    });
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'truncate',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({ relation: 'privilege' }),
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'authenticated', metadata: expect.objectContaining({ relation: 'external-reference' }) }),
    ]));
    expect(response.markdown).toContain('privilege-revoke');
  });

  it('queries Supabase privilege grants as focused native relationships without splitting function arguments', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'privilege-grant', ['--limit', '20']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.displayEdges.length).toBeGreaterThan(0);
    expect(response.displayEdges.every((edge: { metadata?: { relation?: string } }) => (
      edge.metadata?.relation === 'privilege-grant'
    ))).toBe(true);
    expect(response.relationshipGroups).toEqual({
      references: expect.arrayContaining([
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'execute',
          relation: 'privilege-grant',
          action: 'grant',
          objectType: 'function',
          objectName: 'public.append_task_attachment(p_task_id uuid, p_attachment jsonb)',
          role: 'service_role',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'execute',
          relation: 'privilege-grant',
          action: 'grant',
          objectType: 'function',
          objectName: 'public.append_task_attachment(p_task_id uuid, p_attachment jsonb)',
          role: 'authenticated',
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'select',
          relation: 'privilege-grant',
          action: 'grant',
          objectType: 'tables-in-schema',
          objectName: 'public',
          role: 'authenticated',
          grantOption: true,
        }),
        expect.objectContaining({
          source: '20260609020000_drop_entity_uuid_defaults.sql',
          target: 'update',
          relation: 'privilege-grant',
          action: 'grant',
          objectType: 'tables-in-schema',
          objectName: 'storage',
          role: 'authenticated',
          grantOption: true,
        }),
      ]),
    });
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'execute',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'privilege',
          objectNames: ['public.append_task_attachment(p_task_id uuid, p_attachment jsonb)'],
          roles: ['service_role', 'authenticated'],
        }),
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'select',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        metadata: expect.objectContaining({
          relation: 'privilege',
          action: 'grant',
          objectType: 'tables-in-schema',
          objectNames: ['public', 'storage'],
          roles: ['authenticated'],
          grantOption: true,
        }),
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'p_attachment jsonb)',
      }),
    ]));
    expect(response.markdown).toContain('privilege-grant');
  });

  it('keeps privilege grant strict native endpoints closed with complete function statement evidence', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'privilege-grant', ['--limit', '20', '--native-json']);
    const markdownResult = queryNativeMarkdown(root, 'privilege-grant');

    expectSpawnSuccess(result);
    expectSpawnSuccess(markdownResult);
    const response = JSON.parse(result.stdout);
    const nodeIds = new Set(response.nodes.map((node: { id: string }) => node.id));
    expect(response.edges.length).toBeGreaterThan(0);
    expect(response.edges.every((edge: { source: string; target: string; metadata?: unknown; sourceName?: unknown; targetName?: unknown }) => (
      nodeIds.has(edge.source)
      && nodeIds.has(edge.target)
      && edge.metadata === undefined
      && edge.sourceName === undefined
      && edge.targetName === undefined
    ))).toBe(true);
    expect(response.edges.every((edge: Record<string, unknown>) => (
      Object.keys(edge).every(key => ['source', 'target', 'kind', 'line', 'column'].includes(key))
    ))).toBe(true);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'file:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:20260609020000_drop_entity_uuid_defaults.sql',
        kind: 'file',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'execute',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        startLine: 38,
      }),
    ]));
    expect(response.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'p_attachment jsonb)',
      }),
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'execute',
        content: expect.stringContaining('grant execute on function public.append_task_attachment(p_task_id uuid, p_attachment jsonb) to service_role, authenticated;'),
      }),
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'select',
        content: expect.stringContaining('grant select, update on all tables in schema public, storage to authenticated with grant option;'),
      }),
    ]));
    expect(response.relatedFiles).toEqual(expect.arrayContaining([
      'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
    ]));

    const markdownCode = nativeMarkdownCodeSection(markdownResult.stdout);
    expect(markdownCode).toContain('### Code');
    expect(markdownCode).toContain('grant execute on function public.append_task_attachment(p_task_id uuid, p_attachment jsonb) to service_role, authenticated;');
    expect(markdownCode).toContain('grant select, update on all tables in schema public, storage to authenticated with grant option;');
    expect(markdownCode).not.toContain('### Relationships');
    expect(markdownCode).not.toContain('### NanoFlow Coverage');
  });

  it('keeps privilege revoke strict native endpoints closed with statement evidence', () => {
    const root = makeFixture();

    const result = queryOverlay(root, 'privilege-revoke', ['--limit', '20', '--native-json']);
    const markdownResult = queryNativeMarkdown(root, 'privilege-revoke');

    expectSpawnSuccess(result);
    expectSpawnSuccess(markdownResult);
    const response = JSON.parse(result.stdout);
    const nodeIds = new Set(response.nodes.map((node: { id: string }) => node.id));
    expect(response.edges.length).toBeGreaterThan(0);
    expect(response.edges.every((edge: { source: string; target: string; metadata?: unknown; sourceName?: unknown; targetName?: unknown }) => (
      nodeIds.has(edge.source)
      && nodeIds.has(edge.target)
      && edge.metadata === undefined
      && edge.sourceName === undefined
      && edge.targetName === undefined
    ))).toBe(true);
    expect(response.edges.every((edge: Record<string, unknown>) => (
      Object.keys(edge).every(key => ['source', 'target', 'kind', 'line', 'column'].includes(key))
    ))).toBe(true);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'file:supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql:20260609020000_drop_entity_uuid_defaults.sql',
        kind: 'file',
      }),
      expect.objectContaining({
        kind: 'variable',
        name: 'truncate',
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        startLine: 39,
      }),
    ]));
    expect(response.codeBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'truncate',
        content: expect.stringContaining('revoke truncate on table public.tasks from authenticated;'),
      }),
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'select',
        content: expect.stringContaining('revoke grant option for select on all tables in schema public from authenticated restrict;'),
      }),
      expect.objectContaining({
        filePath: 'supabase/migrations/20260609020000_drop_entity_uuid_defaults.sql',
        nodeKind: 'variable',
        nodeName: 'usage',
        content: expect.stringContaining('revoke usage on schema public from authenticated granted by postgres cascade;'),
      }),
    ]));

    const markdownCode = nativeMarkdownCodeSection(markdownResult.stdout);
    expect(markdownCode).toContain('### Code');
    expect(markdownCode).toContain('revoke truncate on table public.tasks from authenticated;');
    expect(markdownCode).toContain('revoke grant option for select on all tables in schema public from authenticated restrict;');
    expect(markdownCode).toContain('revoke usage on schema public from authenticated granted by postgres cascade;');
    expect(markdownCode).not.toContain('### Relationships');
    expect(markdownCode).not.toContain('### NanoFlow Coverage');
  });
}
