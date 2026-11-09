import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayJsonProjectionOperationOwnerJsonCodeBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-operation-owner-json-code-budget.spec-helpers';
import { registerCodegraphOverlayJsonProjectionStorageOwnerCodeBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-storage-owner-code-budget.spec-helpers';
import { registerCodegraphOverlayJsonProjectionIncrementalPredicateOwnerCodeBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-incremental-predicate-owner-code-budget.spec-helpers';

export function registerCodegraphOverlayJsonProjectionOwnerCodeBudgetSpecs(context: CodegraphOverlaySpecContext): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots, queryScriptPath, repoRoot } = context;
  registerCodegraphOverlayJsonProjectionOperationOwnerJsonCodeBudgetSpecs(context);
  registerCodegraphOverlayJsonProjectionStorageOwnerCodeBudgetSpecs(context);

  registerCodegraphOverlayJsonProjectionIncrementalPredicateOwnerCodeBudgetSpecs(context);

  it('prioritizes table write owner methods without duplicating synthetic operation variables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-table-write-source-budget-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/project-save-task-batch.service.ts';
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
    const methodNode = {
      id: `method:${serviceFile}:ProjectSaveTaskBatchService::upsertTasks`,
      kind: 'method',
      name: 'upsertTasks',
      qualifiedName: 'ProjectSaveTaskBatchService::upsertTasks',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 6,
    };
    const tableWriteNode = {
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
        nodes: [methodNode, tableWriteNode],
        edges: [{
          source: methodNode.id,
          target: tableWriteNode.id,
          kind: 'references',
          line: 3,
          column: 12,
          metadata: {
            relation: 'supabase-table-write',
            table: 'tasks',
            writeOperation: 'upsert',
          },
        }],
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
      content: expect.stringContaining(".from('tasks')"),
    }));
    expect(response.codeBlocks[0].content).toContain('.upsert(rows');
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeKind: 'variable',
        nodeName: 'tasks.upsert',
        startLine: 3,
        endLine: 3,
      }),
    ]));
  });

  it('prioritizes RPC owner methods without duplicating synthetic RPC variables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-rpc-source-budget-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/project-delete-coordinator.service.ts';
    writeFile(root, serviceFile, [
      'export class ProjectDeleteCoordinatorService {',
      '  async softDeleteProject(client: { rpc(name: string, args: unknown): unknown }, projectId: string): Promise<unknown> {',
      "    return client.rpc('soft_delete_project', {",
      '      p_project_id: projectId,',
      '    });',
      '  }',
      '}',
      '',
    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:ProjectDeleteCoordinatorService::softDeleteProject`,
      kind: 'method',
      name: 'softDeleteProject',
      qualifiedName: 'ProjectDeleteCoordinatorService::softDeleteProject',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 6,
    };
    const rpcNode = {
      id: `variable:${serviceFile}:supabase-rpc:soft_delete_project:ProjectDeleteCoordinatorService.softDeleteProject`,
      kind: 'variable',
      name: 'soft_delete_project',
      qualifiedName: 'ProjectDeleteCoordinatorService.softDeleteProject::soft_delete_project',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 3,
      endLine: 3,
      signature: 'rpc soft_delete_project',
      metadata: { relation: 'supabase-rpc' },
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
        nodes: [methodNode, rpcNode],
        edges: [{
          source: methodNode.id,
          target: rpcNode.id,
          kind: 'references',
          line: 3,
          column: 12,
          metadata: {
            relation: 'supabase-rpc',
            functionName: 'soft_delete_project',
          },
        }],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'supabase-rpc', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'softDeleteProject',
      content: expect.stringContaining("client.rpc('soft_delete_project'"),
    }));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeKind: 'variable',
        nodeName: 'soft_delete_project',
        startLine: 3,
        endLine: 3,
      }),
    ]));
  });

  it('uses operation owner methods as strict native Markdown entry points for Supabase operation queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-supabase-owner-native-markdown-'));
    tempRoots.push(root);
    const tableWriteFile = 'src/app/core/services/sync/project-save-task-batch.service.ts';
    const rpcFile = 'src/app/core/services/sync/project-delete-coordinator.service.ts';
    writeFile(root, tableWriteFile, [
      'export class ProjectSaveTaskBatchService {',
      '  async upsertTasks(client: { from(table: string): unknown }, rows: unknown[]): Promise<unknown> {',
      "    return client.from('tasks')",
      '      .upsert(rows, { onConflict: "id" })',
      "      .select('id,updated_at');",
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, rpcFile, [
      'export class ProjectDeleteCoordinatorService {',
      '  async softDeleteProject(client: { rpc(name: string, args: unknown): unknown }, projectId: string): Promise<unknown> {',
      "    return client.rpc('soft_delete_project', {",
      '      p_project_id: projectId,',
      '    });',
      '  }',
      '}',
      '',
    ].join('\n'));
    const tableWriteMethodNode = {
      id: `method:${tableWriteFile}:ProjectSaveTaskBatchService::upsertTasks`,
      kind: 'method',
      name: 'upsertTasks',
      qualifiedName: 'ProjectSaveTaskBatchService::upsertTasks',
      filePath: tableWriteFile,
      language: 'typescript',
      startLine: 2,
      endLine: 6,
    };
    const tableWriteNode = {
      id: `variable:${tableWriteFile}:supabase-table-write:tasks.upsert:ProjectSaveTaskBatchService.upsertTasks`,
      kind: 'variable',
      name: 'tasks.upsert',
      qualifiedName: 'ProjectSaveTaskBatchService.upsertTasks::tasks.upsert',
      filePath: tableWriteFile,
      language: 'typescript',
      startLine: 3,
      endLine: 3,
      signature: 'tasks.upsert',
      metadata: { relation: 'supabase-table-write' },
    };
    const rpcMethodNode = {
      id: `method:${rpcFile}:ProjectDeleteCoordinatorService::softDeleteProject`,
      kind: 'method',
      name: 'softDeleteProject',
      qualifiedName: 'ProjectDeleteCoordinatorService::softDeleteProject',
      filePath: rpcFile,
      language: 'typescript',
      startLine: 2,
      endLine: 6,
    };
    const rpcNode = {
      id: `variable:${rpcFile}:supabase-rpc:soft_delete_project:ProjectDeleteCoordinatorService.softDeleteProject`,
      kind: 'variable',
      name: 'soft_delete_project',
      qualifiedName: 'ProjectDeleteCoordinatorService.softDeleteProject::soft_delete_project',
      filePath: rpcFile,
      language: 'typescript',
      startLine: 3,
      endLine: 3,
      signature: 'rpc soft_delete_project',
      metadata: { relation: 'supabase-rpc' },
    };
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [tableWriteFile, rpcFile],
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
          tableWriteMethodNode,
          tableWriteNode,
          rpcMethodNode,
          rpcNode,
        ],
        edges: [
          {
            source: tableWriteMethodNode.id,
            target: tableWriteNode.id,
            kind: 'references',
            line: 3,
            column: 12,
            metadata: {
              relation: 'supabase-table-write',
              table: 'tasks',
              writeOperation: 'upsert',
            },
          },
          {
            source: rpcMethodNode.id,
            target: rpcNode.id,
            kind: 'references',
            line: 3,
            column: 12,
            metadata: {
              relation: 'supabase-rpc',
              functionName: 'soft_delete_project',
            },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const tableWriteResult = spawnSync(process.execPath, [
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
    const rpcResult = spawnSync(process.execPath, [
      queryScriptPath,
      '--root',
      root,
      '--query',
      'supabase-rpc',
      '--limit',
      '20',
      '--native-markdown',
      '--skip-refresh',
    ], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });

    expectSpawnSuccess(tableWriteResult);
    expectSpawnSuccess(rpcResult);
    const tableWriteEntryPoints = tableWriteResult.stdout.slice(
      tableWriteResult.stdout.indexOf('### Entry Points'),
      tableWriteResult.stdout.indexOf('### Related Symbols'),
    );
    expect(tableWriteEntryPoints).toContain(`- **upsertTasks** (method) - ${tableWriteFile}:2`);
    expect(tableWriteEntryPoints).not.toContain(`- **tasks.upsert** (variable) - ${tableWriteFile}:3`);
    expect(tableWriteResult.stdout).toContain('#### upsertTasks (src/app/core/services/sync/project-save-task-batch.service.ts:2)');
    expect(tableWriteResult.stdout).toContain('.upsert(rows');
    expect(tableWriteResult.stdout).not.toContain('### NanoFlow Coverage');

    const rpcEntryPoints = rpcResult.stdout.slice(
      rpcResult.stdout.indexOf('### Entry Points'),
      rpcResult.stdout.indexOf('### Related Symbols'),
    );
    expect(rpcEntryPoints).toContain(`- **softDeleteProject** (method) - ${rpcFile}:2`);
    expect(rpcEntryPoints).not.toContain(`- **soft_delete_project** (variable) - ${rpcFile}:3`);
    expect(rpcResult.stdout).toContain('#### softDeleteProject (src/app/core/services/sync/project-delete-coordinator.service.ts:2)');
    expect(rpcResult.stdout).toContain("client.rpc('soft_delete_project'");
    expect(rpcResult.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('uses operation owner methods before local destructured variables in strict native Markdown code blocks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-supabase-owner-code-block-markdown-'));
    tempRoots.push(root);
    const seedFile = 'scripts/seed-supabase.js';
    const serviceFile = 'src/app/core/services/sync/project-save-task-batch.service.ts';
    writeFile(root, seedFile, [
      'export async function seedProject(client, seedProject) {',
      "  const { error } = await client.from('projects').upsert(seedProject);",
      '  if (error) throw error;',
      '}',
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
    const seedFunctionNode = {
      id: `function:${seedFile}:seedProject`,
      kind: 'function',
      name: 'seedProject',
      qualifiedName: 'seedProject',
      filePath: seedFile,
      language: 'javascript',
      startLine: 1,
      endLine: 4,
    };
    const seedErrorNode = {
      id: `variable:${seedFile}:seedProject::error`,
      kind: 'variable',
      name: 'error',
      qualifiedName: 'seedProject::error',
      filePath: seedFile,
      language: 'javascript',
      startLine: 2,
      endLine: 2,
      signature: 'const { error }',
    };
    const seedTableWriteNode = {
      id: `variable:${seedFile}:supabase-table-write:projects.upsert:seedProject`,
      kind: 'variable',
      name: 'projects.upsert',
      qualifiedName: 'seedProject::projects.upsert',
      filePath: seedFile,
      language: 'javascript',
      startLine: 2,
      endLine: 2,
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
          seedFunctionNode,
          seedErrorNode,
          seedTableWriteNode,
          serviceMethodNode,
          serviceTableWriteNode,
        ],
        edges: [
          {
            source: seedFunctionNode.id,
            target: seedTableWriteNode.id,
            kind: 'references',
            line: 2,
            column: 26,
            metadata: {
              relation: 'supabase-table-write',
              table: 'projects',
              writeOperation: 'upsert',
            },
          },
          {
            source: seedErrorNode.id,
            target: seedTableWriteNode.id,
            kind: 'references',
            line: 2,
            column: 11,
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
    const codeSection = result.stdout.slice(result.stdout.indexOf('### Code'));
    // 干净路径上的真实 owner 优先于低价值 scripts/ 路径 owner；两个 owner 都必须保留证据块。
    expect(codeSection).toMatch(/^### Code\s+#### upsertTasks \(src\/app\/core\/services\/sync\/project-save-task-batch\.service\.ts:2\)/);
    expect(codeSection).toContain('#### seedProject (scripts/seed-supabase.js:1)');
    expect(result.stdout).not.toContain('#### error (scripts/seed-supabase.js:2)');
    expect(result.stdout).toContain("client.from('projects').upsert(seedProject)");
    expect(result.stdout).toContain('.upsert(rows');
  });

}
