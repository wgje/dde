import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  childExitEvent,
  cleanupAnalyzerTempRoots,
  contextResponseEvent,
  makeCodexMcpConfig,
  makeLog,
  makeRawLog,
  makeScriptFile,
  runAnalyzer,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogActiveWrapperSpecs,
} from './analyze-codegraph-mcp-log-active-wrapper.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogActiveHashSpecs,
} from './analyze-codegraph-mcp-log-active-hash.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs,
} from './analyze-codegraph-mcp-log-current-wrapper.spec-helpers';
import {
  registerAnalyzeCodegraphMcpLogDirectMcpSpecs,
} from './analyze-codegraph-mcp-log-direct-mcp.spec-helpers';
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

  it('surfaces direct per-wrapper watcher topology as file-lock contention risk', () => {
    const script = makeScriptFile('shared-daemon-topology');
    const logPath = makeLog([
      wrapperStartEvent('direct-watcher-run', script, {
        pid: 43100,
        wrapperPid: 43100,
        env: {
          CODEGRAPH_NO_DAEMON: '0',
          CODEGRAPH_NO_WATCH: '0',
        },
        effectiveChildEnv: {
          CODEGRAPH_NO_DAEMON: '1',
          CODEGRAPH_NO_WATCH: '0',
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
          CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
        },
        runtimeTopology: {
          mode: 'direct-session',
          watcherOwnership: 'per-wrapper-watcher',
          fileLockContentionRisk: 'multi-wrapper-writers',
          daemonDisabled: true,
          watchDisabled: false,
        },
      }),
      contextResponseEvent('direct-watcher-run', 'direct-watcher-context'),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentWrapper.runtimeTopology).toEqual(expect.objectContaining({
      mode: 'direct-session',
      watcherOwnership: 'per-wrapper-watcher',
      fileLockContentionRisk: 'multi-wrapper-writers',
    }));
    expect(summary.activeWrappers).toEqual(expect.objectContaining({
      runtimeTopologyModes: { 'direct-session': 1 },
      directWatcherContentionRisk: 1,
      sharedDaemonProxyCount: 0,
    }));
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
            { field: 'codegraphTarget', expected: '@colbymchenry/codegraph@1.5.0', actual: '@colbymchenry/codegraph@1.1.1' },
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
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
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
    expect(result.stdout).toContain('"expectedCodegraphTarget":"@colbymchenry/codegraph@1.5.0"');
    expect(result.stdout).toContain('"currentWrapperTarget":"@colbymchenry/codegraph@1.1.1"');
    expect(result.stdout).toContain('"currentWrapperTargetComparison":{"matches":false,"expected":"@colbymchenry/codegraph@1.5.0","actual":"@colbymchenry/codegraph@1.1.1"}');
    expect(result.stdout).toContain('"hostConfigMismatches":');
    expect(result.stdout).toContain('"field":"codegraphTarget","expected":"@colbymchenry/codegraph@1.5.0","actual":"@colbymchenry/codegraph@1.1.1"');
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

  it('classifies a configured env key omitted by a legacy wrapper log as unobserved', () => {
    const script = makeScriptFile('module.exports = { version: "legacy-env-observation" };\n');
    const logPath = makeLog([
      wrapperStartEvent('legacy-env-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.5.0',
        env: {},
      }),
      contextResponseEvent('legacy-env-run', 'legacy-env-context'),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: { npm_config_cache: 'D:/Code/tools/codegraph-npm-cache' },
    });

    const result = runAnalyzer(logPath, [], { NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath });
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.codexMcpConfig.mismatch).toBe(false);
    expect(summary.codexMcpConfig.currentWrapperEnv).toEqual(expect.objectContaining({
      matches: null,
      mismatchedKeys: [],
      unobservedKeys: ['npm_config_cache'],
      comparisons: [expect.objectContaining({
        key: 'npm_config_cache',
        status: 'unobserved',
        expected: 'D:/Code/tools/codegraph-npm-cache',
        actual: null,
      })],
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it.each([
    ['drive path', 'D:/x/', String.raw`d:\x`],
    ['UNC path', '//SERVER/share/cache/', String.raw`\\server\share\cache`],
  ])('normalizes configured npm cache %s when the wrapper observation schema is explicit', (_label, expectedCache, actualCache) => {
    const script = makeScriptFile('module.exports = { version: "explicit-env-observation" };\n');
    const logPath = makeLog([
      wrapperStartEvent('explicit-env-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.5.0',
        envObservationSchemaVersion: 1,
        observedEnvKeys: ['npm_config_cache'],
        env: { npm_config_cache: actualCache },
      }),
      contextResponseEvent('explicit-env-run', 'explicit-env-context'),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: { npm_config_cache: expectedCache },
    });

    const result = runAnalyzer(logPath, [], { NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath });
    const comparison = JSON.parse(result.stdout).codexMcpConfig.currentWrapperEnv;

    expect(result.status).toBe(0);
    expect(comparison).toEqual(expect.objectContaining({
      matches: true,
      matchedKeys: ['npm_config_cache'],
      mismatchedKeys: [],
      unobservedKeys: [],
      comparisons: [expect.objectContaining({ key: 'npm_config_cache', status: 'matched' })],
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('classifies an explicitly observed configured env difference as mismatched', () => {
    const script = makeScriptFile('module.exports = { version: "mismatched-env-observation" };\n');
    const logPath = makeLog([
      wrapperStartEvent('mismatched-env-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.5.0',
        envObservationSchemaVersion: 1,
        observedEnvKeys: ['npm_config_cache'],
        env: { npm_config_cache: 'D:/other-cache' },
      }),
      contextResponseEvent('mismatched-env-run', 'mismatched-env-context'),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: { npm_config_cache: 'D:/expected-cache' },
    });

    const result = runAnalyzer(logPath, [], { NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath });
    const summary = JSON.parse(result.stdout);

    expect(summary.codexMcpConfig.mismatch).toBe(true);
    expect(summary.codexMcpConfig.currentWrapperEnv).toEqual(expect.objectContaining({
      matches: false,
      mismatchedKeys: ['npm_config_cache'],
      comparisons: [expect.objectContaining({ key: 'npm_config_cache', status: 'mismatched' })],
    }));
  }, ANALYZER_SPEC_TIMEOUT_MS);

  it('classifies an observed env key absent from active config as not-configured', () => {
    const script = makeScriptFile('module.exports = { version: "not-configured-env-observation" };\n');
    const logPath = makeLog([
      wrapperStartEvent('not-configured-env-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.5.0',
        envObservationSchemaVersion: 1,
        observedEnvKeys: ['npm_config_cache'],
        env: { npm_config_cache: 'D:/runtime-only-cache' },
      }),
      contextResponseEvent('not-configured-env-run', 'not-configured-env-context'),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: {},
    });

    const result = runAnalyzer(logPath, [], { NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath });
    const comparison = JSON.parse(result.stdout).codexMcpConfig.currentWrapperEnv;

    expect(result.status).toBe(0);
    expect(comparison).toEqual(expect.objectContaining({
      matches: null,
      notConfiguredKeys: ['npm_config_cache'],
      mismatchedKeys: [],
      comparisons: [expect.objectContaining({
        key: 'npm_config_cache',
        status: 'not-configured',
        expected: null,
        actual: 'D:/runtime-only-cache',
      })],
    }));
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
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
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
        expectedCodegraphTarget: '@colbymchenry/codegraph@1.5.0',
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

  registerAnalyzeCodegraphMcpLogDirectMcpSpecs();

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

  registerAnalyzeCodegraphMcpLogCurrentWrapperSpecs();

  registerAnalyzeCodegraphMcpLogOverlayDiagnosticSpecs();

  registerAnalyzeCodegraphMcpLogChildFailureSpecs();
  registerAnalyzeCodegraphMcpLogSourceOrderingSpecs();

  registerAnalyzeCodegraphMcpLogActiveHashSpecs();
  registerAnalyzeCodegraphMcpLogActiveWrapperSpecs();
});
