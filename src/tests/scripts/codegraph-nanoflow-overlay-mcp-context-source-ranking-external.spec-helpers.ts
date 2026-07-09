import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextSourceRankingExternalSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    makeFakeCodegraph,
    readJsonLine,
    waitForLogEvent,
  } = context;

  it('ignores external package matches when ranking renderable overlay source files', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-external-package-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/sync/retry-queue.service.ts',
      [
        'export class RetryQueueService {',
        '  enqueue(operationId: string): void {',
        '    void operationId;',
        '  }',
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
        "  query: 'idb-keyval retry queue service',",
        '  matches: [{',
        '    kind: "import",',
        '    name: "get",',
        '    score: 100,',
        '    item: { target: "idb-keyval" }',
        '  }, {',
        '    kind: "class",',
        '    name: "RetryQueueService",',
        '    file: "src/app/core/services/sync/retry-queue.service.ts"',
        '  }],',
        '  nodes: [{',
        '    id: "class:src/app/core/services/sync/retry-queue.service.ts:RetryQueueService",',
        '    kind: "class",',
        '    name: "RetryQueueService",',
        '    qualifiedName: "RetryQueueService",',
        '    filePath: "src/app/core/services/sync/retry-queue.service.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 5',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 1, graphNodes: 1, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-external-package-log-')),
      'wrapper.log',
    );
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
        id: 50,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'idb-keyval retry queue service',
            overlayLimit: 2,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain('#### src/app/core/services/sync/retry-queue.service.ts');
      expect(text).not.toContain('#### idb-keyval');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 50,
      );
      const sourceOrdering = responseEvent.sourceOrdering as {
        rankedOverlayFiles: string[];
        topRankedOverlayFile: string | null;
        topRankedOverlayFileVisibleIndex: number;
        topRankedOverlayFileMissing: boolean;
      };
      expect(sourceOrdering.rankedOverlayFiles).not.toContain('idb-keyval');
      expect(sourceOrdering.topRankedOverlayFile).toBe('src/app/core/services/sync/retry-queue.service.ts');
      expect(sourceOrdering.topRankedOverlayFileVisibleIndex).toBe(0);
      expect(sourceOrdering.topRankedOverlayFileMissing).toBe(false);
    } finally {
      child.kill();
    }
  }, 12_000);
}
