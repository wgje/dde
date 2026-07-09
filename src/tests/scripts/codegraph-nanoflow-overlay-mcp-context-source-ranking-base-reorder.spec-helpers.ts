import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

type SourceOrderingLogPayload = Record<string, unknown> & {
  sourceBlockCount: number;
};

export function registerCodegraphOverlayMcpContextSourceRankingBaseReorderSpecs(
  context: CodegraphOverlaySpecContext,
): void {
  const {
    repoRoot,
    wrapperScriptPath,
    tempRoots,
    writeFile,
    readJsonLine,
    waitForLogEvent,
  } = context;

  it('moves overlay-selected base source blocks before generic base CodeGraph source blocks', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-base-reorder-'));
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
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-base-reorder-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
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
        "    '#### src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.service.ts — overlay(property)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class KnowledgeAnchorPopoverService {',",
        "    '2\\t  private overlay = null;',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        "    '#### scripts/validate-codegraph-overlay-docs.cjs — validateOverlayGraphShape(function)',",
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
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    try {
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 46,
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
      const targetSourceIndex = text.indexOf('#### scripts/validate-codegraph-overlay-docs.cjs');
      const genericSourceIndex = text.indexOf('#### src/app/shared/components/knowledge-anchor/knowledge-anchor-popover.service.ts');
      expect(targetSourceIndex).toBeGreaterThanOrEqual(0);
      if (genericSourceIndex >= 0) {
        expect(targetSourceIndex).toBeLessThan(genericSourceIndex);
      }
      expect(text).toContain('function validateOverlayGraphShape(overlay)');
      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 46,
      );
      const sourceOrdering = responseEvent.sourceOrdering as SourceOrderingLogPayload;
      expect(sourceOrdering).toEqual(expect.objectContaining({
        firstSourceFiles: expect.arrayContaining(['scripts/validate-codegraph-overlay-docs.cjs']),
        rankedOverlayFiles: ['scripts/validate-codegraph-overlay-docs.cjs'],
        topRankedOverlayFileVisibleIndex: 0,
        topRankedOverlayFileMissing: false,
      }));
      expect(sourceOrdering.sourceBlockCount).toBeGreaterThanOrEqual(1);
    } finally {
      child.kill();
    }
  }, 12_000);

  it('preserves native source order for clean production blocks when overlay has only generic symbol matches', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-clean-native-order-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'src/app/core/services/native-first.service.ts',
      [
        'export class NativeFirstService {',
        '  readonly nativeOrder = true;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/app/core/services/overlay-generic.service.ts',
      [
        'export class OverlayGenericService {',
        '  readonly genericOverlayMatch = true;',
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
        "  query: 'OverlayGenericService generic symbol match',",
        '  matches: [{',
        '    kind: "class",',
        '    name: "OverlayGenericService",',
        '    file: "src/app/core/services/overlay-generic.service.ts",',
        '    score: 99',
        '  }],',
        '  nodes: [{',
        '    id: "class:src/app/core/services/overlay-generic.service.ts:OverlayGenericService",',
        '    kind: "class",',
        '    name: "OverlayGenericService",',
        '    qualifiedName: "OverlayGenericService",',
        '    filePath: "src/app/core/services/overlay-generic.service.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { typescriptFiles: 2, graphNodes: 1, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-clean-native-order-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-clean-native-order-log-')), 'wrapper.log');
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
        "    '#### src/app/core/services/native-first.service.ts — NativeFirstService(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class NativeFirstService {',",
        "    '2\\t  readonly nativeOrder = true;',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        "    '#### src/app/core/services/overlay-generic.service.ts — OverlayGenericService(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class OverlayGenericService {',",
        "    '2\\t  readonly genericOverlayMatch = true;',",
        "    '3\\t}',",
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
        id: 47,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'OverlayGenericService generic symbol match',
            overlayLimit: 1,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const nativeFirstIndex = text.indexOf('#### src/app/core/services/native-first.service.ts');
      const overlayGenericIndex = text.indexOf('#### src/app/core/services/overlay-generic.service.ts');
      expect(nativeFirstIndex).toBeGreaterThanOrEqual(0);
      expect(overlayGenericIndex).toBeGreaterThanOrEqual(0);
      expect(nativeFirstIndex).toBeLessThan(overlayGenericIndex);
      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 47,
      );
      const sourceOrdering = responseEvent.sourceOrdering as SourceOrderingLogPayload;
      expect(sourceOrdering).toEqual(expect.objectContaining({
        baseSourceReorderAllowed: false,
        baseSourceReorderReason: 'native-order-preserved',
        firstSourceFiles: expect.arrayContaining(['src/app/core/services/native-first.service.ts']),
        topRankedOverlayFile: 'src/app/core/services/overlay-generic.service.ts',
        topRankedOverlayFileVisibleIndex: 1,
        firstSourceBlockIsTopRankedOverlayFile: false,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('keeps the top-ranked health baseline source when CodeGraph tooling blocks are also visible', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-health-baseline-reorder-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/code-health-baseline.cjs',
      [
        "'use strict';",
        '',
        'function collectCodeHealthBaseline() {',
        '  return { over800: 0, over1500: 0 };',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/analyze-codegraph-mcp-log.cjs',
      [
        "'use strict';",
        '',
        'function hasCurrentContextSourceOrderingGuardFailure(summary) {',
        '  return Boolean(summary?.currentContextSourceOrdering);',
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
        "  query: 'adapter health current technical debt baseline ratchet perf guard log guard near threshold files',",
        '  matches: [{',
        '    kind: "function",',
        '    name: "collectCodeHealthBaseline",',
        '    file: "scripts/code-health-baseline.cjs",',
        '    score: 800',
        '  }, {',
        '    kind: "function",',
        '    name: "hasCurrentContextSourceOrderingGuardFailure",',
        '    file: "scripts/analyze-codegraph-mcp-log.cjs",',
        '    score: 300',
        '  }],',
        '  nodes: [{',
        '    id: "function:scripts/code-health-baseline.cjs:collectCodeHealthBaseline",',
        '    kind: "function",',
        '    name: "collectCodeHealthBaseline",',
        '    qualifiedName: "collectCodeHealthBaseline",',
        '    filePath: "scripts/code-health-baseline.cjs",',
        '    language: "javascript",',
        '    startLine: 3,',
        '    endLine: 5',
        '  }, {',
        '    id: "function:scripts/analyze-codegraph-mcp-log.cjs:hasCurrentContextSourceOrderingGuardFailure",',
        '    kind: "function",',
        '    name: "hasCurrentContextSourceOrderingGuardFailure",',
        '    qualifiedName: "hasCurrentContextSourceOrderingGuardFailure",',
        '    filePath: "scripts/analyze-codegraph-mcp-log.cjs",',
        '    language: "javascript",',
        '    startLine: 3,',
        '    endLine: 5',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { javascriptFiles: 2, graphNodes: 2, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-health-baseline-reorder-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-health-baseline-reorder-log-')),
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
        "    'Found 1 symbol across 1 file.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '#### scripts/analyze-codegraph-mcp-log.cjs — hasCurrentContextSourceOrderingGuardFailure(function)',",
        "    '',",
        "    '```javascript',",
        "    '1\\t\\'use strict\\';',",
        "    '2\\t',",
        "    '3\\tfunction hasCurrentContextSourceOrderingGuardFailure(summary) {',",
        "    '4\\t  return Boolean(summary?.currentContextSourceOrdering);',",
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
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
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
            query: 'CodeGraph MCP adapter health current technical debt baseline quality:baseline:ratchet perf:guard codegraph:mcp:log:guard near-threshold files',
            overlayLimit: 2,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const healthSourceIndex = text.indexOf('#### scripts/code-health-baseline.cjs');
      const logAnalyzerSourceIndex = text.indexOf('#### scripts/analyze-codegraph-mcp-log.cjs');
      expect(healthSourceIndex).toBeGreaterThanOrEqual(0);
      expect(logAnalyzerSourceIndex).toBeGreaterThanOrEqual(0);
      expect(healthSourceIndex).toBeLessThan(logAnalyzerSourceIndex);
      expect(text).toContain('function collectCodeHealthBaseline()');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 47,
      );
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        firstSourceFiles: expect.arrayContaining([
          'scripts/code-health-baseline.cjs',
          'scripts/analyze-codegraph-mcp-log.cjs',
        ]),
        topRankedOverlayFile: 'scripts/code-health-baseline.cjs',
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('injects top-ranked tooling source when generic base source blocks fill the visible budget', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-tooling-source-inject-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/analyze-codegraph-mcp-log.cjs',
      [
        "'use strict';",
        '',
        'function analyzeLog() {',
        '  return "source-ordering";',
        '}',
        '',
      ].join('\n'),
    );
    const genericSources = [
      ['src/services/logger.service.ts', 'export class LoggerService {', '  log(): void {}', '}'],
      ['android/app/src/main/java/app/nanoflow/host/NanoflowWidgetTelemetry.kt', 'class NanoflowWidgetTelemetry {', '  fun log() = Unit', '}'],
      ['main.ts', 'export function bootstrapNanoflow(): void {', '  console.log("main");', '}'],
      ['src/services/guards/auth.guard.ts', 'export class GuardLogger {', '  log(): void {}', '}'],
      ['src/utils/standalone-logger.ts', 'export function standaloneLogger(): void {', '  console.log("standalone");', '}'],
      ['src/services/auth.service.ts', 'export class AuthService {', '  log(): void {}', '}'],
    ] as const;
    for (const [filePath, ...lines] of genericSources) {
      writeFile(projectRoot, filePath, [...lines, ''].join('\n'));
    }
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const genericSources = [',
        ...genericSources.map(([filePath], index) => `  ${JSON.stringify({
          kind: filePath.endsWith('.kt') ? 'class' : 'function',
          name: filePath.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? filePath,
          file: filePath,
          score: 100 - index,
        })},`),
        '];',
        'const response = {',
        "  query: 'context-pack source ordering low-value source blocks codegraph-nanoflow-adaptation sourceOrdering log guard',",
        '  matches: [{',
        '    kind: "function",',
        '    name: "analyzeLog",',
        '    file: "scripts/analyze-codegraph-mcp-log.cjs",',
        '    score: 900',
        '  }, ...genericSources],',
        '  nodes: [{',
        '    id: "function:scripts/analyze-codegraph-mcp-log.cjs:analyzeLog",',
        '    kind: "function",',
        '    name: "analyzeLog",',
        '    qualifiedName: "analyzeLog",',
        '    filePath: "scripts/analyze-codegraph-mcp-log.cjs",',
        '    language: "javascript",',
        '    startLine: 3,',
        '    endLine: 5',
        '  }, ...genericSources.map((source, index) => ({',
        '    id: `${source.kind}:${source.file}:${source.name}`,',
        '    kind: source.kind,',
        '    name: source.name,',
        '    qualifiedName: source.name,',
        '    filePath: source.file,',
        '    language: source.file.endsWith(".kt") ? "kotlin" : "typescript",',
        '    startLine: 1,',
        '    endLine: 3,',
        '  }))],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 7, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-tooling-source-inject-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-tooling-source-inject-log-')),
      'wrapper.log',
    );
    tempRoots.push(path.dirname(logPath));
    const baseSourceLines = genericSources.flatMap(([filePath, ...lines]) => [
      `    '#### ${filePath} — generic(function)',`,
      "    '',",
      `    '\`\`\`${filePath.endsWith('.kt') ? 'kotlin' : 'typescript'}',`,
      ...lines.map((line, index) => `    ${JSON.stringify(`${index + 1}\t${line}`)},`),
      "    '```',",
      "    '',",
    ]);
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
        ...baseSourceLines,
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
        id: 48,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'context-pack source ordering low-value source blocks codegraph-nanoflow-adaptation sourceOrdering log guard',
            overlayLimit: 10,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const analyzerSourceIndex = text.indexOf('#### scripts/analyze-codegraph-mcp-log.cjs');
      const genericSourceIndex = text.indexOf('#### src/services/logger.service.ts');
      expect(analyzerSourceIndex).toBeGreaterThanOrEqual(0);
      if (genericSourceIndex >= 0) {
        expect(analyzerSourceIndex).toBeLessThan(genericSourceIndex);
      }
      expect(text).toContain('function analyzeLog()');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 48,
      );
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        topRankedOverlayFile: 'scripts/analyze-codegraph-mcp-log.cjs',
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('keeps explicitly named NanoFlow wrapper source ahead of legacy wrapper and logging noise', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-explicit-wrapper-log-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        "'use strict';",
        '',
        'function handleNanoFlowContextPack() {',
        '  return "current-wrapper";',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/codegraph-mcp-stdio.cjs',
      [
        "'use strict';",
        '',
        'function handleLegacyCodegraphMcp() {',
        '  return "legacy-wrapper";',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/logger.service.ts',
      [
        'export class LoggerService {',
        '  log(): void {}',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'main.ts',
      [
        'export function bootstrapNanoflow(): void {',
        '  console.log("main");',
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
        "  query: 'codegraph-nanoflow-mcp-stdio MCP wrapper logging doctor log guard config target mismatch Transport closed',",
        '  matches: [',
        '    { kind: "function", name: "handleLegacyCodegraphMcp", file: "scripts/codegraph-mcp-stdio.cjs", score: 900 },',
        '    { kind: "function", name: "handleNanoFlowContextPack", file: "scripts/codegraph-nanoflow-mcp-stdio.cjs", score: 870 },',
        '    { kind: "class", name: "LoggerService", file: "src/services/logger.service.ts", score: 860 },',
        '    { kind: "function", name: "bootstrapNanoflow", file: "main.ts", score: 850 }',
        '  ],',
        '  nodes: [',
        '    { id: "function:scripts/codegraph-mcp-stdio.cjs:handleLegacyCodegraphMcp", kind: "function", name: "handleLegacyCodegraphMcp", qualifiedName: "handleLegacyCodegraphMcp", filePath: "scripts/codegraph-mcp-stdio.cjs", language: "javascript", startLine: 3, endLine: 5 },',
        '    { id: "function:scripts/codegraph-nanoflow-mcp-stdio.cjs:handleNanoFlowContextPack", kind: "function", name: "handleNanoFlowContextPack", qualifiedName: "handleNanoFlowContextPack", filePath: "scripts/codegraph-nanoflow-mcp-stdio.cjs", language: "javascript", startLine: 3, endLine: 5 },',
        '    { id: "class:src/services/logger.service.ts:LoggerService", kind: "class", name: "LoggerService", qualifiedName: "LoggerService", filePath: "src/services/logger.service.ts", language: "typescript", startLine: 1, endLine: 3 },',
        '    { id: "function:main.ts:bootstrapNanoflow", kind: "function", name: "bootstrapNanoflow", qualifiedName: "bootstrapNanoflow", filePath: "main.ts", language: "typescript", startLine: 1, endLine: 3 }',
        '  ],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 4, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-explicit-wrapper-log-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-explicit-wrapper-log-log-')),
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
        "    '#### src/services/logger.service.ts — LoggerService(class)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class LoggerService {',",
        "    '2\\t  log(): void {}',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        "    '#### main.ts — bootstrapNanoflow(function)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport function bootstrapNanoflow(): void {',",
        "    '2\\t  console.log(\"main\");',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
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
        id: 49,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'codegraph-nanoflow-mcp-stdio MCP wrapper logging doctor log guard config target mismatch Transport closed',
            overlayLimit: 10,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const sourceHeaders = [...text.matchAll(/^####\s+(.+)$/gm)].map(match => match[1]);
      expect(sourceHeaders[0]).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
      const wrapperSourceIndex = text.indexOf('#### scripts/codegraph-nanoflow-mcp-stdio.cjs');
      const loggerSourceIndex = text.indexOf('#### src/services/logger.service.ts');
      if (loggerSourceIndex >= 0) {
        expect(wrapperSourceIndex).toBeLessThan(loggerSourceIndex);
      }

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 49,
      );
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('keeps explicitly named context-pack helper source as the diagnostic top-ranked file', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-explicit-helper-ranking-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        "'use strict';",
        '',
        'function contextPackExploreQueryFor(rawQuery) {',
        '  return rawQuery;',
        '}',
        '',
        'function filterContextPackBaseSourceBlockEntries(entries) {',
        '  return entries;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'supabase/functions/_shared/widget-common.ts',
      [
        'export function sourceSelectionWidgetCommon(): void {',
        '  console.log("source ordering");',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/contracts/check-flow-current-userid.cjs',
      [
        "'use strict';",
        'const source = "generic";',
        'const projectRoot = process.cwd();',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/patch-esbuild.cjs',
      [
        "'use strict';",
        'const source = "generic";',
        'const target = "esbuild";',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-explicit-helper-ranking-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-explicit-helper-ranking-log-')),
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
        "    '#### scripts/codegraph-nanoflow-mcp-stdio.cjs — contextPackExploreQueryFor(function), filterContextPackBaseSourceBlockEntries(function)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tfunction contextPackExploreQueryFor(rawQuery) {',",
        "    '2\\t  return rawQuery;',",
        "    '3\\t}',",
        "    '4\\tfunction filterContextPackBaseSourceBlockEntries(entries) {',",
        "    '5\\t  return entries;',",
        "    '6\\t}',",
        "    '```',",
        "    '',",
        "    '#### supabase/functions/_shared/widget-common.ts — sourceSelectionWidgetCommon(function)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport function sourceSelectionWidgetCommon(): void {',",
        "    '2\\t  console.log(\"source ordering\");',",
        "    '3\\t}',",
        "    '```',",
        "    '',",
        "    '#### scripts/contracts/check-flow-current-userid.cjs — source(constant), projectRoot(constant)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tconst source = \"generic\";',",
        "    '2\\tconst projectRoot = process.cwd();',",
        "    '```',",
        "    '',",
        "    '#### scripts/patch-esbuild.cjs — source(constant), target(constant)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tconst source = \"generic\";',",
        "    '2\\tconst target = \"esbuild\";',",
        "    '```',",
        "    '',",
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
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'contextPackExploreQueryFor filterContextPackBaseSourceBlockEntries sourceOrdering sourceSelection quality',",
        '  matches: [',
        '    { kind: "function", name: "sourceSelectionWidgetCommon", file: "supabase/functions/_shared/widget-common.ts", score: 980 },',
        '    { kind: "function", name: "contextPackExploreQueryFor", file: "scripts/codegraph-nanoflow-mcp-stdio.cjs", score: 900 },',
        '    { kind: "function", name: "filterContextPackBaseSourceBlockEntries", file: "scripts/codegraph-nanoflow-mcp-stdio.cjs", score: 890 }',
        '  ],',
        '  nodes: [',
        '    { id: "function:supabase/functions/_shared/widget-common.ts:sourceSelectionWidgetCommon", kind: "function", name: "sourceSelectionWidgetCommon", qualifiedName: "sourceSelectionWidgetCommon", filePath: "supabase/functions/_shared/widget-common.ts", language: "typescript", startLine: 1, endLine: 3 },',
        '    { id: "function:scripts/codegraph-nanoflow-mcp-stdio.cjs:contextPackExploreQueryFor", kind: "function", name: "contextPackExploreQueryFor", qualifiedName: "contextPackExploreQueryFor", filePath: "scripts/codegraph-nanoflow-mcp-stdio.cjs", language: "javascript", startLine: 3, endLine: 5 },',
        '    { id: "function:scripts/codegraph-nanoflow-mcp-stdio.cjs:filterContextPackBaseSourceBlockEntries", kind: "function", name: "filterContextPackBaseSourceBlockEntries", qualifiedName: "filterContextPackBaseSourceBlockEntries", filePath: "scripts/codegraph-nanoflow-mcp-stdio.cjs", language: "javascript", startLine: 7, endLine: 9 }',
        '  ],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 3, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
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
        id: 50,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'contextPackExploreQueryFor filterContextPackBaseSourceBlockEntries sourceOrdering sourceSelection quality',
            overlayLimit: 10,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text.indexOf('#### scripts/codegraph-nanoflow-mcp-stdio.cjs'))
        .toBeLessThan(text.indexOf('#### supabase/functions/_shared/widget-common.ts'));
      expect(text).not.toContain('#### scripts/contracts/check-flow-current-userid.cjs');
      expect(text).not.toContain('#### scripts/patch-esbuild.cjs');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 50,
      );
      const sourceOrdering = responseEvent.sourceOrdering as SourceOrderingLogPayload;
      expect(sourceOrdering).toEqual(expect.objectContaining({
        rawTopRankedOverlayFile: 'supabase/functions/_shared/widget-common.ts',
        topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        topRankedOverlayFileSelectionReason: 'preferred-symbol-evidence',
        topRankedOverlayFileSkippedLowValue: true,
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
      expect(sourceOrdering.rankedOverlayFileDetails).toEqual(expect.arrayContaining([
        expect.objectContaining({
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          explicitSymbolEvidence: true,
          preferredSymbolEvidence: true,
          lowValuePenalty: 0,
        }),
      ]));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('filters generic script source blocks for helper-only context-pack tooling queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-helper-only-script-filter-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        "'use strict';",
        '',
        'function contextPackExploreQueryFor(rawQuery) {',
        '  return rawQuery;',
        '}',
        '',
        'function filterContextPackBaseSourceBlockEntries(entries) {',
        '  return entries;',
        '}',
        '',
      ].join('\n'),
    );
    for (const [filePath, sourceLine] of [
      ['scripts/contracts/check-flow-current-userid.cjs', 'const projectRoot = process.cwd();'],
      ['scripts/patch-esbuild.cjs', 'const target = "esbuild";'],
      ['scripts/generate-artifact-manifest.cjs', 'const entry = "artifact";'],
    ] as const) {
      writeFile(
        projectRoot,
        filePath,
        [
          "'use strict';",
          'const source = "generic";',
          sourceLine,
          '',
        ].join('\n'),
      );
    }

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-helper-only-script-filter-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-helper-only-script-filter-log-')),
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
        "    '#### scripts/codegraph-nanoflow-mcp-stdio.cjs — contextPackExploreQueryFor(function), filterContextPackBaseSourceBlockEntries(function)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tfunction contextPackExploreQueryFor(rawQuery) {',",
        "    '2\\t  return rawQuery;',",
        "    '3\\t}',",
        "    '4\\tfunction filterContextPackBaseSourceBlockEntries(entries) {',",
        "    '5\\t  return entries;',",
        "    '6\\t}',",
        "    '```',",
        "    '',",
        "    '#### scripts/contracts/check-flow-current-userid.cjs — source(constant), projectRoot(constant)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tconst source = \"generic\";',",
        "    '2\\tconst projectRoot = process.cwd();',",
        "    '```',",
        "    '',",
        "    '#### scripts/patch-esbuild.cjs — source(constant), target(constant)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tconst source = \"generic\";',",
        "    '2\\tconst target = \"esbuild\";',",
        "    '```',",
        "    '',",
        "    '#### scripts/generate-artifact-manifest.cjs — entry(constant)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tconst entry = \"artifact\";',",
        "    '```',",
        "    '',",
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
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'contextPackExploreQueryFor filterContextPackBaseSourceBlockEntries sanitizeContextPackBaseMarkdownSections CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT sourceOrdering sourceSelection quality',",
        '  matches: [',
        '    { kind: "function", name: "contextPackExploreQueryFor", file: "scripts/codegraph-nanoflow-mcp-stdio.cjs", score: 900 },',
        '    { kind: "function", name: "filterContextPackBaseSourceBlockEntries", file: "scripts/codegraph-nanoflow-mcp-stdio.cjs", score: 890 }',
        '  ],',
        '  nodes: [',
        '    { id: "function:scripts/codegraph-nanoflow-mcp-stdio.cjs:contextPackExploreQueryFor", kind: "function", name: "contextPackExploreQueryFor", qualifiedName: "contextPackExploreQueryFor", filePath: "scripts/codegraph-nanoflow-mcp-stdio.cjs", language: "javascript", startLine: 3, endLine: 5 },',
        '    { id: "function:scripts/codegraph-nanoflow-mcp-stdio.cjs:filterContextPackBaseSourceBlockEntries", kind: "function", name: "filterContextPackBaseSourceBlockEntries", qualifiedName: "filterContextPackBaseSourceBlockEntries", filePath: "scripts/codegraph-nanoflow-mcp-stdio.cjs", language: "javascript", startLine: 7, endLine: 9 }',
        '  ],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 2, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
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
        id: 51,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: 'contextPackExploreQueryFor filterContextPackBaseSourceBlockEntries sanitizeContextPackBaseMarkdownSections CONTEXT_PACK_BASE_SOURCE_FILTER_LIMIT sourceOrdering sourceSelection quality',
            overlayLimit: 10,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain('#### scripts/codegraph-nanoflow-mcp-stdio.cjs');
      expect(text).not.toContain('#### scripts/contracts/check-flow-current-userid.cjs');
      expect(text).not.toContain('#### scripts/patch-esbuild.cjs');
      expect(text).not.toContain('#### scripts/generate-artifact-manifest.cjs');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 51,
      );
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        firstSourceFiles: ['scripts/codegraph-nanoflow-mcp-stdio.cjs'],
        topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        topRankedOverlayFileSelectionReason: 'raw-score-top',
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('keeps de-duplication contract maintenance source ahead of same-name business and migration source blocks', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-dedup-source-filter-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'NanoFlow CodeGraph duplicate hotspots queryOverlay scoreCandidate selectGraphResults formatNativeMarkdown contextPackSourceRankingQueryFor sanitizeContextPackBaseMarkdownSections collectTypeScript buildNativeGraph dedup contract remaining duplicate audit context-pack quality source ordering adapter gate current project semantic coverage',",
        '  matches: [{',
        '    kind: "function",',
        '    name: "DuplicateDedupContractAuditFlow",',
        '    file: "src/services/dock-completion-flow.service.ts",',
        '    score: 900',
        '  }, {',
        '    kind: "function",',
        '    name: "scoreCandidate",',
        '    file: "scripts/query-codegraph-nanoflow-overlay.mjs",',
        '    score: 900',
        '  }, {',
        '    kind: "migration",',
        '    name: "cleanup_duplicate_owner_only_policies",',
        '    file: "supabase/migrations/20260403113000_cleanup_duplicate_owner_only_policies.sql",',
        '    score: 900',
        '  }],',
        '  nodes: [{',
        '    id: "function:src/services/dock-completion-flow.service.ts:DuplicateDedupContractAuditFlow",',
        '    kind: "function",',
        '    name: "DuplicateDedupContractAuditFlow",',
        '    qualifiedName: "DuplicateDedupContractAuditFlow",',
        '    filePath: "src/services/dock-completion-flow.service.ts",',
        '    language: "typescript",',
        '    startLine: 2,',
        '    endLine: 4',
        '  }, {',
        '    id: "function:scripts/query-codegraph-nanoflow-overlay.mjs:scoreCandidate",',
        '    kind: "function",',
        '    name: "scoreCandidate",',
        '    qualifiedName: "scoreCandidate",',
        '    filePath: "scripts/query-codegraph-nanoflow-overlay.mjs",',
        '    language: "javascript",',
        '    startLine: 3,',
        '    endLine: 5',
        '  }, {',
        '    id: "migration:supabase/migrations/20260403113000_cleanup_duplicate_owner_only_policies.sql",',
        '    kind: "migration",',
        '    name: "cleanup_duplicate_owner_only_policies",',
        '    qualifiedName: "cleanup_duplicate_owner_only_policies",',
        '    filePath: "supabase/migrations/20260403113000_cleanup_duplicate_owner_only_policies.sql",',
        '    language: "sql",',
        '    startLine: 1,',
        '    endLine: 2',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 1, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
        'function scoreCandidate(candidate) {',
        '  return candidate.score;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/services/dock-completion-flow.service.ts',
      [
        'export class DockCompletionFlowService {',
        '  scoreCandidate(entry: unknown): number {',
        '    return 0;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'supabase/migrations/20260403113000_cleanup_duplicate_owner_only_policies.sql',
      [
        '-- duplicate owner policy cleanup',
        'select 1;',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt',
      [
        'package app.nanoflow.host',
        '',
        'class NanoflowBootstrapContract {',
        '  fun buildLaunchUri(): String = "nanoflow://bootstrap"',
        '}',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-dedup-source-filter-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-dedup-source-filter-log-')),
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
        "    'Found 4 symbols across 4 files.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '#### src/services/dock-completion-flow.service.ts — scoreCandidate(method)',",
        "    '',",
        "    '```typescript',",
        "    '1\\texport class DockCompletionFlowService {',",
        "    '2\\t  scoreCandidate(entry: unknown): number {',",
        "    '3\\t    return 0;',",
        "    '4\\t  }',",
        "    '5\\t}',",
        "    '```',",
        "    '',",
        "    '#### supabase/migrations/20260403113000_cleanup_duplicate_owner_only_policies.sql — migration(file)',",
        "    '',",
        "    '```sql',",
        "    '1\\t-- duplicate owner policy cleanup',",
        "    '2\\tselect 1;',",
        "    '```',",
        "    '',",
        "    '**`android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt`** — NanoflowBootstrapContract(class), buildLaunchUri(method)',",
        "    '',",
        "    '```kotlin',",
        "    '1\\tpackage app.nanoflow.host',",
        "    '2\\t',",
        "    '3\\tclass NanoflowBootstrapContract {',",
        "    '4\\t  fun buildLaunchUri(): String = \"nanoflow://bootstrap\"',",
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
            query: 'NanoFlow CodeGraph duplicate hotspots queryOverlay scoreCandidate selectGraphResults formatNativeMarkdown contextPackSourceRankingQueryFor sanitizeContextPackBaseMarkdownSections collectTypeScript buildNativeGraph dedup contract remaining duplicate audit context-pack quality source ordering adapter gate current project semantic coverage',
            overlayLimit: 10,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      const adapterSourceIndex = text.indexOf('#### scripts/query-codegraph-nanoflow-overlay.mjs');
      const businessSourceIndex = text.indexOf('#### src/services/dock-completion-flow.service.ts');
      const migrationSourceIndex = text.indexOf('#### supabase/migrations/20260403113000_cleanup_duplicate_owner_only_policies.sql');
      const androidSourceIndex = text.indexOf('android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt');
      expect(adapterSourceIndex).toBeGreaterThanOrEqual(0);
      expect(businessSourceIndex).toBe(-1);
      expect(migrationSourceIndex).toBe(-1);
      expect(androidSourceIndex).toBe(-1);

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 49,
      );
      expect(responseEvent.queryPlan).toEqual(expect.objectContaining({
        baseQuery: 'NanoFlow CodeGraph duplicate hotspots queryOverlay scoreCandidate selectGraphResults formatNativeMarkdown contextPackSourceRankingQueryFor sanitizeContextPackBaseMarkdownSections collectTypeScript buildNativeGraph dedup contract remaining duplicate audit context-pack quality source ordering adapter gate current project semantic coverage',
        overlayQuery: 'NanoFlow CodeGraph duplicate hotspots queryOverlay scoreCandidate selectGraphResults formatNativeMarkdown contextPackSourceRankingQueryFor sanitizeContextPackBaseMarkdownSections collectTypeScript buildNativeGraph dedup contract remaining duplicate audit context-pack quality source ordering adapter gate current project semantic coverage',
      }));
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        topRankedOverlayFile: 'scripts/query-codegraph-nanoflow-overlay.mjs',
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('uses visible de-duplication maintenance source as diagnostic evidence when test helpers outrank overlay matches', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-dedup-diagnostic-source-'));
    tempRoots.push(projectRoot);
    const queryText = 'codegraph nanoflow adaptation dedup contract native output source ordering strict native gaps';

    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        `  query: ${JSON.stringify(queryText)},`,
        '  matches: [{',
        '    kind: "function",',
        '    name: "registerStrictNativeProjectionSpecs",',
        '    file: "src/tests/scripts/codegraph-nanoflow-overlay-query-strict-native.spec-helpers.ts",',
        '    score: 980',
        '  }, {',
        '    kind: "function",',
        '    name: "registerSourceOrderingSpecs",',
        '    file: "src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-source-ordering.spec-helpers.ts",',
        '    score: 960',
        '  }],',
        '  nodes: [{',
        '    id: "function:src/tests/scripts/codegraph-nanoflow-overlay-query-strict-native.spec-helpers.ts:registerStrictNativeProjectionSpecs",',
        '    kind: "function",',
        '    name: "registerStrictNativeProjectionSpecs",',
        '    qualifiedName: "registerStrictNativeProjectionSpecs",',
        '    filePath: "src/tests/scripts/codegraph-nanoflow-overlay-query-strict-native.spec-helpers.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 4',
        '  }, {',
        '    id: "function:src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-source-ordering.spec-helpers.ts:registerSourceOrderingSpecs",',
        '    kind: "function",',
        '    name: "registerSourceOrderingSpecs",',
        '    qualifiedName: "registerSourceOrderingSpecs",',
        '    filePath: "src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-source-ordering.spec-helpers.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 4',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 2, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/validate-codegraph-overlay-docs.cjs',
      [
        "'use strict';",
        'function validateDiscoveredDedupManifestCoverage() {',
        '  return true;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/codegraph-nanoflow-overlay-query-strict-native.spec-helpers.ts',
      [
        'export function registerStrictNativeProjectionSpecs(): void {',
        "  expect('strict native').toBeTruthy();",
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-source-ordering.spec-helpers.ts',
      [
        'export function registerSourceOrderingSpecs(): void {',
        "  expect('source ordering').toBeTruthy();",
        '}',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-dedup-diagnostic-source-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-dedup-diagnostic-source-log-')),
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
        "    'Found 2 symbols across 2 files.',",
        "    '',",
        "    '### Source Code',",
        "    '',",
        "    '> The code below is the **verbatim, current on-disk source** of these files.',",
        "    '',",
        "    '#### scripts/query-codegraph-nanoflow-overlay.mjs — formatStrictNativeMarkdown(function), contextPackSourceRankingQueryFor(function)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tconst response = {};',",
        "    '2\\tfunction formatStrictNativeMarkdown() { return response; }',",
        "    '```',",
        "    '',",
        "    '#### scripts/validate-codegraph-overlay-docs.cjs — validateDiscoveredDedupManifestCoverage(function)',",
        "    '',",
        "    '```javascript',",
        "    '1\\tfunction validateDiscoveredDedupManifestCoverage() {',",
        "    '2\\t  return true;',",
        "    '3\\t}',",
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
        id: 50,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query: queryText,
            overlayLimit: 10,
          },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain('#### scripts/query-codegraph-nanoflow-overlay.mjs');
      expect(text).toContain('#### scripts/validate-codegraph-overlay-docs.cjs');
      expect(text).not.toContain('#### src/tests/scripts/codegraph-nanoflow-overlay-query-strict-native.spec-helpers.ts');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 50,
      );
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        rawTopRankedOverlayFile: 'src/tests/scripts/codegraph-nanoflow-overlay-query-strict-native.spec-helpers.ts',
        topRankedOverlayFile: 'scripts/query-codegraph-nanoflow-overlay.mjs',
        topRankedOverlayFileSelectionReason: 'dedup-maintenance-source-evidence',
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);
}
