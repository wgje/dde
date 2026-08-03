import { expect, it } from 'vitest';

import {
  childExitEvent,
  contextResponseEvent,
  makeLog,
  makeScriptFile,
  runAnalyzer,
  toolsListResponseEvent,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';

const ANALYZER_SPEC_TIMEOUT_MS = 30_000;

export function registerAnalyzeCodegraphMcpLogDirectMcpSpecs(): void {
  it.each([
    {
      label: 'partial',
      outcomeStatus: 'partial',
      contextUsable: true,
      failureClass: 'overlay-stale-skip-refresh',
      expectedFailureClass: 'direct-mcp-context-partial',
    },
    {
      label: 'failed',
      outcomeStatus: 'failed',
      contextUsable: false,
      failureClass: 'context-pack-error',
      expectedFailureClass: 'direct-mcp-context-failed',
    },
  ])('reports direct MCP context $label independently from transport and config', ({
    outcomeStatus,
    contextUsable,
    failureClass,
    expectedFailureClass,
  }) => {
    const script = makeScriptFile(`module.exports = { version: "context-${outcomeStatus}" };\n`);
    const logPath = makeLog([
      wrapperStartEvent(`context-${outcomeStatus}-run`, script),
      contextResponseEvent(`context-${outcomeStatus}-run`, `context-${outcomeStatus}-request`, {
        failureClass,
        outcomeStatus,
        contextUsable,
        outcome: {
          schemaVersion: 1,
          status: outcomeStatus,
          usableContext: contextUsable,
        },
      }),
    ]);

    const result = runAnalyzer(logPath);
    const evidence = JSON.parse(result.stdout).directMcpResponseEvidence;

    expect(result.status).toBe(0);
    expect(evidence).toEqual(expect.objectContaining({
      responseObserved: true,
      contextOutcomeStatus: outcomeStatus,
      contextUsable,
      contextOutcomeFailureClass: expectedFailureClass,
      adapterTrustBlockers: expect.arrayContaining([expectedFailureClass]),
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it.each([
    {
      label: 'future schema',
      schemaVersion: 2,
      outcomeStatus: 'complete',
      contextUsable: true,
    },
    {
      label: 'unknown status',
      schemaVersion: 1,
      outcomeStatus: 'degraded',
      contextUsable: true,
    },
    {
      label: 'status and usability mismatch',
      schemaVersion: 1,
      outcomeStatus: 'complete',
      contextUsable: false,
    },
  ])('fails closed for direct MCP context outcome evidence with $label', ({
    label,
    schemaVersion,
    outcomeStatus,
    contextUsable,
  }) => {
    const runId = `invalid-context-outcome-${label.replaceAll(' ', '-')}`;
    const script = makeScriptFile(`module.exports = { version: ${JSON.stringify(runId)} };\n`);
    const logPath = makeLog([
      wrapperStartEvent(runId, script),
      contextResponseEvent(runId, `${runId}-request`, {
        failureClass: 'success',
        outcomeSchemaVersion: schemaVersion,
        outcomeStatus,
        contextUsable,
        outcome: {
          schemaVersion,
          status: outcomeStatus,
          usableContext: contextUsable,
        },
      }),
    ]);

    const result = runAnalyzer(logPath);
    const evidence = JSON.parse(result.stdout).directMcpResponseEvidence;

    expect(result.status).toBe(0);
    expect(evidence).toEqual(expect.objectContaining({
      responseObserved: true,
      callable: false,
      trustedForAdapterJudgment: false,
      trustedForDirectHostHealth: false,
      contextOutcomeSchemaVersion: schemaVersion,
      contextOutcomeStatus: outcomeStatus,
      contextUsable,
      contextOutcomeFailureClass: 'direct-mcp-context-outcome-invalid',
      adapterTrustBlockers: expect.arrayContaining(['direct-mcp-context-outcome-invalid']),
      directHostTrustBlockers: expect.arrayContaining(['direct-mcp-context-outcome-invalid']),
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it.each([
    {
      label: 'an empty outcome object',
      outcomeEvidence: { outcome: {} },
    },
    {
      label: 'a null outcome',
      outcomeEvidence: { outcome: null },
    },
    {
      label: 'explicit null outcome fields',
      outcomeEvidence: {
        outcomeSchemaVersion: null,
        outcomeStatus: null,
        contextUsable: null,
      },
    },
  ])('fails closed when direct MCP context logs contain $label', ({ label, outcomeEvidence }) => {
    const runId = `present-invalid-context-outcome-${label.replaceAll(' ', '-')}`;
    const script = makeScriptFile(`module.exports = { version: ${JSON.stringify(runId)} };\n`);
    const logPath = makeLog([
      wrapperStartEvent(runId, script),
      contextResponseEvent(runId, `${runId}-request`, {
        failureClass: 'success',
        ...outcomeEvidence,
      }),
    ]);

    const result = runAnalyzer(logPath);
    const evidence = JSON.parse(result.stdout).directMcpResponseEvidence;

    expect(result.status).toBe(0);
    expect(evidence).toEqual(expect.objectContaining({
      responseObserved: true,
      callable: false,
      trustedForAdapterJudgment: false,
      trustedForDirectHostHealth: false,
      contextOutcomeSchemaVersion: null,
      contextOutcomeStatus: null,
      contextUsable: null,
      contextOutcomeFailureClass: 'direct-mcp-context-outcome-invalid',
      adapterTrustBlockers: expect.arrayContaining(['direct-mcp-context-outcome-invalid']),
      directHostTrustBlockers: expect.arrayContaining(['direct-mcp-context-outcome-invalid']),
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('uses observed direct MCP transport errors as host-boundary evidence when wrapper logs are stale', () => {
    const script = makeScriptFile('module.exports = { version: "observed-direct-mcp-error" };\n');
    const logPath = makeLog([
      wrapperStartEvent('old-direct-mcp-run', script, {
        ts: '2026-06-13T18:00:00.000Z',
      }),
      toolsListResponseEvent('old-direct-mcp-run', {
        ts: '2026-06-13T18:01:00.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, [
      '--direct-mcp-error=Transport closed',
      '--observed-at=2026-06-13T19:00:00.000Z',
      '--fail-on-untrusted-direct-mcp',
    ]);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.observedDirectMcpError).toBe('Transport closed');
    expect(summary.observedDirectMcpFailureClass).toBe('observed-direct-mcp-transport-closed');
    expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-transport-closed',
      failureBoundary: 'codex-mcp-host-transport',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts',
      failureClasses: expect.arrayContaining([
        'observed-direct-mcp-transport-closed',
        'mcp-host-wrapper-not-started',
      ]),
    }));
    expect(summary.diagnosticTriage.primaryEvidence).toEqual(expect.objectContaining({
      directMcpError: 'Transport closed',
      observedDirectMcpFailureClass: 'observed-direct-mcp-transport-closed',
      hasCurrentWrapperEvidence: false,
    }));
    expect(summary.diagnosticTriage.doNotMisdiagnoseAs).toEqual(expect.arrayContaining([
      'adapter-source-regression',
      'direct-mcp-healthy',
      'wrapper-transport-crash',
    ]));
    expect(summary.diagnosticTriage.misdiagnosisGuards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mistakenConclusion: 'adapter-source-regression',
        requiredEvidenceBeforeConclusion: 'npm run codegraph:adapter:context -- --query "<query>" --json',
      }),
      expect.objectContaining({
        mistakenConclusion: 'wrapper-transport-crash',
        blockedBy: expect.stringContaining('direct MCP reported observed-direct-mcp-transport-closed'),
      }),
    ]));
    expect(summary.diagnosticTriage.evidenceGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        missingEvidence: 'current-wrapper-log-evidence',
        blocksConclusions: expect.arrayContaining([
          'adapter-source-regression',
          'wrapper-transport-crash',
        ]),
      }),
      expect.objectContaining({
        missingEvidence: 'fresh-adapter-fallback-result',
        requiredCommand: 'npm run codegraph:adapter:context -- --query "<query>" --json',
        blocksConclusions: expect.arrayContaining([
          'adapter-source-regression',
          'wrapper-transport-crash',
        ]),
      }),
      expect.objectContaining({
        missingEvidence: 'adapter-doctor-config-snapshot',
        requiredCommand: 'npm run codegraph:adapter:doctor -- --explain',
      }),
    ]));
    expect(summary.diagnosticTriage.requiredEvidenceBeforeConclusion).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conclusion: 'adapter-source-regression',
        requiredEvidence: expect.arrayContaining([
          'fresh adapter fallback reproduces the same failure',
          'adapter doctor confirms the current Codex MCP config and wrapper target/env',
        ]),
      }),
      expect.objectContaining({
        conclusion: 'wrapper-transport-crash',
        requiredEvidence: expect.arrayContaining([
          'latestEffectiveCriticalTransportFailure or currentCriticalTransportFailures > 0',
        ]),
      }),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('does not let observed direct MCP errors hide current wrapper transport failures', () => {
    const script = makeScriptFile('module.exports = { version: "current-wrapper-crash-still-wins" };\n');
    const logPath = makeLog([
      wrapperStartEvent('current-crash-run', script, {
        ts: '2026-06-13T18:00:00.000Z',
      }),
      childExitEvent({
        ts: '2026-06-13T18:01:00.000Z',
        runId: 'current-crash-run',
        code: 1,
        activeRequestCount: 1,
        pendingContextPackCount: 1,
        activeRequests: [{ requestId: 'active-direct-mcp-request' }],
      }),
    ]);

    const result = runAnalyzer(logPath, [
      '--direct-mcp-error=Transport closed',
      '--observed-at=2026-06-13T18:02:00.000Z',
      '--fail-on-critical',
    ]);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'current-wrapper-transport-failure',
      failureBoundary: 'mcp-wrapper-transport',
      adapterFailureLikely: true,
      directMcpTrust: 'do-not-trust-direct-mcp-until-current-transport-failure-is-fixed',
      failureClasses: expect.arrayContaining([
        'current-critical-transport-failure',
        'observed-direct-mcp-transport-closed',
      ]),
    }));
    expect(summary.diagnosticTriage.primaryEvidence).toEqual(expect.objectContaining({
      directMcpError: 'Transport closed',
      latestEffectiveCriticalTransportFailure: expect.objectContaining({
        event: 'child.exit',
      }),
    }));
    expect(summary.diagnosticTriage.doNotMisdiagnoseAs).not.toEqual(expect.arrayContaining([
      'wrapper-transport-crash',
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('does not let an expired wrapper crash override host-side Transport closed with no current wrapper', () => {
    const script = makeScriptFile('module.exports = { version: "expired-wrapper-crash" };\n');
    const logPath = makeLog([
      wrapperStartEvent('expired-crash-run', script, {
        ts: '2026-06-13T18:00:00.000Z',
      }),
      childExitEvent({
        ts: '2026-06-13T18:01:00.000Z',
        runId: 'expired-crash-run',
        code: 1,
        activeRequestCount: 1,
        pendingContextPackCount: 1,
        activeRequests: [{ requestId: 'expired-request' }],
      }),
    ]);

    const result = runAnalyzer(logPath, [
      '--direct-mcp-error=Transport closed',
      '--observed-at=2026-06-13T19:00:00.000Z',
      '--fail-on-untrusted-direct-mcp',
    ]);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.criticalTransportFailures).toBe(1);
    expect(summary.currentWrapper).toBeNull();
    expect(summary.logFreshness).toEqual(expect.objectContaining({
      hasCurrentWrapperEvidence: false,
      staleAgainstObservedAt: true,
    }));
    expect(summary.effectiveTransportHealthy).toBe(true);
    expect(summary.effectiveCriticalTransportFailures).toBe(0);
    expect(summary.latestEffectiveCriticalTransportFailure).toBeNull();
    expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-transport-closed',
      failureBoundary: 'codex-mcp-host-transport',
      adapterFailureLikely: false,
      failureClasses: expect.arrayContaining([
        'observed-direct-mcp-transport-closed',
        'mcp-host-wrapper-not-started',
      ]),
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('summarizes default stale wrapper keepalive without treating it as transport failure', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-stale-keepalive" };\n');
    const staleHash = '8'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('stale-keepalive-run', script, {
        scriptSha256: staleHash,
      }),
      {
        ts: '2026-06-13T18:00:01.000Z',
        runId: 'stale-keepalive-run',
        event: 'wrapper.script.stale',
        startupScriptSha256: staleHash,
        diskScriptSha256: script.sha256,
        staleAgainstDisk: true,
      },
      {
        ts: '2026-06-13T18:00:02.000Z',
        runId: 'stale-keepalive-run',
        event: 'wrapper.script.stale.continue',
        failureClass: 'stale-wrapper-script',
        tool: 'nanoflow_context_pack',
        requestKind: 'nanoflow-context-pack',
      },
      {
        ts: '2026-06-13T18:00:03.000Z',
        runId: 'stale-keepalive-run',
        event: 'wrapper.script.stale.recycle.skipped',
        failureClass: 'stale-wrapper-script',
        expectedExit: false,
        autoRecycle: false,
        investigation: {
          transportShouldStayAlive: true,
        },
      },
      contextResponseEvent('stale-keepalive-run', 'context-after-stale', {
        ts: '2026-06-13T18:00:04.000Z',
      }),
      toolsListResponseEvent('stale-keepalive-run', {
        ts: '2026-06-13T18:00:05.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(true);
    expect(summary.currentTransportHealthy).toBe(true);
    expect(summary.criticalTransportFailures).toBe(0);
    expect(summary.staleWrapper).toEqual(expect.objectContaining({
      detected: 1,
      continued: 1,
      recycleSkipped: 1,
      recycleRequested: 0,
      shutdown: 0,
    }));
    expect(summary.currentStaleWrapper).toEqual(expect.objectContaining({
      recycleSkipped: 1,
      recycleRequested: 0,
      shutdown: 0,
      latest: expect.objectContaining({
        event: 'wrapper.script.stale.recycle.skipped',
        expectedExit: false,
        autoRecycle: false,
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('skipped automatic recycle'),
      expect.stringContaining('restart the MCP host/session'),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);
}
