import { createHash } from 'node:crypto';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterDoctorLiveProcessSpecContext {
  makeRoot(): string;
  trackTempRoot(root: string): void;
  runDoctor(root: string, args?: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  writePackage(root: string, scripts: Record<string, string>): void;
  requiredScripts(): Record<string, string>;
  writeCodexConfig(root: string, codexConfigPath: string, command?: string, codegraphTarget?: string): void;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function registerWindowsNativeProcessEnumerationSpec(makeRoot: () => string): void {
  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('enumerates a live wrapper through the bounded Windows native snapshot', async () => {
    const root = makeRoot();
    const wrapperPath = path.join(root, 'codegraph-nanoflow-mcp-stdio.cjs');
    writeFileSync(wrapperPath, 'setInterval(() => {}, 1_000);\n');
    const child = spawn(
      process.execPath,
      [wrapperPath, '@colbymchenry/codegraph@1.6.2', 'serve', '--mcp', '--path', root],
      { stdio: 'ignore', windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const helperPath = path.join(
        process.cwd(),
        'scripts',
        'codegraph-adapter-doctor-live-processes.cjs',
      );
      const probe = [
        `const helper = require(${JSON.stringify(helperPath)});`,
        'process.stdout.write(JSON.stringify(helper.readLiveProcessList()));',
      ].join(' ');
      const env = { ...process.env };
      delete env.NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON;
      env.NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_SNAPSHOT_TIMEOUT_MS = '5000';
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, ['-e', probe], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env,
        timeout: 7_000,
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(7_000);
      const report = JSON.parse(result.stdout);
      expect(report).toEqual(expect.objectContaining({
        available: true,
        source: 'powershell-native',
        error: null,
      }));
      expect(report.processes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pid: child.pid,
          parentPid: process.pid,
          parentName: expect.stringMatching(/^node(?:\.exe)?$/i),
          parentCommandLine: expect.any(String),
          startedAt: expect.any(String),
          commandLine: expect.stringContaining('codegraph-nanoflow-mcp-stdio.cjs'),
        }),
      ]));
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill();
        await Promise.race([
          exited,
          new Promise(resolve => setTimeout(resolve, 2_000)),
        ]);
      }
    }
  });
}

