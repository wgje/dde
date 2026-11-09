import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it } from 'vitest';

import type { CodegraphOverlaySpecContext } from './codegraph-nanoflow-overlay.spec-context';
import {
  callContextPack,
  writeOverlayResponseScript,
} from './codegraph-nanoflow-overlay-mcp-context-quality.helpers';

const OVERLAY_STALE_SKIP_REFRESH = 'overlay-stale-skip-refresh';

interface ContextPackResponse {
  error?: { code?: number; message?: string };
  result?: {
    isError: boolean;
    content: Array<{ type: string; text: string }>;
    structuredContent?: {
      outcome?: {
        schemaVersion: number;
        status: string;
        usableContext: boolean;
        primaryFailureClass: string | null;
        base: { status: string; isError: boolean; textBytes: number };
        overlay: {
          status: string;
          isError: boolean;
          failureClass: string | null;
          generationId: string | null;
        };
      };
    };
    _meta?: {
      nanoflowFailureClass?: string;
      nanoflowOutcomeSchemaVersion?: number;
      nanoflowOutcomeStatus?: string;
      nanoflowContextUsable?: boolean;
    };
  };
}

async function callWrapperTool(
  child: ChildProcessWithoutNullStreams,
  readJsonLine: CodegraphOverlaySpecContext['readJsonLine'],
  id: number,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 8_000,
): Promise<ContextPackResponse> {
  const responsePromise = readJsonLine(child, timeoutMs);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  })}\n`);
  return await responsePromise as ContextPackResponse;
}

function spawnContextPackWrapper(
  repoRoot: string,
  wrapperScriptPath: string,
  projectRoot: string,
  fakeCodegraph: string,
  env: Record<string, string | undefined> = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [
    wrapperScriptPath, fakeCodegraph, 'serve', '--mcp', '--path', projectRoot,
  ], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function writeRawOverlayResponseScript(projectRoot: string, rawOutput: string): void {
  const scriptPath = path.join(projectRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env node',
      `process.stdout.write(${JSON.stringify(rawOutput)});`,
      '',
    ].join('\n'),
  );
}

function writeDelayedOverlayResponseScript(
  projectRoot: string,
  delayMs: number,
  payload: Record<string, unknown>,
): void {
  const scriptPath = path.join(projectRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env node',
    `const payload = ${JSON.stringify(payload)};`,
    `setTimeout(() => process.stdout.write(JSON.stringify(payload)), ${delayMs});`,
    '',
  ].join('\n'));
}

function writeStaleOverlayFailureScript(projectRoot: string): void {
  const scriptPath = path.join(projectRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, [
    '#!/usr/bin/env node',
    `const marker = ${JSON.stringify(OVERLAY_STALE_SKIP_REFRESH)};`,
    "const args = process.argv.join(' ');",
    "process.stderr.write(`${JSON.stringify({ event: 'profile', detail: marker })}\\n`);",
    "if (args.includes('substring-only')) process.exitCode = 2;",
    "else { process.stderr.write(`${marker}\\n`); if (args.includes('timeout-precedence')) setInterval(() => {}, 1000); else process.exitCode = 2; }",
    '',
  ].join('\n'));
}

function makeContextPackBaseFake(
  tempRoots: string[],
  responseText: string,
  exitOnExplore = false,
  emptyContentOnExplore = false,
): string {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-pack-base-fake-'));
  tempRoots.push(fakeRoot);
  const fakePath = path.join(fakeRoot, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on(\'line\', line => {',
      '  if (!line.trim()) return;',
      '  const message = JSON.parse(line);',
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] } }));",
      '    return;',
      '  }',
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      ...(exitOnExplore
        ? ['    process.exit(70);', '    return;']
        : (emptyContentOnExplore
          ? [
              "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { isError: false, content: [] } }));",
            ]
          : [
            `    const text = ${JSON.stringify(responseText)};`,
            "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
          ])),
      '    return;',
      '  }',
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      '});',
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeContextPackFailurePreload(tempRoots: string[]): string {
  const preloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-context-pack-failure-preload-'));
  tempRoots.push(preloadRoot);
  const preloadPath = path.join(preloadRoot, 'failure-preload.cjs');
  fs.writeFileSync(preloadPath, [
    "'use strict';",
    "const isWrapper = /codegraph-nanoflow-mcp-stdio\\.cjs$/i.test(process.argv[1] ?? '');",
    "const mode = process.env.NANOFLOW_TEST_CONTEXT_FAILURE_MODE;",
    'if (isWrapper && mode === \'entry\') {',
    '  const originalSetTimeout = global.setTimeout;',
    '  global.setTimeout = function (callback, delay, ...args) {',
    "    if (String(new Error().stack).includes('forwardNanoFlowContextPackRequestUnchecked')) throw new Error('fixture context entry failure');",
    '    return originalSetTimeout(callback, delay, ...args);',
    '  };',
    '}',
    'if (isWrapper && mode === \'forward\') {',
    "  const childProcess = require('node:child_process');",
    '  const originalSpawn = childProcess.spawn;',
    '  childProcess.spawn = function (...args) {',
    '    const child = originalSpawn(...args);',
    '    const originalWrite = child.stdin.write.bind(child.stdin);',
    '    child.stdin.write = function (chunk, ...writeArgs) {',
    "      const text = String(chunk);",
    "      if (text.includes('\\\"id\\\":-') && text.includes('\\\"name\\\":\\\"codegraph_explore\\\"')) {",
    "        throw Object.assign(new Error('fixture forwarding failure'), { code: 'EPIPE' });",
    '      }',
    '      return originalWrite(chunk, ...writeArgs);',
    '    };',
    '    return child;',
    '  };',
    '}',
    'if (isWrapper && mode === \'combine\') {',
    '  const originalByteLength = Buffer.byteLength.bind(Buffer);',
    '  let thrown = false;',
    '  Buffer.byteLength = function (value, ...args) {',
    "    const stack = String(new Error().stack);",
    "    if (!thrown && stack.includes('handleCodegraphContextPackResponse') && String(value).includes('combine-handler-base-evidence')) {",
    '      thrown = true;',
    "      throw new Error('fixture context combination failure');",
    '    }',
    '    return originalByteLength(value, ...args);',
    '  };',
    '}',
    '',
  ].join('\n'));
  return preloadPath;
}

export function registerCodegraphOverlayMcpContextPackSpecs(context: CodegraphOverlaySpecContext): void {
  const {
    repoRoot,
    wrapperScriptPath,
    WRAPPER_REPO_OVERLAY_ENV,
    WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS,
    WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS,
    tempRoots,
    makeFreshMcpFixture,
    makeFakeCodegraph,
    makeHangingExploreFakeCodegraph,
    parseJsonLines,
    readJsonLine,
  } = context;

  it('classifies only an exact stale marker line and preserves timeout precedence for both MCP tools', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-pack-stale-skip-'));
    tempRoots.push(projectRoot);
    writeStaleOverlayFailureScript(projectRoot);
    const logPath = path.join(projectRoot, 'wrapper.log');
    const baseStartSentinel = 'BASE-CONTEXT-START-SENTINEL';
    const baseEndSentinel = 'BASE-CONTEXT-END-SENTINEL';
    const preservedBaseBody = [
      baseStartSentinel,
      'base evidence first line',
      'base evidence final line',
      baseEndSentinel,
    ].join('\n');
    const baseText = `\n## Exploration: stale skip\n\n${preservedBaseBody}\n \t`;
    const child = spawnContextPackWrapper(
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      makeContextPackBaseFake(tempRoots, baseText),
      {
        ...WRAPPER_REPO_OVERLAY_ENV,
        NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '500',
      },
    );
    let id = 70;
    const callTool = (name: string, query: string) => callWrapperTool(
      child,
      readJsonLine,
      id++,
      name,
      { query, limit: 1 },
    );
    try {
      const overlay = await callTool('nanoflow_overlay_query', 'exact-stale');
      expect(overlay.result).toEqual(expect.objectContaining({
        isError: true,
        content: [{ type: 'text', text: OVERLAY_STALE_SKIP_REFRESH }],
        _meta: { nanoflowFailureClass: OVERLAY_STALE_SKIP_REFRESH },
      }));

      const contextPack = await callTool('nanoflow_context_pack', 'exact-stale');
      expect(contextPack.result?.isError).toBe(true);
      expect(contextPack.result?.content).toHaveLength(1);
      const contextText = contextPack.result?.content[0].text ?? '';
      expect(contextText).toBe([
        '> **Partial NanoFlow context:** base CodeGraph context remains usable; the NanoFlow overlay is unavailable.',
        '',
        baseText,
        '',
        '### NanoFlow Overlay Error',
        '',
        OVERLAY_STALE_SKIP_REFRESH,
      ].join('\n'));
      expect(contextText).not.toBe(OVERLAY_STALE_SKIP_REFRESH);
      expect(contextText).toContain(preservedBaseBody);
      expect(contextText).toContain('Partial NanoFlow context');
      expect(contextText).toContain('### NanoFlow Overlay Error');
      expect(contextText.endsWith(OVERLAY_STALE_SKIP_REFRESH)).toBe(true);
      expect(contextText.split(OVERLAY_STALE_SKIP_REFRESH)).toHaveLength(2);
      const warningBoundary = '> **Partial NanoFlow context:** base CodeGraph context remains usable; the NanoFlow overlay is unavailable.\n\n';
      const errorBoundary = `\n\n### NanoFlow Overlay Error\n\n${OVERLAY_STALE_SKIP_REFRESH}`;
      expect(contextText.slice(warningBoundary.length, -errorBoundary.length)).toBe(baseText);
      const warningIndex = contextText.indexOf('Partial NanoFlow context');
      const baseStartIndex = contextText.indexOf(baseStartSentinel);
      const baseEndIndex = contextText.indexOf(baseEndSentinel);
      const overlayErrorIndex = contextText.indexOf('### NanoFlow Overlay Error');
      const markerIndex = contextText.lastIndexOf(OVERLAY_STALE_SKIP_REFRESH);
      expect(warningIndex).toBeGreaterThanOrEqual(0);
      expect(warningIndex).toBeLessThan(baseStartIndex);
      expect(baseStartIndex).toBeLessThan(baseEndIndex);
      expect(baseEndIndex).toBeLessThan(overlayErrorIndex);
      expect(overlayErrorIndex).toBeLessThan(markerIndex);
      expect(markerIndex + OVERLAY_STALE_SKIP_REFRESH.length).toBe(contextText.length);
      const outcome = contextPack.result?.structuredContent?.outcome;
      expect(outcome).toEqual({
        schemaVersion: 1,
        status: 'partial',
        usableContext: true,
        primaryFailureClass: OVERLAY_STALE_SKIP_REFRESH,
        base: {
          status: 'available',
          isError: false,
          textBytes: Buffer.byteLength(baseText, 'utf8'),
        },
        overlay: {
          status: 'stale',
          isError: true,
          failureClass: OVERLAY_STALE_SKIP_REFRESH,
          generationId: null,
        },
      });
      expect(contextPack.result?._meta).toEqual({
        nanoflowFailureClass: OVERLAY_STALE_SKIP_REFRESH,
        nanoflowOutcomeSchemaVersion: 1,
        nanoflowOutcomeStatus: 'partial',
        nanoflowContextUsable: true,
      });
      const contextResponseEntry = parseJsonLines(logPath)
        .find(entry => entry.event === 'nanoflow.context.response' && entry.query === 'exact-stale');
      expect(contextResponseEntry).toEqual(expect.objectContaining({
        outcome,
        outcomeSchemaVersion: 1,
        outcomeStatus: 'partial',
        contextUsable: true,
        failureClass: OVERLAY_STALE_SKIP_REFRESH,
      }));

      const substring = await callTool('nanoflow_overlay_query', 'substring-only');
      expect(substring.result?._meta?.nanoflowFailureClass).toBe('overlay-nonzero-exit');
      expect(substring.result?.content[0].text).not.toBe(OVERLAY_STALE_SKIP_REFRESH);
      const timeout = await callTool('nanoflow_overlay_query', 'timeout-precedence');
      expect(timeout.result?._meta?.nanoflowFailureClass).toBe('overlay-timeout');
    } finally {
      child.kill();
    }
  }, 20_000);

  it('keeps a pure no-hit context pack minimal without synthetic NanoFlow sections', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-pack-no-hit-'));
    tempRoots.push(projectRoot);
    writeOverlayResponseScript(projectRoot, {
      query: 'DefinitelyMissingSymbol',
      matches: [],
      nodes: [],
      edges: [],
      relationshipGroups: {},
      relatedFiles: [],
      coverage: { graphNodes: 0, graphEdges: 0 },
    });
    const noHitText = [
      '## Exploration: DefinitelyMissingSymbol',
      '',
      'No symbols found for this query.',
    ].join('\n');
    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeContextPackBaseFake(tempRoots, noHitText),
      query: 'DefinitelyMissingSymbol',
      readJsonLine,
    });

    expect(text).toContain('No symbols found for this query.');
    expect(text).not.toContain('### Relationships');
    expect(text).not.toContain('### Related Symbols');
    expect(text).not.toContain('### NanoFlow Coverage');
    expect(text).not.toContain('### Next Steps');
  }, 12_000);

  it('collapses unrelated weak upstream hits for an explicit missing symbol query', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-pack-weak-no-hit-'));
    tempRoots.push(projectRoot);
    const query = 'DefinitelyMissingSymbol20260718';
    writeOverlayResponseScript(projectRoot, {
      query,
      matches: [],
      nodes: [],
      edges: [],
      relationshipGroups: {},
      relatedFiles: [],
      coverage: { graphNodes: 0, graphEdges: 0 },
    });
    const weakHitText = [
      `## Exploration: ${query}`,
      '',
      'Found 2 symbols across 1 files.',
      '',
      '### Related Symbols',
      '- src/unrelated.service.ts: UnrelatedService:1',
      '',
      '### Source Code',
      '',
      '**`src/unrelated.service.ts`**',
      '',
      '```typescript',
      '1\texport class UnrelatedService {}',
      '```',
    ].join('\n');

    const text = await callContextPack({
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph: makeContextPackBaseFake(tempRoots, weakHitText),
      query,
      readJsonLine,
    });

    expect(text).toBe(`## Exploration: ${query}\n\nNo code context matched this query.`);
    expect(text).not.toContain('UnrelatedService');
    expect(text).not.toContain('### Related Symbols');
    expect(text).not.toContain('### Source Code');
    expect(text).not.toContain('### NanoFlow Coverage');
  }, 12_000);

  it.each([
    {
      label: 'empty response',
      rawOutput: '',
      evidence: 'returned no text content',
      failureClass: 'overlay-empty-response',
    },
    {
      label: 'non-JSON response',
      rawOutput: 'not-json-overlay-evidence',
      evidence: 'not-json-overlay-evidence',
      failureClass: 'overlay-json-parse',
    },
    {
      label: 'invalid JSON shape',
      rawOutput: JSON.stringify({ unexpectedShape: 'invalid-shape-overlay-evidence' }),
      evidence: 'invalid-shape-overlay-evidence',
      failureClass: 'overlay-invalid-json-shape',
    },
  ])('preserves base evidence and fails closed for a malformed overlay $label', async ({ rawOutput, evidence, failureClass }) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-context-pack-malformed-overlay-'));
    tempRoots.push(projectRoot);
    writeRawOverlayResponseScript(projectRoot, rawOutput);
    const baseEvidence = 'upstream-base-evidence-must-survive';
    const fakeCodegraph = makeContextPackBaseFake(
      tempRoots,
      `## Exploration: malformed-overlay\n\n${baseEvidence}`,
    );
    const child = spawnContextPackWrapper(
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      {
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '5000',
        NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '5000',
      },
    );

    try {
      const contextResponse = await callWrapperTool(child, readJsonLine, 81, 'nanoflow_context_pack', {
        query: 'malformed-overlay', maxFiles: 1, overlayLimit: 1,
      });
      const contextText = contextResponse.result?.content[0].text ?? '';
      const expectedPrefix = [
        '> **Partial NanoFlow context:** base CodeGraph context remains usable; the NanoFlow overlay is unavailable.',
        '',
        `## Exploration: malformed-overlay\n\n${baseEvidence}`,
        '',
        '### NanoFlow Overlay Error',
        '',
      ].join('\n');
      expect(contextResponse.result?.isError).toBe(true);
      expect(contextText.startsWith(expectedPrefix)).toBe(true);
      expect(contextText).toContain(baseEvidence);
      expect(contextText).toContain(evidence);
      expect(contextText).not.toContain('### Relationships');
      expect(contextText).not.toContain('### Related Symbols');
      expect(contextText).not.toContain('### NanoFlow Coverage');
      expect(contextText).not.toContain('### Next Steps');

      const overlayResponse = await callWrapperTool(child, readJsonLine, 82, 'nanoflow_overlay_query', {
        query: 'malformed-overlay', limit: 1, json: true,
      });
      expect(overlayResponse.result?.isError).toBe(true);
      expect(overlayResponse.result?.content[0].text).toContain(evidence);
      expect(overlayResponse.result?._meta?.nanoflowFailureClass).toBe(failureClass);
    } finally {
      child.kill();
    }
  }, 15_000);

  it('returns a combined NanoFlow context pack from base codegraph and overlay results', async () => {
    const projectRoot = makeFreshMcpFixture();
    const fakeCodegraph = makeFakeCodegraph();
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawnContextPackWrapper(
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      { ...WRAPPER_REPO_OVERLAY_ENV, NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    );

    try {
      const response = await callWrapperTool(
        child,
        readJsonLine,
        3,
        'nanoflow_context_pack',
        { query: 'ProjectShellComponent', overlayLimit: 1 },
        WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS,
      );
      const result = response.result!;
      const packText = result.content[0].text;

      expect(result.isError).toBe(false);
      expect(result.structuredContent?.outcome).toEqual(expect.objectContaining({
        status: 'complete',
        usableContext: true,
        primaryFailureClass: null,
        base: expect.objectContaining({ status: 'available', isError: false }),
        overlay: expect.objectContaining({ status: 'available', isError: false, failureClass: null }),
      }));
      expect(result._meta).toEqual(expect.objectContaining({
        nanoflowFailureClass: 'success',
        nanoflowOutcomeSchemaVersion: 1,
        nanoflowOutcomeStatus: 'complete',
        nanoflowContextUsable: true,
      }));
      expect(packText).toContain('### Relationships');
      expect(packText).toContain('### Related Symbols');
      expect(packText).toContain('### Next Steps');
      expect(packText).toContain('Use codegraph_node or targeted file reads only for files named in this context pack.');
      expect(packText).toMatch(/(?:## Exploration: ProjectShellComponent|\*\*Exploration: ProjectShellComponent\*\*)/);
      expect(packText).toContain('base codegraph context');
      expect(packText.trim().startsWith('{')).toBe(false);
      expect(() => JSON.parse(packText)).toThrow();

      const logEntries = parseJsonLines(logPath);
      expect(logEntries).toContainEqual(expect.objectContaining({
        event: 'overlay.query.start',
        json: true,
        contextJson: true,
        outputMode: 'context-json',
      }));
      const overlayStartEntry = logEntries.find((entry) => entry.event === 'nanoflow.context.overlay.start');
      expect(overlayStartEntry).toEqual(expect.objectContaining({
        event: 'nanoflow.context.overlay.start',
        contextId: expect.any(String),
        baseElapsedMs: expect.any(Number),
        deadlineRemainingMs: expect.any(Number),
      }));
      const contextResponseEntry = logEntries.find((entry) => entry.event === 'nanoflow.context.response');
      expect(contextResponseEntry).toEqual(expect.objectContaining({
        outputMode: 'markdown',
        textStartsWithJson: false,
        outcomeStatus: 'complete',
        contextUsable: true,
        failureClass: 'success',
        contextId: overlayStartEntry?.contextId,
        baseElapsedMs: expect.any(Number),
        overlayElapsedMs: expect.any(Number),
        totalElapsedMs: expect.any(Number),
        overlayQueryId: expect.any(String),
        overlayMatchCount: expect.any(Number),
        overlayNodeCount: expect.any(Number),
        overlayEdgeCount: expect.any(Number),
        overlayRelationshipGroupCount: expect.any(Number),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it.each([
    {
      label: 'base and overlay available', base: 'available', overlay: 'available',
      status: 'complete', usable: true, failureClass: 'success', overlayStatus: 'available',
    },
    {
      label: 'base available and overlay stale', base: 'available', overlay: 'stale',
      status: 'partial', usable: true, failureClass: OVERLAY_STALE_SKIP_REFRESH, overlayStatus: 'stale',
    },
    {
      label: 'base timed out and overlay available', base: 'timeout', overlay: 'available',
      status: 'partial', usable: true, failureClass: 'base-codegraph-timeout-overlay-only', overlayStatus: 'available',
    },
    {
      label: 'base returned empty content and overlay available', base: 'empty', overlay: 'available',
      status: 'partial', usable: true, failureClass: 'base-codegraph-unavailable', overlayStatus: 'available',
    },
    {
      label: 'base timed out and overlay failed', base: 'timeout', overlay: 'failed',
      status: 'failed', usable: false, failureClass: 'base-codegraph-timeout', overlayStatus: 'unavailable',
    },
  ])('emits the canonical context outcome when $label', async (testCase) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-context-outcome-matrix-'));
    tempRoots.push(projectRoot);
    const query = `context-outcome-${testCase.base}-${testCase.overlay}`;
    if (testCase.overlay === 'available') {
      writeOverlayResponseScript(projectRoot, {
        query, matches: [], nodes: [], edges: [], relationshipGroups: {}, relatedFiles: [],
        coverage: { graphNodes: 1, graphEdges: 0 },
      });
    } else if (testCase.overlay === 'stale') {
      writeStaleOverlayFailureScript(projectRoot);
    } else {
      writeRawOverlayResponseScript(projectRoot, '');
    }
    const baseText = `## Exploration: ${query}\n\nfresh-base-context-evidence`;
    const fakeCodegraph = testCase.base === 'timeout'
      ? makeHangingExploreFakeCodegraph()
      : makeContextPackBaseFake(tempRoots, baseText, false, testCase.base === 'empty');
    const logPath = path.join(projectRoot, 'wrapper.log');
    const child = spawnContextPackWrapper(repoRoot, wrapperScriptPath, projectRoot, fakeCodegraph, {
      ...WRAPPER_REPO_OVERLAY_ENV,
      NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '150',
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_OVERLAY_GRACE_MS: '150',
      NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '500',
    });

    try {
      const response = await callWrapperTool(child, readJsonLine, 35, 'nanoflow_context_pack', {
        query, maxFiles: 1, overlayLimit: 1,
      });
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).toBe(testCase.status !== 'complete');
      expect(response.result?.content).toHaveLength(1);
      expect(response.result?.structuredContent?.outcome).toEqual(expect.objectContaining({
        schemaVersion: 1,
        status: testCase.status,
        usableContext: testCase.usable,
        primaryFailureClass: testCase.failureClass === 'success' ? null : testCase.failureClass,
        base: expect.objectContaining({
          status: testCase.base === 'available' ? 'available' : 'unavailable',
          textBytes: testCase.base === 'available' ? Buffer.byteLength(baseText, 'utf8') : 0,
        }),
        overlay: expect.objectContaining({ status: testCase.overlayStatus }),
      }));
      expect(response.result?._meta).toEqual(expect.objectContaining({
        nanoflowFailureClass: testCase.failureClass,
        nanoflowOutcomeSchemaVersion: 1,
        nanoflowOutcomeStatus: testCase.status,
        nanoflowContextUsable: testCase.usable,
      }));
      if (testCase.status === 'complete') {
        expect(response.result?.content[0].text).toContain('fresh-base-context-evidence');
        expect(response.result?.content[0].text).not.toContain('Partial NanoFlow context');
        expect(response.result?.content[0].text).not.toContain('### NanoFlow Overlay Error');
      }
      if (testCase.base === 'empty') {
        const logEntries = parseJsonLines(logPath);
        const contextResponseEntry = logEntries.find(
          entry => entry.event === 'nanoflow.context.response' && entry.query === query,
        );
        expect(contextResponseEntry).toEqual(expect.objectContaining({
          failureClass: 'base-codegraph-unavailable',
          investigation: expect.objectContaining({ failureClass: 'base-codegraph-unavailable' }),
        }));
        const clientResponseEntry = logEntries.find(
          entry => entry.event === 'client.response' && entry.query === query,
        );
        expect(clientResponseEntry).toEqual(expect.objectContaining({
          failureClass: 'base-codegraph-unavailable',
          isError: true,
        }));
      }
    } finally {
      child.kill();
    }
  }, 20_000);

  it('waits for the overlay deadline after base context returns first', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-context-overlay-deadline-'));
    tempRoots.push(projectRoot);
    const query = 'overlay-deadline-after-base';
    const generationId = 'g-delayed-overlay-deadline';
    writeDelayedOverlayResponseScript(projectRoot, 220, {
      query,
      generationId,
      matches: [],
      nodes: [],
      edges: [],
      relationshipGroups: {},
      relatedFiles: [],
      coverage: { graphNodes: 1, graphEdges: 0 },
    });
    const baseText = `## Exploration: ${query}\n\nbase-returned-before-overlay`;
    const fakeCodegraph = makeContextPackBaseFake(tempRoots, baseText);
    const logPath = path.join(projectRoot, 'wrapper.log');
    const child = spawnContextPackWrapper(repoRoot, wrapperScriptPath, projectRoot, fakeCodegraph, {
      ...WRAPPER_REPO_OVERLAY_ENV,
      NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '100',
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_OVERLAY_GRACE_MS: '20',
      NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS: '500',
    });

    try {
      const response = await callWrapperTool(child, readJsonLine, 37, 'nanoflow_context_pack', {
        query, maxFiles: 1, overlayLimit: 1,
      });
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).toBe(false);
      expect(response.result?.structuredContent?.outcome).toEqual(expect.objectContaining({
        status: 'complete',
        usableContext: true,
        primaryFailureClass: null,
        base: expect.objectContaining({ status: 'available' }),
        overlay: expect.objectContaining({ status: 'available', generationId }),
      }));
      const logEntries = parseJsonLines(logPath);
      const contextResponseEntry = logEntries.find(
        entry => entry.event === 'nanoflow.context.response' && entry.query === query,
      );
      expect(contextResponseEntry).toEqual(expect.objectContaining({
        failureClass: 'success',
        baseElapsedMs: expect.any(Number),
        overlayElapsedMs: expect.any(Number),
        overlayRecoveryTimedOut: false,
        overlayRecoveryTimeoutMs: expect.any(Number),
        queryPlan: expect.objectContaining({
          contextTimeoutMs: 100,
          overlayTimeoutMs: 500,
        }),
      }));
      expect(contextResponseEntry?.baseElapsedMs).toBeLessThan(100);
      expect(contextResponseEntry?.overlayElapsedMs).toBeGreaterThanOrEqual(220);
      expect(contextResponseEntry?.overlayRecoveryTimeoutMs).toBeGreaterThan(220);
      expect(logEntries.some(entry => entry.event === 'overlay.query.timeout')).toBe(false);
    } finally {
      child.kill();
    }
  }, 10_000);

  it.each([
    { mode: 'entry', failureClass: 'context-pack-entry-error', status: 'failed', baseStatus: 'unavailable' },
    { mode: 'forward', failureClass: 'base-codegraph-unavailable', status: 'failed', baseStatus: 'unavailable' },
    { mode: 'child-exit', failureClass: 'base-codegraph-child-exit', status: 'failed', baseStatus: 'unavailable' },
    { mode: 'combine', failureClass: 'context-pack-error', status: 'partial', baseStatus: 'available' },
  ])('emits a structured context outcome from the $mode failure handler', async (testCase) => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-context-handler-outcome-'));
    tempRoots.push(projectRoot);
    writeOverlayResponseScript(projectRoot, {
      query: testCase.mode, matches: [], nodes: [], edges: [], relationshipGroups: {}, relatedFiles: [],
      coverage: { graphNodes: 1, graphEdges: 0 },
    });
    const baseText = `## Exploration: ${testCase.mode}\n\ncombine-handler-base-evidence`;
    const fakeCodegraph = makeContextPackBaseFake(
      tempRoots,
      baseText,
      testCase.mode === 'child-exit',
    );
    const preloadPath = makeContextPackFailurePreload(tempRoots);
    const child = spawnContextPackWrapper(repoRoot, wrapperScriptPath, projectRoot, fakeCodegraph, {
      ...WRAPPER_REPO_OVERLAY_ENV,
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '3000',
      NANOFLOW_TEST_CONTEXT_FAILURE_MODE: testCase.mode,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(' '),
    });

    try {
      const response = await callWrapperTool(child, readJsonLine, 36, 'nanoflow_context_pack', {
        query: testCase.mode, maxFiles: 1, overlayLimit: 1,
      });
      expect(response.error).toBeUndefined();
      expect(response.result?.content).toHaveLength(1);
      expect(response.result?.isError).toBe(true);
      expect(response.result?.structuredContent?.outcome).toEqual(expect.objectContaining({
        status: testCase.status,
        usableContext: testCase.status === 'partial',
        primaryFailureClass: testCase.failureClass,
        base: expect.objectContaining({ status: testCase.baseStatus }),
        overlay: expect.objectContaining({ status: 'unavailable' }),
      }));
      expect(response.result?._meta).toEqual(expect.objectContaining({
        nanoflowFailureClass: testCase.failureClass,
        nanoflowOutcomeStatus: testCase.status,
      }));
      if (testCase.mode === 'combine') {
        expect(response.result?.content[0].text).toContain(baseText);
        expect(response.result?.structuredContent?.outcome?.base.textBytes)
          .toBe(Buffer.byteLength(baseText, 'utf8'));
      }
    } finally {
      child.kill();
    }
  }, 20_000);

  it('logs base response warnings when CodeGraph returns an auto-sync disabled banner', async () => {
    const projectRoot = makeFreshMcpFixture();
    const warning = 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.\nReason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.';
    const sourceTail = 'source-code-tail-without-warning '.repeat(120);
    const fakeCodegraph = makeContextPackBaseFake(
      tempRoots,
      `${warning}\n\n## Exploration: ProjectShellComponent\nbase codegraph context\n${sourceTail}`,
    );
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawnContextPackWrapper(
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      { ...WRAPPER_REPO_OVERLAY_ENV, NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    );

    try {
      const response = await callWrapperTool(
        child,
        readJsonLine,
        33,
        'nanoflow_context_pack',
        { query: 'ProjectShellComponent', overlayLimit: 1 },
        WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS,
      );

      expect(response.result?.isError).toBe(false);
      expect(response.result?.content[0].text).toContain('CodeGraph auto-sync is DISABLED');

      const logEntries = parseJsonLines(logPath);
      const contextResponseEntry = logEntries.find((entry) => entry.event === 'nanoflow.context.response');
      expect(contextResponseEntry).toEqual(expect.objectContaining({
        baseResponseWarnings: expect.objectContaining({
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
          textTail: expect.stringContaining('index is frozen'),
        }),
        responseWarnings: expect.objectContaining({
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
        }),
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);

  it('does not classify auto-sync warning literals inside returned source code as runtime warnings', async () => {
    const projectRoot = makeFreshMcpFixture();
    const source = "## Exploration\nbase codegraph context\n\n### Source Code\n\n```typescript\n144\tconst warning = 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen. Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.';\n```";
    const fakeCodegraph = makeContextPackBaseFake(tempRoots, source);
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-log-')), 'wrapper.log');
    tempRoots.push(path.dirname(logPath));
    const child = spawnContextPackWrapper(
      repoRoot,
      wrapperScriptPath,
      projectRoot,
      fakeCodegraph,
      { ...WRAPPER_REPO_OVERLAY_ENV, NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    );

    try {
      const response = await callWrapperTool(
        child,
        readJsonLine,
        34,
        'nanoflow_context_pack',
        { query: 'auto-sync warning diagnostics source', overlayLimit: 1 },
        WRAPPER_REPO_OVERLAY_RESPONSE_TIMEOUT_MS,
      );

      expect(response.result?.isError).toBe(false);
      expect(response.result?.content[0].text).toContain('CodeGraph auto-sync is DISABLED');

      const logEntries = parseJsonLines(logPath);
      const contextResponseEntry = logEntries.find((entry) => entry.event === 'nanoflow.context.response');
      expect(contextResponseEntry).toEqual(expect.objectContaining({
        baseResponseWarnings: {
          codegraphAutoSyncDisabled: false,
        },
        responseWarnings: {
          codegraphAutoSyncDisabled: false,
        },
      }));
    } finally {
      child.kill();
    }
  }, WRAPPER_REPO_OVERLAY_TEST_TIMEOUT_MS);
}
