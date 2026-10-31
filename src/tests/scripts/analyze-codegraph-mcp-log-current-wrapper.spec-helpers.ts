import { expect, it } from 'vitest';

import {
  childExitEvent,
  contextResponseEvent,
  expectCleanCurrentContextSourceOrdering,
  makeCodexMcpConfig,
  makeLog,
  makeScriptFile,
  makeSourceOrderingFixture,
  runAnalyzer,
  toolsListResponseEvent,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';

const ANALYZER_SPEC_TIMEOUT_MS = 30_000;

export function registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs(): void {
  it('does not fail on historical critical exits when the current wrapper is healthy', () => {
    const script = makeScriptFile('module.exports = { version: "fresh" };\n');
    const logPath = makeLog([
      wrapperStartEvent('old-run', script, {
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-09',
        scriptSha256: '1'.repeat(64),
      }),
      childExitEvent({
        runId: 'old-run',
        code: 1,
        activeRequestCount: 1,
        pendingContextPackCount: 0,
        activeRequests: [{ requestId: 'old-request' }],
      }),
      wrapperStartEvent('fresh-run', script, {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      contextResponseEvent('fresh-run', 'fresh-context', {
        ts: '2026-06-13T18:01:01.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(false);
    expect(summary.criticalTransportFailures).toBe(1);
    expect(summary.currentTransportHealthy).toBe(true);
    expect(summary.currentCriticalTransportFailures).toBe(0);
    expect(summary.latestCriticalTransportFailure).toEqual(expect.objectContaining({
      runId: 'old-run',
      event: 'child.exit',
    }));
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'fresh-run',
      matchesDisk: true,
      staleAgainstDisk: false,
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('reports current wrapper health as the effective transport status when historical critical exits remain in the log', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-effective-health" };\n');
    const logPath = makeLog([
      wrapperStartEvent('historical-crash-run', script, {
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-09',
        scriptSha256: '1'.repeat(64),
      }),
      childExitEvent({
        runId: 'historical-crash-run',
        code: 1,
        activeRequestCount: 1,
        pendingContextPackCount: 0,
        activeRequests: [{ requestId: 'historical-request' }],
      }),
      wrapperStartEvent('fresh-effective-run', script, {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      contextResponseEvent('fresh-effective-run', 'fresh-effective-context', {
        ts: '2026-06-13T18:01:01.000Z',
      }),
    ]);

    const jsonResult = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(jsonResult.stdout);

    expect(jsonResult.status).toBe(0);
    expect(summary.transportHealthy).toBe(false);
    expect(summary.criticalTransportFailures).toBe(1);
    expect(summary.currentTransportHealthy).toBe(true);
    expect(summary.currentCriticalTransportFailures).toBe(0);
    expect(summary.effectiveTransportHealthy).toBe(true);
    expect(summary.effectiveCriticalTransportFailures).toBe(0);
    expect(summary.transportHealthScope).toBe('current-wrapper');
    expect(summary.latestEffectiveCriticalTransportFailure).toBeNull();
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Historical critical transport failures remain in the log'),
      expect.stringContaining('effectiveTransportHealthy/currentTransportHealthy'),
    ]));
    expect(summary.recommendations).not.toEqual(expect.arrayContaining([
      'Inspect latestCriticalTransportFailure.requestId and active requests before changing overlay timeouts.',
    ]));

    const textResult = runAnalyzer(logPath, ['--fail-on-critical', '--text']);

    expect(textResult.status).toBe(0);
    expect(textResult.stdout).toContain('effectiveTransportHealthy=true transportHealthScope=current-wrapper effectiveCriticalTransportFailures=0');
    expect(textResult.stdout).toContain('transportHealthy=false criticalTransportFailures=1');
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('marks a successful direct MCP response untrusted when it came from a config-mismatched wrapper', () => {
    const script = makeScriptFile('module.exports = { version: "mismatched-direct-response" };\n');
    const configPath = makeCodexMcpConfig({
      root: 'D:/Code/dde',
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: {
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      },
    });
    const logPath = makeLog([
      wrapperStartEvent('old-host-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      contextResponseEvent('old-host-run', 'old-host-context', {
        ts: '2026-06-13T18:01:01.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, [], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(summary.directMcpResponseEvidence).toEqual(expect.objectContaining({
      status: 'response-untrusted',
      responseObserved: true,
      callable: true,
      trustedForAdapterJudgment: false,
      runId: 'old-host-run',
      requestId: 'old-host-context',
      responseTs: '2026-06-13T18:01:01.000Z',
      codegraphTarget: '@colbymchenry/codegraph@1.1.1',
      configuredCodegraphTarget: '@colbymchenry/codegraph@1.5.0',
      configuredContextResponseObserved: false,
      trustBlockers: expect.arrayContaining([
        'codegraph-target-mismatch',
        'wrapper-env-mismatch',
        'no-configured-context-response',
      ]),
    }));
    expect(summary.diagnosticTriage.primaryEvidence.directMcpResponseEvidence).toEqual(
      summary.directMcpResponseEvidence,
    );
    expect(summary.diagnosticTriage.misdiagnosisGuards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mistakenConclusion: 'direct-mcp-healthy',
        blockedBy: expect.stringContaining('successful direct MCP response came from an untrusted wrapper'),
      }),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('trusts a successful direct MCP response only when wrapper identity matches the current Codex config', () => {
    const script = makeScriptFile('module.exports = { version: "trusted-direct-response" };\n');
    const configuredEnv = {
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
    };
    const configPath = makeCodexMcpConfig({
      root: 'D:/Code/dde',
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: configuredEnv,
    });
    const logPath = makeLog([
      wrapperStartEvent('current-host-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.5.0',
        env: configuredEnv,
      }),
      contextResponseEvent('current-host-run', 'current-host-context', {
        ts: '2026-06-13T18:01:01.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, [], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(summary.directMcpResponseEvidence).toEqual(expect.objectContaining({
      status: 'response-trusted',
      responseObserved: true,
      callable: true,
      trustedForAdapterJudgment: true,
      runId: 'current-host-run',
      requestId: 'current-host-context',
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      configuredCodegraphTarget: '@colbymchenry/codegraph@1.5.0',
      configuredContextResponseObserved: true,
      trustBlockers: [],
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('does not treat a successful adapter fallback probe as proof that the direct MCP host is healthy', () => {
    const script = makeScriptFile('module.exports = { version: "trusted-fallback-probe" };\n');
    const configuredEnv = {
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
    };
    const configPath = makeCodexMcpConfig({
      root: 'D:/Code/dde',
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: configuredEnv,
    });
    const logPath = makeLog([
      wrapperStartEvent('fallback-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@next',
        env: configuredEnv,
        codexConfigAlignment: {
          status: 'override',
          reason: 'adapter-fallback-target-override',
          alignmentMode: 'adapter-fallback',
          mismatches: [{
            field: 'codegraphTarget',
            expected: '@colbymchenry/codegraph@1.5.0',
            actual: '@colbymchenry/codegraph@next',
          }],
          mismatchCount: 1,
        },
      }),
      contextResponseEvent('fallback-run', 'fallback-context', {
        ts: '2026-06-13T18:01:01.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, [], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(summary.directMcpResponseEvidence).toEqual(expect.objectContaining({
      status: 'response-trusted-adapter-probe-only',
      provenance: 'adapter-fallback-or-smoke',
      callable: true,
      trustedForAdapterJudgment: true,
      trustedForDirectHostHealth: false,
      adapterTrustBlockers: [],
      directHostTrustBlockers: expect.arrayContaining([
        'intentional-config-alignment-override',
        'no-configured-context-response',
      ]),
    }));
    expect(summary.diagnosticTriage).toEqual(expect.objectContaining({
      status: 'direct-mcp-response-provenance-untrusted',
      failureBoundary: 'codex-mcp-host-evidence',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-configured-response-is-observed',
    }));
    expect(summary.diagnosticTriage.misdiagnosisGuards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mistakenConclusion: 'direct-mcp-healthy',
        blockedBy: expect.stringContaining('successful direct MCP response came from an untrusted wrapper'),
      }),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('does not treat older runs with the same script hash as the current wrapper run', () => {
    const script = makeScriptFile('module.exports = { version: "same-hash" };\n');
    const logPath = makeLog([
      wrapperStartEvent('old-same-hash-run', script),
      childExitEvent({
        runId: 'old-same-hash-run',
        code: 3221225794,
        activeRequestCount: 1,
        pendingContextPackCount: 0,
      }),
      wrapperStartEvent('latest-run', script, {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      contextResponseEvent('latest-run', 'latest-clean', {
        ts: '2026-06-13T18:01:01.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(false);
    expect(summary.criticalTransportFailures).toBe(1);
    expect(summary.currentWrapper.runId).toBe('latest-run');
    expect(summary.currentTransportHealthy).toBe(true);
    expect(summary.currentCriticalTransportFailures).toBe(0);
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      topRankedNotFirst: 0,
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('selects the current wrapper from the latest run activity, not only the last wrapper start', () => {
    const activeScript = makeScriptFile('module.exports = { version: "active" };\n');
    const idleScript = makeScriptFile('module.exports = { version: "idle" };\n');
    const logPath = makeLog([
      wrapperStartEvent('active-run', activeScript),
      wrapperStartEvent('idle-run', idleScript, {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      contextResponseEvent('active-run', 'active-context', {
        ts: '2026-06-13T18:02:00.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'active-run',
      scriptSha256: activeScript.sha256,
      matchesDisk: true,
    }));
    expectCleanCurrentContextSourceOrdering(summary, { duplicateSourceSections: 0, topRankedMissing: 0 });
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('keeps current context-pack source-ordering diagnostics when the latest active run only lists tools', () => {
    const contextScript = makeScriptFile('module.exports = { version: "context" };\n');
    const toolsScript = makeScriptFile('module.exports = { version: "tools" };\n');
    const logPath = makeLog([
      wrapperStartEvent('context-run', contextScript),
      contextResponseEvent('context-run', 'context-response'),
      wrapperStartEvent('tools-run', toolsScript, {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      toolsListResponseEvent('tools-run'),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'tools-run',
      scriptSha256: toolsScript.sha256,
    }));
    expect(summary.currentContextWrapper).toEqual(expect.objectContaining({
      runId: 'context-run',
      scriptSha256: contextScript.sha256,
      matchesDisk: true,
    }));
    expect(summary.currentDiskContextWrapper).toEqual(expect.objectContaining({
      runId: 'context-run',
      scriptSha256: contextScript.sha256,
      matchesDisk: true,
    }));
    expectCleanCurrentContextSourceOrdering(summary);
    expect(summary.currentDiskContextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      withDiagnostics: 1,
      lowValueSourcePollution: 0,
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('does not treat stale context-pack evidence as current after a fresh wrapper lists tools', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-after-stale-context" };\n');
    const staleHash = '9'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('stale-context-run', script, {
        scriptSha256: staleHash,
      }),
      contextResponseEvent('stale-context-run', 'stale-context', {
        ts: '2026-06-13T18:01:00.000Z',
        sourceOrdering: makeSourceOrderingFixture({
          firstSourceFiles: ['src/noisy.ts', 'src/app/core/services/real.service.ts'],
          rankedOverlayFiles: ['src/app/core/services/real.service.ts'],
          topRankedOverlayFile: 'src/app/core/services/real.service.ts',
          topRankedOverlayFileVisibleIndex: 1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
      wrapperStartEvent('fresh-tools-run', script, {
        ts: '2026-06-13T18:02:00.000Z',
      }),
      toolsListResponseEvent('fresh-tools-run', {
        ts: '2026-06-13T18:02:01.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, [
      '--fail-on-stale-current-wrapper',
      '--fail-on-current-source-ordering',
    ]);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'fresh-tools-run',
      matchesDisk: true,
    }));
    expect(summary.currentContextWrapper).toEqual(expect.objectContaining({
      runId: 'stale-context-run',
      rawMatchesDisk: false,
      matchesDisk: null,
      staleAgainstDisk: false,
      supersededByFreshWrapper: true,
    }));
    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      topRankedNotFirst: 1,
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('context-pack response is older than a fresh wrapper start'),
      expect.stringContaining('Historical context-pack source ordering issues remain'),
    ]));
    expect(summary.recommendations).not.toEqual(expect.arrayContaining([
      expect.stringContaining('current context-pack wrapper script hash does not match'),
      expect.stringContaining('current context-pack wrapper script hash could not be compared'),
      expect.stringContaining('current wrapper still has context-pack source ordering issues'),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('keeps stale context-pack evidence current when it responds after a fresh wrapper start', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-before-stale-context-response" };\n');
    const staleHash = '7'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('stale-context-run', script, {
        scriptSha256: staleHash,
      }),
      wrapperStartEvent('fresh-tools-run', script, {
        ts: '2026-06-13T18:02:00.000Z',
      }),
      toolsListResponseEvent('fresh-tools-run', {
        ts: '2026-06-13T18:02:01.000Z',
      }),
      contextResponseEvent('stale-context-run', 'stale-context-after-fresh-start', {
        ts: '2026-06-13T18:03:00.000Z',
        sourceOrdering: makeSourceOrderingFixture({
          firstSourceFiles: ['src/noisy.ts', 'src/app/core/services/real.service.ts'],
          rankedOverlayFiles: ['src/app/core/services/real.service.ts'],
          topRankedOverlayFile: 'src/app/core/services/real.service.ts',
          topRankedOverlayFileVisibleIndex: 1,
          firstSourceBlockIsTopRankedOverlayFile: false,
        }),
      }),
    ]);

    const result = runAnalyzer(logPath, [
      '--fail-on-stale-current-wrapper',
      '--fail-on-current-source-ordering',
    ]);
    const summary = JSON.parse(result.stdout);

    expect(result.status, result.stderr).toBe(1);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'stale-context-run',
      matchesDisk: false,
      staleAgainstDisk: true,
    }));
    expect(summary.currentContextWrapper).toEqual(expect.objectContaining({
      runId: 'stale-context-run',
      matchesDisk: false,
      staleAgainstDisk: true,
      supersededByFreshWrapper: false,
      latestTs: '2026-06-13T18:03:00.000Z',
      latestRequestId: 'stale-context-after-fresh-start',
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('current context-pack wrapper script hash does not match'),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);

	  it('keeps current disk context diagnostics when a fresh wrapper exits after serving context', () => {
	    const script = makeScriptFile('module.exports = { version: "fresh-exit-after-context" };\n');
	    const logPath = makeLog([
      wrapperStartEvent('fresh-run', script),
      contextResponseEvent('fresh-run', 'fresh-context', {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      {
        ts: '2026-06-13T18:02:00.000Z',
        runId: 'fresh-run',
        event: 'wrapper.exit',
        failureClass: 'host-stdin-closed',
        expectedExit: true,
        transportClosedBy: 'client-stdin',
        activeRequestsAtShutdown: 0,
      },
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentDiskContextWrapper).toEqual(expect.objectContaining({
      runId: 'fresh-run',
      latestEvent: 'nanoflow.context.response',
      matchesDisk: true,
    }));
    expect(summary.currentDiskContextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      withDiagnostics: 1,
      missingDiagnostics: 0,
	    }));
	  }, ANALYZER_SPEC_TIMEOUT_MS);

	  it('keeps current disk context source-ordering diagnostics when a later stale wrapper serves context', () => {
	    const script = makeScriptFile('module.exports = { version: "fresh-context-before-stale" };\n');
	    const staleHash = '0'.repeat(64);
	    const logPath = makeLog([
	      wrapperStartEvent('fresh-run', script),
	      contextResponseEvent('fresh-run', 'fresh-bad-context', {
	        sourceOrdering: makeSourceOrderingFixture({
	          firstSourceFiles: ['src/noisy.ts', 'src/app/core/services/real.service.ts'],
	          rankedOverlayFiles: ['src/app/core/services/real.service.ts'],
	          topRankedOverlayFile: 'src/app/core/services/real.service.ts',
	          topRankedOverlayFileVisibleIndex: 1,
	          firstSourceBlockIsTopRankedOverlayFile: false,
	        }),
	      }),
	      wrapperStartEvent('stale-run', script.path, {
	        ts: '2026-06-13T18:01:00.000Z',
	        scriptSha256: staleHash,
	      }),
	      contextResponseEvent('stale-run', 'stale-context', {
	        ts: '2026-06-13T18:01:01.000Z',
	      }),
	    ]);

	    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
	    const summary = JSON.parse(result.stdout);

	    expect(result.status, result.stderr).toBe(1);
	    expect(summary.currentContextWrapper).toEqual(expect.objectContaining({
	      runId: 'stale-run',
	      matchesDisk: false,
	    }));
	    expect(summary.currentDiskContextWrapper).toEqual(expect.objectContaining({
	      runId: 'fresh-run',
	      latestEvent: 'nanoflow.context.response',
	      matchesDisk: true,
	    }));
	    expect(summary.currentDiskContextSourceOrdering).toEqual(expect.objectContaining({
	      total: 1,
	      withDiagnostics: 1,
	      topRankedNotFirst: 1,
	      lowValueSourcePollution: 0,
	    }));
	  }, ANALYZER_SPEC_TIMEOUT_MS);

	  it('fails current source-ordering guard when diagnostics are present but incomplete', () => {
	    const script = makeScriptFile('module.exports = { version: "partial-source-ordering" };\n');
	    const logPath = makeLog([
	      wrapperStartEvent('partial-run', script),
	      contextResponseEvent('partial-run', 'partial-context', {
	        sourceOrdering: {
	          sourceSectionCount: 1,
	          duplicateSourceSectionCount: 0,
	        },
	      }),
	    ]);

	    const result = runAnalyzer(logPath, ['--fail-on-current-source-ordering']);
	    const summary = JSON.parse(result.stdout);

	    expect(result.status, result.stderr).toBe(1);
	    expect(summary.currentContextSourceOrdering).toEqual(expect.objectContaining({
	      total: 1,
	      withDiagnostics: 0,
	      missingDiagnostics: 1,
	      latestMissingDiagnostics: expect.objectContaining({
	        requestId: 'partial-context',
        missingSourceOrderingFields: expect.arrayContaining([
          'sourceRankingQuery',
          'sourceVisibilityQuery',
          'firstSourceFiles',
          'rankedOverlayFileDetails',
          'topRankedOverlayFileVisibleIndex',
	          'firstSourceBlockIsTopRankedOverlayFile',
	        ]),
	      }),
	    }));
	  }, ANALYZER_SPEC_TIMEOUT_MS);
}
