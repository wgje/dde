import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

interface CodegraphOverlayMcpContextSourceFilteringArtifactsMetadataSpecContext
  extends CodegraphOverlaySpecContext {
  extractContextSourceHeaders(text: string): string[];
  spawnContextPackWrapper(
    fakeCodegraph: string,
    projectRoot: string,
    logPath?: string,
  ): ChildProcessWithoutNullStreams;
}

export function registerCodegraphOverlayMcpContextSourceFilteringArtifactsMetadataSpecs(
  context: CodegraphOverlayMcpContextSourceFilteringArtifactsMetadataSpecContext,
): void {
  const {
    tempRoots,
    writeFile,
    readJsonLine,
    waitForLogEvent,
    extractContextSourceHeaders,
    spawnContextPackWrapper,
  } = context;

  it('filters build, cache, and coverage source blocks unless explicitly requested', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-build-cache-noise-'));
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
    writeFile(projectRoot, 'dist/main.js', 'export const bundledProjectShellComponent = true;\n');
    writeFile(projectRoot, 'coverage/lcov-report/index.html', '<main>ProjectShellComponent coverage</main>\n');
    writeFile(projectRoot, '.angular/cache/project-shell.component.ts', 'export const cachedProjectShellComponent = true;\n');
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
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-build-cache-noise-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-build-cache-noise-log-')), 'wrapper.log');
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
        "    '#### dist/main.js — bundledProjectShellComponent(constant)',",
        "    '',",
        "    '```javascript',",
        "    '1\\texport const bundledProjectShellComponent = true;',",
        "    '```',",
        "    '',",
        "    '#### coverage/lcov-report/index.html — ProjectShellComponent(coverage)',",
        "    '',",
        "    '```html',",
        "    '1\\t<main>ProjectShellComponent coverage</main>',",
        "    '```',",
        "    '',",
        "    '#### .angular/cache/project-shell.component.ts — cachedProjectShellComponent(constant)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport const cachedProjectShellComponent = true;',",
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
        id: 49,
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
      expect(text).not.toContain('dist/main.js');
      expect(text).not.toContain('coverage/lcov-report/index.html');
      expect(text).not.toContain('.angular/cache/project-shell.component.ts');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 49,
      );
      const sourceSelection = responseEvent.sourceSelection as {
        filteredSourceFiles?: Array<{ filePath?: string; reason?: string; lowValuePenalty?: number }>;
      };
      const filteredFiles = sourceSelection.filteredSourceFiles ?? [];
      expect(filteredFiles.map(file => file.filePath)).toEqual(expect.arrayContaining([
        'dist/main.js',
        'coverage/lcov-report/index.html',
        '.angular/cache/project-shell.component.ts',
      ]));
      expect(filteredFiles.every(file => file.reason === 'low-value-source-path')).toBe(true);
      expect(filteredFiles.every(file => Number(file.lowValuePenalty ?? 0) > 0)).toBe(true);
    } finally {
      child.kill();
    }
  }, 12_000);

  it('filters low-value base metadata sections after source code without dropping clean metadata', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-post-source-metadata-'));
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
    writeFile(
      projectRoot,
      'src/app/core/shell/project-shell.component.spec.ts',
      [
        "describe('ProjectShellComponent', () => {",
        '  it("boots", () => {});',
        '});',
        '',
      ].join('\n'),
    );
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
        '  nodes: [{',
        '    id: "class:src/app/core/shell/project-shell.component.ts:ProjectShellComponent",',
        '    kind: "class",',
        '    name: "ProjectShellComponent",',
        '    qualifiedName: "ProjectShellComponent",',
        '    filePath: "src/app/core/shell/project-shell.component.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 2, graphNodes: 1, graphEdges: 0 }',
        '}));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-post-source-metadata-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-post-source-metadata-log-')),
      'wrapper.log',
    );
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
        "    '### Source Code',",
        "    '',",
        "    '#### src/app/core/shell/project-shell.component.ts — ProjectShellComponent(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class ProjectShellComponent {',",
        "    '2\\t  readonly startupMode = \\'workspace\\';',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        "    '### Related Symbols',",
        "    '',",
        "    '- src/app/core/shell/project-shell.component.ts — ProjectShellComponent(class)',",
        "    '- src/app/core/shell/project-shell.component.spec.ts — ProjectShellComponent(spec)',",
        "    '',",
        "    '### Relationships',",
        "    '',",
        "    '- ProjectShellComponent -> ProjectShellComponentSpec (references)',",
        "    '- src/app/core/shell/project-shell.component.spec.ts -> ProjectShellComponent (tests)',",
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
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain('### Related Symbols');
      expect(text).toContain('### Relationships');
      expect(text).toContain('- src/app/core/shell/project-shell.component.ts — ProjectShellComponent(class)');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 50,
      );
      const baseSectionFiltering = responseEvent.baseSectionFiltering as {
        filteredLineCount?: number;
        sectionsTouched?: unknown[];
        filteredLineDetails?: Array<{ section?: string; filePath?: string; reason?: string }>;
      };
      expect(baseSectionFiltering).toEqual(expect.objectContaining({
        filteredLineCount: 2,
        sectionsTouched: expect.arrayContaining(['Related Symbols', 'Relationships']),
      }));
      expect(baseSectionFiltering.filteredLineDetails).toEqual(expect.arrayContaining([
        expect.objectContaining({
          section: 'Related Symbols',
          filePath: 'src/app/core/shell/project-shell.component.spec.ts',
          reason: 'low-value-source',
        }),
        expect.objectContaining({
          section: 'Relationships',
          filePath: 'src/app/core/shell/project-shell.component.spec.ts',
          reason: 'low-value-source',
        }),
      ]));
      expect(text).not.toContain('src/app/core/shell/project-shell.component.spec.ts');
    } finally {
      child.kill();
    }
  }, 12_000);
}
