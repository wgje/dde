import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterContextCliRecoverySpecContext {
  repoRoot: string;
  trackTempRoot(root: string): void;
  makeConfigBackedAdapterProject(): string;
  makeContextReturningFakeCodegraph(): string;
  makeHangingExploreFakeCodegraph(): string;
  makeMaxFilesSensitiveFakeCodegraph(): string;
  makeTempAdapterProject(): string;
  makeStubbornProcessTreeAdapterProject(): string;
  runAdapterContext(options: {
    projectRoot: string;
    query: string;
    codegraphTarget?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  }): SpawnSyncReturns<string>;
}

interface AdapterSummary {
  ok?: boolean;
  complete?: boolean;
  partial?: boolean;
  contextUsable?: boolean;
  contextText?: string;
  maxFiles?: number;
  toolingTriageFastTimeout?: boolean;
  wrapperRequestTimeoutMs?: number;
  outcome?: {
    schemaVersion?: number;
    status?: string;
    usableContext?: boolean;
    primaryFailureClass?: string | null;
    base?: { status?: string };
    overlay?: { status?: string; failureClass?: string | null };
  };
  overlay?: { unavailable?: boolean; failureClass?: string; rawResponse?: string | null; message?: string };
  diagnostics?: {
    contextAttempts?: Array<{
      maxFiles?: number;
      maxFilesOmitted?: boolean;
      partial?: boolean;
      isError?: boolean;
      mcpIsError?: boolean;
      failureClass?: string;
    }>;
    overlayUnavailable?: boolean;
    overlayFailureClass?: string;
    overlayTextBytes?: number;
  };
}

function expectedOutcome(
  status: 'complete' | 'partial' | 'failed',
  primaryFailureClass: string | null,
  baseStatus: 'available' | 'unavailable',
  overlayStatus: 'available' | 'stale' | 'unavailable',
  expectedAttempts?: number,
) {
  return {
    status,
    usableContext: status !== 'failed',
    primaryFailureClass,
    baseStatus,
    overlayStatus,
    partial: status === 'partial',
    ...(expectedAttempts ? { expectedAttempts } : {}),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    Atomics.wait(sleeper, 0, 0, 50);
  }
  return !processExists(pid);
}

function terminateWindowsProcessTree(pid: number): void {
  if (!pid || process.platform !== 'win32' || !processExists(pid)) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

function writeMalformedOverlayAdapterHarness(
  projectRoot: string,
  overlayContent: Array<{ type: string; text?: unknown }>,
  declaredFailures: { context?: string; overlay?: string; contextResult?: Record<string, unknown> } = {},
): void {
  const scriptsRoot = path.join(projectRoot, 'scripts');
  fs.writeFileSync(
    path.join(scriptsRoot, 'codegraph-nanoflow-mcp-stdio.cjs'),
    [
      "'use strict';",
      "const readline = require('node:readline');",
      `const overlayContent = ${JSON.stringify(overlayContent)};`,
      `const contextFailureClass = ${JSON.stringify(declaredFailures.context ?? null)};`,
      `const overlayFailureClass = ${JSON.stringify(declaredFailures.overlay ?? null)};`,
      `const explicitContextResult = ${JSON.stringify(declaredFailures.contextResult ?? null)};`,
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on(\'line\', line => {',
      '  if (!line.trim()) return;',
      '  const message = JSON.parse(line);',
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [",
      "      { name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } },",
      "      { name: 'nanoflow_context_pack', description: 'fake', inputSchema: { type: 'object' } },",
      "      { name: 'nanoflow_overlay_query', description: 'fake', inputSchema: { type: 'object' } },",
      '    ] } }));',
      '    return;',
      '  }',
      "  if (message.method === 'tools/call' && message.params?.name === 'nanoflow_context_pack') {",
      "    const result = explicitContextResult ?? (contextFailureClass ? { isError: true, content: [{ type: 'text', text: contextFailureClass }], _meta: { nanoflowFailureClass: contextFailureClass } } : { isError: false, content: [{ type: 'text', text: '## Exploration: malformed adapter overlay\\n\\nadapter-upstream-context-evidence' }] });",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));",
      '    return;',
      '  }',
      "  if (message.method === 'tools/call' && message.params?.name === 'nanoflow_overlay_query') {",
      "    const result = overlayFailureClass ? { isError: true, content: [{ type: 'text', text: overlayFailureClass }], _meta: { nanoflowFailureClass: overlayFailureClass } } : { isError: false, content: overlayContent };",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));",
      '    return;',
      '  }',
      '});',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(scriptsRoot, 'analyze-codegraph-mcp-log.cjs'),
    [
      "'use strict';",
      'process.stdout.write(JSON.stringify({',
      '  transportHealthy: true,',
      '  criticalTransportFailures: 0,',
      '  overlayTimeouts: 0,',
      '  currentWrapper: null,',
      '  currentContextWrapper: null,',
      '  currentContextSourceOrdering: null,',
      '  currentDiskContextWrapper: null,',
      '  currentDiskContextSourceOrdering: null,',
      '  activeWrappers: { total: 0 }',
      '}));',
      '',
    ].join('\n'),
  );
}

