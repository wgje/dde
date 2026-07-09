import { createHash } from 'node:crypto';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterDoctorHostMcpSpecContext {
  makeRoot(): string;
  trackTempRoot(root: string): void;
  runDoctor(root: string, args?: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  writePackage(root: string, scripts: Record<string, string>): void;
  requiredScripts(): Record<string, string>;
  writeCodexConfig(
    root: string,
    codexConfigPath: string,
    command?: string,
    codegraphTarget?: string,
  ): void;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function registerCodegraphAdapterDoctorHostMcpSpecs(
  context: CodegraphAdapterDoctorHostMcpSpecContext,
): void {
  const {
    makeRoot,
    trackTempRoot,
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  } = context;

  it('reports current CodeGraph auto-sync disabled as an index-frozen host MCP check', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperSource = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperSource);
    const wrapperSha256 = sha256(wrapperSource);
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-29T13:00:00.000Z',
          runId: 'autosync-disabled',
          pid: 41000,
          wrapperPid: 41000,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: '@colbymchenry/codegraph@1.2.0',
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:01.000Z',
          runId: 'autosync-disabled',
          event: 'child.stderr',
          text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen. Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:02.000Z',
          runId: 'autosync-disabled',
          event: 'nanoflow.context.response',
          requestId: 'context-after-autosync-warning',
          failureClass: 'success',
        }),
      ].join('\n') + '\n',
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
          pid: 41000,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 1,
      latest: expect.objectContaining({
        event: 'child.stderr',
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:current-autosync-disabled',
        ok: false,
        investigation: expect.objectContaining({
          failureBoundary: 'base-codegraph-index-watcher',
          failureClass: 'codegraph-autosync-disabled',
        }),
      }),
    ]));
    expect(report.hostMcp.recommendation).toEqual(expect.arrayContaining([
      expect.stringContaining('run codegraph sync'),
    ]));
  });

  it('reports current context response auto-sync warnings as an index-frozen host MCP check', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperSource = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperSource);
    const wrapperSha256 = sha256(wrapperSource);
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-29T13:00:00.000Z',
          runId: 'autosync-response-warning',
          pid: 41003,
          wrapperPid: 41003,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: '@colbymchenry/codegraph@1.2.0',
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:02.000Z',
          runId: 'autosync-response-warning',
          pid: 41003,
          wrapperPid: 41003,
          event: 'nanoflow.context.response',
          requestId: 'context-with-autosync-warning',
          failureClass: 'success',
          baseResponseWarnings: {
            codegraphAutoSyncDisabled: true,
            failureClass: 'codegraph-autosync-disabled',
            textTail: [
              'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.',
              '',
              'should-not-leak-full-warning-body',
              'x'.repeat(5_000),
            ].join('\n'),
            shouldNotLeakHeavyDiagnostic: 'should-not-leak-doctor-warning',
          },
        }),
      ].join('\n') + '\n',
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
          pid: 41003,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentCodegraphAutoSyncDisabled.latest).toEqual(expect.objectContaining({
      event: 'nanoflow.context.response',
      failureClass: 'codegraph-autosync-disabled',
      baseResponseWarnings: expect.objectContaining({
        codegraphAutoSyncDisabled: true,
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(JSON.stringify(report.hostMcp.currentCodegraphAutoSyncDisabled.latest)).not.toContain('should-not-leak');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:current-autosync-disabled',
        ok: false,
      }),
    ]));
  });

  it('reports auto-sync disabled warnings from live non-current wrappers as direct MCP risk', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperSource = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperSource);
    const wrapperSha256 = sha256(wrapperSource);
    const expectedTarget = '@colbymchenry/codegraph@1.2.0';
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-07-07T03:40:00.000Z',
          runId: 'older-live-run',
          pid: 41001,
          wrapperPid: 41001,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: expectedTarget,
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: '2026-07-07T03:40:10.000Z',
          runId: 'older-live-run',
          wrapperPid: 41001,
          event: 'child.stderr',
          text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen. Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
        }),
        JSON.stringify({
          ts: '2026-07-07T03:45:00.000Z',
          runId: 'fresh-live-run',
          pid: 41002,
          wrapperPid: 41002,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: expectedTarget,
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
      ].join('\n') + '\n',
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
          pid: 41001,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} ${expectedTarget} serve --mcp --path ${root}`,
        },
        {
          pid: 41002,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} ${expectedTarget} serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 0,
      latest: null,
    }));
    expect(report.hostMcp.activeCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 1,
      latest: expect.objectContaining({
        runId: 'older-live-run',
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(report.hostMcp.activeCodegraphAutoSyncDisabledRuns).toEqual([
      expect.objectContaining({
        runId: 'older-live-run',
        pid: 41001,
        codegraphTarget: expectedTarget,
        count: 1,
      }),
    ]);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:current-autosync-disabled',
        ok: true,
      }),
      expect.objectContaining({
        name: 'host-mcp:active-autosync-disabled',
        ok: false,
      }),
    ]));
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-stale-or-index-frozen',
      failureClasses: expect.arrayContaining([
        'codegraph-autosync-disabled',
        'active-wrapper-autosync-disabled',
      ]),
      observed: expect.objectContaining({
        activeAutoSyncDisabledCount: 1,
        activeAutoSyncDisabledRuns: expect.arrayContaining([
          expect.objectContaining({
            runId: 'older-live-run',
            pid: 41001,
          }),
        ]),
      }),
    }));
    expect(report.hostMcp.recommendation).toEqual(expect.arrayContaining([
      expect.stringContaining('activeCodegraphAutoSyncDisabledRuns'),
    ]));
  });

  it('limits active auto-sync run details in human-readable root-cause output', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperSource = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperSource);
    const wrapperSha256 = sha256(wrapperSource);
    const expectedTarget = '@colbymchenry/codegraph@1.2.0';
    const warningText = 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen.';
    const wrapperEvents = Array.from({ length: 7 }, (_, index) => {
      const pid = 42000 + index;
      const runId = `autosync-live-${index}`;
      return [
        JSON.stringify({
          ts: `2026-07-07T04:0${index}:00.000Z`,
          runId,
          pid,
          wrapperPid: pid,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: expectedTarget,
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: `2026-07-07T04:0${index}:10.000Z`,
          runId,
          wrapperPid: pid,
          event: 'child.stderr',
          text: warningText,
        }),
      ];
    }).flat();
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      `${wrapperEvents.join('\n')}\n`,
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);

    const result = runDoctor(root, ['--explain'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify(
        Array.from({ length: 7 }, (_, index) => ({
          pid: 42000 + index,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} ${expectedTarget} serve --mcp --path ${root}`,
        })),
      ),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(result.stdout).toContain('activeAutoSyncDisabled=7');
    expect(result.stdout).toContain('runId=autosync-live-0');
    expect(result.stdout).toContain('runId=autosync-live-4');
    expect(result.stdout).toContain('+2 more');
    expect(result.stdout).not.toContain('runId=autosync-live-5');
    expect(result.stdout).not.toContain('runId=autosync-live-6');
  });

  it('uses live wrapper process ids to ignore stale fixture wrapper log entries', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperSource = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperSource);
    const wrapperSha256 = sha256(wrapperSource);
    const expectedTarget = '@colbymchenry/codegraph@1.2.0';
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-07-06T08:30:00.000Z',
          runId: 'live-host-run',
          pid: 7771,
          wrapperPid: 7771,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: expectedTarget,
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: '2026-07-06T08:32:00.000Z',
          runId: 'fixture-run',
          pid: 8882,
          wrapperPid: 8882,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: path.join(root, 'fake-codegraph-framed.cjs'),
          env: {},
        }),
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath, process.execPath, expectedTarget);

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 7771,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} ${expectedTarget} serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentWrapper).toEqual(expect.objectContaining({
      runId: 'live-host-run',
      wrapperPid: 7771,
      codegraphTarget: expectedTarget,
    }));
    expect(report.hostMcp.liveWrapperLogFilter).toEqual(expect.objectContaining({
      applied: true,
      ignoredWrapperStarts: 1,
    }));
    expect(report.hostMcp.currentWrapperTargetMatchesConfig).toBe(true);
    expect(report.hostMcp.currentWrapperEnvMatchesConfig).toBe(true);
  });

  it('ignores PowerShell process-list commands that mention the wrapper path', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    writeFileSync(wrapperPath, 'fresh wrapper\n');
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath, process.execPath);

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 7773,
          parentPid: 13880,
          commandLine: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${wrapperPath}*' }"`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.liveProcesses).toEqual(expect.objectContaining({
      checked: true,
      matchingWrapperCount: 0,
      commandMismatchCount: 0,
      targetMismatchCount: 0,
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:live-process-config',
        ok: true,
      }),
    ]));
  });

  it('prints expected and actual values for failing Codex MCP environment checks', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeFileSync(
      codexConfigPath,
      [
        '[mcp_servers.codegraph]',
        'command = "node"',
        'args = [',
        `  ${JSON.stringify(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))},`,
        '  "@colbymchenry/codegraph@1.2.0",',
        '  "serve",',
        '  "--mcp",',
        `  ${JSON.stringify('--path')},`,
        `  ${JSON.stringify(root)},`,
        ']',
        '',
        '[mcp_servers.codegraph.env]',
        'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "1000"',
        '',
      ].join('\n'),
    );

    const result = runDoctor(root, ['--explain'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '- FAIL mcp-config:env:NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS expected=30000 actual=1000',
    );
    expect(result.stdout).toContain(
      '- FAIL mcp-config:env:NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE expected=0 actual=<missing>',
    );
  });
}
