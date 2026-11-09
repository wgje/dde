import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeQueryAwareOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';
import { writeFakeCodegraphExploreScript } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextQualityToolingFocusSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
  } = context;

  it('focuses tooling test wording before overlay lookup to avoid business stale-test pollution', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-tooling-test-focus-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/smoke-codegraph-mcp-wrapper.cjs',
      [
        'function verifyStaleWrapperAnalysis(analysis) {',
        "  return analysis.failureClass === 'stale-wrapper-script';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/project-operation-conflict-stale-remote.spec-helpers.ts',
      [
        'export interface ProjectOperationConflictStaleRemoteSpecContext {',
        '  staleRemoteVersion: number;',
        '}',
        '',
      ].join('\n'),
    );

    const noisyQuery = 'stale wrapper test assertions codegraph mcp wrapper stale-smoke';
    const focusedQuery = 'wrapper mcp smoke';
    const noisyResponse = {
      query: noisyQuery,
      matches: [
        {
          kind: 'interface',
          name: 'ProjectOperationConflictStaleRemoteSpecContext',
          file: 'src/services/project-operation-conflict-stale-remote.spec-helpers.ts',
        },
      ],
      nodes: [
        {
          id: 'interface:src/services/project-operation-conflict-stale-remote.spec-helpers.ts:ProjectOperationConflictStaleRemoteSpecContext',
          kind: 'interface',
          name: 'ProjectOperationConflictStaleRemoteSpecContext',
          qualifiedName: 'ProjectOperationConflictStaleRemoteSpecContext',
          filePath: 'src/services/project-operation-conflict-stale-remote.spec-helpers.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        {
          kind: 'function',
          name: 'verifyStaleWrapperAnalysis',
          file: 'scripts/smoke-codegraph-mcp-wrapper.cjs',
        },
      ],
      nodes: [
        {
          id: 'function:scripts/smoke-codegraph-mcp-wrapper.cjs:verifyStaleWrapperAnalysis',
          kind: 'function',
          name: 'verifyStaleWrapperAnalysis',
          qualifiedName: 'verifyStaleWrapperAnalysis',
          filePath: 'scripts/smoke-codegraph-mcp-wrapper.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 3,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-tooling-test-focus-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {});

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query: noisyQuery,
    });

    expect(text).toContain(`baseQuery=${focusedQuery}`);
    expect(text).toContain('verifyStaleWrapperAnalysis');
    expect(text).not.toContain('ProjectOperationConflictStaleRemoteSpecContext');
  }, 12_000);

  it('keeps stale wrapper assertion wording on lifecycle diagnostics instead of return/exit business code', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-stale-wrapper-assertion-focus-'));
    tempRoots.push(projectRoot);
    const lifecycleSpecLines = [
      'export function registerCodegraphOverlayMcpLifecycleDiagnosticSpecs(): void {',
      "  expect(logText).toContain('wrapper.shutdown.stale-wrapper-script');",
      '  expect(shutdownEvent.expectedExit).toBe(true);',
      "  expect(contextEvent).toEqual(expect.objectContaining({ source: 'nanoflow-context-pack' }));",
      '  await expect(childExitPromise).resolves.toEqual(expect.objectContaining({',
      '    code: 0,',
      '    signal: null,',
      '  }));',
      ...Array.from({ length: 140 }, (_, index) => `  const filler${index} = ${index};`),
      '}',
      '',
    ];
    writeFile(
      projectRoot,
      'src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts',
      lifecycleSpecLines.join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/features/flow/services/flow-task-detail-form.service.ts',
      [
        'export class FlowTaskDetailFormService {',
        '  shouldExitEditMode(): boolean {',
        '    return true;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/core/services/sync/connection-rest-persistence.service.ts',
      [
        'export class ConnectionRestPersistenceService {',
        '  insertConnectionReturningUpdatedAt(): string {',
        "    return 'updated_at';",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/serve-pwa-preview.cjs',
      [
        'function shutdown() {',
        "  return 'preview stopped';",
        '}',
        '',
      ].join('\n'),
    );

    const noisyQueries = [
      'stale wrapper assertions return exit host restart test',
      '测试 stale wrapper 返回退出 host 重启 断言',
    ];
    const focusedQuery = 'stale wrapper shutdown lifecycle diagnostics spec assertions';
    const noisyResponse = {
      query: noisyQueries[0],
      matches: [
        {
          kind: 'method',
          name: 'shouldExitEditMode',
          file: 'src/app/features/flow/services/flow-task-detail-form.service.ts',
        },
        {
          kind: 'method',
          name: 'insertConnectionReturningUpdatedAt',
          file: 'src/app/core/services/sync/connection-rest-persistence.service.ts',
        },
      ],
      nodes: [
        {
          id: 'method:src/app/features/flow/services/flow-task-detail-form.service.ts:FlowTaskDetailFormService::shouldExitEditMode',
          kind: 'method',
          name: 'shouldExitEditMode',
          qualifiedName: 'FlowTaskDetailFormService::shouldExitEditMode',
          filePath: 'src/app/features/flow/services/flow-task-detail-form.service.ts',
          language: 'typescript',
          startLine: 2,
          endLine: 4,
        },
        {
          id: 'method:src/app/core/services/sync/connection-rest-persistence.service.ts:ConnectionRestPersistenceService::insertConnectionReturningUpdatedAt',
          kind: 'method',
          name: 'insertConnectionReturningUpdatedAt',
          qualifiedName: 'ConnectionRestPersistenceService::insertConnectionReturningUpdatedAt',
          filePath: 'src/app/core/services/sync/connection-rest-persistence.service.ts',
          language: 'typescript',
          startLine: 2,
          endLine: 4,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 2, graphEdges: 0 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        {
          kind: 'function',
          name: 'registerCodegraphOverlayMcpLifecycleDiagnosticSpecs',
          file: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts',
        },
      ],
      nodes: [
        {
          id: 'function:src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts:registerCodegraphOverlayMcpLifecycleDiagnosticSpecs',
          kind: 'function',
          name: 'registerCodegraphOverlayMcpLifecycleDiagnosticSpecs',
          qualifiedName: 'registerCodegraphOverlayMcpLifecycleDiagnosticSpecs',
          filePath: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts',
          language: 'typescript',
          startLine: 1,
          endLine: lifecycleSpecLines.length - 1,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 1, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-stale-wrapper-assertion-focus-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [
        {
          header: 'scripts/serve-pwa-preview.cjs — shutdown(function)',
          language: 'javascript',
          lines: [
            '1\tfunction shutdown() {',
            "2\t  return 'preview stopped';",
            '3\t}',
          ],
        },
        {
          header: 'src/app/core/shell/workspace-shell-keyboard-shortcuts.controller.ts — handleShortcut(method)',
          language: 'typescript',
          lines: [
            '1\texport class WorkspaceShellKeyboardShortcutsController {',
            '2\t  handleShortcut(): void {}',
            '3\t}',
          ],
        },
      ],
    });

    for (const noisyQuery of noisyQueries) {
      const text = await callContextPack({
        repoRoot,
        wrapperScriptPath,
        projectRoot,
        fakeCodegraph,
        readJsonLine,
        query: noisyQuery,
      });

      const sourceHeaders = extractContextSourceHeaders(text);
      expect(text).toContain(`baseQuery=${focusedQuery}`);
      expect(sourceHeaders[0]).toContain('codegraph-nanoflow-overlay-mcp-lifecycle-diagnostics.spec-helpers.ts');
      expect(text).toContain('wrapper.shutdown.stale-wrapper-script');
      expect(text).toContain('expectedExit');
      expect(text).toContain('childExitPromise');
      expect(text).toContain('code: 0');
      expect(text).toContain('signal: null');
      expect(text).toContain("source: 'nanoflow-context-pack'");
      expect(text).not.toContain('serve-pwa-preview.cjs');
      expect(text).not.toContain('workspace-shell-keyboard-shortcuts.controller.ts');
      expect(text).not.toContain('shouldExitEditMode');
      expect(text).not.toContain('insertConnectionReturningUpdatedAt');
    }
  }, 12_000);

  it('focuses broad helper fixture quality queries on the context-quality fixture helper', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-helper-fixture-quality-focus-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts',
      [
        'export function buildFakeCodegraphExploreScript(config) {',
        '  return JSON.stringify(config);',
        '}',
        '',
        'export function writeFakeCodegraphExploreScript(filePath, config) {',
        '  return [filePath, buildFakeCodegraphExploreScript(config)];',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/analyze-codegraph-mcp-log-current-wrapper.spec-helpers.ts',
      [
        'export function registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs() {',
        '  return true;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/core/external-sources/external-source.model.ts',
      [
        "export type ExternalSourceLinkRow = { sourceType: string };",
        '',
      ].join('\n'),
    );

    const noisyQuery = 'NanoFlow CodeGraph current adaptation helper fixtures generic script source blocks quality standard';
    const focusedQuery = [
      'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts',
      'buildFakeCodegraphExploreScript',
      'writeFakeCodegraphExploreScript',
      'context-pack source quality fixtures',
    ].join(' ');
    const noisyResponse = {
      query: noisyQuery,
      matches: [
        { kind: 'function', name: 'registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs', file: 'src/tests/scripts/analyze-codegraph-mcp-log-current-wrapper.spec-helpers.ts' },
        { kind: 'type_alias', name: 'ExternalSourceLinkRow', file: 'src/app/core/external-sources/external-source.model.ts' },
      ],
      nodes: [
        {
          id: 'function:src/tests/scripts/analyze-codegraph-mcp-log-current-wrapper.spec-helpers.ts:registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs',
          kind: 'function',
          name: 'registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs',
          qualifiedName: 'registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs',
          filePath: 'src/tests/scripts/analyze-codegraph-mcp-log-current-wrapper.spec-helpers.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'type_alias:src/app/core/external-sources/external-source.model.ts:ExternalSourceLinkRow',
          kind: 'type_alias',
          name: 'ExternalSourceLinkRow',
          qualifiedName: 'ExternalSourceLinkRow',
          filePath: 'src/app/core/external-sources/external-source.model.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 1,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 2, graphEdges: 0 },
    };
    const focusedResponse = {
      query: focusedQuery,
      matches: [
        { kind: 'function', name: 'buildFakeCodegraphExploreScript', file: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts' },
        { kind: 'function', name: 'writeFakeCodegraphExploreScript', file: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts' },
      ],
      nodes: [
        {
          id: 'function:src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts:buildFakeCodegraphExploreScript',
          kind: 'function',
          name: 'buildFakeCodegraphExploreScript',
          qualifiedName: 'buildFakeCodegraphExploreScript',
          filePath: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 3,
        },
        {
          id: 'function:src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts:writeFakeCodegraphExploreScript',
          kind: 'function',
          name: 'writeFakeCodegraphExploreScript',
          qualifiedName: 'writeFakeCodegraphExploreScript',
          filePath: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts',
          language: 'typescript',
          startLine: 5,
          endLine: 7,
        },
      ],
      relationshipGroups: {},
      coverage: { graphNodes: 2, graphEdges: 0 },
    };
    writeQueryAwareOverlayResponseScript(projectRoot, focusedQuery, focusedResponse, noisyResponse);

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-helper-fixture-quality-focus-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      focusedQuery,
      focused: {
        includeMaxFiles: true,
        preludeLines: [
          'Found 2 symbols across 2 files.',
          '',
          '**Relationships**',
          '',
          '**references:**',
          '- ExternalSourceLinkRow → registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs',
        ],
        sourceBlocks: [
          {
            header: 'src/tests/scripts/analyze-codegraph-mcp-log-current-wrapper.spec-helpers.ts — registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs(function)',
            language: 'typescript',
            lines: [
              '1\texport function registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs() {',
              '2\t  return true;',
              '3\t}',
            ],
          },
          {
            header: 'src/app/core/external-sources/external-source.model.ts — ExternalSourceLinkRow(type_alias)',
            language: 'typescript',
            lines: [
              "1\texport type ExternalSourceLinkRow = { sourceType: string };",
            ],
          },
        ],
      },
      fallback: {
        includeMaxFiles: true,
        sourceBlocks: [
          {
            header: 'src/tests/scripts/analyze-codegraph-mcp-log-current-wrapper.spec-helpers.ts — registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs(function)',
            language: 'typescript',
            lines: ['1\texport function registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs() {', '2\t  return true;', '3\t}'],
          },
          {
            header: 'src/app/core/external-sources/external-source.model.ts — ExternalSourceLinkRow(type_alias)',
            language: 'typescript',
            lines: ["1\texport type ExternalSourceLinkRow = { sourceType: string };"],
          },
        ],
      },
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query: noisyQuery,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(text).toContain(`baseQuery=${focusedQuery}`);
    expect(sourceHeaders[0]).toContain('codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts');
    expect(text).toContain('buildFakeCodegraphExploreScript');
    expect(text).toContain('writeFakeCodegraphExploreScript');
    expect(text).not.toContain('registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs');
    expect(text).not.toContain('ExternalSourceLinkRow');
  }, 12_000);
}
