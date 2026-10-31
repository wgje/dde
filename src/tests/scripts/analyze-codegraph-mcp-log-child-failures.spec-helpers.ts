import { expect, it } from 'vitest';

import {
  expectChildSpawnErrorSummary,
  makeLog,
  makeScriptFile,
  runAnalyzer,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';

export function registerAnalyzeCodegraphMcpLogChildFailureSpecs(): void {
  it('summarizes child spawn startup failures separately from request-time transport exits', () => {
    const script = makeScriptFile('module.exports = { version: "spawn-error" };\n');
    const logPath = makeLog([
      {
        ts: '2026-06-12T08:24:03.596Z',
        runId: 'spawn-error-run',
        event: 'wrapper.start',
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-14',
        scriptPath: script.path,
        scriptSha256: script.sha256,
      },
      {
        ts: '2026-06-12T08:24:04.596Z',
        runId: 'spawn-error-run',
        event: 'child.spawn.error',
        message: 'spawn codegraph ENOENT',
        code: 'ENOENT',
        target: 'D:/Code/tools/codegraph/missing.js',
        resolvedTarget: 'D:/Code/tools/codegraph/missing.js',
        exists: false,
        investigation: {
          failureBoundary: 'base-codegraph-child',
          failureClass: 'child-spawn-missing-target',
          transportShouldStayAlive: false,
        },
        runtime: {
          activeRequestCount: 0,
          pendingContextPackCount: 0,
          pendingToolsListCount: 0,
        },
      },
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(true);
    expectChildSpawnErrorSummary(summary, { scriptSha256: script.sha256 });
  }, 15_000);

  it('summarizes wrapper runtime diagnostics for fatal MCP client protocol errors', () => {
    const script = makeScriptFile('module.exports = { version: "runtime-diagnostic" };\n');
    const logPath = makeLog([
      wrapperStartEvent('runtime-diagnostic-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      }),
      {
        ts: '2026-06-12T08:24:04.596Z',
        runId: 'runtime-diagnostic-run',
        event: 'wrapper.runtime.diagnostic',
        kind: 'clientInvalidHeader',
        failureClass: 'client-invalid-header',
        fatal: true,
        expectedExit: false,
        transportClosedBy: 'client-invalid-header',
        activeRequestsAtShutdown: 0,
        investigation: {
          failureBoundary: 'mcp-client-input',
          failureClass: 'client-invalid-header',
          transportShouldStayAlive: false,
          nextEvidence: [
            'client.header.invalid',
            'wrapper.exit',
            'rootCauseSnapshot.recentClientRequests',
          ],
        },
        runtime: {
          activeRequestCount: 0,
          pendingContextPackCount: 0,
          pendingToolsListCount: 0,
        },
        rootCauseSnapshot: {
          runtime: {
            activeRequestCount: 0,
            pendingContextPackCount: 0,
            pendingToolsListCount: 0,
          },
          recentClientRequests: [],
          recentChildStderr: [],
          recentChildStdout: [],
        },
      },
      {
        ts: '2026-06-12T08:24:04.597Z',
        runId: 'runtime-diagnostic-run',
        event: 'wrapper.exit',
        code: 1,
        reason: 'client-invalid-header',
        failureClass: 'client-invalid-header',
        expectedExit: false,
        transportClosedBy: 'client-invalid-header',
        activeRequestsAtShutdown: 0,
        runtime: {
          activeRequestCount: 0,
          pendingContextPackCount: 0,
          pendingToolsListCount: 0,
        },
      },
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(false);
    expect(summary.criticalTransportFailures).toBe(2);
    expect(summary.wrapperRuntimeDiagnostics).toEqual(expect.objectContaining({
      count: 1,
      fatal: 1,
      byKind: { clientInvalidHeader: 1 },
      byClass: { 'client-invalid-header': 1 },
      latest: expect.objectContaining({
        event: 'wrapper.runtime.diagnostic',
        kind: 'clientInvalidHeader',
        failureClass: 'client-invalid-header',
        transportClosedBy: 'client-invalid-header',
        wrapperStart: expect.objectContaining({
          runId: 'runtime-diagnostic-run',
          scriptSha256: script.sha256,
        }),
      }),
    }));
    expect(summary.wrapperExit).toEqual(expect.objectContaining({
      total: 1,
      critical: 1,
      latest: expect.objectContaining({
        event: 'wrapper.exit',
        reason: 'client-invalid-header',
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Wrapper runtime diagnostics recorded fatal errors'),
    ]));
  }, 15_000);

  it('summarizes base CodeGraph crash-loop backoff and fail-fast unavailable responses', () => {
    const script = makeScriptFile('module.exports = { version: "restart-backoff" };\n');
    const logPath = makeLog([
      {
        ts: '2026-06-13T18:00:00.000Z',
        runId: 'restart-backoff-run',
        event: 'wrapper.start',
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-15',
        scriptPath: script.path,
        scriptSha256: script.sha256,
      },
      {
        ts: '2026-06-13T18:00:01.000Z',
        runId: 'restart-backoff-run',
        event: 'child.restart.delayed',
        code: 3221225794,
        signal: null,
        reason: 'unexpected-exit',
        previousPid: 1234,
        delayMs: 1000,
        rapidExitCount: 5,
        restartWindowMs: 10_000,
        investigation: {
          failureBoundary: 'base-codegraph-child',
          failureClass: 'base-codegraph-crash-loop',
          transportShouldStayAlive: true,
        },
      },
      {
        ts: '2026-06-13T18:00:02.000Z',
        runId: 'restart-backoff-run',
        event: 'base-codegraph.unavailable',
        requestId: 'restart-backoff-run:request-7',
        requestKind: 'nanoflow-context-pack',
        tool: 'nanoflow_context_pack',
        query: 'crash-loop-context-pack',
        source: 'nanoflow-context-pack',
        failureClass: 'base-codegraph-unavailable',
        childRestartBackoffPending: true,
      },
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(true);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'restart-backoff-run',
      matchesDisk: true,
    }));
    expect(summary.childRestartBackoff).toEqual(expect.objectContaining({
      count: 1,
      byCode: { 3221225794: 1 },
      byExitClass: { 'windows-native-crash': 1 },
      byExitName: { STATUS_DLL_INIT_FAILED: 1 },
      maxDelayMs: 1000,
      latest: expect.objectContaining({
        event: 'child.restart.delayed',
        childExitCodeHex: '0xc0000142',
        childExitClass: 'windows-native-crash',
        childExitName: 'STATUS_DLL_INIT_FAILED',
        delayMs: 1000,
        rapidExitCount: 5,
        investigation: expect.objectContaining({
          failureClass: 'base-codegraph-crash-loop',
        }),
      }),
    }));
    expect(summary.currentChildRestartBackoff).toEqual(expect.objectContaining({
      count: 1,
      byCode: { 3221225794: 1 },
      byExitClass: { 'windows-native-crash': 1 },
      byExitName: { STATUS_DLL_INIT_FAILED: 1 },
      maxDelayMs: 1000,
    }));
    expect(summary.baseCodegraphUnavailable).toEqual(expect.objectContaining({
      count: 1,
      byRequestKind: { 'nanoflow-context-pack': 1 },
      latest: expect.objectContaining({
        event: 'base-codegraph.unavailable',
        failureClass: 'base-codegraph-unavailable',
        childRestartBackoffPending: true,
      }),
    }));
    expect(summary.currentBaseCodegraphUnavailable).toEqual(expect.objectContaining({
      count: 1,
      byRequestKind: { 'nanoflow-context-pack': 1 },
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('current wrapper is backing off base CodeGraph child restarts'),
      expect.stringContaining('base-codegraph-unavailable responses'),
    ]));
  }, 15_000);
}