function writeRawAdapterOverlayScript(projectRoot: string, repoRoot: string, rawOutput: string): void {
  const libraryRoot = path.join(projectRoot, 'scripts', 'lib');
  fs.mkdirSync(libraryRoot, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'lib', 'codegraph-context-outcome.cjs'),
    path.join(libraryRoot, 'codegraph-context-outcome.cjs'),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'scripts', 'query-codegraph-nanoflow-overlay.mjs'),
    [
      '#!/usr/bin/env node',
      `process.stdout.write(${JSON.stringify(rawOutput)});`,
      '',
    ].join('\n'),
  );
}

export function registerCodegraphAdapterContextCliRecoverySpecs(
  context: CodegraphAdapterContextCliRecoverySpecContext,
): void {
  const {
    repoRoot,
    trackTempRoot,
    makeConfigBackedAdapterProject,
    makeContextReturningFakeCodegraph,
    makeHangingExploreFakeCodegraph,
    makeMaxFilesSensitiveFakeCodegraph,
    makeTempAdapterProject,
    makeStubbornProcessTreeAdapterProject,
    runAdapterContext,
  } = context;

  it.each([
    {
      label: 'empty text',
      content: [] as Array<{ type: string; text?: unknown }>,
      failureClass: 'overlay-empty-response',
      rawEvidence: null,
    },
    {
      label: 'non-JSON text',
      content: [{ type: 'text', text: 'adapter-non-json-overlay-evidence' }],
      failureClass: 'overlay-json-parse-error',
      rawEvidence: 'adapter-non-json-overlay-evidence',
    },
    {
      label: 'invalid JSON shape',
      content: [{ type: 'text', text: JSON.stringify({ unexpectedShape: 'adapter-invalid-shape-evidence' }) }],
      failureClass: 'overlay-invalid-json-shape',
      rawEvidence: 'adapter-invalid-shape-evidence',
    },
  ])('preserves context and reports malformed overlay $label without false success', ({ content, failureClass, rawEvidence }) => {
    const projectRoot = makeConfigBackedAdapterProject();
    writeMalformedOverlayAdapterHarness(projectRoot, content);
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: 'fake-codegraph-target',
      query: 'malformed adapter overlay',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--max-files', '1', '--timeout-ms', '10000'],
    });

    expect(result.status, [result.stdout, result.stderr, result.error?.message ?? ''].join('\n')).toBe(0);
    const summary = JSON.parse(result.stdout) as AdapterSummary;
    expect(summary.ok).toBe(false);
    expect(summary.contextText).toContain('adapter-upstream-context-evidence');
    expect(summary.overlay).toEqual(expect.objectContaining({
      unavailable: true,
      failureClass,
      rawResponse: rawEvidence === null ? null : expect.stringContaining(rawEvidence),
    }));
    expect(summary.diagnostics).toEqual(expect.objectContaining({
      overlayUnavailable: true,
      overlayFailureClass: failureClass,
    }));
  }, 30_000);

  it.each([
    {
      label: 'structured partial context',
      contextResult: {
        isError: true,
        content: [{
          type: 'text',
          text: [
            '> **Partial NanoFlow context:** base CodeGraph context remains usable; the NanoFlow overlay is unavailable.',
            '',
            '## Exploration: structured partial adapter context',
            '',
            'adapter-structured-base-evidence',
            '',
            '### NanoFlow Overlay Error',
            '',
            'overlay-stale-skip-refresh',
          ].join('\n'),
        }],
        structuredContent: {
          outcome: {
            schemaVersion: 1,
            status: 'partial',
            usableContext: true,
            primaryFailureClass: 'overlay-stale-skip-refresh',
            base: { status: 'available', isError: false, textBytes: 81 },
            overlay: {
              status: 'stale',
              isError: true,
              failureClass: 'overlay-stale-skip-refresh',
              generationId: null,
            },
          },
        },
        _meta: {
          nanoflowFailureClass: 'overlay-stale-skip-refresh',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'partial',
          nanoflowContextUsable: true,
        },
      },
      expectedPartial: true,
      expectedUsable: true,
      expectedStatus: 'partial',
      expectedContextEvidence: 'adapter-structured-base-evidence',
    },
    {
      label: 'legacy exact stale marker',
      contextResult: {
        isError: true,
        content: [{ type: 'text', text: 'overlay-stale-skip-refresh' }],
        _meta: { nanoflowFailureClass: 'overlay-stale-skip-refresh' },
      },
      expectedPartial: false,
      expectedUsable: false,
      expectedStatus: 'failed',
      expectedContextEvidence: 'overlay-stale-skip-refresh',
    },
  ])('distinguishes $label from a failed legacy marker', ({
    contextResult,
    expectedPartial,
    expectedUsable,
    expectedStatus,
    expectedContextEvidence,
  }) => {
    const projectRoot = makeConfigBackedAdapterProject();
    writeMalformedOverlayAdapterHarness(projectRoot, [{
      type: 'text',
      text: JSON.stringify({ query: 'context outcome', count: 0, matches: [], nodes: [], edges: [] }),
    }], { contextResult });
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: 'fake-codegraph-target',
      query: 'strict partial context outcome',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--max-files', '1', '--timeout-ms', '10000'],
    });

    expect(result.status, [result.stdout, result.stderr, result.error?.message ?? ''].join('\n')).toBe(0);
    const summary = JSON.parse(result.stdout) as AdapterSummary;
    expect(summary.ok).toBe(false);
    expect(summary.complete).toBe(false);
    expect(summary.partial).toBe(expectedPartial);
    expect(summary.contextUsable).toBe(expectedUsable);
    expect(summary.contextText).toContain(expectedContextEvidence);
    expect(summary.outcome).toEqual(expect.objectContaining({
      schemaVersion: 1,
      status: expectedStatus,
      usableContext: expectedUsable,
      primaryFailureClass: 'overlay-stale-skip-refresh',
      base: expect.objectContaining({ status: expectedUsable ? 'available' : 'unavailable' }),
      overlay: expect.objectContaining({
        status: 'stale',
        failureClass: 'overlay-stale-skip-refresh',
      }),
    }));
  }, 30_000);

  it.each([
    {
      label: 'structuredContent complete outcome over contradictory timeout text and metadata',
      contextResult: {
        isError: true,
        content: [{ type: 'text', text: 'Base CodeGraph timed out before returning source\nstructured-complete-evidence' }],
        structuredContent: {
          outcome: {
            schemaVersion: 1,
            status: 'complete',
            usableContext: true,
            primaryFailureClass: null,
            base: { status: 'available', isError: false, textBytes: 72 },
            overlay: {
              status: 'available',
              isError: false,
              failureClass: null,
              generationId: 'structured-complete-generation',
            },
          },
        },
        _meta: {
          nanoflowFailureClass: 'overlay-stale-skip-refresh',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'partial',
          nanoflowContextUsable: true,
        },
      },
      expected: expectedOutcome('complete', null, 'available', 'available'),
    },
    {
      label: 'structuredContent outcome over conflicting metadata and text',
      contextResult: {
        isError: true,
        content: [{ type: 'text', text: 'Base CodeGraph timed out before returning source\nstructured-partial-evidence' }],
        structuredContent: {
          outcome: {
            schemaVersion: 1,
            status: 'partial',
            usableContext: true,
            primaryFailureClass: 'structured-overlay-unavailable',
            base: { status: 'available', isError: false, textBytes: 101 },
            overlay: {
              status: 'unavailable',
              isError: true,
              failureClass: 'structured-overlay-unavailable',
              generationId: 'structured-generation',
            },
          },
        },
        _meta: {
          nanoflowFailureClass: 'overlay-stale-skip-refresh',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'failed',
          nanoflowContextUsable: false,
        },
      },
      expected: expectedOutcome('partial', 'structured-overlay-unavailable', 'available', 'unavailable'),
    },
    {
      label: 'invalid structuredContent outcome fails closed over valid metadata and timeout text',
      contextResult: {
        isError: false,
        content: [{ type: 'text', text: 'Base CodeGraph timed out before returning source\ninvalid-structured-evidence' }],
        structuredContent: {
          outcome: {
            schemaVersion: 1,
            status: 'complete',
            usableContext: true,
            primaryFailureClass: null,
            base: { status: 'available', isError: false, textBytes: 0 },
            overlay: { status: 'available', isError: false, failureClass: null, generationId: null },
          },
        },
        _meta: {
          nanoflowFailureClass: 'success',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'complete',
          nanoflowContextUsable: true,
        },
      },
      expected: expectedOutcome('failed', 'context-outcome-invalid', 'unavailable', 'unavailable'),
    },
    {
      label: 'metadata complete outcome over contradictory timeout text',
      contextResult: {
        isError: false,
        content: [{ type: 'text', text: 'No base CodeGraph context was returned.\nmetadata-complete-evidence' }],
        _meta: {
          nanoflowFailureClass: 'success',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'complete',
          nanoflowContextUsable: true,
        },
      },
      expected: expectedOutcome('complete', null, 'available', 'available'),
    },
    {
      label: 'metadata outcome over conflicting exact-marker text',
      contextResult: {
        isError: true,
        content: [{ type: 'text', text: 'overlay-stale-skip-refresh' }],
        _meta: {
          nanoflowFailureClass: 'overlay-stale-skip-refresh',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'partial',
          nanoflowContextUsable: true,
        },
      },
      expected: expectedOutcome('partial', 'overlay-stale-skip-refresh', 'available', 'stale'),
    },
    {
      label: 'metadata base timeout overlay-only outcome without reversing components',
      contextResult: {
        isError: true,
        content: [{ type: 'text', text: '## Exploration: metadata overlay only\n\nmetadata-overlay-evidence' }],
        _meta: {
          nanoflowFailureClass: 'base-codegraph-timeout-overlay-only',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'partial',
          nanoflowContextUsable: true,
        },
      },
      expected: expectedOutcome('partial', 'base-codegraph-timeout-overlay-only', 'unavailable', 'available', 2),
    },
    {
      label: 'metadata overlay timeout outcome without reversing components',
      contextResult: {
        isError: true,
        content: [{ type: 'text', text: '## Exploration: metadata base only\n\nmetadata-base-evidence' }],
        _meta: {
          nanoflowFailureClass: 'overlay-timeout',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'partial',
          nanoflowContextUsable: true,
        },
      },
      expected: expectedOutcome('partial', 'overlay-timeout', 'available', 'unavailable'),
    },
    {
      label: 'metadata context pack failure keeps both components unavailable',
      contextResult: {
        isError: true,
        content: [{ type: 'text', text: 'context pack combination failed' }],
        _meta: {
          nanoflowFailureClass: 'context-pack-error',
          nanoflowOutcomeSchemaVersion: 1,
          nanoflowOutcomeStatus: 'failed',
          nanoflowContextUsable: false,
        },
      },
      expected: expectedOutcome('failed', 'context-pack-error', 'unavailable', 'unavailable'),
    },
    {
      label: 'text-only exact marker fallback',
      contextResult: {
        isError: true,
        content: [{ type: 'text', text: 'overlay-stale-skip-refresh' }],
      },
      expected: expectedOutcome('failed', 'overlay-stale-skip-refresh', 'unavailable', 'stale'),
    },
  ])('uses $label before lower-precedence adapter context evidence', ({ contextResult, expected }) => {
    const projectRoot = makeConfigBackedAdapterProject();
    writeMalformedOverlayAdapterHarness(projectRoot, [{
      type: 'text',
      text: JSON.stringify({ query: 'precedence', count: 0, matches: [], nodes: [], edges: [] }),
    }], { contextResult });
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: 'fake-codegraph-target',
      query: 'adapter context outcome precedence',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--timeout-ms', '10000'],
    });

    expect(result.status, [result.stdout, result.stderr, result.error?.message ?? ''].join('\n')).toBe(0);
    const summary = JSON.parse(result.stdout) as AdapterSummary;
    expect(summary.ok).toBe(expected.status === 'complete');
    expect(summary.complete).toBe(expected.status === 'complete');
    expect(summary.partial).toBe(expected.partial);
    expect(summary.contextUsable).toBe(expected.usableContext);
    expect(summary.outcome).toEqual(expect.objectContaining({
      status: expected.status,
      usableContext: expected.usableContext,
      primaryFailureClass: expected.primaryFailureClass,
      base: expect.objectContaining({ status: expected.baseStatus }),
      overlay: expect.objectContaining({ status: expected.overlayStatus }),
    }));
    const expectedAttempts = 'expectedAttempts' in expected ? (expected.expectedAttempts ?? 1) : 1;
    expect(summary.diagnostics?.contextAttempts).toHaveLength(expectedAttempts);
    expect(summary.diagnostics?.contextAttempts?.[0]).toEqual(expect.objectContaining({
      isError: !expected.usableContext,
      failureClass: expected.status === 'complete' ? 'success' : expected.primaryFailureClass,
    }));
  }, 30_000);

  it.each([
    { label: 'direct', context: undefined, overlay: 'overlay-stale-skip-refresh', expectedOverlay: 'overlay-stale-skip-refresh', expectedOk: false },
    { label: 'context', context: 'overlay-stale-skip-refresh', overlay: undefined, expectedOverlay: 'success', expectedOk: false },
    { label: 'both', context: 'overlay-stale-skip-refresh', overlay: 'overlay-stale-skip-refresh', expectedOverlay: 'overlay-stale-skip-refresh', expectedOk: false },
    { label: 'unknown control', context: undefined, overlay: 'overlay-unknown-declared', expectedOverlay: 'overlay-mcp-error', expectedOk: true },
  ])('preserves declared $label MCP failure classes without false success', ({ context, overlay, expectedOverlay, expectedOk }) => {
    const projectRoot = makeConfigBackedAdapterProject();
    writeMalformedOverlayAdapterHarness(projectRoot, [{
      type: 'text',
      text: JSON.stringify({ query: 'declared failure', count: 0, matches: [], nodes: [], edges: [] }),
    }], { context, overlay });
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: 'fake-codegraph-target',
      query: 'declared overlay failure',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--max-files', '1', '--timeout-ms', '10000'],
    });

    expect(result.status, [result.stdout, result.stderr, result.error?.message ?? ''].join('\n')).toBe(0);
    const summary = JSON.parse(result.stdout) as AdapterSummary;
    expect(summary.ok).toBe(expectedOk);
    expect(summary.diagnostics?.contextAttempts?.[0]).toEqual(expect.objectContaining({
      mcpIsError: Boolean(context),
      failureClass: context ?? 'success',
    }));
    expect(summary.diagnostics?.overlayFailureClass).toBe(expectedOverlay);
    if (overlay) expect(summary.overlay?.failureClass).toBe(expectedOverlay);
    if (context) expect(summary.contextText).toBe(context);
  }, 30_000);

  it.each([
    {
      label: 'empty text',
      rawOutput: '',
      failureClass: 'overlay-empty-response',
    },
    {
      label: 'non-JSON text',
      rawOutput: 'adapter-real-wrapper-non-json-evidence',
      failureClass: 'overlay-json-parse-error',
    },
    {
      label: 'invalid JSON shape',
      rawOutput: JSON.stringify({ unexpectedShape: 'adapter-real-wrapper-invalid-shape' }),
      failureClass: 'overlay-invalid-json-shape',
    },
  ])('preserves the real wrapper malformed overlay $label failure class', ({ rawOutput, failureClass }) => {
    const projectRoot = makeConfigBackedAdapterProject();
    writeRawAdapterOverlayScript(projectRoot, repoRoot, rawOutput);
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: makeContextReturningFakeCodegraph(),
      query: 'real wrapper malformed overlay',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--max-files', '1', '--timeout-ms', '15000'],
    });

    expect(result.status, [result.stdout, result.stderr, result.error?.message ?? ''].join('\n')).toBe(0);
    const summary = JSON.parse(result.stdout) as AdapterSummary;
    expect(summary.ok).toBe(false);
    expect(summary.contextText).toContain('scripts/analyze-codegraph-mcp-log.cjs');
    expect(summary.overlay).toEqual(expect.objectContaining({
      unavailable: true,
      failureClass,
    }));
    expect(summary.diagnostics?.overlayFailureClass).toBe(failureClass);
  }, 45_000);

  it.runIf(process.platform === 'win32')('terminates the wrapper process tree after a context request timeout', () => {
    const projectRoot = makeStubbornProcessTreeAdapterProject();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-process-tree-state-'));
    trackTempRoot(stateRoot);
    const descendantPidPath = path.join(stateRoot, 'descendant.pid');
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: 'fake-codegraph-target',
      query: 'process tree timeout cleanup',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--timeout-ms', '1000'],
      env: { NANOFLOW_TEST_DESCENDANT_PID_FILE: descendantPidPath },
      timeout: 15_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Timed out waiting for nanoflow_context_pack');
    expect(fs.existsSync(descendantPidPath)).toBe(true);
    const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
    try {
      expect(waitForProcessExit(descendantPid, 2_000)).toBe(true);
    } finally {
      terminateWindowsProcessTree(descendantPid);
    }
  }, 20_000);

  it('fails required overlay quality checks when the provenance query returns no results', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-empty-overlay-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: fakeCodegraph,
      query: 'empty overlay quality gate',
      args: [
        '--overlay-query', 'empty-overlay-result', '--overlay-limit', '1', '--overlay-query-limit', '1',
        '--max-files', '1', '--timeout-ms', '15000', '--require-overlay-match',
      ],
      env: { NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Overlay query "empty-overlay-result" returned no usable results');
    expect(result.stderr).toContain('resultCount=0');
    expect(result.stderr).toContain(`logPath=${logPath}`);
  }, 60_000);

  it('does not spend a second base retry after tooling overlay-only timeout recovery', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeHangingExploreFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-overlay-only-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: fakeCodegraph,
      query: 'codegraph mcp wrapper timeout truncation source ordering log guard',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--timeout-ms', '8000'],
      env: { NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    });

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as AdapterSummary;

    expect(summary.ok).toBe(false);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.wrapperRequestTimeoutMs).toBeLessThan(8000);
    expect(summary.diagnostics?.contextAttempts).toEqual([
      expect.objectContaining({
        maxFiles: 8,
        maxFilesOmitted: true,
        partial: true,
        failureClass: 'base-codegraph-timeout-overlay-only',
      }),
    ]);
    const logText = fs.readFileSync(logPath, 'utf8');
    const contextRequestCount = (logText.match(/"event":"nanoflow\.context\.child\.request"/g) ?? []).length;
    expect(contextRequestCount).toBe(1);
  }, 60_000);

  it('keeps context output when the standalone overlay provenance query exceeds the output budget', () => {
    const projectRoot = makeTempAdapterProject();
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-overlay-max-buffer-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: fakeCodegraph,
      query: 'codegraph adapter gate log guard oversized overlay provenance',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--max-files', '1', '--timeout-ms', '15000'],
      env: { NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    });

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as AdapterSummary;

    expect(summary.ok).toBe(false);
    expect(summary.complete).toBe(false);
    expect(summary.partial).toBe(true);
    expect(summary.contextUsable).toBe(true);
    expect(summary.outcome).toEqual(expect.objectContaining({
      status: 'partial',
      usableContext: true,
      base: expect.objectContaining({ status: 'available' }),
      overlay: expect.objectContaining({ status: 'unavailable' }),
    }));
    expect(summary.contextText).toContain('scripts/analyze-codegraph-mcp-log.cjs');
    expect(summary.overlay).toEqual(expect.objectContaining({
      unavailable: true,
      failureClass: 'overlay-mcp-error',
    }));
    expect(summary.overlay?.message).toContain('exceeded 16777216 bytes');
    expect(summary.diagnostics).toEqual(expect.objectContaining({
      overlayUnavailable: true,
      overlayFailureClass: 'overlay-mcp-error',
      overlayTextBytes: 0,
    }));
  }, 60_000);

  it('retries base CodeGraph timeouts with a narrower maxFiles budget', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-retry-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: fakeCodegraph,
      query: 'WorkspaceShellBeforeUnloadController setup cleanup beforeUnloadGuard beforeUnloadManager isBrowser',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--max-files', '8', '--timeout-ms', '6000'],
      env: { NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    });

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as AdapterSummary;

    expect(summary.ok).toBe(true);
    expect(summary.maxFiles).toBe(8);
    expect(summary.contextText).toBe([
      '## Exploration: WorkspaceShellBeforeUnloadController setup cleanup beforeUnloadGuard beforeUnloadManager isBrowser',
      '',
      'No code context matched this query.',
    ].join('\n'));
    const attempts = summary.diagnostics?.contextAttempts ?? [];
    expect(attempts[0]).toEqual(expect.objectContaining({
      maxFiles: 8,
      partial: true,
    }));
    expect(['base-codegraph-timeout', 'base-codegraph-timeout-overlay-only'])
      .toContain(attempts[0]?.failureClass);
    expect(attempts.at(-1)).toEqual(expect.objectContaining({
      maxFiles: 1,
      isError: false,
    }));
    expect(['success', 'overlay-timeout']).toContain(attempts.at(-1)?.failureClass);
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"event":"nanoflow.context.timeout"');
    expect(logText).toContain('"maxFiles":8');
    expect(logText).toContain('"maxFiles":1');
  }, 60_000);
}
