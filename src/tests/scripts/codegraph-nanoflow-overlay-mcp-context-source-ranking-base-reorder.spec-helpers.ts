import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { registerCodegraphOverlayMcpContextSourceRankingDedupMaintenanceSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ranking-dedup-maintenance.spec-helpers';
import { registerCodegraphOverlayMcpContextSourceRankingExplicitToolingSpecs } from './codegraph-nanoflow-overlay-mcp-context-source-ranking-explicit-tooling.spec-helpers';

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

  registerCodegraphOverlayMcpContextSourceRankingExplicitToolingSpecs(context);
  registerCodegraphOverlayMcpContextSourceRankingDedupMaintenanceSpecs(context);
}
