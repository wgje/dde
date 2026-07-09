import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayJsonProjectionSyncRuleEntrypointSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const { writeFile, queryOverlay, expectSpawnSuccess, tempRoots, queryScriptPath, repoRoot } = context;

  it('uses select owner methods as strict native Markdown entry points for sync-required-field queries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-sync-required-field-native-markdown-'));
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
      '',
      '同步查询 tasks 选择字段必须包含 content。',
      '',
    ].join('\n'));
    const methodNode = {
      id: `method:${serviceFile}:TaskRepositoryService::getUpdatedTasks`,
      kind: 'method',
      name: 'getUpdatedTasks',
      qualifiedName: 'TaskRepositoryService::getUpdatedTasks',
      filePath: serviceFile,
      language: 'typescript',
      startLine: 4,
      endLine: 7,
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
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: [serviceFile, configFile],
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
          methodNode,
          listContentFieldNode,
          contentRuleNode,
        ],
        edges: [
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
            source: methodNode.id,
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
      'sync-required-field',
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
    const entryPointsStart = result.stdout.indexOf('### Entry Points');
    const relatedSymbolsStart = result.stdout.indexOf('### Related Symbols');
    const entryPoints = result.stdout.slice(entryPointsStart, relatedSymbolsStart);
    expect(entryPoints).toContain(`- **getUpdatedTasks** (method) - ${serviceFile}:4`);
    expect(entryPoints).not.toContain('- **content** (variable) - AGENTS.md:3');
    expect(result.stdout).toContain('### Code');
    expect(result.stdout).toContain('#### getUpdatedTasks (src/services/task-repository.service.ts:4)');
    expect(result.stdout).toContain('.select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS)');
    expect(result.stdout).not.toContain('### NanoFlow Coverage');
  });

  it('keeps low-information import and export nodes out of native JSON entry points', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-entrypoint-priority-'));
    tempRoots.push(root);
    writeFile(
      root,
      'src/injectable.service.ts',
      [
        "import { Injectable } from '@angular/core';",
        '',
        '@Injectable({ providedIn: "root" })',
        'export class InjectableService {',
        '  touch(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    const nodes = [
      {
        id: 'import:src/injectable.service.ts:Injectable:@angular/core:Injectable:1',
        kind: 'import',
        name: 'Injectable',
        qualifiedName: 'Injectable',
        filePath: 'src/injectable.service.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        signature: 'import Injectable from @angular/core',
        updatedAt: 1781055245312,
      },
      {
        id: 'class:src/injectable.service.ts:InjectableService',
        kind: 'class',
        name: 'InjectableService',
        qualifiedName: 'InjectableService',
        filePath: 'src/injectable.service.ts',
        language: 'typescript',
        startLine: 4,
        endLine: 6,
        startColumn: 0,
        endColumn: 1,
        signature: 'class InjectableService',
        updatedAt: 1781055245312,
      },
    ];
    const overlay = {
      schemaVersion: 1,
      generatedAt: '2026-06-10T00:00:00.000Z',
      project: { root },
      coverageTargets: {},
      typescript: {
        files: ['src/injectable.service.ts'],
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
        nodes,
        edges: [
          {
            source: 'src/injectable.service.ts',
            target: 'import:src/injectable.service.ts:Injectable:@angular/core:Injectable:1',
            kind: 'contains',
            metadata: { relation: 'file-symbol' },
          },
          {
            source: 'src/injectable.service.ts',
            target: 'class:src/injectable.service.ts:InjectableService',
            kind: 'contains',
            metadata: { relation: 'file-symbol' },
          },
        ],
      },
    };
    const overlayPath = path.join(root, '.codegraph', 'nanoflow-overlay.json');
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, JSON.stringify(overlay, null, 2));

    const result = queryOverlay(root, 'Injectable', ['--limit', '10']);

    expectSpawnSuccess(result);
    const response = JSON.parse(result.stdout);
    expect(response.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'import', name: 'Injectable' }),
      expect.objectContaining({ kind: 'class', name: 'InjectableService' }),
    ]));
    expect(response.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'InjectableService' }),
    ]));
    expect(response.entryPoints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'import' }),
    ]));
    expect(response.entryPoints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'export' }),
    ]));
    expect(response.entryPoints).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'parameter' }),
    ]));
  });
}
