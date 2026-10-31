import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  contextResponseEvent,
  makeCodexMcpConfig,
  makeLog,
  makeScriptFile,
  makeSourceOrderingFixture,
  runAnalyzer,
  toolsListResponseEvent,
  wrapperStartEvent,
} from './analyze-codegraph-mcp-log.spec-helpers';

export function registerAnalyzeCodegraphMcpLogActiveWrapperSpecs(): void {
  it('limits active wrapper diagnostics to recently active sessions', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-active-window" };\n');
    const staleHash = '2'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('historical-stale-run', script, {
        ts: '2026-06-13T17:00:00.000Z',
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-13',
        scriptSha256: staleHash,
      }),
      contextResponseEvent('historical-stale-run', 'historical-context', {
        ts: '2026-06-13T17:01:00.000Z',
      }),
      wrapperStartEvent('fresh-current-run', script, {
        ts: '2026-06-13T18:02:00.000Z',
      }),
      toolsListResponseEvent('fresh-current-run', {
        ts: '2026-06-13T18:03:00.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.activeWrappers).toEqual(expect.objectContaining({
      total: 1,
      matchingDisk: 1,
      staleAgainstDisk: 0,
      unknownDiskHash: 0,
      activeWindowMs: 1_800_000,
    }));
    expect(summary.activeWrappers.latest).toEqual([
      expect.objectContaining({
        runId: 'fresh-current-run',
        matchesDisk: true,
      }),
    ]);
    expect(summary.recommendations).not.toEqual(expect.arrayContaining([
      expect.stringContaining('Multiple active wrapper script hashes are handling MCP requests'),
      expect.stringContaining('Active wrapper sessions still use an older on-disk script hash'),
    ]));
  }, 15_000);

  it('flags a stale live wrapper when its logged hash differs from the on-disk script hash', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-on-disk" };\n');
    const staleHash = '3'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('stale-run', script, {
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-09',
        scriptSha256: staleHash,
      }),
      contextResponseEvent('stale-run', 'stale-context', {
        query: 'vitest.services.config.mts setupFiles',
        sourceOrdering: undefined,
      }),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      scriptPath: script.path,
      scriptSha256: staleHash,
      diskScriptSha256: script.sha256,
      matchesDisk: false,
      staleAgainstDisk: true,
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('current wrapper script hash does not match the current on-disk wrapper script'),
      expect.stringContaining('restart the MCP host/session'),
    ]));
  }, 15_000);

  it('can fail the guard when the current wrapper is stale against disk', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-on-disk" };\n');
    const logPath = makeLog([
      wrapperStartEvent('stale-run', script, {
        scriptSha256: '5'.repeat(64),
      }),
      toolsListResponseEvent('stale-run'),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-stale-current-wrapper']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'stale-run',
      matchesDisk: false,
      staleAgainstDisk: true,
    }));
  }, 15_000);

  it('reports live MCP host config drift when current wrapper target and env differ from Codex config', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-script-old-config-host" };\n');
    const logPath = makeLog([
      wrapperStartEvent('old-config-live-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      toolsListResponseEvent('old-config-live-run'),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: {
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      },
    });

    const result = runAnalyzer(logPath, ['--fail-on-host-config-mismatch'], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.codexMcpConfig).toEqual(expect.objectContaining({
      exists: true,
      codegraphServerConfigured: true,
      expectedCodegraphTarget: '@colbymchenry/codegraph@1.5.0',
      mismatch: true,
      rootCause: expect.objectContaining({
        failureBoundary: 'mcp-host-config',
        failureClass: 'mcp-host-config-drift',
      }),
    }));
    expect(summary.codexMcpConfig.currentWrapperTarget).toEqual(expect.objectContaining({
      expected: '@colbymchenry/codegraph@1.5.0',
      actual: '@colbymchenry/codegraph@1.1.1',
      matches: false,
    }));
    expect(summary.codexMcpConfig.currentWrapperEnv).toEqual(expect.objectContaining({
      mismatchedKeys: ['NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS'],
      matches: false,
    }));
    expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-config-mismatch',
      failureBoundary: 'codex-mcp-host',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts',
      fallback: 'npm run codegraph:adapter:context -- --query "<query>" --json',
      failureClasses: expect.arrayContaining([
        'mcp-host-config-drift',
        'mcp-host-codegraph-target-mismatch',
        'mcp-host-env-mismatch',
      ]),
      observed: expect.objectContaining({
        expectedCodegraphTarget: '@colbymchenry/codegraph@1.5.0',
        currentWrapperTarget: '@colbymchenry/codegraph@1.1.1',
        currentWrapperEnvMismatchedKeys: ['NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS'],
        hostConfigMismatches: expect.arrayContaining([
          expect.objectContaining({
            scope: 'currentWrapper',
            field: 'codegraphTarget',
            expected: '@colbymchenry/codegraph@1.5.0',
            actual: '@colbymchenry/codegraph@1.1.1',
          }),
          expect.objectContaining({
            scope: 'currentWrapper',
            field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
            expected: '30000',
            actual: '60000',
          }),
        ]),
      }),
      recovery: expect.arrayContaining([
        expect.stringContaining('Restart the Codex MCP host/session'),
        expect.stringContaining('npm run codegraph:adapter:context -- --query "<query>" --json'),
      ]),
    }));
    expect(summary.diagnosticTriage.primaryEvidence).toEqual(expect.objectContaining({
      currentWrapperTargetComparison: expect.objectContaining({
        expected: '@colbymchenry/codegraph@1.5.0',
        actual: '@colbymchenry/codegraph@1.1.1',
        matches: false,
      }),
      currentWrapperEnvComparison: expect.objectContaining({
        matches: false,
        mismatches: expect.arrayContaining([
          expect.objectContaining({
            key: 'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
            expected: '30000',
            actual: '60000',
          }),
        ]),
      }),
      hostConfigMismatches: expect.arrayContaining([
        expect.objectContaining({
          scope: 'currentWrapper',
          field: 'codegraphTarget',
          expected: '@colbymchenry/codegraph@1.5.0',
          actual: '@colbymchenry/codegraph@1.1.1',
        }),
        expect.objectContaining({
          scope: 'currentWrapper',
          field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
          expected: '30000',
          actual: '60000',
        }),
      ]),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('Live CodeGraph MCP wrapper target/env does not match the active Codex MCP configuration'),
      expect.stringContaining('npm run codegraph:adapter:context -- --query "<query>" --json'),
    ]));
  }, 15_000);

  it('does not misclassify adapter fallback config overrides as live Codex host drift', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-adapter-fallback" };\n');
    const logPath = makeLog([
      wrapperStartEvent('adapter-fallback-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.5.0',
        env: {
          NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE: 'adapter-fallback',
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '15000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
        codexConfigAlignment: {
          status: 'override',
          reason: 'wrapper-config-alignment-intentional-override',
          alignmentMode: 'adapter-fallback',
          expected: {
            codegraphTarget: '@colbymchenry/codegraph@1.5.0',
            env: {
              NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
              NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
            },
          },
          actual: {
            codegraphTarget: '@colbymchenry/codegraph@1.5.0',
            env: {
              NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '15000',
              NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
            },
          },
          mismatches: [
            {
              field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
              expected: '30000',
              actual: '15000',
            },
          ],
          mismatchCount: 1,
        },
      }),
      contextResponseEvent('adapter-fallback-run', 'adapter-fallback-context'),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: {
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      },
    });

    const result = runAnalyzer(logPath, ['--fail-on-host-config-mismatch'], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.codexMcpConfig).toEqual(expect.objectContaining({
      mismatch: false,
      hostConfigAlignmentOverrides: expect.arrayContaining([
        expect.objectContaining({
          scope: 'currentWrapper',
          status: 'override',
          alignmentMode: 'adapter-fallback',
          reason: 'wrapper-config-alignment-intentional-override',
          mismatchCount: 1,
        }),
        expect.objectContaining({
          scope: 'currentContextWrapper',
          status: 'override',
          alignmentMode: 'adapter-fallback',
          reason: 'wrapper-config-alignment-intentional-override',
          mismatchCount: 1,
        }),
      ]),
    }));
    expect(summary.codexMcpConfig.currentWrapperEnv).toEqual(expect.objectContaining({
      matches: null,
      ignored: true,
      ignoredReason: 'wrapper-config-alignment-intentional-override',
      alignmentMode: 'adapter-fallback',
    }));
    expect(summary.rootCauseSummary.failureClasses).not.toEqual(expect.arrayContaining([
      'mcp-host-config-drift',
      'mcp-host-env-mismatch',
    ]));
    expect(summary.diagnosticTriage.primaryEvidence).toEqual(expect.objectContaining({
      hostConfigMismatches: [],
      hostConfigAlignmentOverrides: expect.arrayContaining([
        expect.objectContaining({
          scope: 'currentWrapper',
          alignmentMode: 'adapter-fallback',
        }),
      ]),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('adapter-fallback'),
      expect.stringContaining('not live Codex MCP host drift'),
    ]));
  }, 15_000);

  it('uses an explicit project root for gate smoke provenance without claiming direct host health', () => {
    const script = makeScriptFile('module.exports = { version: "gate-smoke-project-root" };\n');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-mcp-project-root-'));
    const configuredEnv = {
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
    };
    const smokeEnv = {
      ...configuredEnv,
      NANOFLOW_CODEGRAPH_CONFIG_ALIGNMENT_MODE: 'smoke',
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '85000',
    };
    try {
      fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.codex', 'config.toml'), [
        '[mcp_servers.codegraph]',
        'command = "node"',
        'args = [',
        `  ${JSON.stringify(script.path)},`,
        '  "@colbymchenry/codegraph@1.5.0",',
        '  "serve",',
        '  "--mcp",',
        '  "--path",',
        `  ${JSON.stringify(projectRoot)},`,
        ']',
        '',
        '[mcp_servers.codegraph.env]',
        'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"',
        'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
        '',
      ].join('\n'));
      const logPath = makeLog([
        wrapperStartEvent('gate-smoke-run', script, {
          codegraphTarget: '@colbymchenry/codegraph@1.5.0',
          env: smokeEnv,
          codexConfigAlignment: {
            status: 'override',
            reason: 'wrapper-config-alignment-intentional-override',
            alignmentMode: 'smoke',
            expected: {
              codegraphTarget: '@colbymchenry/codegraph@1.5.0',
              env: configuredEnv,
            },
            actual: {
              codegraphTarget: '@colbymchenry/codegraph@1.5.0',
              env: smokeEnv,
            },
            mismatchCount: 1,
          },
        }),
        contextResponseEvent('gate-smoke-run', 'gate-smoke-context'),
      ]);

      const result = runAnalyzer(logPath, [
        '--project-root',
        projectRoot,
        '--fail-on-untrusted-direct-mcp',
      ]);
      const summary = JSON.parse(result.stdout);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(summary.codexMcpConfig).toEqual(expect.objectContaining({
        root: projectRoot,
        scope: 'project',
        codegraphServerConfigured: true,
        expectedCodegraphTarget: '@colbymchenry/codegraph@1.5.0',
      }));
      expect(summary.directMcpResponseEvidence).toEqual(expect.objectContaining({
        status: 'response-trusted-adapter-probe-only',
        provenance: 'adapter-fallback-or-smoke',
        trustedForAdapterJudgment: true,
        trustedForDirectHostHealth: false,
      }));
      expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
        directMcpTrust: 'do-not-trust-direct-mcp-until-configured-response-is-observed',
      }));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not treat stale historical wrapper activity as current direct MCP evidence', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-script-old-config-host" };\n');
    const logPath = makeLog([
      wrapperStartEvent('old-config-historical-run', script, {
        ts: '2026-06-13T18:00:00.000Z',
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      toolsListResponseEvent('old-config-historical-run', {
        ts: '2026-06-13T18:01:00.000Z',
      }),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: {
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      },
    });

    const result = runAnalyzer(logPath, [
      '--observed-at',
      '2026-06-13T18:45:00.000Z',
      '--fail-on-untrusted-direct-mcp',
    ], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.currentWrapper).toBeNull();
    expect(summary.activeWrappers).toEqual(expect.objectContaining({
      total: 0,
      codegraphTargets: {},
    }));
    expect(summary.codexMcpConfig).toEqual(expect.objectContaining({
      mismatch: false,
    }));
    expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-no-current-wrapper-evidence',
      failureBoundary: 'codex-mcp-host-transport',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-writes-wrapper-log',
      failureClasses: expect.arrayContaining([
        'no-current-wrapper-evidence',
        'mcp-host-wrapper-not-started',
      ]),
      observed: expect.objectContaining({
        expectedCodegraphTarget: '@colbymchenry/codegraph@1.5.0',
        currentWrapperTarget: null,
        activeWrapperCount: 0,
        latestLogAgeMs: 2_640_000,
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('No current CodeGraph MCP wrapper activity was recorded'),
      expect.stringContaining('Codex MCP host transport'),
    ]));
    expect(summary.recommendations).not.toEqual(expect.arrayContaining([
      expect.stringContaining('Live CodeGraph MCP wrapper target/env does not match'),
    ]));
  }, 15_000);

  it('treats auto-sync disabled warnings from recently active non-current wrappers as untrusted direct MCP evidence', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-script-active-autosync" };\n');
    const logPath = makeLog([
      wrapperStartEvent('older-active-run', script, {
        ts: '2026-06-13T18:00:00.000Z',
      }),
      contextResponseEvent('older-active-run', 'older-context-before-warning', {
        ts: '2026-06-13T18:00:10.000Z',
      }),
      {
        ts: '2026-06-13T18:00:20.000Z',
        runId: 'older-active-run',
        event: 'child.stderr',
        text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen. Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
      },
      wrapperStartEvent('fresh-current-run', script, {
        ts: '2026-06-13T18:02:00.000Z',
      }),
      toolsListResponseEvent('fresh-current-run', {
        ts: '2026-06-13T18:02:10.000Z',
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-untrusted-direct-mcp']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.currentWrapper).toEqual(expect.objectContaining({
      runId: 'fresh-current-run',
      matchesDisk: true,
    }));
    expect(summary.currentCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 0,
      latest: null,
    }));
    expect(summary.activeCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 1,
      latest: expect.objectContaining({
        runId: 'older-active-run',
        event: 'child.stderr',
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(summary.activeCodegraphAutoSyncDisabledRuns).toEqual([
      expect.objectContaining({
        runId: 'older-active-run',
        count: 1,
        matchesDisk: true,
        latest: expect.objectContaining({
          failureClass: 'codegraph-autosync-disabled',
        }),
      }),
    ]);
    expect(summary.activeCodegraphAutoSyncDisabledRuns[0].latest.wrapperStart).toBeUndefined();
    expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'base-codegraph-autosync-disabled',
      directMcpTrust: 'do-not-trust-direct-mcp-index-freshness-until-sync-runs',
      failureClasses: expect.arrayContaining([
        'codegraph-autosync-disabled',
        'active-wrapper-autosync-disabled',
      ]),
      observed: expect.objectContaining({
        activeAutoSyncDisabledCount: 1,
        activeAutoSyncDisabledTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(summary.rootCauseSummary.observed.activeAutoSyncDisabledRuns[0].latest.wrapperStart).toBeUndefined();
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('recently active CodeGraph MCP wrappers returned auto-sync disabled warnings'),
      expect.stringContaining('activeCodegraphAutoSyncDisabledRuns'),
    ]));
  }, 15_000);

  it('uses runtime topology transitions instead of startup topology for active fallback watcher diagnosis', () => {
    const script = makeScriptFile('module.exports = { version: "runtime-fallback-watcher" };\n');
    const logPath = makeLog([
      wrapperStartEvent('runtime-fallback-run', script, {
        ts: '2026-06-13T18:00:00.000Z',
        effectiveChildEnv: {
          CODEGRAPH_NO_DAEMON: '0',
          CODEGRAPH_NO_WATCH: '0',
        },
        runtimeTopology: {
          mode: 'shared-daemon-proxy',
          watcherOwnership: 'shared-daemon-single-watcher',
          fileLockContentionRisk: 'single-writer',
          daemonDisabled: false,
          watchDisabled: false,
        },
      }),
      toolsListResponseEvent('runtime-fallback-run', {
        ts: '2026-06-13T18:00:10.000Z',
      }),
      {
        ts: '2026-06-13T18:00:20.000Z',
        runId: 'runtime-fallback-run',
        event: 'child.runtime-topology.transition',
        reason: 'shared-daemon-connection-lost',
        from: {
          mode: 'shared-daemon-proxy',
          watcherOwnership: 'shared-daemon-single-watcher',
          fileLockContentionRisk: 'single-writer',
        },
        to: {
          mode: 'in-process-fallback',
          watcherOwnership: 'in-process-fallback-initializing',
          fileLockContentionRisk: 'multi-wrapper-writers-pending',
          daemonDisabled: false,
          watchDisabled: false,
        },
      },
      {
        ts: '2026-06-13T18:00:30.000Z',
        runId: 'runtime-fallback-run',
        event: 'child.runtime-topology.transition',
        reason: 'fallback-file-watcher-active',
        from: {
          mode: 'in-process-fallback',
          watcherOwnership: 'in-process-fallback-initializing',
          fileLockContentionRisk: 'multi-wrapper-writers-pending',
        },
        to: {
          mode: 'in-process-fallback-watcher',
          watcherOwnership: 'per-wrapper-fallback-watcher',
          fileLockContentionRisk: 'multi-wrapper-writers',
          daemonDisabled: false,
          watchDisabled: false,
        },
      },
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-untrusted-direct-mcp']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.activeWrappers).toEqual(expect.objectContaining({
      runtimeTopologyModes: { 'in-process-fallback-watcher': 1 },
      watcherOwnership: { 'per-wrapper-fallback-watcher': 1 },
      inProcessFallbackCount: 1,
      inProcessFallbackWatcherCount: 1,
    }));
    expect(summary.activeWrappers.latest).toEqual([
      expect.objectContaining({
        runId: 'runtime-fallback-run',
        runtimeTopology: expect.objectContaining({
          mode: 'in-process-fallback-watcher',
          watcherOwnership: 'per-wrapper-fallback-watcher',
          fileLockContentionRisk: 'multi-wrapper-writers',
        }),
      }),
    ]);
    expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'base-codegraph-shared-daemon-fallback-watcher',
      failureBoundary: 'base-codegraph-process-topology',
      directMcpTrust: 'do-not-trust-direct-mcp-until-fallback-proxies-restart',
      failureClasses: expect.arrayContaining([
        'active-shared-daemon-fallback',
        'active-in-process-fallback-watcher',
      ]),
      observed: expect.objectContaining({
        activeInProcessFallbackCount: 1,
        activeInProcessFallbackWatcherCount: 1,
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('shared-daemon proxies have fallen back to per-wrapper in-process watchers'),
    ]));
  }, 15_000);

  it('ignores response warning flags whose evidence is a source-code literal rather than a leading banner', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-script-source-warning" };\n');
    const sourceWarningTail = [
      '...139\\t    }));',
      '140\\t  });',
      "144\\tconst warning = 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen. Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.';",
    ].join('\n');
    const logPath = makeLog([
      wrapperStartEvent('source-warning-run', script),
      contextResponseEvent('source-warning-run', 'source-warning-context', {
        baseResponseWarnings: {
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
          textTail: sourceWarningTail,
        },
        responseWarnings: {
          codegraphAutoSyncDisabled: true,
          failureClass: 'codegraph-autosync-disabled',
          textTail: sourceWarningTail,
        },
      }),
    ]);

    const result = runAnalyzer(logPath, ['--fail-on-untrusted-direct-mcp']);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(summary.codegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 0,
      latest: null,
    }));
    expect(summary.currentCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 0,
      latest: null,
    }));
    expect(summary.activeCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 0,
      latest: null,
    }));
    expect(summary.rootCauseSummary.failureClasses).not.toEqual(expect.arrayContaining([
      'codegraph-autosync-disabled',
      'active-wrapper-autosync-disabled',
    ]));
  }, 15_000);

  it('can fail the guard when root cause says direct MCP is untrusted', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-script-old-config-host" };\n');
    const logPath = makeLog([
      wrapperStartEvent('old-config-live-run', script, {
        codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        env: {
          NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
          NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
        },
      }),
      contextResponseEvent('old-config-live-run', 'old-config-context'),
    ]);
    const configPath = makeCodexMcpConfig({
      root: path.dirname(logPath),
      wrapperScriptPath: script.path,
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      env: {
        NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
        NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
      },
    });

    const result = runAnalyzer(logPath, ['--fail-on-untrusted-direct-mcp'], {
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: configPath,
    });
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(summary.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-config-mismatch',
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts',
      fallback: 'npm run codegraph:adapter:context -- --query "<query>" --json',
    }));
  }, 15_000);

  it('does not report stale current context source-ordering issues as current behavior', () => {
    const script = makeScriptFile('module.exports = { version: "fresh-context-fix" };\n');
    const staleHash = '4'.repeat(64);
    const logPath = makeLog([
      wrapperStartEvent('stale-context-run', script, {
        wrapperVersion: 'nanoflow-codegraph-wrapper-2026-06-13',
        scriptSha256: staleHash,
      }),
      contextResponseEvent('stale-context-run', 'stale-context-bad-order', {
        query: 'idb-keyval retry queue service',
        sourceOrdering: makeSourceOrderingFixture({
          firstSourceFiles: ['src/app/core/services/sync/retry-queue.service.ts'],
          rankedOverlayFiles: ['idb-keyval', 'src/app/core/services/sync/retry-queue.service.ts'],
          topRankedOverlayFile: 'idb-keyval',
          topRankedOverlayFileVisibleIndex: -1,
          firstSourceBlockIsTopRankedOverlayFile: false,
          topRankedOverlayFileMissing: true,
        }),
      }),
      wrapperStartEvent('fresh-tools-run', script, {
        ts: '2026-06-13T18:01:00.000Z',
      }),
      toolsListResponseEvent('fresh-tools-run'),
    ]);

    const result = runAnalyzer(logPath);
    const summary = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
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
      topRankedMissing: 1,
      latestIssue: expect.objectContaining({
        requestId: 'stale-context-bad-order',
      }),
    }));
    expect(summary.recommendations).toEqual(expect.arrayContaining([
      expect.stringContaining('context-pack response is older than a fresh wrapper start'),
      expect.stringContaining('Historical context-pack source ordering issues remain in the log'),
    ]));
    expect(summary.recommendations).not.toEqual(expect.arrayContaining([
      expect.stringContaining('The current wrapper still has context-pack source ordering issues'),
    ]));
  }, 15_000);
}
