import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayJsonProjectionSyncRuleEntrypointSpecs } from './codegraph-nanoflow-overlay-json-projection-sync-rule-entrypoints.spec-helpers';
import { registerCodegraphOverlayJsonProjectionSyncRuleFieldBudgetSpecs } from './codegraph-nanoflow-overlay-json-projection-sync-rule-field-budget.spec-helpers';

function createMinimalSyncRuleOverlay(
  root: string,
  files: string[],
  nodes: unknown[],
  edges: unknown[],
): unknown {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-10T00:00:00.000Z',
    project: { root },
    coverageTargets: {},
    typescript: {
      files,
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
    graph: { nodes, edges },
  };
}

function writeOverlayFixture(root: string, overlay: unknown): void {
  const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));
}

export function registerCodegraphOverlayJsonProjectionSyncRuleBudgetSpecs(context: CodegraphOverlaySpecContext): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots, queryScriptPath, repoRoot } = context;
  const queryNativeMarkdown = (root: string, query: string) => spawnSync(process.execPath, [
    queryScriptPath,
    '--root',
    root,
    '--query',
    query,
    '--limit',
    '20',
    '--native-markdown',
    '--skip-refresh',
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });

  registerCodegraphOverlayJsonProjectionSyncRuleFieldBudgetSpecs(context);

  it('uses matched predicate owner lines for sync-required-predicate strict native code blocks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-sync-required-predicate-long-owner-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/long-delta-loader.service.ts';
    const fillerLines = Array.from({ length: 80 }, (_, index) => (
      `    const filler${index} = '${'x'.repeat(80)}';`
    ));
    const predicateLine = fillerLines.length + 5;
    const predicateChainStartLine = predicateLine - 2;
    writeFile(root, serviceFile, [
      'export class LongDeltaLoaderService {',
      '  async loadDelta(client: { from(table: string): unknown }, effectiveSince: string): Promise<unknown> {',
      ...fillerLines,
      "    return client.from('tasks')",
      "      .select('id,content,updated_at')",
      "      .gt('updated_at', effectiveSince);",
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, 'AGENTS.md', [
      '# Rules',
      '读路径：IndexedDB -> 后台增量拉取(updated_at > last_sync_time)。',
      '',
    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:LongDeltaLoaderService::loadDelta`,
      kind: 'method',
      name: 'loadDelta',
      qualifiedName: 'LongDeltaLoaderService::loadDelta',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: predicateLine + 2,
    };
    const predicateNode = {
      id: `variable:${serviceFile}:supabase-incremental-predicate:tasks:updated_at:gt:LongDeltaLoaderService.loadDelta`,
      kind: 'variable',
      name: 'updated_at > last_sync_time',
      qualifiedName: 'LongDeltaLoaderService.loadDelta::updated_at>last_sync_time',
      filePath: serviceFile,
      language: 'typescript',
      startLine: predicateLine,
      endLine: predicateLine,
      signature: 'tasks.updated_at gt effectiveSince',
      metadata: { relation: 'supabase-incremental-predicate' },
    };
    const updatedAtRuleNode = {
      id: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:updated_at',
      kind: 'variable',
      name: 'updated_at',
      qualifiedName: 'updated_at',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 2,
      endLine: 2,
      signature: 'sync-rule keyword updated_at',
    };
    const lastSyncRuleNode = {
      id: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:last_sync_time',
      kind: 'variable',
      name: 'last_sync_time',
      qualifiedName: 'last_sync_time',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 2,
      endLine: 2,
      signature: 'sync-rule keyword last_sync_time',
    };
    const overlay = createMinimalSyncRuleOverlay(
      root,
      [serviceFile],
      [methodNode, predicateNode, updatedAtRuleNode, lastSyncRuleNode],
      [
          {
            source: methodNode.id,
            target: predicateNode.id,
            kind: 'references',
            line: predicateChainStartLine,
            column: 7,
            metadata: {
              relation: 'supabase-incremental-predicate',
              table: 'tasks',
              column: 'updated_at',
              operator: 'gt',
              cursor: 'effectiveSince',
            },
          },
          {
            source: updatedAtRuleNode.id,
            target: predicateNode.id,
            kind: 'references',
            metadata: {
              relation: 'sync-required-predicate',
              table: 'tasks',
              column: 'updated_at',
              cursorKeyword: 'updated_at',
            },
          },
          {
            source: lastSyncRuleNode.id,
            target: predicateNode.id,
            kind: 'references',
            metadata: {
              relation: 'sync-required-predicate',
              table: 'tasks',
              column: 'updated_at',
              cursorKeyword: 'last_sync_time',
            },
          },
      ],
    );
    writeOverlayFixture(root, overlay);

    const result = queryOverlay(root, 'sync-required-predicate', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'loadDelta',
      startLine: predicateChainStartLine,
      content: expect.stringContaining("      .gt('updated_at', effectiveSince);"),
    }));
  });

  it('uses predicate owner methods as strict native Markdown entry points for sync-required-predicate queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-sync-required-predicate-native-markdown-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/long-delta-loader.service.ts';
    const fillerLines = Array.from({ length: 80 }, (_, index) => (
      `    const filler${index} = '${'x'.repeat(80)}';`
    ));
    const predicateLine = fillerLines.length + 5;
    const predicateChainStartLine = predicateLine - 2;
    writeFile(root, serviceFile, [
      'export class LongDeltaLoaderService {',
      '  async loadDelta(client: { from(table: string): unknown }, effectiveSince: string): Promise<unknown> {',
      ...fillerLines,
      "    return client.from('tasks')",
      "      .select('id,content,updated_at')",
      "      .gt('updated_at', effectiveSince);",
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, 'AGENTS.md', [
      '# Rules',
      '读路径：IndexedDB -> 后台增量拉取(updated_at > last_sync_time)。',
      '',
    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:LongDeltaLoaderService::loadDelta`,
      kind: 'method',
      name: 'loadDelta',
      qualifiedName: 'LongDeltaLoaderService::loadDelta',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: predicateLine + 2,
    };
    const predicateNode = {
      id: `variable:${serviceFile}:supabase-incremental-predicate:tasks:updated_at:gt:LongDeltaLoaderService.loadDelta`,
      kind: 'variable',
      name: 'updated_at > last_sync_time',
      qualifiedName: 'LongDeltaLoaderService.loadDelta::updated_at>last_sync_time',
      filePath: serviceFile,
      language: 'typescript',
      startLine: predicateLine,
      endLine: predicateLine,
      signature: 'tasks.updated_at gt effectiveSince',
      metadata: { relation: 'supabase-incremental-predicate' },
    };
    const updatedAtRuleNode = {
      id: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:updated_at',
      kind: 'variable',
      name: 'updated_at',
      qualifiedName: 'updated_at',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 2,
      endLine: 2,
      signature: 'sync-rule keyword updated_at',
    };
    const lastSyncRuleNode = {
      id: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first:Read path:last_sync_time',
      kind: 'variable',
      name: 'last_sync_time',
      qualifiedName: 'last_sync_time',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 2,
      endLine: 2,
      signature: 'sync-rule keyword last_sync_time',
    };
    const overlay = createMinimalSyncRuleOverlay(
      root,
      [serviceFile],
      [methodNode, predicateNode, updatedAtRuleNode, lastSyncRuleNode],
      [
          {
            source: methodNode.id,
            target: predicateNode.id,
            kind: 'references',
            line: predicateChainStartLine,
            column: 7,
            metadata: {
              relation: 'supabase-incremental-predicate',
              table: 'tasks',
              column: 'updated_at',
              operator: 'gt',
              cursor: 'effectiveSince',
            },
          },
          {
            source: updatedAtRuleNode.id,
            target: predicateNode.id,
            kind: 'references',
            metadata: {
              relation: 'sync-required-predicate',
              table: 'tasks',
              column: 'updated_at',
              cursorKeyword: 'updated_at',
            },
          },
          {
            source: lastSyncRuleNode.id,
            target: predicateNode.id,
            kind: 'references',
            metadata: {
              relation: 'sync-required-predicate',
              table: 'tasks',
              column: 'updated_at',
              cursorKeyword: 'last_sync_time',
            },
          },
      ],
    );
    writeOverlayFixture(root, overlay);

    const result = queryNativeMarkdown(root, 'sync-required-predicate');

    expectSpawnSuccess(result);
    const entryPointsStart = result.stdout.indexOf('### Entry Points');
    const relatedSymbolsStart = result.stdout.indexOf('### Related Symbols');
    const entryPoints = result.stdout.slice(entryPointsStart, relatedSymbolsStart);
    expect(entryPoints).toContain(`- **loadDelta** (method) - ${serviceFile}:2`);
    expect(entryPoints).not.toContain('- **updated_at** (variable) - AGENTS.md:2');
    expect(entryPoints).not.toContain('- **last_sync_time** (variable) - AGENTS.md:2');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain(`#### loadDelta (${serviceFile}:${predicateChainStartLine})`);
    expect(result.stdout).toContain("      .gt('updated_at', effectiveSince);");
    expect(result.stdout).not.toContain('### Source Code');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('prioritizes predicate owner methods for sync-required-predicate rule queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-sync-required-predicate-source-budget-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/project-delta.service.ts';
    writeFile(root, serviceFile, [
      'export class ProjectDeltaService {',
      '  async loadDeltaRows(client: { from(table: string): unknown }, effectiveSince: string): Promise<unknown> {',
      "    return client.from('tasks')",
      "      .select('id,content,updated_at')",
      "      .gt('updated_at', effectiveSince)",
      "      .order('updated_at', { ascending: true });",
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, 'AGENTS.md', [
      '# Rules',
      '',
      '读路径：IndexedDB -> 后台增量拉取(updated_at > last_sync_time)。',
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
      signature: 'tasks.updated_at gt effectiveSince',
      metadata: { relation: 'supabase-incremental-predicate' },
    };
    const updatedAtRuleNode = {
      id: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first 数据流:读路径:updated_at',
      kind: 'variable',
      name: 'updated_at',
      qualifiedName: 'updated_at',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 3,
      endLine: 3,
      signature: 'sync-rule keyword updated_at',
    };
    const lastSyncRuleNode = {
      id: 'variable:AGENTS.md:sync-rule-keyword:5.2 Offline-first 数据流:读路径:last_sync_time',
      kind: 'variable',
      name: 'last_sync_time',
      qualifiedName: 'last_sync_time',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 3,
      endLine: 3,
      signature: 'sync-rule keyword last_sync_time',
    };
    const overlay = createMinimalSyncRuleOverlay(
      root,
      [serviceFile],
      [methodNode, predicateNode, updatedAtRuleNode, lastSyncRuleNode],
      [
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
              cursor: 'effectiveSince',
            },
          },
          {
            source: updatedAtRuleNode.id,
            target: predicateNode.id,
            kind: 'references',
            metadata: {
              relation: 'sync-required-predicate',
              cursorKeyword: 'updated_at',
            },
          },
          {
            source: lastSyncRuleNode.id,
            target: predicateNode.id,
            kind: 'references',
            metadata: {
              relation: 'sync-required-predicate',
              cursorKeyword: 'last_sync_time',
            },
          },
      ],
    );
    writeOverlayFixture(root, overlay);

    const result = queryOverlay(root, 'sync-required-predicate', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThanOrEqual(2);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'loadDeltaRows',
      content: expect.stringContaining(".gt('updated_at', effectiveSince)"),
    }));
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeKind: 'variable',
        nodeName: 'updated_at > last_sync_time',
        startLine: 5,
        endLine: 5,
      }),
      expect.objectContaining({
        filePath: 'AGENTS.md',
        nodeKind: 'variable',
      }),
    ]));
  });

  it('prioritizes select owner methods for sync-required-field rule queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-sync-required-field-source-budget-'));
    tempRoots.push(root);
    const serviceFile = 'src/services/task-repository.service.ts';
    const configFile = 'src/config/sync.config.ts';
    writeFile(root, serviceFile, [
      'import { FIELD_SELECT_CONFIG } from "../config/sync.config";',
      '',
      'export class TaskRepositoryService {',
      '  async getUpdatedTasks(client: { from(table: string): unknown }): Promise<unknown> {',
      "    return client.from('tasks')",
      '      .select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS);',
      '  }',
      '',
      '  async loadTaskDetails(client: { from(table: string): unknown }): Promise<unknown> {',
      "    return client.from('tasks')",
      '      .select(FIELD_SELECT_CONFIG.TASK_DETAIL_FIELDS);',
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, configFile, [
      'export const FIELD_SELECT_CONFIG = {',
      "  TASK_LIST_FIELDS: 'id,content,updated_at',",
      "  TASK_DETAIL_FIELDS: 'id,content,deleted_at',",
      '} as const;',
      '',
    ].join('\n'));
    writeFile(root, 'AGENTS.md', [
      '# Rules',
      '',
      '同步查询 tasks 选择字段必须包含 content。',
      '',
    ].join('\n'));
    const getUpdatedTasksNode = {
      id: `method:${serviceFile}:TaskRepositoryService::getUpdatedTasks`,
      kind: 'method',
      name: 'getUpdatedTasks',
      qualifiedName: 'TaskRepositoryService::getUpdatedTasks',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 4,
      endLine: 7,
    };
    const loadTaskDetailsNode = {
      id: `method:${serviceFile}:TaskRepositoryService::loadTaskDetails`,
      kind: 'method',
      name: 'loadTaskDetails',
      qualifiedName: 'TaskRepositoryService::loadTaskDetails',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 9,
      endLine: 12,
    };
    const listContentFieldNode = {
      id: `property:${configFile}:FIELD_SELECT_CONFIG.TASK_LIST_FIELDS::content`,
      kind: 'property',
      name: 'content',
      qualifiedName: 'FIELD_SELECT_CONFIG.TASK_LIST_FIELDS::content',
      filePath: configFile,
      language: 'typescript',
      startLine: 2,
      endLine: 2,
      signature: 'TASK_LIST_FIELDS.content',
      metadata: { relation: 'supabase-select-field' },
    };
    const detailContentFieldNode = {
      id: `property:${configFile}:FIELD_SELECT_CONFIG.TASK_DETAIL_FIELDS::content`,
      kind: 'property',
      name: 'content',
      qualifiedName: 'FIELD_SELECT_CONFIG.TASK_DETAIL_FIELDS::content',
      filePath: configFile,
      language: 'typescript',
      startLine: 3,
      endLine: 3,
      signature: 'TASK_DETAIL_FIELDS.content',
      metadata: { relation: 'supabase-select-field' },
    };
    const contentRuleNode = {
      id: 'variable:AGENTS.md:hard-rule-keyword:5.2 Offline-first 数据流:content',
      kind: 'variable',
      name: 'content',
      qualifiedName: 'content',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 3,
      endLine: 3,
      signature: 'hard-rule keyword content',
    };
    const overlay = createMinimalSyncRuleOverlay(
      root,
      [serviceFile, configFile],
      [
          getUpdatedTasksNode,
          loadTaskDetailsNode,
          listContentFieldNode,
          detailContentFieldNode,
          contentRuleNode,
        ],
      [
          {
            source: contentRuleNode.id,
            target: listContentFieldNode.id,
            kind: 'references',
            metadata: {
              relation: 'sync-required-field',
              table: 'tasks',
              field: 'content',
            },
          },
          {
            source: contentRuleNode.id,
            target: detailContentFieldNode.id,
            kind: 'references',
            metadata: {
              relation: 'sync-required-field',
              table: 'tasks',
              field: 'content',
            },
          },
          {
            source: getUpdatedTasksNode.id,
            target: listContentFieldNode.id,
            kind: 'references',
            line: 6,
            column: 15,
            metadata: {
              relation: 'supabase-select-field',
              table: 'tasks',
              field: 'content',
              selectSource: 'FIELD_SELECT_CONFIG.TASK_LIST_FIELDS',
            },
          },
          {
            source: loadTaskDetailsNode.id,
            target: detailContentFieldNode.id,
            kind: 'references',
            line: 11,
            column: 15,
            metadata: {
              relation: 'supabase-select-field',
              table: 'tasks',
              field: 'content',
              selectSource: 'FIELD_SELECT_CONFIG.TASK_DETAIL_FIELDS',
            },
          },
      ],
    );
    writeOverlayFixture(root, overlay);

    const result = queryOverlay(root, 'sync-required-field', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.edges.length).toBeGreaterThanOrEqual(2);
    expect(response.codeBlocks.slice(0, 2)).toEqual([
      expect.objectContaining({
        filePath: serviceFile,
        nodeKind: 'method',
        nodeName: 'getUpdatedTasks',
        content: expect.stringContaining('FIELD_SELECT_CONFIG.TASK_LIST_FIELDS'),
      }),
      expect.objectContaining({
        filePath: serviceFile,
        nodeKind: 'method',
        nodeName: 'loadTaskDetails',
        content: expect.stringContaining('FIELD_SELECT_CONFIG.TASK_DETAIL_FIELDS'),
      }),
    ]);
    expect(response.codeBlocks).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: 'AGENTS.md',
        nodeKind: 'variable',
        nodeName: 'content',
      }),
    ]));
  });

  registerCodegraphOverlayJsonProjectionSyncRuleEntrypointSpecs(context);
}
