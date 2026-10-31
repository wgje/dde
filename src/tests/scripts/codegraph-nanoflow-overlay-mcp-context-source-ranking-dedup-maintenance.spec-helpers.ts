import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import { writeFakeCodegraphExploreScript } from './codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers';

const DEDUP_MAINTENANCE_FOCUSED_QUERY = 'docs/codegraph-nanoflow-dedup-contract.json scripts/validate-codegraph-overlay-docs.cjs scripts/query-codegraph-nanoflow-overlay.mjs scripts/codegraph-nanoflow-mcp-stdio.cjs dedup contract';

export function registerCodegraphOverlayMcpContextSourceRankingDedupMaintenanceSpecs(
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
        baseQuery: DEDUP_MAINTENANCE_FOCUSED_QUERY,
        overlayQuery: DEDUP_MAINTENANCE_FOCUSED_QUERY,
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

  it('rewrites broad de-duplication maintenance intent to canonical contract sources', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-dedup-broad-query-'));
    tempRoots.push(projectRoot);
    const rawQuery = 'NanoFlow CodeGraph current adaptation quality dedup maintenance source ordering test helper pollution remaining semantic gaps native output standard';
    const focusedQuery = DEDUP_MAINTENANCE_FOCUSED_QUERY;

    writeFile(
      projectRoot,
      'scripts/query-codegraph-nanoflow-overlay.mjs',
      [
        '#!/usr/bin/env node',
        `const focusedQuery = ${JSON.stringify(focusedQuery)};`,
        "const queryIndex = process.argv.indexOf('--query');",
        "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
        'const focused = query === focusedQuery;',
        'const response = focused ? {',
        '  query,',
        '  matches: [{',
        '    kind: "function",',
        '    name: "contextPackSourceRankingQueryFor",',
        '    file: "scripts/codegraph-nanoflow-mcp-stdio.cjs",',
        '    score: 1200',
        '  }, {',
        '    kind: "function",',
        '    name: "validateDiscoveredDedupManifestCoverage",',
        '    file: "scripts/validate-codegraph-overlay-docs.cjs",',
        '    score: 1100',
        '  }, {',
        '    kind: "interface",',
        '    name: "FakeCodegraphExploreResponse",',
        '    file: "src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts",',
        '    score: 200',
        '  }, {',
        '    kind: "class",',
        '    name: "NanoflowBootstrapContract",',
        '    file: "android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt",',
        '    score: 150',
        '  }],',
        '  nodes: [{',
        '    id: "function:scripts/codegraph-nanoflow-mcp-stdio.cjs:contextPackSourceRankingQueryFor",',
        '    kind: "function",',
        '    name: "contextPackSourceRankingQueryFor",',
        '    qualifiedName: "contextPackSourceRankingQueryFor",',
        '    filePath: "scripts/codegraph-nanoflow-mcp-stdio.cjs",',
        '    language: "javascript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }, {',
        '    id: "function:scripts/validate-codegraph-overlay-docs.cjs:validateDiscoveredDedupManifestCoverage",',
        '    kind: "function",',
        '    name: "validateDiscoveredDedupManifestCoverage",',
        '    qualifiedName: "validateDiscoveredDedupManifestCoverage",',
        '    filePath: "scripts/validate-codegraph-overlay-docs.cjs",',
        '    language: "javascript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }, {',
        '    id: "interface:src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts:FakeCodegraphExploreResponse",',
        '    kind: "interface",',
        '    name: "FakeCodegraphExploreResponse",',
        '    qualifiedName: "FakeCodegraphExploreResponse",',
        '    filePath: "src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }, {',
        '    id: "class:android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt:NanoflowBootstrapContract",',
        '    kind: "class",',
        '    name: "NanoflowBootstrapContract",',
        '    qualifiedName: "NanoflowBootstrapContract",',
        '    filePath: "android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt",',
        '    language: "kotlin",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }],',
        '  relationshipGroups: {},',
        '  coverage: { graphNodes: 2, graphEdges: 0 }',
        '} : {',
        '  query,',
        '  matches: [{',
        '    kind: "interface",',
        '    name: "FakeCodegraphExploreResponse",',
        '    file: "src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts",',
        '    score: 1200',
        '  }, {',
        '    kind: "class",',
        '    name: "NanoflowBootstrapContract",',
        '    file: "android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt",',
        '    score: 1100',
        '  }],',
        '  nodes: [{',
        '    id: "interface:src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts:FakeCodegraphExploreResponse",',
        '    kind: "interface",',
        '    name: "FakeCodegraphExploreResponse",',
        '    qualifiedName: "FakeCodegraphExploreResponse",',
        '    filePath: "src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts",',
        '    language: "typescript",',
        '    startLine: 1,',
        '    endLine: 3',
        '  }, {',
        '    id: "class:android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt:NanoflowBootstrapContract",',
        '    kind: "class",',
        '    name: "NanoflowBootstrapContract",',
        '    qualifiedName: "NanoflowBootstrapContract",',
        '    filePath: "android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt",',
        '    language: "kotlin",',
        '    startLine: 1,',
        '    endLine: 3',
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
      'scripts/codegraph-nanoflow-mcp-stdio.cjs',
      [
        'function contextPackSourceRankingQueryFor(query) {',
        '  return query;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'scripts/validate-codegraph-overlay-docs.cjs',
      [
        'function validateDiscoveredDedupManifestCoverage() {',
        '  return true;',
        '}',
        '',
      ].join('\n'),
    );
    writeFile(
      projectRoot,
      'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts',
      'export interface FakeCodegraphExploreResponse {}\n',
    );
    writeFile(
      projectRoot,
      'android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt',
      'class NanoflowBootstrapContract\n',
    );

    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-dedup-broad-query-fake-'));
    tempRoots.push(fakeRoot);
    const fakeCodegraph = path.join(fakeRoot, 'fake-codegraph.cjs');
    writeFakeCodegraphExploreScript(fakeCodegraph, {
      focusedQuery,
      focused: {
        preludeLines: [
          '**Not shown above — explore these names for their source**',
          '',
          '- src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts: FakeCodegraphExploreResponse:1',
          '- android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt: NanoflowBootstrapContract:1',
          '- scripts/validate-codegraph-overlay-docs.cjs: validateDiscoveredDedupManifestCoverage:1',
        ],
        sourceBlocks: [{
          header: 'scripts/codegraph-nanoflow-mcp-stdio.cjs — contextPackSourceRankingQueryFor(function)',
          language: 'javascript',
          lines: [
            '1\tfunction contextPackSourceRankingQueryFor(query) {',
            '2\t  return query;',
            '3\t}',
          ],
        }, {
          header: 'scripts/validate-codegraph-overlay-docs.cjs — validateDiscoveredDedupManifestCoverage(function)',
          language: 'javascript',
          lines: [
            '1\tfunction validateDiscoveredDedupManifestCoverage() {',
            '2\t  return true;',
            '3\t}',
          ],
        }],
      },
      fallback: {
        sourceBlocks: [{
          header: 'src/tests/scripts/codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts — FakeCodegraphExploreResponse(interface)',
          language: 'typescript',
          lines: ['1\texport interface FakeCodegraphExploreResponse {}'],
        }, {
          header: 'android/app/src/main/java/app/nanoflow/host/NanoflowBootstrapContract.kt — NanoflowBootstrapContract(class)',
          language: 'kotlin',
          lines: ['1\tclass NanoflowBootstrapContract'],
        }],
      },
    });

    const logPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-dedup-broad-query-log-')),
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
        id: 51,
        method: 'tools/call',
        params: {
          name: 'nanoflow_context_pack',
          arguments: { query: rawQuery, overlayLimit: 10 },
        },
      })}\n`);

      const contextResponse = await contextResponsePromise as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      const text = contextResponse.result.content[0].text;
      expect(contextResponse.result.isError).toBe(false);
      expect(text).toContain('scripts/codegraph-nanoflow-mcp-stdio.cjs');
      expect(text).toContain('scripts/validate-codegraph-overlay-docs.cjs');
      expect(text).not.toContain('codegraph-nanoflow-overlay-mcp-context-quality-tooling-fixtures.helpers.ts');
      expect(text).not.toContain('NanoflowBootstrapContract.kt');

      const responseEvent = await waitForLogEvent(
        logPath,
        'nanoflow.context.response',
        2_000,
        (entry) => entry.originalId === 51,
      );
      expect(responseEvent.queryPlan).toEqual(expect.objectContaining({
        baseQuery: focusedQuery,
        overlayQuery: focusedQuery,
      }));
      expect(responseEvent.sourceOrdering).toEqual(expect.objectContaining({
        topRankedOverlayFileVisibleIndex: 0,
        firstSourceBlockIsTopRankedOverlayFile: true,
        topRankedOverlayFileMissing: false,
      }));
    } finally {
      child.kill();
    }
  }, 12_000);
}