export function registerCodegraphAdapterDoctorLiveProcessSpecs(
  context: CodegraphAdapterDoctorLiveProcessSpecContext,
): void {
  const {
    makeRoot,
    trackTempRoot,
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  } = context;

  registerWindowsNativeProcessEnumerationSpec(makeRoot);

  it('preserves live process start time for PID reuse diagnostics', () => {
    const helperPath = path.join(process.cwd(), 'scripts', 'codegraph-adapter-doctor-live-processes.cjs');
    const probe = [
      `const helper = require(${JSON.stringify(helperPath)});`,
      'process.stdout.write(JSON.stringify(helper.readLiveProcessList()));',
    ].join(' ');
    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([{
          pid: 51860,
          parentPid: 54276,
          parentName: 'codex.exe',
          parentCommandLine: 'codex.exe app-server',
          startedAt: '2026-07-13T20:41:17.000Z',
          commandLine: 'node scripts/codegraph-nanoflow-mcp-stdio.cjs @colbymchenry/codegraph@1.6.2',
        }]),
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      available: true,
      processes: [expect.objectContaining({
        pid: 51860,
        parentName: 'codex.exe',
        parentCommandLine: 'codex.exe app-server',
        startedAt: '2026-07-13T20:41:17.000Z',
      })],
    }));
  });

  it('ignores historical wrapper runs when the operating system reuses a live PID', () => {
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
    const expectedTarget = '@colbymchenry/codegraph@1.6.2';
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-07-06T18:08:15.331Z',
          runId: 'historical-direct-watcher',
          pid: 51860,
          wrapperPid: 51860,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: '@colbymchenry/codegraph@1.1.1',
          env: {
            CODEGRAPH_NO_DAEMON: '1',
            CODEGRAPH_NO_WATCH: '0',
            CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
            CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
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
        JSON.stringify({
          ts: '2026-07-06T18:08:16.331Z',
          runId: 'historical-direct-watcher',
          pid: 51860,
          wrapperPid: 51860,
          event: 'child.stderr',
          text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen. Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
        }),
        JSON.stringify({
          ts: '2026-07-06T18:08:17.331Z',
          runId: 'historical-direct-watcher',
          pid: 51860,
          wrapperPid: 51860,
          event: 'nanoflow.context.response',
          requestId: 'historical-context',
          failureClass: 'success',
        }),
        JSON.stringify({
          ts: '2026-07-13T20:41:18.047Z',
          runId: 'current-shared-daemon',
          pid: 51860,
          wrapperPid: 51860,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: expectedTarget,
          env: {
            CODEGRAPH_NO_DAEMON: '0',
            CODEGRAPH_NO_WATCH: '0',
            CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
            CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
          effectiveChildEnv: {
            CODEGRAPH_NO_DAEMON: '0',
            CODEGRAPH_NO_WATCH: '0',
            CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
            CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
          },
          runtimeTopology: {
            mode: 'shared-daemon-proxy',
            watcherOwnership: 'shared-daemon-single-watcher',
            fileLockContentionRisk: 'single-writer',
            daemonDisabled: false,
            watchDisabled: false,
          },
        }),
        JSON.stringify({
          ts: '2026-07-13T20:41:20.047Z',
          runId: 'current-shared-daemon',
          pid: 51860,
          wrapperPid: 51860,
          event: 'nanoflow.context.response',
          requestId: 'current-context',
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
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([{
        pid: 51860,
        parentPid: 54276,
        startedAt: '2026-07-13T20:41:17.000Z',
        commandLine: `"${process.execPath}" ${wrapperPath} ${expectedTarget} serve --mcp --path ${root}`,
      }]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentWrapper).toEqual(expect.objectContaining({
      runId: 'current-shared-daemon',
      codegraphTarget: expectedTarget,
    }));
    expect(report.hostMcp.activeCodegraphAutoSyncDisabled).toEqual(expect.objectContaining({
      count: 0,
      latest: null,
    }));
    expect(report.hostMcp.activeDirectWatcherRuns).toEqual([]);
    expect(report.hostMcp.liveWrapperLogFilter).toEqual(expect.objectContaining({
      processStartClockSkewMs: 5_000,
      liveWrapperProcesses: [expect.objectContaining({
        pid: 51860,
        startedAt: '2026-07-13T20:41:17.000Z',
      })],
      ignoredPidReuseWrapperStarts: 1,
      ignoredPidReuseContextResponses: 1,
    }));
  });

  it('reports live wrapper processes that still use a command line different from Codex config', () => {
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
    const expectedCommand = path.join(root, 'codex-tools', 'node.exe');
    const expectedCodegraphTarget = path.join(root, 'vendor', 'codegraph.js');
    writeCodexConfig(root, codexConfigPath, expectedCommand, expectedCodegraphTarget);

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 7772,
          parentPid: 13880,
          commandLine: `"C:\\nvm4w\\nodejs\\node.exe" ${wrapperPath} @colbymchenry/codegraph@1.6.2 serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.liveProcesses).toEqual(expect.objectContaining({
      checked: true,
      matchingWrapperCount: 1,
      commandMismatchCount: 1,
      targetMismatchCount: 1,
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:live-process-config',
        ok: false,
        expectedCommand,
        expectedCodegraphTarget,
      }),
    ]));
  });

  it('ignores auxiliary smoke wrappers owned by a different parent process', () => {
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
    const wrapperSha256 = sha256(wrapperSource);
    const expectedTarget = '@colbymchenry/codegraph@1.6.2';
    const configuredEnv = {
      CODEGRAPH_NO_DAEMON: '0',
      CODEGRAPH_NO_WATCH: '0',
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
      CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
    };
    writeFileSync(wrapperPath, wrapperSource);
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      `${JSON.stringify({
        ts: '2026-07-13T22:00:00.000Z',
        runId: 'codex-host-wrapper',
        pid: 7775,
        wrapperPid: 7775,
        event: 'wrapper.start',
        scriptPath: wrapperPath,
        scriptSha256: wrapperSha256,
        codegraphTarget: expectedTarget,
        env: configuredEnv,
      })}\n`,
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const fakeTarget = path.join(codexConfigDir, 'fake-codegraph.cjs');

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 7775,
          parentPid: 54276,
          parentName: 'codex.exe',
          parentCommandLine: 'codex.exe app-server',
          commandLine: `"${process.execPath}" ${wrapperPath} ${expectedTarget} serve --mcp --path ${root}`,
        },
        {
          pid: 8888,
          parentPid: 10480,
          parentName: 'node.exe',
          parentCommandLine: 'node.exe vitest run codegraph-adapter-doctor.spec.ts',
          commandLine: `"${process.execPath}" ${wrapperPath} ${fakeTarget} serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.liveProcesses).toEqual(expect.objectContaining({
      matchingWrapperCount: 1,
      auxiliaryProcessCount: 1,
      commandMismatchCount: 0,
      targetMismatchCount: 0,
      hostParentPids: [54276],
      auxiliaryProcesses: [expect.objectContaining({
        pid: 8888,
        parentPid: 10480,
        observedCodegraphTarget: fakeTarget,
      })],
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:live-process-config',
        ok: true,
        auxiliaryProcessCount: 1,
      }),
    ]));
  });

  it('reports live wrapper processes that still use stale daemon env from an older Codex session', () => {
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
      `${JSON.stringify({
        ts: '2026-06-29T13:00:00.000Z',
        runId: 'live-env-stale',
        pid: 7774,
        wrapperPid: 7774,
        event: 'wrapper.start',
        scriptPath: wrapperPath,
        scriptSha256: wrapperSha256,
          env: {
            CODEGRAPH_NO_DAEMON: '0',
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
      })}\n`,
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeFileSync(
      codexConfigPath,
      [
        '[mcp_servers.codegraph]',
        'command = "node"',
        'args = [',
        `  ${JSON.stringify(wrapperPath)},`,
        '  "@colbymchenry/codegraph@1.6.2",',
        '  "serve",',
        '  "--mcp",',
        `  ${JSON.stringify('--path')},`,
        `  ${JSON.stringify(root)},`,
        ']',
        '',
        '[mcp_servers.codegraph.env]',
        'CODEGRAPH_NO_DAEMON = "1"',
        'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"',
        'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
        '',
      ].join('\n'),
    );

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 7774,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.6.2 serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentWrapperEnvMatchesConfig).toBe(false);
    expect(report.hostMcp.currentWrapperMatchesDisk).toBe(true);
    expect(report.hostMcp.scriptStaleAgainstDisk).toBe(false);
    expect(report.hostMcp.staleAgainstDisk).toBe(false);
    expect(report.hostMcp.hostConfigMismatch).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:current-wrapper-env',
        ok: false,
        expected: expect.objectContaining({
          CODEGRAPH_NO_DAEMON: '1',
        }),
        actual: expect.objectContaining({
          CODEGRAPH_NO_DAEMON: '0',
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-config',
          failureClass: 'mcp-host-env',
        }),
      }),
    ]));
  });

  it('ignores historical wrapper target mismatch when live process listing is empty', () => {
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
    const expectedCodegraphTarget = path.join(root, 'vendor', 'codegraph.js');
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-29T12:00:00.000Z',
          runId: 'historical-autosync-disabled',
          event: 'child.stderr',
          text: 'CodeGraph auto-sync is DISABLED - historical warning from an older wrapper run.',
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:00.000Z',
          runId: 'target-mismatch',
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: '@colbymchenry/codegraph@1.6.2',
        }),
      ].join('\n') + '\n',
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath, process.execPath, expectedCodegraphTarget);

    const result = runDoctor(root, ['--explain'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('hostConfigMismatch=no');
    expect(result.stdout).toContain('currentWrapper=unknown');
    expect(result.stdout).not.toContain('FAIL host-mcp:current-wrapper-target');
    expect(result.stdout).not.toContain('autoSyncDisabledTail=');
    const jsonResult = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    });
    const report = JSON.parse(jsonResult.stdout);
    expect(report.hostMcp.liveWrapperLogFilter).toEqual(expect.objectContaining({
      applied: true,
      liveWrapperPids: [],
      ignoredWrapperStarts: 1,
    }));
    expect(report.hostMcp.scriptStaleAgainstDisk).toBe(false);
    expect(report.hostMcp.hostConfigMismatch).toBe(false);
    expect(report.hostMcp.currentWrapperTargetMatchesConfig).toBeNull();
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'no-current-host-mcp-root-cause',
      directMcpTrust: 'current-host-log-clean',
      failureClasses: [],
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:live-process-config',
        ok: true,
      }),
    ]));
  });

  it('reports observed direct MCP transport closure even when no live wrapper remains', () => {
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
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-29T13:00:00.000Z',
          runId: 'old-clean-wrapper',
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: 'old-wrapper-hash',
          codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        }),
      ].join('\n') + '\n',
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

    const explainResult = runDoctor(root, ['--explain', '--direct-mcp-error', 'Transport closed'], env);

    expect(explainResult.status, explainResult.stderr || explainResult.stdout).toBe(1);
    expect(explainResult.stdout).toContain('host MCP recovery:');
    expect(explainResult.stdout).toContain('Direct CodeGraph MCP returned an error before fresh wrapper evidence was written');
    expect(explainResult.stdout).toContain('status=direct-mcp-host-transport-closed');
    expect(explainResult.stdout).toContain('failureClasses=observed-direct-mcp-transport-closed,direct-mcp-no-live-wrapper-process');
    expect(explainResult.stdout).toContain('observedDirectMcpError=Transport closed liveWrapperProcessCount=0');
    expect(explainResult.stdout).toContain('fallback=npm run codegraph:adapter:context -- --query "<query>" --json');

    const jsonResult = runDoctor(root, ['--direct-mcp-error', 'Transport closed'], env);
    const report = JSON.parse(jsonResult.stdout);
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-transport-closed',
      failureBoundary: 'codex-mcp-host-transport',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts',
      failureClasses: [
        'observed-direct-mcp-transport-closed',
        'direct-mcp-no-live-wrapper-process',
      ],
    }));
    expect(report.hostMcp.recommendation).toEqual(expect.arrayContaining([
      expect.stringContaining('connected Codex MCP host/session as closed'),
      expect.stringContaining('npm run codegraph:adapter:context'),
    ]));
  });

  it('summarizes stale direct MCP host root cause before adapter failures are misdiagnosed', () => {
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
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-29T13:00:00.000Z',
          runId: 'stale-direct-mcp',
          pid: 12092,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: 'old-wrapper-hash',
          codegraphTarget: '@colbymchenry/codegraph@1.1.1',
          env: {
            CODEGRAPH_NO_DAEMON: '0',
            CODEGRAPH_NO_WATCH: '0',
            CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
            CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:01.000Z',
          runId: 'stale-direct-mcp',
          pid: 12092,
          event: 'child.stderr',
          text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen. Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:02.000Z',
          runId: 'stale-direct-mcp',
          pid: 12092,
          event: 'nanoflow.context.response',
          requestId: 'context-after-stale-host-warning',
          failureClass: 'success',
          responseWarnings: {
            codegraphAutoSyncDisabled: true,
            failureClass: 'codegraph-autosync-disabled',
            textTail: 'irrelevant source tail without the warning banner',
          },
          wrapperStart: {
            ts: '2026-06-29T13:00:00.000Z',
            runId: 'stale-direct-mcp',
            pid: 12092,
            scriptPath: wrapperPath,
            scriptSha256: 'old-wrapper-hash',
            codegraphTarget: '@colbymchenry/codegraph@1.1.1',
            env: {
              CODEGRAPH_NO_DAEMON: '0',
              CODEGRAPH_NO_WATCH: '0',
              CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
              CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
              NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
              NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
            },
          },
        }),
      ].join('\n') + '\n',
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
          pid: 12092,
          parentPid: 3000,
          commandLine: `"C:\\nvm4w\\nodejs\\node.exe" ${wrapperPath} @colbymchenry/codegraph@1.1.1 serve --mcp --path ${root}`,
        },
      ]),
    };

    const explainResult = runDoctor(root, ['--explain'], env);

    expect(explainResult.status, explainResult.stderr || explainResult.stdout).toBe(1);
    expect(explainResult.stdout).toContain('host MCP root cause:');
    expect(explainResult.stdout).toContain('status=direct-mcp-host-stale-or-index-frozen');
    expect(explainResult.stdout).toContain('adapterFailureLikely=false');
    expect(explainResult.stdout).toContain('codegraphTarget expected=@colbymchenry/codegraph@1.6.2 current=@colbymchenry/codegraph@1.1.1');
    expect(explainResult.stdout).toContain('configuredWrapper current=<missing> context=<missing>');
    expect(explainResult.stdout).toContain(
      'envMismatches=2 current-wrapper.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS expected=30000 actual=60000; current-context-wrapper.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS expected=30000 actual=60000',
    );
    expect(explainResult.stdout).toContain('liveProcessMismatches=1 pid=12092 target=@colbymchenry/codegraph@1.1.1');
    expect(explainResult.stdout).toContain('fallback=npm run codegraph:adapter:context -- --query "<query>" --json');

    const jsonResult = runDoctor(root, [], env);
    const report = JSON.parse(jsonResult.stdout);
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-stale-or-index-frozen',
      failureBoundary: 'codex-mcp-host-and-base-codegraph-index-watcher',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts-or-index-syncs',
      fallback: 'npm run codegraph:adapter:context -- --query "<query>" --json',
      failureClasses: expect.arrayContaining([
        'mcp-host-wrapper-script-stale',
        'mcp-host-env-mismatch',
        'mcp-host-codegraph-target-mismatch',
        'mcp-host-live-process-config-mismatch',
        'codegraph-autosync-disabled',
      ]),
    }));
    expect(report.hostMcp.rootCauseSummary.expected).toEqual(expect.objectContaining({
      codegraphTarget: '@colbymchenry/codegraph@1.6.2',
    }));
    expect(report.hostMcp.rootCauseSummary.observed).toEqual(expect.objectContaining({
      currentWrapperTarget: '@colbymchenry/codegraph@1.1.1',
      currentConfiguredWrapper: null,
      currentConfiguredContextWrapper: null,
      liveProcessMismatchCount: 1,
      envMismatchCount: 2,
      envMismatches: [
        expect.objectContaining({
          scope: 'current-wrapper',
          key: 'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
          expected: '30000',
          actual: '60000',
        }),
        expect.objectContaining({
          scope: 'current-context-wrapper',
          key: 'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
          expected: '30000',
          actual: '60000',
        }),
      ],
      autoSyncDisabled: expect.objectContaining({
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(report.hostMcp.rootCauseSummary.observed.liveProcessMismatches[0]).toEqual(expect.objectContaining({
      pid: 12092,
      parentPid: 3000,
      observedCodegraphTarget: '@colbymchenry/codegraph@1.1.1',
      targetMatches: false,
    }));
  });
}
