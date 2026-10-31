import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayMcpContextSourceRankingBaseReorderSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ranking-base-reorder.spec-helpers';
import { registerCodegraphOverlayMcpContextSourceRankingBudgetSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ranking-budget.spec-helpers';
import { registerCodegraphOverlayMcpContextSourceRankingExternalSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ranking-external.spec-helpers';
import { registerCodegraphOverlayMcpContextSourceRankingPromotionSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ranking-promotion.spec-helpers';

export function registerCodegraphOverlayMcpContextSourceRankingSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    makeFakeCodegraph,
    readJsonLine,
    waitForLogEvent,
  } = context;

  registerCodegraphOverlayMcpContextSourceRankingBaseReorderSpecs(context);

  it('keeps the top-ranked base source block ahead of injected overlay source evidence', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-injected-reorder-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/sync/retry-queue.service.ts',
      [
        'export class RetryQueueService {',
        '  private storageReady = false;',
        '  initializeStorageLoad(): void {',
        '    this.storageReady = true;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/core/services/sync/retry-queue-base.service.ts',
      [
        'export class RetryQueueBaseService {',
        '  captureStorageLoadToken(): string { return "token"; }',
        '  isStorageLoadTokenCurrent(): boolean { return true; }',
        '  logStaleStorageLoad(): void {}',
        '  closeStorageConnections(): void {}',
        '  loadFromStorage(): void {}',
        '  saveToStorageImmediate(): void {}',
        '  lifecycleClosed = false;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'RetryQueueService initializeStorageLoad captureStorageLoadToken isStorageLoadTokenCurrent logStaleStorageLoad closeStorageConnections loadFromStorage saveToStorageImmediate lifecycleClosed race',",
        '  matches: [{',
        '    kind: "class",',
        '    name: "RetryQueueService",',
        '    file: "src/app/core/services/sync/retry-queue.service.ts"',
        '  }, {',
        '    kind: "class",',
        '    name: "RetryQueueBaseService",',
        '    file: "src/app/core/services/sync/retry-queue-base.service.ts"',
        '  }],',
        '  nodes: [{',
        '    id: "class:src/app/core/services/sync/retry-queue.service.ts:RetryQueueService",',
        '    kind: "class",',
        '    name: "RetryQueueService",',
        '    qualifiedName: "RetryQueueService",',
        '    filePath: "src/app/core/services/sync/retry-queue.service.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 6',
        '  }, {',
        '    id: "method:src/app/core/services/sync/retry-queue.service.ts:RetryQueueService::initializeStorageLoad",',
        '    kind: "method",',
        '    name: "initializeStorageLoad",',
        '    qualifiedName: "RetryQueueService::initializeStorageLoad",',
        '    filePath: "src/app/core/services/sync/retry-queue.service.ts",',
        '    language: "typescript",',
        '    startLine: 3,',
        '    endLine: 5',
        '  }, {',
        '    id: "class:src/app/core/services/sync/retry-queue-base.service.ts:RetryQueueBaseService",',
        '    kind: "class",',
        '    name: "RetryQueueBaseService",',
        '    qualifiedName: "RetryQueueBaseService",',
        '    filePath: "src/app/core/services/sync/retry-queue-base.service.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 9',
        '  }, {',
        '    id: "method:src/app/core/services/sync/retry-queue-base.service.ts:RetryQueueBaseService::captureStorageLoadToken",',
        '    kind: "method",',
        '    name: "captureStorageLoadToken",',
        '    qualifiedName: "RetryQueueBaseService::captureStorageLoadToken",',
        '    filePath: "src/app/core/services/sync/retry-queue-base.service.ts",',
        '    language: "typescript",',
        '    startLine: 2,',
        '    endLine: 2',
        '  }, {',
        '    id: "method:src/app/core/services/sync/retry-queue-base.service.ts:RetryQueueBaseService::isStorageLoadTokenCurrent",',
        '    kind: "method",',
        '    name: "isStorageLoadTokenCurrent",',
        '    qualifiedName: "RetryQueueBaseService::isStorageLoadTokenCurrent",',
        '    filePath: "src/app/core/services/sync/retry-queue-base.service.ts",',
        '    language: "typescript",',
        '    startLine: 3,',
        '    endLine: 3',
        '  }, {',
        '    id: "property:src/app/core/services/sync/retry-queue-base.service.ts:RetryQueueBaseService::lifecycleClosed",',
        '    kind: "property",',
        '    name: "lifecycleClosed",',
        '    qualifiedName: "RetryQueueBaseService::lifecycleClosed",',
        '    filePath: "src/app/core/services/sync/retry-queue-base.service.ts",',
        '    language: "typescript",',
        '    startLine: 8,',
        '    endLine: 8',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 2, graphNodes: 6, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-injected-reorder-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-injected-reorder-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method !== 'tools/call' || message.params?.name !== 'codegraph_explore') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        "    return;",
        "  }",
        "  const query = message.params.arguments.query;",
        "  const text = [",
        "    '## Exploration: ' + query,",
        "    '',",
        "    'Found 2 symbols across 2 files.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '#### src/app/core/services/sync/retry-queue.service.ts — RetryQueueService(class), initializeStorageLoad(method)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class RetryQueueService {',",
        "    '2\\t  private storageReady = false;',",
        "    '6\\t}',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/services/sync/retry-queue-base.service.ts — captureStorageLoadToken(method), isStorageLoadTokenCurrent(method), logStaleStorageLoad(method), closeStorageConnections(method), loadFromStorage(method), saveToStorageImmediate(method), lifecycleClosed(property)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class RetryQueueBaseService {',",
        "    '2\\t  captureStorageLoadToken(): string { return \"token\"; }',",
        "    '3\\t  isStorageLoadTokenCurrent(): boolean { return true; }',",
        "    '4\\t  logStaleStorageLoad(): void {}',",
        "    '5\\t  closeStorageConnections(): void {}',",
        "    '6\\t  loadFromStorage(): void {}',",
        "    '7\\t  saveToStorageImmediate(): void {}',",
        "    '8\\t  lifecycleClosed = false;',",
        "    '9\\t}',",
        "    '```',",
        "  ].join('\\n');",
        "  console.log(JSON.stringify({",
        "    jsonrpc: '2.0',",
        "    id: message.id,",
        "    result: { content: [{ type: 'text', text }] },",
        "  }));",
        "});",
        '',
      ].join('\n'),
    );

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 52,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'RetryQueueService initializeStorageLoad captureStorageLoadToken isStorageLoadTokenCurrent logStaleStorageLoad closeStorageConnections loadFromStorage saveToStorageImmediate lifecycleClosed race',
            overlayLimit: 2,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text.indexOf('#### src/app/core/services/sync/retry-queue-base.service.ts')).toBeLessThan(
        text.indexOf('#### src/app/core/services/sync/retry-queue.service.ts'),
      );

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 52,
      );
      expect(responseEvent).toEqual(expect.objectContaining({
        sourceOrdering: expect.objectContaining({
          baseSourceReorderAllowed: true,
          baseSourceReorderReason: 'focused-member-overlay-evidence',
          firstSourceFiles: expect.arrayContaining([
            'src/app/core/services/sync/retry-queue-base.service.ts',
            'src/app/core/services/sync/retry-queue.service.ts',
          ]),
          topRankedOverlayFile: 'src/app/core/services/sync/retry-queue-base.service.ts',
          topRankedOverlayFileVisibleIndex: 0,
          firstSourceBlockIsTopRankedOverlayFile: true,
          topRankedOverlayFileMissing: false,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('orders multiple overlay source candidates by match relevance instead of file name', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-match-rank-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/a-generic-cleanup.service.ts',
      [
        'export class AGenericCleanupService {',
        '  cleanup(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/z-event-driven-sync-pulse.service.ts',
      [
        'export class EventDrivenSyncPulseService {',
        '  triggerNow(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'EventDrivenSyncPulseService triggerNow cleanup service',",
        '  matches: [{',
        '    kind: "class",',
        '    name: "EventDrivenSyncPulseService",',
        '    file: "src/z-event-driven-sync-pulse.service.ts"',
        '  }, {',
        '    kind: "class",',
        '    name: "AGenericCleanupService",',
        '    file: "src/a-generic-cleanup.service.ts"',
        '  }],',
        '  nodes: [{',
        '    id: "class:src/z-event-driven-sync-pulse.service.ts:EventDrivenSyncPulseService",',
        '    kind: "class",',
        '    name: "EventDrivenSyncPulseService",',
        '    qualifiedName: "EventDrivenSyncPulseService",',
        '    filePath: "src/z-event-driven-sync-pulse.service.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }, {',
        '    id: "method:src/z-event-driven-sync-pulse.service.ts:EventDrivenSyncPulseService::triggerNow",',
        '    kind: "method",',
        '    name: "triggerNow",',
        '    qualifiedName: "EventDrivenSyncPulseService::triggerNow",',
        '    filePath: "src/z-event-driven-sync-pulse.service.ts",',
        '    language: "typescript",',
        '    startLine: 2,',
        '    endLine: 2',
        '  }, {',
        '    id: "class:src/a-generic-cleanup.service.ts:AGenericCleanupService",',
        '    kind: "class",',
        '    name: "AGenericCleanupService",',
        '    qualifiedName: "AGenericCleanupService",',
        '    filePath: "src/a-generic-cleanup.service.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 2, graphNodes: 3, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-match-rank-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));

    const child = spawn(
      process.execPath,
      [wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
      {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 49,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'EventDrivenSyncPulseService triggerNow cleanup service',
            overlayLimit: 2,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text.indexOf('#### src/z-event-driven-sync-pulse.service.ts')).toBeLessThan(
        text.indexOf('#### src/a-generic-cleanup.service.ts'),
      );
      expect(text).toContain('2\t  triggerNow(): void {}');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 49,
      );
      expect(responseEvent).toEqual(expect.objectContaining({
        sourceOrdering: expect.objectContaining({
          firstSourceFiles: [
            'src/z-event-driven-sync-pulse.service.ts',
            'src/a-generic-cleanup.service.ts',
          ],
          rankedOverlayFiles: [
            'src/z-event-driven-sync-pulse.service.ts',
            'src/a-generic-cleanup.service.ts',
          ],
          rankedOverlayFileDetails: [
            expect.objectContaining({
              filePath: 'src/z-event-driven-sync-pulse.service.ts',
              matchRank: 0,
            }),
            expect.objectContaining({
              filePath: 'src/a-generic-cleanup.service.ts',
              matchRank: 1,
            }),
          ],
          firstSourceBlockIsTopRankedOverlayFile: true,
          topRankedOverlayFileMissing: false,
        }),
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  registerCodegraphOverlayMcpContextSourceRankingPromotionSpecs(context);

  registerCodegraphOverlayMcpContextSourceRankingBudgetSpecs(context);
  registerCodegraphOverlayMcpContextSourceRankingExternalSpecs(context);
}
