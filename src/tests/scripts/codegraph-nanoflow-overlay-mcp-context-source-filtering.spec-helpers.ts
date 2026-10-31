import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayMcpContextSourceFilteringArtifactsMetadataSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-filtering-artifacts-metadata.spec-helpers';
import { registerCodegraphOverlayMcpContextSourceFilteringTailSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-filtering-tail.spec-helpers';

export function registerCodegraphOverlayMcpContextSourceFilteringSpecs(context: CodegraphOverlaySpecContext): void {
  const { tempRoots, writeFile, readJsonLine, waitForLogEvent } = context;

  it('filters low-ranked base CodeGraph source blocks after a strong explicit file hit', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-source-priority-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'vitest.services.config.mts',
      [
        "import { defineConfig } from 'vitest/config';",
        '',
        'export default defineConfig({',
        '  test: {',
        '    isolate: true,',
        "    setupFiles: ['./src/test-setup.services.ts'],",
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/generic-cleanup.service.ts',
      [
        'export class GenericCleanupService {',
        '  cleanup(): void {',
        '    const setupFiles = true;',
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
        "  query: 'vitest.services.config.mts setupFiles cleanup',",
        '  matches: [{ kind: "constant", name: "default", file: "vitest.services.config.mts" }],',
        '  nodes: [{',
        '    id: "constant:vitest.services.config.mts:default",',
        '    kind: "constant",',
        '    name: "default",',
        '    qualifiedName: "default",',
        '    filePath: "vitest.services.config.mts",',
        '    language: "typescript",',
        '    startLine: 3,',
        '    endLine: 8',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 1, graphNodes: 1, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-source-priority-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
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
        "    'Found 6 symbols across 6 files.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '#### vitest.services.config.mts — default(constant)',",
        "    '',",
        "    '```typescript',",
        "    '1\\timport { defineConfig } from \\'vitest/config\\';',",
        "    '2\\t',",
        "    '3\\texport default defineConfig({',",
        "    '4\\t  test: {',",
        "    '5\\t    isolate: true,',",
        "    '6\\t    setupFiles: [\\'./src/test-setup.services.ts\\'],',",
        "    '7\\t  },',",
        "    '8\\t});',",
        "    '```',",
        "    '',",
        "    '#### vitest.config.mts — default(constant)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport default defineConfig({ test: {} });',",
        "    '```',",
        "    '',",
        "    '#### vitest.components.config.mts — default(constant)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport default defineConfig({ test: { include: [\\'components\\'] } });',",
        "    '```',",
        "    '',",
        "    '#### vitest.minimal.config.mts — default(constant)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport default defineConfig({ test: { include: [\\'minimal\\'] } });',",
        "    '```',",
        "    '',",
        "    '#### src/app/features/flow/services/flow-relink-tool.service.ts — relink(method)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class FlowRelinkToolService {}',",
        "    '```',",
        "    '',",
        "    '#### src/app/features/flow/services/flow-link-template.service.ts — template(method)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class FlowLinkTemplateService {}',",
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

    const child = spawnContextPackWrapper(context, fakeCodegraph, projectRoot);

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 45,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'vitest.services.config.mts setupFiles cleanup',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      const sourceHeaders = [...text.matchAll(/^####\s+(.+)$/gm)].map((match) => match[1]);
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain('#### vitest.services.config.mts');
      expect(sourceHeaders.length).toBeLessThanOrEqual(4);
      expect(text).not.toContain('flow-relink-tool.service.ts');
      expect(text).not.toContain('flow-link-template.service.ts');
      expect(text).toContain("6\t    setupFiles: ['./src/test-setup.services.ts'],");
    } finally {
      child.kill();
    }
  }, 12_000);

  it('filters avoidable low-value base source blocks for plain symbol queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-low-value-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify({',
        '  query: "ProjectShellComponent",',
        '  matches: [{',
        '    kind: "class",',
        '    name: "ProjectShellComponent",',
        '    file: "src/app/core/shell/project-shell.component.ts"',
        '  }, {',
        '    kind: "class",',
        '    name: "ProjectShellContentResizeController",',
        '    file: "src/app/core/shell/project-shell-content-resize.controller.ts"',
        '  }, {',
        '    kind: "class",',
        '    name: "FlowCommandService",',
        '    file: "src/app/features/flow/services/flow-command.service.ts"',
        '  }, {',
        '    kind: "constant",',
        '    name: "routes",',
        '    file: "src/app.routes.ts"',
        '  }, {',
        '    kind: "class",',
        '    name: "ProjectShellComponent",',
        '    file: "src/app/core/shell/project-shell.component.spec.ts"',
        '  }, {',
        '    kind: "class",',
        '    name: "AppProjectCoordinatorService",',
        '    file: "src/app/core/services/app-project-coordinator.service.ts"',
        '  }],',
        '  nodes: [],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 6, graphNodes: 0, graphEdges: 0 }',
        '}));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-low-value-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-low-value-log-')), 'wrapper.log');
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
        "    'Found 6 symbols across 6 files.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '#### src/app/core/shell/project-shell.component.ts — ProjectShellComponent(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class ProjectShellComponent {}',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/shell/project-shell-content-resize.controller.ts — ProjectShellContentResizeController(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class ProjectShellContentResizeController {}',",
        "    '```',",
        "    '',",
        "    '#### src/app/features/flow/services/flow-command.service.ts — FlowCommandService(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class FlowCommandService {}',",
        "    '```',",
        "    '',",
        "    '#### src/app.routes.ts — routes(constant)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport const routes = [];',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/shell/project-shell.component.spec.ts — ProjectShellComponent(spec)',",
        "    '',",
        "    '```typescript',",
        "    '1\\tdescribe(\\'ProjectShellComponent\\', () => {});',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/services/app-project-coordinator.service.ts — AppProjectCoordinatorService(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class AppProjectCoordinatorService {}',",
        "    '```',",
        "  ].join('\\n');",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
        "});",
        '',
      ].join('\n'),
    );

    const child = spawnContextPackWrapper(context, fakeCodegraph, projectRoot, logPath);

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 46,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'ProjectShellComponent',
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
      expect(sourceHeaders.join('\n')).toContain('src/app/core/shell/project-shell.component.ts');
      expect(sourceHeaders.join('\n')).not.toContain('project-shell.component.spec.ts');
      expect(sourceHeaders.length, sourceHeaders.join('\n')).toBeLessThanOrEqual(4);

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 46,
      );
      const sourceOrdering = responseEvent.sourceOrdering as {
        firstSourceFiles?: string[];
      };
      expect(sourceOrdering.firstSourceFiles?.join('\n')).not.toContain('project-shell.component.spec.ts');
      expect(sourceOrdering.firstSourceFiles?.length).toBeLessThanOrEqual(4);
    } finally {
      child.kill();
    }
  }, 12_000);

  it('filters avoidable low-value base source blocks even when the source count is within budget', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-low-value-within-budget-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify({',
        '  query: "ProjectShellComponent",',
        '  matches: [{',
        '    kind: "class",',
        '    name: "ProjectShellComponent",',
        '    file: "src/app/core/shell/project-shell.component.ts"',
        '  }, {',
        '    kind: "class",',
        '    name: "ProjectShellContentResizeController",',
        '    file: "src/app/core/shell/project-shell-content-resize.controller.ts"',
        '  }, {',
        '    kind: "constant",',
        '    name: "routes",',
        '    file: "src/app.routes.ts"',
        '  }, {',
        '    kind: "class",',
        '    name: "ProjectShellComponent",',
        '    file: "src/app/core/shell/project-shell.component.spec.ts"',
        '  }],',
        '  nodes: [],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 4, graphNodes: 0, graphEdges: 0 }',
        '}));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-low-value-budget-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
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
        "    '#### src/app/core/shell/project-shell.component.spec.ts — ProjectShellComponent(spec)',",
        "    '',",
        "    '```typescript',",
        "    '1\\tdescribe(\\'ProjectShellComponent\\', () => {});',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/shell/project-shell.component.ts — ProjectShellComponent(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class ProjectShellComponent {}',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/shell/project-shell-content-resize.controller.ts — ProjectShellContentResizeController(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class ProjectShellContentResizeController {}',",
        "    '```',",
        "    '',",
        "    '#### src/app.routes.ts — routes(constant)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport const routes = [];',",
        "    '```',",
        "  ].join('\\n');",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
        "});",
        '',
      ].join('\n'),
    );

    const child = spawnContextPackWrapper(context, fakeCodegraph, projectRoot);

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 47,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'ProjectShellComponent',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const sourceHeaders = extractContextSourceHeaders(contextResponse.result.content[0].text);
      expect(contextResponse.result.isError).toBe(false);
      expect(sourceHeaders.join('\n')).not.toContain('project-shell.component.spec.ts');
      expect(sourceHeaders.length, sourceHeaders.join('\n')).toBe(3);

      const specResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 48,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'ProjectShellComponent spec',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const specResponse = await specResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const specHeaders = extractContextSourceHeaders(specResponse.result.content[0].text);
      expect(specResponse.result.isError).toBe(false);
      expect(specHeaders.join('\n')).toContain('project-shell.component.spec.ts');
    } finally {
      child.kill();
    }
  }, 12_000);

  registerCodegraphOverlayMcpContextSourceFilteringArtifactsMetadataSpecs({
    ...context,
    extractContextSourceHeaders,
    spawnContextPackWrapper: (fakeCodegraph, projectRoot, logPath) =>
      spawnContextPackWrapper(context, fakeCodegraph, projectRoot, logPath),
  });

  registerCodegraphOverlayMcpContextSourceFilteringTailSpecs({
    ...context,
    extractContextSourceHeaders,
    spawnContextPackWrapper: (fakeCodegraph, projectRoot, logPath) =>
      spawnContextPackWrapper(context, fakeCodegraph, projectRoot, logPath),
  });
}

function extractContextSourceHeaders(text: string): string[] {
  return [
    ...[...text.matchAll(/^####\s+(.+)$/gm)].map((match) => ({
      index: match.index ?? Number.MAX_SAFE_INTEGER,
      header: match[1],
    })),
    ...[...text.matchAll(/^\*\*`([^`]+)`\*\*(?:\s+[—-]\s*(.*))?$/gm)].map((match) => ({
      index: match.index ?? Number.MAX_SAFE_INTEGER,
      header: match[2] ? `${match[1]} — ${match[2]}` : match[1],
    })),
  ]
    .sort((a, b) => a.index - b.index)
    .map(entry => entry.header);
}

function spawnContextPackWrapper(
  context: CodegraphOverlaySpecContext,
  fakeCodegraph: string,
  projectRoot: string,
  logPath?: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [context.wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot],
    {
      cwd: context.repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
        NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
        ...(logPath ? { NANOFLOW_CODEGRAPH_MCP_LOG: logPath } : {}),
      },
    },
  );
}
