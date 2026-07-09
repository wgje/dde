import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayMcpContextSourceRankingSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ranking.spec-helpers';
import { registerCodegraphOverlayMcpContextMatchRankSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ordering-match-rank.spec-helpers';
import { registerCodegraphOverlayMcpContextSourceOrderingResourceSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ordering-resource.spec-helpers';
import { registerCodegraphOverlayMcpContextSourceFilteringSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-filtering.spec-helpers';


export function registerCodegraphOverlayMcpContextSourceOrderingSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    makeFakeCodegraph,
    readJsonLine,
    waitForLogEvent,
  } = context;

  it('keeps explicit same-file symbol evidence before generic base source windows', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-focused-symbol-'));
    tempRoots.push(projectRoot);
    const scriptFile = 'scripts/codegraph-nanoflow-mcp-stdio.cjs';
    const fillerLines = Array.from({ length: 90 }, (_, index) => `const filler${index} = ${index};`);
    const sourceLines = [
      "'use strict';",
      "const WRAPPER_VERSION = 'fixture';",
      ...fillerLines,
      '',
      'function forwardToCodegraph(jsonText) {',
      '  const text = jsonText.trim();',
      "  return writeToCodegraphStdin(`${text}\\n`, 'client-message');",
      '}',
      '',
      'function writeToCodegraphStdin(text) {',
      '  return text.length > 0;',
      '}',
    ];
    const forwardLine = sourceLines.findIndex(line => line.startsWith('function forwardToCodegraph')) + 1;
    writeFile(projectRoot, scriptFile, `${sourceLines.join('\n')}\n`);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'forwardToCodegraph scripts/codegraph-nanoflow-mcp-stdio.cjs',",
        '  matches: [{',
        '    kind: "function",',
        '    name: "forwardToCodegraph",',
        `    file: ${JSON.stringify(scriptFile)},`,
        '    score: 1200,',
        '    item: {',
        `      id: "function:${scriptFile}:forwardToCodegraph",`,
        '      kind: "function",',
        '      name: "forwardToCodegraph",',
        '      qualifiedName: "forwardToCodegraph",',
        `      filePath: ${JSON.stringify(scriptFile)},`,
        '      language: "javascript",',
        `      startLine: ${forwardLine},`,
        `      endLine: ${forwardLine + 3}`,
        '    }',
        '  }],',
        '  nodes: [{',
        `    id: "constant:${scriptFile}:WRAPPER_VERSION",`,
        '    kind: "constant",',
        '    name: "WRAPPER_VERSION",',
        '    qualifiedName: "WRAPPER_VERSION",',
        `    filePath: ${JSON.stringify(scriptFile)},`,
        '    language: "javascript",',
        '    startLine: 2,',
        '    endLine: 2',
        '  }, {',
        `    id: "function:${scriptFile}:forwardToCodegraph",`,
        '    kind: "function",',
        '    name: "forwardToCodegraph",',
        '    qualifiedName: "forwardToCodegraph",',
        `    filePath: ${JSON.stringify(scriptFile)},`,
        '    language: "javascript",',
        `    startLine: ${forwardLine},`,
        `    endLine: ${forwardLine + 3}`,
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 2, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );

    const baseSourceRows = [
      '## Exploration: forwardToCodegraph scripts/codegraph-nanoflow-mcp-stdio.cjs',
      '',
      'Found 2 symbols across 1 files.',
      '',
      '### Source Code',
      '',
      `#### ${scriptFile} — WRAPPER_VERSION(constant), forwardToCodegraph(function)`,
      '',
      '```javascript',
      ...sourceLines.slice(0, 70).map((line, index) => `${index + 1}\t${line}`),
      '',
      '... (gap) ...',
      '',
      `${forwardLine}\t${sourceLines[forwardLine - 1]}`,
      `${forwardLine + 1}\t${sourceLines[forwardLine]}`,
      `${forwardLine + 2}\t${sourceLines[forwardLine + 1]}`,
      `${forwardLine + 3}\t${sourceLines[forwardLine + 2]}`,
      '```',
    ].join('\n');
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-focused-symbol-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        `const baseText = ${JSON.stringify(baseSourceRows)};`,
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  if (message.method === 'tools/list') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] } }));",
        "    return;",
        "  }",
        "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: baseText }] } }));",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
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
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 61,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'forwardToCodegraph scripts/codegraph-nanoflow-mcp-stdio.cjs',
            overlayLimit: 4,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const forwardIndex = text.indexOf(`${forwardLine}\tfunction forwardToCodegraph(jsonText) {`);
      const genericIndex = text.indexOf("2\tconst WRAPPER_VERSION = 'fixture';");
      const sourceHeaders = [...text.matchAll(/^#### .*codegraph-nanoflow-mcp-stdio\.cjs\b/gim)];
      expect(forwardIndex).toBeGreaterThanOrEqual(0);
      expect(sourceHeaders).toHaveLength(1);
      if (genericIndex >= 0) {
        expect(forwardIndex).toBeLessThan(genericIndex);
      }
    } finally {
      child.kill();
    }
  }, 12_000);

  it('adds overlay source blocks to context packs when base CodeGraph misses an exact config file', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-source-'));
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
        '    const isolation = true;',
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
        "  query: 'vitest.services.config.mts setupFiles isolation cleanup',",
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
        '  }, {',
        '    id: "method:src/generic-cleanup.service.ts:GenericCleanupService::cleanup",',
        '    kind: "method",',
        '    name: "cleanup",',
        '    qualifiedName: "GenericCleanupService::cleanup",',
        '    filePath: "src/generic-cleanup.service.ts",',
        '    language: "typescript",',
        '    startLine: 2,',
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
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'vitest.services.config.mts setupFiles isolation cleanup',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain('## Exploration: vitest.services.config.mts setupFiles isolation cleanup');
      expect(text).toContain('#### vitest.services.config.mts — default(constant)');
      expect(text.indexOf('#### vitest.services.config.mts')).toBeLessThan(
        text.indexOf('#### src/generic-cleanup.service.ts'),
      );
      expect(text).toContain("6\t    setupFiles: ['./src/test-setup.services.ts'],");
    } finally {
      child.kill();
    }
  }, 12_000);

  registerCodegraphOverlayMcpContextSourceFilteringSpecs(context);

  it('merges overlay source blocks into a leading base Source Code section instead of appending a second section', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-leading-source-'));
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
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-leading-source-fake-'));
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
        "  const text = [",
        "    '### Source Code',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '#### src/generic-cleanup.service.ts — cleanup(method)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class GenericCleanupService {',",
        "    '2\\t  cleanup(): void {',",
        "    '3\\t    const setupFiles = true;',",
        "    '4\\t  }',",
        "    '5\\t}',",
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
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 47,
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
      const sourceSectionCount = [...text.matchAll(/^### Source Code\b/gm)].length;
      const sourceHeaders = [...text.matchAll(/^####\s+(.+)$/gm)].map((match) => match[1]);
      expect(contextResponse.result.isError).toBe(false);
      expect(sourceSectionCount).toBe(1);
      expect(sourceHeaders[0]).toContain('vitest.services.config.mts');
      expect(sourceHeaders[1]).toContain('src/generic-cleanup.service.ts');
      expect(text).toContain("6\t    setupFiles: ['./src/test-setup.services.ts'],");
    } finally {
      child.kill();
    }
  }, 12_000);

  registerCodegraphOverlayMcpContextSourceOrderingResourceSpecs(context);
  registerCodegraphOverlayMcpContextSourceRankingSpecs(context);
}
