import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

interface CodegraphOverlayMcpContextSourceFilteringTailSpecContext
  extends CodegraphOverlaySpecContext {
  extractContextSourceHeaders(text: string): string[];
  spawnContextPackWrapper(
    fakeCodegraph: string,
    projectRoot: string,
    logPath?: string,
  ): ChildProcessWithoutNullStreams;
}

export function registerCodegraphOverlayMcpContextSourceFilteringTailSpecs(
  context: CodegraphOverlayMcpContextSourceFilteringTailSpecContext,
): void {
  const {
    tempRoots,
    writeFile,
    readJsonLine,
    waitForLogEvent,
    extractContextSourceHeaders,
    spawnContextPackWrapper,
  } = context;

  it('filters minified bundles source maps and lockfiles unless explicitly requested', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-bundle-lock-noise-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/shell/project-shell.component.ts',
      [
        'export class ProjectShellComponent {',
        "  readonly startupMode = 'workspace';",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(projectRoot, 'src/app/core/shell/project-shell.component.min.js', 'export const minifiedProjectShellComponent=true;\n');
    writeFile(projectRoot, 'src/app/core/shell/project-shell.component.js.map', '{"sources":["project-shell.component.ts"]}\n');
    writeFile(projectRoot, 'package-lock.json', '{"name":"ProjectShellComponent"}\n');
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify({',
        '  query: "ProjectShellComponent startup",',
        '  matches: [{',
        '    kind: "class",',
        '    name: "ProjectShellComponent",',
        '    file: "src/app/core/shell/project-shell.component.ts"',
        '  }],',
        '  nodes: [],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 1, graphNodes: 0, graphEdges: 0 }',
        '}));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-bundle-lock-noise-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-bundle-lock-noise-log-')), 'wrapper.log');
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
        "    'Found 4 symbols across 4 files.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '#### src/app/core/shell/project-shell.component.min.js — minifiedProjectShellComponent(constant)',",
        "    '',",
        "    '```javascript',",
        "    '1\\texport const minifiedProjectShellComponent=true;',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/shell/project-shell.component.js.map — ProjectShellComponent(source-map)',",
        "    '',",
        "    '```json',",
        "    '1\\t{\\\"sources\\\":[\\\"project-shell.component.ts\\\"]}',",
        "    '```',",
        "    '',",
        "    '#### package-lock.json — ProjectShellComponent(lockfile)',",
        "    '',",
        "    '```json',",
        "    '1\\t{\\\"name\\\":\\\"ProjectShellComponent\\\"}',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/shell/project-shell.component.ts — ProjectShellComponent(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class ProjectShellComponent {',",
        "    '2\\t  readonly startupMode = \\'workspace\\';',",
        "    '3\\t}',",
        "    '```',",
        "  ].join('\\n');",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
        "});",
        '',
      ].join('\n'),
    );

    const child = spawnContextPackWrapper(fakeCodegraph, projectRoot, logPath);

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'ProjectShellComponent startup',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      const sourceHeaders = extractContextSourceHeaders(text);
      expect(contextResponse.result.isError).toBe(false);
      expect(sourceHeaders).toEqual([
        'src/app/core/shell/project-shell.component.ts — ProjectShellComponent(class)',
      ]);
      expect(text).not.toContain('project-shell.component.min.js');
      expect(text).not.toContain('project-shell.component.js.map');
      expect(text).not.toContain('package-lock.json');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 50,
      );
      const sourceSelection = responseEvent.sourceSelection as {
        filteredSourceFiles?: Array<{ filePath?: string; reason?: string; lowValuePenalty?: number }>;
      };
      const filteredFiles = sourceSelection.filteredSourceFiles ?? [];
      expect(filteredFiles.map(file => file.filePath)).toEqual(expect.arrayContaining([
        'src/app/core/shell/project-shell.component.min.js',
        'src/app/core/shell/project-shell.component.js.map',
        'package-lock.json',
      ]));
      expect(filteredFiles.every(file => file.reason === 'low-value-source-path')).toBe(true);
      expect(filteredFiles.every(file => Number(file.lowValuePenalty ?? 0) > 0)).toBe(true);
    } finally {
      child.kill();
    }
  }, 12_000);
}
