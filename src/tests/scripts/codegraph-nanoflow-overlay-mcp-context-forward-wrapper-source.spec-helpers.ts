import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import {
  callContextPack,
  extractContextSourceHeaders,
  writeOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';
import { writeFakeCodegraphExploreScript } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpContextForwardWrapperSourceSpec(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
  } = context;

  it('keeps exact wrapper function source visible when base CodeGraph returns a noisy single source block', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-forward-wrapper-source-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        'function forwardToCodegraph(jsonText) {',
        '  const text = jsonText.trim();',
        '  return writeToCodegraphStdin(`${text}\\n`, "client-message");',
        '}',
        '',
        'function requestChildShutdown(reason) {',
        '  return { reason, expectedExit: true };',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/sync-rpc-client.service.ts',
      [
        'export class SyncRpcClientService {',
        '  server = "rpc";',
        '}',
        '',
      ].join('\n'),
    );

    const query = 'forwardToCodegraph 主体 shutdown 机制';
    writeOverlayResponseScript(projectRoot, {
      query,
      matches: [
        {
          kind: 'function',
          name: 'forwardToCodegraph',
          file: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          score: 429,
        },
        {
          kind: 'function',
          name: 'requestChildShutdown',
          file: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          score: 5,
        },
      ],
      nodes: [
        {
          id: 'function:scripts/codegraph-nanoflow-mcp-stdio.cjs:forwardToCodegraph',
          kind: 'function',
          name: 'forwardToCodegraph',
          qualifiedName: 'forwardToCodegraph',
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          language: 'javascript',
          startLine: 1,
          endLine: 4,
        },
        {
          id: 'function:scripts/codegraph-nanoflow-mcp-stdio.cjs:requestChildShutdown',
          kind: 'function',
          name: 'requestChildShutdown',
          qualifiedName: 'requestChildShutdown',
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          language: 'javascript',
          startLine: 6,
          endLine: 8,
        },
      ],
      relationshipGroups: {
        calls: [
          {
            source: 'forwardToCodegraph',
            target: 'writeToCodegraphStdin',
            relation: 'call',
          },
        ],
      },
      coverage: { graphNodes: 2, graphEdges: 1 },
    });

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-forward-wrapper-source-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [
        {
          header: 'src/services/sync-rpc-client.service.ts — server(variable)',
          language: 'typescript',
          lines: [
            '1\texport class SyncRpcClientService {',
            '2\t  server = "rpc";',
            '3\t}',
          ],
        },
      ],
    });

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      readJsonLine,
      query,
    });

    const sourceHeaders = extractContextSourceHeaders(text);
    expect(sourceHeaders[0]).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
    expect(text).toContain('function forwardToCodegraph(jsonText)');
    expect(text).toContain('writeToCodegraphStdin');
    expect(sourceHeaders.join('\n')).not.toContain('sync-rpc-client.service.ts');
  }, 12_000);
}
