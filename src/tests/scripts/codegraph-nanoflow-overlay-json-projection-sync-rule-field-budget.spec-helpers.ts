import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

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

export function registerCodegraphOverlayJsonProjectionSyncRuleFieldBudgetSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots } = context;

  it('uses matched select owner lines for sync-required-field strict native code blocks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-sync-required-field-long-owner-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/long-task-loader.service.ts';
    const configFile = 'src/config/sync.config.ts';
    const fillerLines = Array.from({ length: 80 }, (_, index) => (
      `    const filler${index} = '${'x'.repeat(80)}';`
    ));
    const selectLine = fillerLines.length + 5;
    const selectChainStartLine = selectLine - 1;
    writeFile(root, serviceFile, [
      'import { FIELD_SELECT_CONFIG } from "../../../config/sync.config";',
      'export class LongTaskLoaderService {',
      '  async loadRows(client: { from(table: string): unknown }): Promise<unknown> {',
      ...fillerLines,
      "    return client.from('tasks')",
      '      .select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS);',
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, configFile, [
      'export const FIELD_SELECT_CONFIG = {',
      "  TASK_LIST_FIELDS: 'id,content,updated_at',",
      '} as const;',
      '',
    ].join('\n'));
    writeFile(root, 'AGENTS.md', [
      '# Rules',
      '同步查询 tasks 选择字段必须包含 content。',
      '',
    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:LongTaskLoaderService::loadRows`,
      kind: 'method',
      name: 'loadRows',
      qualifiedName: 'LongTaskLoaderService::loadRows',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 3,
      endLine: selectLine + 2,
    };
    const fieldNode = {
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
    const ruleNode = {
      id: 'variable:AGENTS.md:hard-rule-keyword:5.2 Offline-first:content',
      kind: 'variable',
      name: 'content',
      qualifiedName: 'content',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 2,
      endLine: 2,
      signature: 'hard-rule keyword content',
    };
    const overlay = createMinimalSyncRuleOverlay(
      root,
      [serviceFile, configFile],
      [methodNode, fieldNode, ruleNode],
      [
        {
          source: ruleNode.id,
          target: fieldNode.id,
          kind: 'references',
          metadata: {
            relation: 'sync-required-field',
            table: 'tasks',
            field: 'content',
          },
        },
        {
          source: methodNode.id,
          target: fieldNode.id,
          kind: 'references',
          line: selectChainStartLine,
          column: 7,
          metadata: {
            relation: 'supabase-select-field',
            table: 'tasks',
            field: 'content',
            selectSource: 'FIELD_SELECT_CONFIG.TASK_LIST_FIELDS',
          },
        },
      ],
    );
    writeOverlayFixture(root, overlay);

    const result = queryOverlay(root, 'sync-required-field', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'loadRows',
      startLine: selectChainStartLine,
      content: expect.stringContaining('      .select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS);'),
    }));
  });

  it('prioritizes real select owner provenance before noisy sync-required-field provenance fills the native budget', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-sync-required-field-provenance-budget-'));
    tempRoots.push(root);
    const serviceFile = 'src/app/core/services/sync/budget-task-loader.service.ts';
    const configFile = 'src/config/sync-budget.config.ts';
    writeFile(root, serviceFile, [
      'export class BudgetTaskLoaderService {',
      '  async loadRows(client: { from(table: string): { select(fields: string): unknown } }): Promise<unknown> {',
      "    return client.from('tasks').select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS);",
      '  }',
      '}',
      '',
    ].join('\n'));
    writeFile(root, configFile, [
      'export const FIELD_SELECT_CONFIG = {',
      "  TASK_LIST_FIELDS: 'id,content,updated_at',",
      '} as const;',
      '',
    ].join('\n'));
    writeFile(root, 'AGENTS.md', [
      '# Rules',
      '同步查询 tasks 选择字段必须包含 content。',
      '',
    ].join('\n'));

    const noiseNodes = Array.from({ length: 6 }, (_, index) => {
      const filePath = `src/app/core/services/sync/budget-task-loader-${index}.spec.ts`;
      writeFile(root, filePath, [
        `export const noisyContent${index} = 'content';`,
        '',
      ].join('\n'));
      return {
        id: `property:${filePath}:noisyContent${index}`,
        kind: 'property',
        name: `noisyContent${index}`,
        qualifiedName: `noisyContent${index}`,
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
      };
    });
    const methodNode = {
      id: `method:${serviceFile}:BudgetTaskLoaderService::loadRows`,
      kind: 'method',
      name: 'loadRows',
      qualifiedName: 'BudgetTaskLoaderService::loadRows',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 2,
      endLine: 4,
    };
    const fieldNode = {
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
    const ruleNode = {
      id: 'variable:AGENTS.md:hard-rule-keyword:5.2 Offline-first:content',
      kind: 'variable',
      name: 'content',
      qualifiedName: 'content',
      filePath: 'AGENTS.md',
      language: 'unknown',
      startLine: 2,
      endLine: 2,
      signature: 'hard-rule keyword content',
    };
    const overlay = createMinimalSyncRuleOverlay(
      root,
      [serviceFile, configFile, ...noiseNodes.map(node => node.filePath as string)],
      [fieldNode, ruleNode, ...noiseNodes, methodNode],
      [
        {
          source: ruleNode.id,
          target: fieldNode.id,
          kind: 'references',
          metadata: {
            relation: 'sync-required-field',
            table: 'tasks',
            field: 'content',
          },
        },
        ...noiseNodes.map(node => ({
          source: node.id,
          target: fieldNode.id,
          kind: 'references',
          line: 1,
          column: 1,
          metadata: {
            relation: 'supabase-select-field',
            table: 'tasks',
            field: 'content',
            selectSource: 'fixture-noise',
          },
        })),
        {
          source: methodNode.id,
          target: fieldNode.id,
          kind: 'references',
          line: 3,
          column: 12,
          metadata: {
            relation: 'supabase-select-field',
            table: 'tasks',
            field: 'content',
            selectSource: 'FIELD_SELECT_CONFIG.TASK_LIST_FIELDS',
          },
        },
      ],
    );
    writeOverlayFixture(root, overlay);

    const result = queryOverlay(root, 'sync-required-field', ['--limit', '20', '--native-json']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.codeBlocks[0]).toEqual(expect.objectContaining({
      filePath: serviceFile,
      nodeKind: 'method',
      nodeName: 'loadRows',
      content: expect.stringContaining("client.from('tasks').select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS)"),
    }));
    expect(response.codeBlocks.slice(0, 5).some((block: { filePath?: string }) => block.filePath === serviceFile))
      .toBe(true);
  });
}
