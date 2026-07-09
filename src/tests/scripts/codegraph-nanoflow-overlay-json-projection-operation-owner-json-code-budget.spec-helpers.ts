import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionOperationOwnerJsonCodeBudgetSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots, repoRoot, queryScriptPath } = context;

  it('keeps strict native JSON operation code blocks focused on owner methods', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-supabase-owner-code-block-json-'));
    tempRoots.push(root);
    const seedFile = 'scripts/seed-supabase.js';
    const serviceFile = 'src/app/core/services/sync/project-save-task-batch.service.ts';
    writeFile(root, seedFile, [
      "const { error } = await client.from('projects').upsert(seedProject);",
      'if (error) throw error;',
      '',
    ].join('\n'));
    writeFile(root, serviceFile, [
      'export class ProjectSaveTaskBatchService {',
      '  async upsertTasks(client: { from(table: string): unknown }, rows: unknown[]): Promise<unknown> {',
      "    return client.from('tasks')",
      '      .upsert(rows, { onConflict: "id" })',
      "      .select('id,updated_at');",
      '  }',
      '}',
      '',
    ].join('\n'));
    const seedErrorNode = {
      id: `constant:${seedFile}:error`,
      kind: 'constant',
      name: 'error',
      qualifiedName: 'error',
      filePath: seedFile,
      language: 'javascript',
      startLine: 1,
      endLine: 1,
      signature: 'const { error }',
    };
    const seedTableWriteNode = {
      id: `variable:${seedFile}:supabase-table-write:projects.upsert`,
      kind: 'variable',
      name: 'projects.upsert',
      qualifiedName: 'supabase.table_write:projects.upsert',
      filePath: seedFile,
      language: 'javascript',
      startLine: 1,
      endLine: 1,
      signature: 'projects.upsert',
      metadata: { relation: 'supabase-table-write' },
    };
    const serviceMethodNode = {
      id: `method:${serviceFile}:ProjectSaveTaskBatchService::upsertTasks`,
      kind: 'method',
      name: 'upsertTasks',
      qualifiedName: 'ProjectSaveTaskBatchService::upsertTasks',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 6,
    };
    const serviceTableWriteNode = {
      id: `variable:${serviceFile}:supabase-table-write:tasks.upsert:ProjectSaveTaskBatchService.upsertTasks`,
      kind: 'variable',
      name: 'tasks.upsert',
      qualifiedName: 'ProjectSaveTaskBatchService.upsertTasks::tasks.upsert',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 3,
      endLine: 3,
      signature: 'tasks.upsert',
      metadata: { relation: 'supabase-table-write' },
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
        nodes: [
          seedErrorNode,
          seedTableWriteNode,
          serviceMethodNode,
          serviceTableWriteNode,
        ],
        edges: [
          {
            source: seedErrorNode.id,
            target: seedTableWriteNode.id,
            kind: 'references',
            line: 1,
            column: 9,
            metadata: {
              relation: 'supabase-table-write',
              table: 'projects',
              writeOperation: 'upsert',
            },
          },
          {
            source: serviceMethodNode.id,
            target: serviceTableWriteNode.id,
            kind: 'references',
            line: 3,
            column: 12,
            metadata: {
              relation: 'supabase-table-write',
              table: 'tasks',
              writeOperation: 'upsert',
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'supabase-table-write', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'upsertTasks',
      content: expect.stringContaining('.upsert(rows'),
    }));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: seedFile,
        nodeKind: 'constant',
        nodeName: 'error',
      }),
    ]));
  });

  it('keeps strict native Markdown operation code blocks focused on owner methods', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-supabase-owner-code-block-markdown-'));
    tempRoots.push(root);
    const seedFile = 'scripts/seed-supabase.js';
    const serviceFile = 'src/app/core/services/sync/project-save-task-batch.service.ts';
    writeFile(root, seedFile, [
      "const { error } = await client.from('projects').upsert(seedProject);",
      'if (error) throw error;',
      '',
    ].join('\n'));
    writeFile(root, serviceFile, [
      'export class ProjectSaveTaskBatchService {',
      '  async upsertTasks(client: { from(table: string): unknown }, rows: unknown[]): Promise<unknown> {',
      "    return client.from('tasks')",
      '      .upsert(rows, { onConflict: "id" })',
      "      .select('id,updated_at');",
      '  }',
      '}',
      '',
    ].join('\n'));
    const seedErrorNode = {
      id: `constant:${seedFile}:error`,
      kind: 'constant',
      name: 'error',
      qualifiedName: 'error',
      filePath: seedFile,
      language: 'javascript',
      startLine: 1,
      endLine: 1,
      signature: 'const { error }',
    };
    const seedTableWriteNode = {
      id: `variable:${seedFile}:supabase-table-write:projects.upsert`,
      kind: 'variable',
      name: 'projects.upsert',
      qualifiedName: 'supabase.table_write:projects.upsert',
      filePath: seedFile,
      language: 'javascript',
      startLine: 1,
      endLine: 1,
      signature: 'projects.upsert',
      metadata: { relation: 'supabase-table-write' },
    };
    const serviceMethodNode = {
      id: `method:${serviceFile}:ProjectSaveTaskBatchService::upsertTasks`,
      kind: 'method',
      name: 'upsertTasks',
      qualifiedName: 'ProjectSaveTaskBatchService::upsertTasks',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 6,
    };
    const serviceTableWriteNode = {
      id: `variable:${serviceFile}:supabase-table-write:tasks.upsert:ProjectSaveTaskBatchService.upsertTasks`,
      kind: 'variable',
      name: 'tasks.upsert',
      qualifiedName: 'ProjectSaveTaskBatchService.upsertTasks::tasks.upsert',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 3,
      endLine: 3,
      signature: 'tasks.upsert',
      metadata: { relation: 'supabase-table-write' },
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
        nodes: [
          seedErrorNode,
          seedTableWriteNode,
          serviceMethodNode,
          serviceTableWriteNode,
        ],
        edges: [
          {
            source: seedErrorNode.id,
            target: seedTableWriteNode.id,
            kind: 'references',
            line: 1,
            column: 9,
            metadata: {
              relation: 'supabase-table-write',
              table: 'projects',
              writeOperation: 'upsert',
            },
          },
          {
            source: serviceMethodNode.id,
            target: serviceTableWriteNode.id,
            kind: 'references',
            line: 3,
            column: 12,
            metadata: {
              relation: 'supabase-table-write',
              table: 'tasks',
              writeOperation: 'upsert',
            },
          },
        ],
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
      'supabase-table-write',
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
    expect(result.stdout).toContain('## Code Context');
    expect(result.stdout).toContain('### Entry Points');
    expect(result.stdout).toContain('### Relationships');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain(`- **upsertTasks** (method) - ${serviceFile}:2`);
    expect(result.stdout).toContain(`#### upsertTasks (${serviceFile}:2)`);
    expect(result.stdout).toContain('.upsert(rows');
    expect(result.stdout).not.toContain(`#### error (${seedFile}:1)`);
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
    expect(result.stdout).not.toContain('### Source Code');
  });
}
