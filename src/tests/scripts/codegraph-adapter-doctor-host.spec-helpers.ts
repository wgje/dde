import { createHash } from 'node:crypto';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterDoctorHostSpecContext {
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

export function registerCodegraphAdapterDoctorHostSpecs(
  context: CodegraphAdapterDoctorHostSpecContext,
): void {
  const {
    makeRoot,
    trackTempRoot,
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  } = context;

  it('reports a stale host MCP wrapper before Transport closed is misdiagnosed as adapter failure', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-27T07:00:00.000Z',
          runId: 'stale-run',
          pid: 43000,
          wrapperPid: 43000,
          event: 'wrapper.start',
          scriptPath: path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
          scriptSha256: 'old-hash',
        }),
        JSON.stringify({
          ts: '2026-06-27T07:01:00.000Z',
          runId: 'stale-run',
          event: 'nanoflow.context.response',
          wrapperStart: {
            runId: 'stale-run',
            pid: 43000,
            wrapperPid: 43000,
            scriptPath: path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
            scriptSha256: 'old-hash',
          },
        }),
      ].join('\n'),
    );

    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const result = runDoctor(root, ['--explain'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 43000,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('hostMcp: log=present malformed=0 currentWrapper=stale');
  });

  it('classifies observed direct MCP Transport closed even when no new wrapper log was written', () => {
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
          ts: '2026-07-07T09:18:13.876Z',
          runId: 'old-direct-run',
          pid: 43010,
          wrapperPid: 43010,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: sha256(wrapperContents),
          codegraphTarget: '@colbymchenry/codegraph@1.2.0',
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: '2026-07-07T09:18:13.876Z',
          runId: 'old-direct-run',
          event: 'tools.list.augmented',
          failureClass: 'success',
        }),
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const env = {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    };

    const result = runDoctor(root, [
      '--direct-mcp-error',
      'Transport closed',
      '--observed-at',
      '2026-07-07T10:00:00.000Z',
      '--explain',
    ], env);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(result.stdout).toContain('status=direct-mcp-host-transport-closed');
    expect(result.stdout).toContain('failureClasses=observed-direct-mcp-transport-closed,direct-mcp-no-live-wrapper-process');
    expect(result.stdout).toContain('directMcpTrust=do-not-trust-direct-mcp-until-host-restarts');
    expect(result.stdout).toContain('observedDirectMcpError=Transport closed');
    expect(result.stdout).toContain('logEvidence latestTs=2026-07-07T09:18:13.876Z latestEvent=tools.list.augmented');
    expect(result.stdout).toContain('observedAt=2026-07-07T10:00:00.000Z latestLogAgeMs=2506124 staleAgainstObservedAt=true hasCurrentWrapperEvidence=false');
    expect(result.stdout).toContain('ignoredWrapperStarts=1 ignoredContextResponses=0 ignoredStaleWrapperStarts=0 ignoredStaleContextResponses=0 noCurrentWrapperEvidence=true');
    expect(result.stdout).toContain('fallback=npm run codegraph:adapter:context -- --query "<query>" --json');

    const jsonResult = runDoctor(root, [
      '--direct-mcp-error=Transport closed',
      '--observed-at=2026-07-07T10:00:00.000Z',
    ], env);
    const report = JSON.parse(jsonResult.stdout);
    expect(report.hostMcp.observedDirectMcpError).toBe('Transport closed');
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-transport-closed',
      failureBoundary: 'codex-mcp-host-transport',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts',
      failureClasses: expect.arrayContaining([
        'observed-direct-mcp-transport-closed',
        'direct-mcp-no-live-wrapper-process',
      ]),
      observed: expect.objectContaining({
        directMcpError: 'Transport closed',
        liveWrapperProcessCount: 0,
        logEvidence: expect.objectContaining({
          observedAt: '2026-07-07T10:00:00.000Z',
          latestTs: '2026-07-07T09:18:13.876Z',
          latestEvent: 'tools.list.augmented',
          latestRunId: 'old-direct-run',
          latestLogAgeMs: 2_506_124,
          activeWindowMs: 1_800_000,
          staleAgainstObservedAt: true,
          hasCurrentWrapperEvidence: false,
          noCurrentWrapperEvidence: true,
          liveWrapperLogFilter: expect.objectContaining({
            applied: true,
            liveWrapperPids: [],
            ignoredWrapperStarts: 1,
            ignoredContextResponses: 0,
          }),
          currentEvidenceWindow: expect.objectContaining({
            applied: true,
            observedAt: '2026-07-07T10:00:00.000Z',
            activeWindowMs: 1_800_000,
            ignoredWrapperStarts: 0,
            ignoredContextResponses: 0,
          }),
        }),
      }),
      recovery: expect.arrayContaining([
        expect.stringContaining('Restart the Codex MCP host/session'),
        expect.stringContaining('npm run codegraph:adapter:context -- --query "<query>" --json'),
      ]),
    }));
  });

  it('persists observed direct MCP incident evidence for post-mortem recovery', () => {
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
          ts: '2026-07-07T09:18:13.876Z',
          runId: 'incident-old-run',
          pid: 43020,
          wrapperPid: 43020,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: sha256(wrapperContents),
          codegraphTarget: '@colbymchenry/codegraph@1.2.0',
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);

    const result = runDoctor(root, [
      '--direct-mcp-error=Transport closed',
      '--observed-at=2026-07-07T10:00:00.000Z',
    ], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    const incidentPath = path.join(root, '.codegraph', 'codegraph-mcp-incident.latest.json');
    expect(existsSync(incidentPath)).toBe(true);
    expect(report.hostMcp.directMcpIncident).toEqual(expect.objectContaining({
      written: true,
      path: '.codegraph/codegraph-mcp-incident.latest.json',
      directMcpError: 'Transport closed',
      rootCauseStatus: 'direct-mcp-host-transport-closed',
      fallback: 'npm run codegraph:adapter:context -- --query "<query>" --json',
    }));

    const incident = JSON.parse(readFileSync(incidentPath, 'utf8'));
    expect(incident).toEqual(expect.objectContaining({
      schemaVersion: 1,
      root,
      directMcpError: 'Transport closed',
      observedAt: '2026-07-07T10:00:00.000Z',
      fallback: 'npm run codegraph:adapter:context -- --query "<query>" --json',
      rootCauseSummary: expect.objectContaining({
        status: 'direct-mcp-host-transport-closed',
        adapterFailureLikely: false,
        directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts',
      }),
      failedChecks: expect.arrayContaining([
        expect.objectContaining({
          name: 'host-mcp:observed-direct-mcp-error',
          failureClass: 'observed-direct-mcp-transport-closed',
        }),
      ]),
      recovery: expect.arrayContaining([
        expect.stringContaining('Restart the Codex MCP host/session'),
        expect.stringContaining('npm run codegraph:adapter:context'),
      ]),
      hostMcp: expect.objectContaining({
        observedDirectMcpError: 'Transport closed',
        observedDirectMcpFailureClass: 'observed-direct-mcp-transport-closed',
        logEvidence: expect.objectContaining({
          observedAt: '2026-07-07T10:00:00.000Z',
          latestTs: '2026-07-07T09:18:13.876Z',
          latestEvent: 'wrapper.start',
          latestRunId: 'incident-old-run',
          latestLogAgeMs: 2_506_124,
          staleAgainstObservedAt: true,
          hasCurrentWrapperEvidence: false,
          noCurrentWrapperEvidence: true,
        }),
        currentEvidenceWindow: expect.objectContaining({
          applied: true,
          observedAt: '2026-07-07T10:00:00.000Z',
          activeWindowMs: 1_800_000,
          ignoredWrapperStarts: 0,
          ignoredContextResponses: 0,
        }),
        liveWrapperLogFilter: expect.objectContaining({
          applied: true,
          liveWrapperPids: [],
          ignoredWrapperStarts: 1,
          ignoredContextResponses: 0,
        }),
        liveProcesses: expect.objectContaining({
          available: true,
          matchingWrapperCount: 0,
          commandMismatchCount: 0,
          targetMismatchCount: 0,
        }),
      }),
    }));
  });

  it('persists stale live process mismatch details in direct MCP incident evidence', () => {
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
      `${JSON.stringify({
        ts: '2026-07-07T09:18:13.876Z',
        runId: 'stale-live-process-run',
        pid: 43030,
        wrapperPid: 43030,
        event: 'wrapper.start',
        scriptPath: wrapperPath,
        scriptSha256: sha256(wrapperContents),
        codegraphTarget: '@colbymchenry/codegraph@1.2.0',
      })}\n`,
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const staleCommandLine = `"C:\\nvm4w\\nodejs\\node.exe" ${wrapperPath} @colbymchenry/codegraph@1.1.1 serve --mcp --path ${root}`;

    const result = runDoctor(root, [
      '--direct-mcp-error=Transport closed',
      '--observed-at=2026-07-07T10:00:00.000Z',
    ], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 43030,
          parentPid: 3000,
          commandLine: staleCommandLine,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const incident = JSON.parse(readFileSync(
      path.join(root, '.codegraph', 'codegraph-mcp-incident.latest.json'),
      'utf8',
    ));
    expect(incident.hostMcp.liveProcesses).toEqual(expect.objectContaining({
      matchingWrapperCount: 1,
      targetMismatchCount: 1,
      mismatchedProcesses: [
        expect.objectContaining({
          pid: 43030,
          parentPid: 3000,
          observedCodegraphTarget: '@colbymchenry/codegraph@1.1.1',
          targetMatches: false,
          commandLineTail: expect.stringContaining('@colbymchenry/codegraph@1.1.1'),
        }),
      ],
    }));
  });

  it('filters stale wrapper log evidence by observed direct MCP error time when live processes are unavailable', () => {
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
          ts: '2026-07-07T09:18:13.876Z',
          runId: 'old-time-window-run',
          pid: 43011,
          wrapperPid: 43011,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: sha256(wrapperContents),
          codegraphTarget: '@colbymchenry/codegraph@1.2.0',
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: '2026-07-07T09:18:20.000Z',
          runId: 'old-time-window-run',
          event: 'nanoflow.context.response',
          requestId: 'old-context',
          wrapperStart: {
            ts: '2026-07-07T09:18:13.876Z',
            runId: 'old-time-window-run',
            pid: 43011,
            wrapperPid: 43011,
            scriptPath: wrapperPath,
            scriptSha256: sha256(wrapperContents),
            codegraphTarget: '@colbymchenry/codegraph@1.2.0',
            env: {
              NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
              NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
            },
          },
        }),
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);

    const result = runDoctor(root, [
      '--direct-mcp-error=Transport closed',
      '--observed-at=2026-07-07T10:00:00.000Z',
    ], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '{not-json',
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentWrapper).toBeNull();
    expect(report.hostMcp.currentContextWrapper).toBeNull();
    expect(report.hostMcp.rootCauseSummary.observed.logEvidence).toEqual(expect.objectContaining({
      observedAt: '2026-07-07T10:00:00.000Z',
      latestLogAgeMs: 2_500_000,
      staleAgainstObservedAt: true,
      hasCurrentWrapperEvidence: false,
      noCurrentWrapperEvidence: true,
      liveWrapperLogFilter: expect.objectContaining({
        applied: false,
        ignoredWrapperStarts: 0,
        ignoredContextResponses: 0,
      }),
      currentEvidenceWindow: expect.objectContaining({
        applied: true,
        ignoredWrapperStarts: 1,
        ignoredContextResponses: 1,
      }),
    }));
  });

  it('does not fail a stale context-pack wrapper that is older than a fresh host wrapper start', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const freshHash = '54178e9a9c162933b1ecbaa36bcbbc208da284ff2948023e5fc190337869137d';
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-27T07:00:00.000Z',
          runId: 'stale-context-run',
          pid: 43001,
          wrapperPid: 43001,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: 'old-hash',
        }),
        JSON.stringify({
          ts: '2026-06-27T07:01:00.000Z',
          runId: 'stale-context-run',
          event: 'nanoflow.context.response',
          wrapperStart: {
            ts: '2026-06-27T07:00:00.000Z',
            runId: 'stale-context-run',
            pid: 43001,
            wrapperPid: 43001,
            scriptPath: wrapperPath,
            scriptSha256: 'old-hash',
          },
        }),
        JSON.stringify({
          ts: '2026-06-27T07:02:00.000Z',
          runId: 'fresh-run',
          pid: 43002,
          wrapperPid: 43002,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: freshHash,
        }),
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const env = {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 43001,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
        {
          pid: 43002,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
      ]),
    };

    const result = runDoctor(root, ['--explain'], env);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('currentWrapper=fresh');
    expect(result.stdout).toContain('currentContextWrapper=unknown-after-fresh-wrapper');
    const jsonResult = runDoctor(root, [], env);
    const report = JSON.parse(jsonResult.stdout);
    expect(report.hostMcp.currentContextWrapperRawMatchesDisk).toBe(false);
    expect(report.hostMcp.currentContextWrapperMatchesDisk).toBeNull();
    expect(report.hostMcp.currentContextWrapperSupersededByFreshWrapper).toBe(true);
  });

  it('fails stale context-pack evidence when it responds after a fresh host wrapper start', () => {
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
    const freshHash = sha256(wrapperContents);
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-27T07:00:00.000Z',
          runId: 'stale-context-run',
          pid: 43003,
          wrapperPid: 43003,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: 'old-hash',
        }),
        JSON.stringify({
          ts: '2026-06-27T07:02:00.000Z',
          runId: 'fresh-run',
          pid: 43004,
          wrapperPid: 43004,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: freshHash,
        }),
        JSON.stringify({
          ts: '2026-06-27T07:03:00.000Z',
          runId: 'stale-context-run',
          event: 'nanoflow.context.response',
          requestId: 'stale-context-after-fresh-start',
          wrapperStart: {
            ts: '2026-06-27T07:00:00.000Z',
            runId: 'stale-context-run',
            pid: 43003,
            wrapperPid: 43003,
            scriptPath: wrapperPath,
            scriptSha256: 'old-hash',
          },
        }),
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const env = {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 43003,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
        {
          pid: 43004,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
      ]),
    };

    const result = runDoctor(root, [], env);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentWrapperMatchesDisk).toBe(true);
    expect(report.hostMcp.currentContextWrapperRawMatchesDisk).toBe(false);
    expect(report.hostMcp.currentContextWrapperMatchesDisk).toBe(false);
    expect(report.hostMcp.currentContextWrapperSupersededByFreshWrapper).toBe(false);
    expect(report.hostMcp.currentContextWrapperLatestTs).toBe('2026-06-27T07:03:00.000Z');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:current-context-wrapper',
        ok: false,
      }),
    ]));
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
    const env = {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    };

    const result = runDoctor(root, [], env);

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
