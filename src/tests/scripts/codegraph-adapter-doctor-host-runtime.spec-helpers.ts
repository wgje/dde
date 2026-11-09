import { createHash } from 'node:crypto';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterDoctorHostRuntimeSpecContext {
  makeRoot(): string;
  trackTempRoot(root: string): void;
  runDoctor(root: string, args?: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  writePackage(root: string, scripts: Record<string, string>): void;
  requiredScripts(): Record<string, string>;
  writeCodexConfig(root: string, codexConfigPath: string): void;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function registerCodegraphAdapterDoctorHostRuntimeSpecs(
  context: CodegraphAdapterDoctorHostRuntimeSpecContext,
): void {
  const {
    makeRoot,
    trackTempRoot,
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  } = context;

  it('detects a live shared-daemon proxy that has become an in-process fallback watcher', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperContents = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperContents);
    const wrapperHash = sha256(wrapperContents);
    const configuredEnv = {
      CODEGRAPH_NO_DAEMON: '0',
      CODEGRAPH_NO_WATCH: '0',
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
      CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
    };
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-07-13T22:11:00.000Z',
          runId: 'fallback-watcher-run',
          pid: 43210,
          wrapperPid: 43210,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperHash,
          codegraphTarget: '@colbymchenry/codegraph@1.6.2',
          env: configuredEnv,
          effectiveChildEnv: configuredEnv,
          runtimeTopology: {
            mode: 'shared-daemon-proxy',
            watcherOwnership: 'shared-daemon-single-watcher',
            fileLockContentionRisk: 'single-writer',
            daemonDisabled: false,
            watchDisabled: false,
          },
        }),
        JSON.stringify({
          ts: '2026-07-13T22:11:19.250Z',
          runId: 'fallback-watcher-run',
          wrapperPid: 43210,
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
        }),
        JSON.stringify({
          ts: '2026-07-13T22:11:34.264Z',
          runId: 'fallback-watcher-run',
          wrapperPid: 43210,
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
        }),
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 43210,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.6.2 serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.activeInProcessFallbackWatcherRuns).toEqual([
      expect.objectContaining({
        runId: 'fallback-watcher-run',
        pid: 43210,
        mode: 'in-process-fallback-watcher',
        watcherOwnership: 'per-wrapper-fallback-watcher',
        fileLockContentionRisk: 'multi-wrapper-writers',
      }),
    ]);
    expect(report.hostMcp.currentWrapperRuntimeTopology).toEqual(expect.objectContaining({
      mode: 'in-process-fallback-watcher',
      watcherOwnership: 'per-wrapper-fallback-watcher',
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:active-in-process-fallback-watchers',
        ok: false,
        count: 1,
      }),
    ]));
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'base-codegraph-shared-daemon-fallback-watcher',
      failureBoundary: 'base-codegraph-process-topology',
      failureClasses: expect.arrayContaining(['active-in-process-fallback-watcher']),
    }));
  });

  it('reports malformed host MCP log lines instead of silently discarding root-cause evidence', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperContents = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperContents);
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-27T07:00:00.000Z',
          runId: 'fresh-run',
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: sha256(wrapperContents),
        }),
        '{"ts":"2026-06-27T07:01:00.000Z","runId":"fresh-run","event":"wrapper.script.stale"',
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.logMalformedLines).toBe(1);
    expect(report.hostMcp.latestMalformedLogLine).toEqual(expect.objectContaining({
      lineNumber: 2,
      textTail: expect.stringContaining('wrapper.script.stale'),
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:log-parse',
        ok: false,
      }),
    ]));
  });
}
