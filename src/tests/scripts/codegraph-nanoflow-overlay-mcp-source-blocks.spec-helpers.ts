import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

export function registerCodegraphOverlayMcpSourceBlockSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
  } = context;

  it('does not duplicate overlay source blocks when base CodeGraph uses different path separators', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-base-dedupe-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/validate-codegraph-overlay-docs.cjs',
      [
        "'use strict';",
        '',
        'function validateOverlayGraphShape(overlay) {',
        '  return overlay.graph.nodes.length;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.service.ts',
      [
        'export class KnowledgeAnchorPopoverService {',
        '  private overlay = null;',
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
        "  query: 'CodeGraph overlay native graph shape health validate-codegraph-overlay-docs',",
        '  matches: [{ kind: "function", name: "validateOverlayGraphShape", file: "scripts/validate-codegraph-overlay-docs.cjs" }],',
        '  nodes: [{',
        '    id: "function:scripts/validate-codegraph-overlay-docs.cjs:validateOverlayGraphShape",',
        '    kind: "function",',
        '    name: "validateOverlayGraphShape",',
        '    qualifiedName: "validateOverlayGraphShape",',
        '    filePath: "scripts/validate-codegraph-overlay-docs.cjs",',
        '    language: "javascript",',
        '    startLine: 3,',
        '    endLine: 5',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 2, graphNodes: 1, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-base-dedupe-fake-'));
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
        "    'Found 2 symbols across 2 files.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '#### src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.service.ts — overlay(property)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class KnowledgeAnchorPopoverService {',",
        "    '2\\t  private overlay = null;',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        "    '#### Scripts\\\\Validate-CodeGraph-Overlay-Docs.cjs — validateOverlayGraphShape(function)',",
        "    '',",
        "    '```javascript',",
        "    '1\\t\\'use strict\\';',",
        "    '2\\t',",
        "    '3\\tfunction validateOverlayGraphShape(overlay) {',",
        "    '4\\t  return overlay.graph.nodes.length;',",
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
            query: 'CodeGraph overlay native graph shape health validate-codegraph-overlay-docs',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const targetHeaders = [...text.matchAll(/^#### .*validate-codegraph-overlay-docs\.cjs\b/gim)];
      expect(targetHeaders).toHaveLength(1);
      const targetSourceIndex = text.indexOf('#### Scripts\\Validate-CodeGraph-Overlay-Docs.cjs');
      const genericSourceIndex = text.indexOf('#### src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.service.ts');
      expect(targetSourceIndex).toBeGreaterThanOrEqual(0);
      if (genericSourceIndex >= 0) {
        expect(targetSourceIndex).toBeLessThan(genericSourceIndex);
      }
    } finally {
      child.kill();
    }
  }, 12_000);

  it('replaces same-file base source blocks when overlay injects focused evidence', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-same-file-replace-'));
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
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify({',
        '  query: "RetryQueueService initializeStorageLoad",',
        '  matches: [{',
        '    kind: "method",',
        '    name: "initializeStorageLoad",',
        '    file: "src/app/core/services/sync/retry-queue.service.ts"',
        '  }],',
        '  nodes: [{',
        '    id: "method:src/app/core/services/sync/retry-queue.service.ts:RetryQueueService::initializeStorageLoad",',
        '    kind: "method",',
        '    name: "initializeStorageLoad",',
        '    qualifiedName: "RetryQueueService::initializeStorageLoad",',
        '    filePath: "src/app/core/services/sync/retry-queue.service.ts",',
        '    language: "typescript",',
        '    startLine: 3,',
        '    endLine: 5',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 1, graphNodes: 1, graphEdges: 0 }',
        '}));',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-same-file-replace-fake-'));
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
        "    'Found 1 symbol across 1 file.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '#### src/app/core/services/sync/retry-queue.service.ts — RetryQueueService(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class RetryQueueService {',",
        "    '2\\t  private storageReady = false;',",
        "    '6\\t}',",
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
        id: 49,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'RetryQueueService initializeStorageLoad',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const sourceHeaders = [...text.matchAll(/^#### .*retry-queue\.service\.ts\b/gim)];
      expect(sourceHeaders).toHaveLength(1);
      expect(text).toContain('3\t  initializeStorageLoad(): void {');
      expect(text).toContain('4\t    this.storageReady = true;');
    } finally {
      child.kill();
    }
  }, 12_000);

  it('deduplicates and source-orders overlay related symbols in context packs', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-related-symbols-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const nodes = [',
        '  { id: "source:cloud", kind: "variable", name: "SYNC_CONFIG.CLOUD_LOAD_TIMEOUT", filePath: "AGENTS.md", startLine: 17 },',
        '  { id: "keyword:cloud", kind: "variable", name: "SYNC_CONFIG.CLOUD_LOAD_TIMEOUT", filePath: "AGENTS.md", startLine: 17 },',
        '  { id: "source:debounce", kind: "variable", name: "SYNC_CONFIG.DEBOUNCE_DELAY", filePath: "AGENTS.md", startLine: 16 },',
        '  { id: "keyword:debounce", kind: "variable", name: "SYNC_CONFIG.DEBOUNCE_DELAY", filePath: "AGENTS.md", startLine: 16 },',
        '  { id: "source:polling", kind: "variable", name: "SYNC_CONFIG.POLLING_INTERVAL", filePath: "AGENTS.md", startLine: 18 },',
        '  { id: "keyword:polling", kind: "variable", name: "SYNC_CONFIG.POLLING_INTERVAL", filePath: "AGENTS.md", startLine: 18 },',
        '];',
        'const relationshipGroups = { references: [',
        '  { source: "Write path", target: "SYNC_CONFIG.CLOUD_LOAD_TIMEOUT", relation: "sync-config-keyword", keyword: "SYNC_CONFIG.CLOUD_LOAD_TIMEOUT", line: 17 },',
        '  { source: "Write path", target: "SYNC_CONFIG.DEBOUNCE_DELAY", relation: "sync-config-keyword", keyword: "SYNC_CONFIG.DEBOUNCE_DELAY", line: 16 },',
        '  { source: "Write path", target: "SYNC_CONFIG.POLLING_INTERVAL", relation: "sync-config-keyword", keyword: "SYNC_CONFIG.POLLING_INTERVAL", line: 18 },',
        '] };',
        'process.stdout.write(JSON.stringify({',
        '  query: "sync-config-keyword",',
        '  matches: [],',
        '  nodes,',
        '  relationshipGroups,',
        '  coverage: { typescriptFiles: 1, graphNodes: nodes.length, graphEdges: 0 }',
        '}));',
        '',
      ].join('\n'),
    );
    const fakeCodegraph = path.join(projectRoot, 'fake-codegraph.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  console.log(JSON.stringify({",
        "    jsonrpc: '2.0',",
        "    id: message.id,",
        "    result: { content: [{ type: 'text', text: '## Exploration: ' + (message.params?.arguments?.query ?? 'query') + '\\nbase context' }] },",
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
        id: 48,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'sync-config-keyword',
            overlayLimit: 20,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain([
        '- AGENTS.md: SYNC_CONFIG.DEBOUNCE_DELAY:16, SYNC_CONFIG.CLOUD_LOAD_TIMEOUT:17, SYNC_CONFIG.POLLING_INTERVAL:18',
      ].join('\n'));
      const relationshipOffsets = [
        'SYNC_CONFIG.DEBOUNCE_DELAY',
        'SYNC_CONFIG.CLOUD_LOAD_TIMEOUT',
        'SYNC_CONFIG.POLLING_INTERVAL',
      ].map(key => text.indexOf(`Write path → ${key}`));
      expect(relationshipOffsets.every(offset => offset >= 0)).toBe(true);
      expect(relationshipOffsets).toEqual([...relationshipOffsets].sort((a, b) => a - b));
      expect(text).not.toContain('SYNC_CONFIG.DEBOUNCE_DELAY:16, SYNC_CONFIG.DEBOUNCE_DELAY:16');
      expect(text).not.toContain('SYNC_CONFIG.CLOUD_LOAD_TIMEOUT:17, SYNC_CONFIG.CLOUD_LOAD_TIMEOUT:17');
    } finally {
      child.kill();
    }
  }, 12_000);

  it('bounds context-pack related symbols so metadata noise does not bury overlay source', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-related-budget-'));
    tempRoots.push(projectRoot);
    const targetFile = 'src/z-owner.ts';
    writeFile(
      projectRoot,
      targetFile,
      [
        'export class RenderProblemOwner {',
        '  investigate(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    const targetNode = {
      id: `class:${targetFile}:RenderProblemOwner`,
      kind: 'class',
      name: 'RenderProblemOwner',
      qualifiedName: 'RenderProblemOwner',
      filePath: targetFile,
      language: 'typescript',
      startLine: 1,
      endLine: 3,
    };
    const noisyNodes = Array.from({ length: 10 }, (_, index) => {
      const filePath = `src/noise-${index + 1}.ts`;
      writeFile(
        projectRoot,
        filePath,
        [
          `export class MetadataOnlyNoise${index + 1} {`,
          '  noop(): void {}',
          '}',
          '',
        ].join('\n'),
      );
      return {
        id: `class:${filePath}:MetadataOnlyNoise${index + 1}`,
        kind: 'class',
        name: `MetadataOnlyNoise${index + 1}`,
        qualifiedName: `MetadataOnlyNoise${index + 1}`,
        filePath,
        language: 'typescript',
        startLine: 1,
        endLine: 3,
        metadata: {
          note: 'render problem investigate',
        },
      };
    });
    const overlayResponse = {
      query: 'render problem investigate',
      matches: [{
        kind: 'class',
        name: 'RenderProblemOwner',
        file: targetFile,
      }],
      nodes: [targetNode, ...noisyNodes],
      relationshipGroups: {},
      coverage: {
        typescriptFiles: noisyNodes.length + 1,
        graphNodes: noisyNodes.length + 1,
        graphEdges: 0,
      },
    };
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        `process.stdout.write(${JSON.stringify(`${JSON.stringify(overlayResponse)}\n`)});`,
        '',
      ].join('\n'),
    );
    const fakeCodegraph = path.join(projectRoot, 'fake-codegraph.cjs');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const readline = require('node:readline');",
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        "  const message = JSON.parse(line);",
        "  console.log(JSON.stringify({",
        "    jsonrpc: '2.0',",
        "    id: message.id,",
        "    result: { content: [{ type: 'text', text: '## Exploration: ' + (message.params?.arguments?.query ?? 'query') + '\\nbase context without source' }] },",
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
        id: 49,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'render problem investigate',
            overlayLimit: 20,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain(`- ${targetFile}: RenderProblemOwner:1`);
      expect(text).toContain('- ... and 3 more files');
      expect(text).toContain(`#### ${targetFile} — RenderProblemOwner(class)`);
      expect(text).toContain('1\texport class RenderProblemOwner {');
      expect(text.indexOf(`- ${targetFile}: RenderProblemOwner:1`)).toBeLessThan(
        text.indexOf('- src/noise-1.ts: MetadataOnlyNoise1:1'),
      );
    } finally {
      child.kill();
    }
  }, 12_000);
}
