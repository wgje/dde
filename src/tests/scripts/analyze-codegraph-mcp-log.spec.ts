import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  childExitEvent,
  cleanupAnalyzerTempRoots,
  contextResponseEvent,
  expectCleanCurrentContextSourceOrdering,
  expectCurrentContextSourceOrderingIssue,
  makeCodexMcpConfig,
  makeLog,
  makeRawLog,
  makeScriptFile,
  makeSourceOrderingFixture,
  runAnalyzer,
  toolsListResponseEvent,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogActiveWrapperSpecs,
} from './analyze-codegraph-mcp-log-active-wrapper.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogActiveHashSpecs,
} from './analyze-codegraph-mcp-log-active-hash.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogSourceOrderingSpecs,
} from './analyze-codegraph-mcp-log-source-ordering.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogChildFailureSpecs,
} from './analyze-codegraph-mcp-log-child-failures.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogOverlayDiagnosticSpecs,
} from './analyze-codegraph-mcp-log-overlay-diagnostics.spec-helpers';

const ANALYZER_SPEC_TIMEOUT_MS = 30_000;

describe('analyze-codegraph-mcp-log', () => {
  afterEach(() => {
    cleanupAnalyzerTempRoots();
  });

  it('treats host stdin shutdown and idle child exit as non-critical', () => {
    const logPath = makeLog([
      {
        ts: '2026-06-13T18:00:00.000Z',
        event: 'wrapper.exit',
        failureClass: 'host-stdin-closed',
        expectedExit: true,
        transportClosedBy: 'client-stdin',
        activeRequestsAtShutdown: 0,
      },
      childExitEvent({
        ts: '2026-06-13T18:01:00.000Z',
        code: 0,
        activeRequestCount: 0,
        pendingContextPackCount: 0,
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(true);
    expect(summary.criticalTransportFailures).toBe(0);
    expect(summary.wrapperExit.expectedHostStdinClosed).toBe(1);
    expect(summary.childExit.idleZeroExit).toBe(1);
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('treats host stdout pipe closure as an expected host transport shutdown', () => {
    const logPath = makeLog([
      {
        ts: '2026-06-13T18:00:00.000Z',
        event: 'wrapper.exit',
        failureClass: 'host-stdout-closed',
        expectedExit: true,
        transportClosedBy: 'client-stdout',
        activeRequestsAtShutdown: 0,
      },
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(true);
    expect(summary.criticalTransportFailures).toBe(0);
    expect(summary.wrapperExit.expectedHostStdoutClosed).toBe(1);
    expect(summary.wrapperExit.idleUnclassified).toBe(0);
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('preserves config-alignment evidence on wrapper runtime diagnostics', () => {
    const logPath = makeLog([
      {
        ts: '2026-06-13T18:00:00.000Z',
        runId: 'config-drift-run',
        event: 'wrapper.runtime.diagnostic',
        kind: 'configAlignment',
        failureClass: 'mcp-host-config-mismatch',
        fatal: false,
        configAlignment: {
          status: 'mismatch',
          reason: 'current-wrapper-differs-from-codex-config',
          mismatchCount: 2,
          mismatches: [
            { field: 'codegraphTarget', expected: '@colbymchenry/codegraph@1.2.0', actual: '@colbymchenry/codegraph@1.1.1' },
            { field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS', expected: '30000', actual: '60000' },
          ],
        },
        recovery: [
          'Restart the Codex MCP host/session so direct MCP loads the current config.',
          'Until restart, use npm run codegraph:adapter:context -- --query "<query>" --json for repository facts.',
        ],
        misdiagnosisGuards: [
          {
            mistakenConclusion: 'adapter-source-regression',
            blockedBy: 'failureBoundary=codex-mcp-host; wrapper target/env mismatch is host/session config evidence, not adapter source behavior.',
            requiredEvidenceBeforeConclusion: 'fresh adapter fallback reproduces the same failure',
          },
        ],
        requiredEvidenceBeforeConclusion: [
          {
            conclusion: 'adapter-source-regression',
            requiredEvidence: [
              'fresh adapter fallback reproduces the same failure',
              'adapter doctor confirms the current Codex MCP config and wrapper target/env',
            ],
          },
        ],
      },
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.wrapperRuntimeDiagnostics.latest).toEqual(expect.objectContaining({
      event: 'wrapper.runtime.diagnostic',
      kind: 'configAlignment',
      failureClass: 'mcp-host-config-mismatch',
      configAlignment: expect.objectContaining({
        status: 'mismatch',
        mismatchCount: 2,
        mismatches: expect.arrayContaining([
          expect.objectContaining({ field: 'codegraphTarget' }),
          expect.objectContaining({ field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS' }),
        ]),
      }),
      recovery: expect.arrayContaining([
        expect.stringContaining('Restart the Codex MCP host/session'),
        expect.stringContaining('codegraph:adapter:context'),
      ]),
      misdiagnosisGuards: expect.arrayContaining([
        expect.objectContaining({
          mistakenConclusion: 'adapter-source-regression',
          blockedBy: expect.stringContaining('codex-mcp-host'),
        }),
      ]),
      requiredEvidenceBeforeConclusion: expect.arrayContaining([
        expect.objectContaining({
          conclusion: 'adapter-source-regression',
          requiredEvidence: expect.arrayContaining([
            expect.stringContaining('fresh adapter fallback'),
          ]),
        }),
      ]),
    }));
    expect(summary.wrapperRuntimeDiagnostics.latestNonFatal).toEqual(expect.objectContaining({
      kind: 'configAlignment',
      failureClass: 'mcp-host-config-mismatch',
    }));
    expect(summary.wrapperRuntimeDiagnostics.latestFatal).toBeNull();
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('separates fatal runtime diagnostics from earlier non-fatal config diagnostics', () => {
    const logPath = makeLog([
      {
        ts: '2026-06-13T18:00:00.000Z',
        runId: 'mixed-runtime-diagnostics-run',
        event: 'wrapper.runtime.diagnostic',
        kind: 'configAlignment',
        failureClass: 'mcp-host-config-mismatch',
        fatal: false,
      },
      {
        ts: '2026-06-13T18:00:01.000Z',
        runId: 'mixed-runtime-diagnostics-run',
        event: 'wrapper.runtime.diagnostic',
        kind: 'clientInvalidHeader',
        failureClass: 'client-invalid-header',
        fatal: true,
        transportClosedBy: 'client-invalid-header',
        rootCauseSnapshot: {
          recentClientRequests: [],
        },
      },
    ]);

    const result = runAnalyzer(logPath, ['--text']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('wrapperRuntimeDiagnostics.count=2');
    expect(result.stdout).toContain('wrapperRuntimeDiagnostics.fatal=1');
    expect(result.stdout).toContain('wrapperRuntimeDiagnostics.nonFatal=1');
    expect(result.stdout).toContain('wrapperRuntimeDiagnostics.latestFatal=');
    expect(result.stdout).toContain('"kind":"clientInvalidHeader"');
    expect(result.stdout).toContain('wrapperRuntimeDiagnostics.latestNonFatal=');
    expect(result.stdout).toContain('"kind":"configAlignment"');

    const jsonResult = runAnalyzer(logPath);
    const summary = JSON.parse(jsonResult.stdout);
    expect(summary.wrapperRuntimeDiagnostics.firstNonFatal).toEqual(expect.objectContaining({
      kind: 'configAlignment',
      fatal: false,
    }));
    expect(summary.wrapperRuntimeDiagnostics.latestFatal).toEqual(expect.objectContaining({
      kind: 'clientInvalidHeader',
      failureClass: 'client-invalid-header',
      fatal: true,
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('prints adapter-failure likelihood and recovery for host config drift in text summaries', () => {
    const script = makeScriptFile('module.exports = { version: "current-wrapper" };\n');
    const logPath = makeLog([
      wrapperStartEvent('stale-host-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          CODEGRAPH_NO_DAEMON: '0',
          CODEGRAPH_NO_WATCH: '0',
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
          CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      contextResponseEvent('stale-host-run', 'stale-host-context'),
    ]);
    const projectRoot = path.dirname(logPath);
    const configPath = makeCodexMcpConfig({
      root: projectRoot,
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.2.0',
      env: {
        CODEGRAPH_NO_DAEMON: '0',
        CODEGRAPH_NO_WATCH: '0',
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
        CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      },
    });

    const result = runAnalyzer(logPath, ['--text'], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('rootCauseSummary.status=direct-mcp-host-config-mismatch');
    expect(result.stdout).toContain('rootCauseSummary.adapterFailureLikely=false');
    expect(result.stdout).toContain('rootCauseSummary.directMcpTrust=do-not-trust-direct-mcp-until-host-restarts');
    expect(result.stdout).toContain('rootCauseSummary.recovery=');
    expect(result.stdout).toContain('diagnosticTriage.status=direct-mcp-host-config-mismatch');
    expect(result.stdout).toContain('diagnosticTriage.failureBoundary=codex-mcp-host');
    expect(result.stdout).toContain('diagnosticTriage.adapterFailureLikely=false');
    expect(result.stdout).toContain('diagnosticTriage.directMcpTrust=do-not-trust-direct-mcp-until-host-restarts');
    expect(result.stdout).toContain('diagnosticTriage.conclusionConfidence=high');
    expect(result.stdout).toContain('diagnosticTriage.failureClasses=');
    expect(result.stdout).toContain('mcp-host-config-drift');
    expect(result.stdout).toContain('diagnosticTriage.primaryEvidence=');
    expect(result.stdout).toContain('"expectedCodegraphTarget":"@colbymchenry/codegraph@1.2.0"');
    expect(result.stdout).toContain('"currentWrapperTarget":"@colbymchenry/codegraph@1.1.1"');
    expect(result.stdout).toContain('"currentWrapperTargetComparison":{"matches":false,"expected":"@colbymchenry/codegraph@1.2.0","actual":"@colbymchenry/codegraph@1.1.1"}');
    expect(result.stdout).toContain('"hostConfigMismatches":');
    expect(result.stdout).toContain('"field":"codegraphTarget","expected":"@colbymchenry/codegraph@1.2.0","actual":"@colbymchenry/codegraph@1.1.1"');
    expect(result.stdout).toContain('"field":"env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS","key":"NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS","expected":"30000","actual":"60000"');
    expect(result.stdout).toContain('diagnosticTriage.fallback=npm run codegraph:adapter:context -- --query "<query>" --json');
    expect(result.stdout).toContain('diagnosticTriage.decisionContract=');
    expect(result.stdout).toContain('"mustUseFreshAdapterFallback":true');
    expect(result.stdout).toContain('diagnosticTriage.evidenceGaps=');
    expect(result.stdout).toContain('"fresh-adapter-fallback-result"');
    expect(result.stdout).toContain('diagnosticTriage.requiredEvidenceBeforeConclusion=');
    expect(result.stdout).toContain('"adapter-source-regression"');
    expect(result.stdout).toContain('diagnosticTriage.investigationChecklist=');
    expect(result.stdout).toContain('diagnosticTriage.misdiagnosisGuards=');
    expect(result.stdout).toContain('Restart the Codex MCP host/session');
    expect(result.stdout).toContain('npm run codegraph:adapter:context -- --query "<query>" --json');
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('lets --text override a base --json flag for npm-script guard usage', () => {
    const logPath = makeLog([
      {
        ts: '2026-06-13T18:00:00.000Z',
        event: 'wrapper.exit',
        failureClass: 'host-stdin-closed',
        expectedExit: true,
        transportClosedBy: 'client-stdin',
        activeRequestsAtShutdown: 0,
      },
    ]);

    const result = runAnalyzer(logPath, ['--json', '--text']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('MCP log:');
    expect(result.stdout).toContain('diagnosticTriage.status=');
    expect(() => JSON.parse(result.stdout)).toThrow();
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('front-loads a compact diagnostic triage to avoid misclassifying host drift as an adapter crash', () => {
    const script = makeScriptFile('module.exports = { version: "triage-contract" };\n');
    const staleHash = '6'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('triage-stale-run', script, {
        scriptSha256: staleHash,
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          CODEGRAPH_NO_DAEMON: '0',
          CODEGRAPH_NO_WATCH: '0',
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
          CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      contextResponseEvent('triage-stale-run', 'triage-context', {
        ts: '2026-06-13T18:00:02.000Z',
      }),
      {
        ts: '2026-06-13T18:00:03.000Z',
        runId: 'triage-stale-run',
        event: 'child.stderr',
        text: '[CodeGraph MCP] File watcher degraded; auto-sync disabled because the file lock is held.',
      },
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.2.0',
      env: {
        CODEGRAPH_NO_DAEMON: '0',
        CODEGRAPH_NO_WATCH: '0',
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
        CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      },
    });

    const result = runAnalyzer(logPath, ['--fail-on-untrusted-direct-mcp'], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);
    const summaryKeys = Object.keys(summary);

    expect(result.status).toBe(1);
    expect(summaryKeys.indexOf('diagnosticTriage')).toBeGreaterThanOrEqual(0);
    expect(summaryKeys.indexOf('diagnosticTriage')).toBeLessThan(summaryKeys.indexOf('childExit'));
    expect(summary.diagnosticTriage).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-stale-or-index-frozen',
      failureBoundary: 'codex-mcp-host-and-base-codegraph-index-watcher',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts-or-index-syncs',
      fallback: 'npm run codegraph:adapter:context -- --query "<query>" --json',
      doNotMisdiagnoseAs: expect.arrayContaining([
        'adapter-source-regression',
        'overlay-timeout',
        'wrapper-transport-crash',
        'direct-mcp-healthy',
      ]),
      primaryEvidence: expect.objectContaining({
        expectedCodegraphTarget: '@colbymchenry/codegraph@1.2.0',
        currentWrapperTarget: '@colbymchenry/codegraph@1.1.1',
        currentContextWrapperTarget: '@colbymchenry/codegraph@1.1.1',
        currentWrapperMatchesDisk: false,
        currentContextWrapperMatchesDisk: false,
        activeAutoSyncDisabledCount: 1,
        latestEffectiveCriticalTransportFailure: null,
      }),
    }));
    expect(summary.diagnosticTriage.failureClasses).toEqual(expect.arrayContaining([
      'mcp-host-config-drift',
      'mcp-host-wrapper-script-stale',
      'codegraph-autosync-disabled',
      'active-wrapper-autosync-disabled',
    ]));
    expect(summary.diagnosticTriage.nextAction).toContain('Restart');
    expect(summary.diagnosticTriage.conclusionConfidence).toBe('high');
    expect(summary.diagnosticTriage.decisionContract).toEqual(expect.objectContaining({
      canDiagnoseAdapterFromDirectMcp: false,
      mustUseFreshAdapterFallback: true,
      mustRestartMcpHost: true,
      adapterFixBlockedUntilFreshEvidence: true,
    }));
    expect(summary.diagnosticTriage.investigationChecklist).toEqual(expect.arrayContaining([
      expect.stringContaining('analyze-codegraph-mcp-log.cjs'),
      'npm run codegraph:adapter:context -- --query "<query>" --json',
      'npm run codegraph:adapter:doctor -- --explain',
      expect.stringContaining('Restart the Codex MCP host/session'),
    ]));
    expect(summary.diagnosticTriage.misdiagnosisGuards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mistakenConclusion: 'adapter-source-regression',
        blockedBy: expect.stringContaining('adapterFailureLikely=false'),
      }),
      expect.objectContaining({
        mistakenConclusion: 'wrapper-transport-crash',
        blockedBy: expect.stringContaining('latestEffectiveCriticalTransportFailure=null'),
      }),
      expect.objectContaining({
        mistakenConclusion: 'nanoflow-ranking-regression',
        blockedBy: expect.stringContaining('auto-sync disabled'),
      }),
    ]));
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

  it('fails when the child exits while requests are active', () => {
    const logPath = makeLog([
      childExitEvent({
        ts: '2026-06-13T18:00:00.000Z',
        code: 1,
        activeRequestCount: 2,
        pendingContextPackCount: 1,
        activeRequests: [{ requestId: 'request-1' }],
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.transportHealthy).toBe(false);
    expect(summary.criticalTransportFailures).toBe(1);
    expect(summary.childExit.withActiveRequests).toBe(1);
    expect(summary.latestCriticalTransportFailure.event).toBe('child.exit');
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('fails when the wrapper records a fatal runtime error before transport close', () => {
    const logPath = makeLog([
      {
        ts: '2026-06-13T18:00:00.000Z',
        event: 'wrapper.fatal',
        failureClass: 'wrapper-uncaught-exception',
        expectedExit: false,
        transportClosedBy: 'wrapper-process-fatal',
        error: {
          name: 'Error',
          message: 'fatal probe uncaught',
          stack: 'Error: fatal probe uncaught\n    at fatal-probe.cjs:3:30',
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

    expect(result.status).toBe(1);
    expect(summary.transportHealthy).toBe(false);
    expect(summary.criticalTransportFailures).toBe(1);
    expect(summary.latestCriticalTransportFailure).toEqual(expect.objectContaining({
      event: 'wrapper.fatal',
      failureClass: 'wrapper-uncaught-exception',
      error: expect.objectContaining({
        message: 'fatal probe uncaught',
      }),
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('reports malformed log line diagnostics with nearby run context', () => {
    const script = makeScriptFile('module.exports = { version: "malformed-line-diagnostics" };\n');
    const malformedLine = '{"ts":"2026-06-13T18:00:02.000Z","runId":"malformed-run","seq":3,"event":"nanoflow.context.response","requestId":"truncated-context"';
    const logPath = makeRawLog([
      JSON.stringify(wrapperStartEvent('malformed-run', script, {
        seq: 1,
      })),
      JSON.stringify(contextResponseEvent('malformed-run', 'before-bad-line', {
        ts: '2026-06-13T18:00:01.000Z',
        seq: 2,
      })),
      malformedLine,
      JSON.stringify(childExitEvent({
        ts: '2026-06-13T18:00:03.000Z',
        runId: 'malformed-run',
        seq: 4,
        code: 0,
      })),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.malformedLines).toBe(1);
    expect(summary.malformedLineNumbers).toEqual([3]);
    expect(summary.malformedLineDetails).toEqual([
      expect.objectContaining({
        lineNumber: 3,
        rootCauseClass: 'truncated-json-line',
        suspectedEvent: 'nanoflow.context.response',
        nearbyRunId: 'malformed-run',
        nearbySeq: 3,
        previousEvent: expect.objectContaining({
          event: 'nanoflow.context.response',
          requestId: 'before-bad-line',
        }),
        nextEvent: expect.objectContaining({
          event: 'child.exit',
          seq: 4,
        }),
      }),
    ]);
    expect(summary.malformedLineDetails[0].parseError).toEqual(expect.any(String));
    expect(summary.malformedLineDetails[0].linePreview).toContain('truncated-context');
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Malformed MCP log lines include line-level diagnostics'),
    ]));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('does not treat replay-only child input queue entries as active user work', () => {
    const logPath = makeLog([
      childExitEvent({
        ts: '2026-06-13T18:00:00.000Z',
        code: 3221225794,
        activeRequestCount: 0,
        pendingContextPackCount: 0,
        pendingToolsListCount: 0,
        childInputQueueLength: 1,
        childInputQueueReasons: ['replay-initialized'],
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.transportHealthy).toBe(true);
    expect(summary.criticalTransportFailures).toBe(0);
    expect(summary.childExit.withActiveRequests).toBe(0);
    expect(summary.childExit.idleNonZeroExit).toBe(1);
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('still fails when child input queue entries include real client work', () => {
    const logPath = makeLog([
      childExitEvent({
        ts: '2026-06-13T18:00:00.000Z',
        code: 3221225794,
        activeRequestCount: 0,
        pendingContextPackCount: 0,
        pendingToolsListCount: 0,
        childInputQueueLength: 2,
        childInputQueueReasons: ['replay-initialized', 'client-message'],
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-critical']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.transportHealthy).toBe(false);
    expect(summary.criticalTransportFailures).toBe(1);
    expect(summary.childExit.withActiveRequests).toBe(1);
    expect(summary.latestCriticalTransportFailure.event).toBe('child.exit');
  }, ANALYZER_SPEC_TIMEOUT_MS);

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

  registerAnalyzeCodegraphMcpLogOverlayDiagnosticSpecs();

  registerAnalyzeCodegraphMcpLogChildFailureSpecs();
  registerAnalyzeCodegraphMcpLogSourceOrderingSpecs();

  registerAnalyzeCodegraphMcpLogActiveHashSpecs();
  registerAnalyzeCodegraphMcpLogActiveWrapperSpecs();
});
