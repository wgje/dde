import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionIncrementalPredicateOwnerCodeBudgetSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots, queryScriptPath, repoRoot } = context;

  it('prioritizes incremental predicate owner methods without duplicating predicate variables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-incremental-predicate-source-budget-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/project-delta.service.ts';
    writeFile(root, serviceFile, [
      'export class ProjectDeltaService {',
      '  async loadDeltaRows(client: { from(table: string): unknown }, since: string): Promise<unknown> {',
      "    return client.from('tasks')",
      "      .select('id,content,updated_at')",
      "      .gt('updated_at', since)",
      "      .order('updated_at', { ascending: true });",
      '  }',
      '}',
      '',
    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:ProjectDeltaService::loadDeltaRows`,
      kind: 'method',
      name: 'loadDeltaRows',
      qualifiedName: 'ProjectDeltaService::loadDeltaRows',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 7,
    };
    const predicateNode = {
      id: `variable:${serviceFile}:supabase-incremental-predicate:tasks:updated_at:gt:ProjectDeltaService.loadDeltaRows`,
      kind: 'variable',
      name: 'updated_at > last_sync_time',
      qualifiedName: 'ProjectDeltaService.loadDeltaRows::updated_at>last_sync_time',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 5,
      endLine: 5,
      signature: 'tasks.updated_at gt since',
      metadata: { relation: 'supabase-incremental-predicate' },
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [serviceFile],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
      },
      graph: {
        nodes: [methodNode, predicateNode],
        edges: [
          {
            source: methodNode.id,
            target: predicateNode.id,
            kind: 'references',
            line: 5,
            column: 7,
            metadata: {
              relation: 'supabase-incremental-predicate',
              table: 'tasks',
              column: 'updated_at',
              operator: 'gt',
              cursor: 'since',
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'supabase-incremental-predicate', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBe(1);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'loadDeltaRows',
      content: expect.stringContaining(".gt('updated_at', since)"),
    }));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: serviceFile,
        nodeKind: 'variable',
        nodeName: 'updated_at > last_sync_time',
        startLine: 5,
        endLine: 5,
      }),
    ]));
  });

  it('uses incremental predicate owner methods as strict native Markdown entry points and code blocks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-incremental-predicate-native-markdown-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/project-delta.service.ts';
    writeFile(root, serviceFile, [
      'export class ProjectDeltaService {',
      '  async loadDeltaRows(client: { from(table: string): unknown }, since: string): Promise<unknown> {',
      "    return client.from('tasks')",
      "      .select('id,content,updated_at')",
      "      .gt('updated_at', since)",
      "      .order('updated_at', { ascending: true });",
      '  }',
      '}',
      '',
    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:ProjectDeltaService::loadDeltaRows`,
      kind: 'method',
      name: 'loadDeltaRows',
      qualifiedName: 'ProjectDeltaService::loadDeltaRows',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 7,
    };
    const predicateNode = {
      id: `variable:${serviceFile}:supabase-incremental-predicate:tasks:updated_at:gt:ProjectDeltaService.loadDeltaRows`,
      kind: 'variable',
      name: 'updated_at > last_sync_time',
      qualifiedName: 'ProjectDeltaService.loadDeltaRows::updated_at>last_sync_time',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 5,
      endLine: 5,
      signature: 'tasks.updated_at gt since',
      metadata: { relation: 'supabase-incremental-predicate' },
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [serviceFile],
        classes: [],
        functions: [],
        interfaces: [],
        types: [],
        variables: [],
        enums: [],
        namespaces: [],
        imports: [],
        exports: [],
        parameters: [],
      },
      angular: {
        components: [],
        directives: [],
        pipes: [],
        injectables: [],
        injectors: [],
        dynamicImports: [],
        routes: [],
      },
      supabase: {
        edgeFunctions: [],
        migrations: [],
      },
      agentRules: {
        hardRules: [],
      },
      graph: {
        nodes: [methodNode, predicateNode],
        edges: [{
          source: methodNode.id,
          target: predicateNode.id,
          kind: 'references',
          line: 5,
          column: 7,
          metadata: {
            relation: 'supabase-incremental-predicate',
            table: 'tasks',
            column: 'updated_at',
            operator: 'gt',
            cursor: 'since',
          },
        }],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'supabase-incremental-predicate',
      '--limit',
      '20',
      '--native-markdown',
      '--skip-refresh',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(result);
    const entryPoints = result.stdout.slice(
      result.stdout.indexOf('### Entry Points'),
      result.stdout.indexOf('### Relationships'),
    );
    expect(entryPoints).toContain(`- **loadDeltaRows** (method) - ${serviceFile}:2`);
    expect(entryPoints).not.toContain(`- **updated_at > last_sync_time** (variable) - ${serviceFile}:5`);
    expect(result.stdout).toContain(`#### loadDeltaRows (${serviceFile}:2)`);
    expect(result.stdout).toContain(".gt('updated_at', since)");
    expect(result.stdout).not.toContain(`#### updated_at > last_sync_time (${serviceFile}:5)`);
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).toContain('### Relationships');
  });
}
