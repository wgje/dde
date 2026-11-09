import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import { writeFakeCodegraphExploreScript } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers';
import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';

type SourceOrderingLogPayload = Record<string, unknown> & {
  sourceBlockCount: number;
};

export function registerCodegraphOverlayMcpContextSourceRankingExplicitToolingSpecs(
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

  it('keeps NanoFlow wrapper source ahead of legacy wrapper and logging noise for runtime diagnostics', async () => {
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
        "  query: 'CodeGraph MCP wrapper runtime error logging context pack entry error stderr diagnostics',",
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
            query: 'CodeGraph MCP wrapper runtime error logging context pack entry error stderr diagnostics',
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
        sourceRankingQuery: expect.stringContaining('codegraph-nanoflow-mcp-stdio'),
        topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);

  it('uses a base-only preferred runtime source as the diagnostic top-ranked file for mixed issue-registry queries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-base-runtime-issue-registry-'));
    tempRoots.push(projectRoot);
    writeFile(
      projectRoot,
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        "'use strict';",
        '',
        'function formatNanoFlowContextPackAsMarkdown(pack) {',
        '  return pack.query;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'docs/codegraph-nanoflow-adaptation-issues.md',
      [
        '# NanoFlow CodeGraph Adaptation Issue Registry',
        '',
        '## Open Issues',
        '',
        '## CG-NF-20260715-901: Generated docs diagnostic fixture',
        '',
        '- status: open',
        '- feature_scope: mixed issue registry and runtime diagnostics',
        '- query_surface: nanoflow_context_pack | adapter-context-cli',
        '- expected: final source ordering diagnostics follow the preferred visible runtime source.',
        '- actual: overlay-only ranking reports the issue registry as top-ranked.',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        'const response = {',
        "  query: 'docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues',",
        '  matches: [{',
        '    kind: "file",',
        '    name: "docs/codegraph-nanoflow-adaptation-issues.md",',
        '    file: "docs/codegraph-nanoflow-adaptation-issues.md",',
        '    score: 900',
        '  }],',
        '  nodes: [{',
        '    id: "file:docs/codegraph-nanoflow-adaptation-issues.md",',
        '    kind: "file",',
        '    name: "docs/codegraph-nanoflow-adaptation-issues.md",',
        '    qualifiedName: "docs/codegraph-nanoflow-adaptation-issues.md",',
        '    filePath: "docs/codegraph-nanoflow-adaptation-issues.md",',
        '    language: "markdown",',
        '    startLine: 1,',
        '    endLine: 11',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 1, graphEdges: 0 }',
        '};',
        'process.stdout.write(JSON.stringify(response));',
        '',
      ].join('\n'),
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-base-runtime-issue-registry-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-base-runtime-issue-registry-log-')),
      'wrapper.log',
    );
    tempRoots.push(path.dirname(logPath));
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      sourceBlocks: [{
        header: 'scripts/codegraph-nanoflow-mcp-stdio.cjs — formatNanoFlowContextPackAsMarkdown(function)',
        language: 'javascript',
        lines: [
          '1\tfunction formatNanoFlowContextPackAsMarkdown(pack) {',
          '2\t  return pack.query;',
          '3\t}',
        ],
      }],
    });

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
      const query = 'CodeGraph generated-docs blocker: codegraph:overlay:docs:validate expected/actual overlay baseline counts, issue schema validation, Codex MCP config contract checks, and codegraph:mcp:log:guard implementation';
      const contextResponsePromise = readJsonLine(child, 8_000);
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 58,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: {
            query,
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
      expect(sourceHeaders[1]).toContain('docs/codegraph-nanoflow-adaptation-issues.md');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 58,
      );
      const sourceOrdering = responseEvent.sourceOrdering as SourceOrderingLogPayload;
      expect(sourceOrdering.rankedOverlayFiles).toEqual([
        'docs/codegraph-nanoflow-adaptation-issues.md',
      ]);
      expect(sourceOrdering.rankedOverlayFiles).not.toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
      expect(sourceOrdering).toEqual(expect.objectContaining({
        rawTopRankedOverlayFile: 'docs/codegraph-nanoflow-adaptation-issues.md',
        topRankedOverlayFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        topRankedOverlayFileSelectionReason: 'preferred-symbol-evidence',
        topRankedOverlayFileSkippedLowValue: false,
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
      const topRankedOverlayDecision = sourceOrdering.topRankedOverlayDecision as {
        selectedEntry?: Record<string, unknown>;
      };
      expect(topRankedOverlayDecision).toEqual(expect.objectContaining({
        rawFile: 'docs/codegraph-nanoflow-adaptation-issues.md',
        selectedFile: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        selectionReason: 'preferred-symbol-evidence',
        rawLowValuePenalty: 0,
        selectedLowValuePenalty: 0,
        skippedLowValue: false,
      }));
      expect(topRankedOverlayDecision.selectedEntry).toEqual(expect.objectContaining({
        filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
        lowValuePenalty: 0,
        rawLowValuePenalty: 6000,
        explicitSymbolEvidence: false,
        preferredSymbolEvidence: true,
        matchScore: 0,
        nodeScore: 0,
        codeBlockScore: 0,
      }));
      expect(Number(topRankedOverlayDecision.selectedEntry?.sourceBlockScore ?? 0)).toBeGreaterThan(0);
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
      expect(sourceOrdering.topRankedOverlayDecision).toEqual(expect.objectContaining({
        rawLowValuePenalty: 0,
        selectedLowValuePenalty: 0,
        skippedLowValue: true,
        selectedEntry: expect.objectContaining({
          filePath: 'scripts/codegraph-nanoflow-mcp-stdio.cjs',
          lowValuePenalty: 0,
          rawLowValuePenalty: 6000,
          preferredSymbolEvidence: true,
        }),
      }));
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
}
