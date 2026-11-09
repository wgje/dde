import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextMatchRankSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    makeFakeCodegraph,
    readJsonLine,
    waitForLogEvent,
  } = context;

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
}
