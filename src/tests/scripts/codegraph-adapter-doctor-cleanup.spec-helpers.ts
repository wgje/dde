import { createHash } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterDoctorCleanupSpecContext {
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

export function registerCodegraphAdapterDoctorCleanupSpecs(
  context: CodegraphAdapterDoctorCleanupSpecContext,
): void {
  it('revalidates a cleanup candidate against its observed stale target', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'scripts', 'codegraph-adapter-doctor.cjs'),
      'utf8',
    );
    const cleanupSource = source.slice(
      source.indexOf('function executeStaleWrapperCleanup'),
      source.indexOf('\nfunction main()'),
    );

    expect(cleanupSource).toContain('candidate.codegraphTarget');
  });

  it('falls back to direct wrapper termination when taskkill cannot terminate the job tree', () => {
    const helperPath = path.join(
      process.cwd(),
      'scripts',
      'codegraph-adapter-doctor-live-processes.cjs',
    );
    const probe = [
      `const helper = require(${JSON.stringify(helperPath)});`,
      'const signals = [];',
      'const result = helper.terminateWindowsWrapperProcess(45140, {',
      'runTaskkill: () => ({ status: 1, stdout: "", stderr: "ERROR: Access denied" }),',
      'terminateProcess: (pid, signal) => signals.push({ pid, signal }),',
      'waitForExit: () => true,',
      '});',
      'process.stdout.write(JSON.stringify({ result, signals }));',
    ].join(' ');
    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      result: expect.objectContaining({
        ok: true,
        pid: 45140,
        reason: 'terminated-wrapper-after-taskkill-failed',
        taskkillFailure: 'exit-1',
      }),
      signals: [{ pid: 45140, signal: 'SIGTERM' }],
    });
  });

  it('builds a dry-run cleanup plan only for idle stale Codex-host wrappers', () => {
    const root = context.makeRoot();
    context.writePackage(root, context.requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperSource = 'current wrapper\n';
    writeFileSync(wrapperPath, wrapperSource);
    const currentHash = sha256(wrapperSource);
    const expectedTarget = '@colbymchenry/codegraph@1.6.2';
    const configuredEnv = {
      CODEGRAPH_NO_DAEMON: '0',
      CODEGRAPH_NO_WATCH: '0',
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
      CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
    };
    const staleEnv = {
      ...configuredEnv,
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
      CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
    };
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-07-13T22:00:00.000Z',
          runId: 'stale-idle',
          pid: 12092,
          wrapperPid: 12092,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: 'stale-wrapper-hash',
          codegraphTarget: expectedTarget,
          env: staleEnv,
        }),
        JSON.stringify({
          ts: '2026-07-13T22:00:30.000Z',
          runId: 'stale-idle',
          wrapperPid: 12092,
          event: 'child.stderr',
          text: 'CodeGraph auto-sync is DISABLED - live file watching stopped because the file lock exceeded the retry budget.',
          runtime: { activeRequestCount: 0, pendingContextPackCount: 0 },
        }),
        JSON.stringify({
          ts: '2026-07-13T22:01:00.000Z',
          runId: 'stale-idle',
          wrapperPid: 12092,
          event: 'client.response',
          failureClass: 'success',
          runtime: { activeRequestCount: 0, pendingContextPackCount: 0 },
        }),
        JSON.stringify({
          ts: '2026-07-13T23:55:00.000Z',
          runId: 'stale-active',
          pid: 12094,
          wrapperPid: 12094,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: 'another-stale-wrapper-hash',
          codegraphTarget: expectedTarget,
          env: staleEnv,
        }),
        JSON.stringify({
          ts: '2026-07-13T23:59:30.000Z',
          runId: 'stale-active',
          wrapperPid: 12094,
          event: 'client.request.start',
          runtime: { activeRequestCount: 1, pendingContextPackCount: 1 },
        }),
        JSON.stringify({
          ts: '2026-07-13T23:58:00.000Z',
          runId: 'healthy-current',
          pid: 12093,
          wrapperPid: 12093,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: currentHash,
          codegraphTarget: expectedTarget,
          env: configuredEnv,
        }),
        JSON.stringify({
          ts: '2026-07-13T23:59:00.000Z',
          runId: 'healthy-current',
          wrapperPid: 12093,
          event: 'client.response',
          runtime: { activeRequestCount: 0, pendingContextPackCount: 0 },
        }),
      ].join('\n') + '\n',
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    context.trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    context.writeCodexConfig(root, codexConfigPath);
    const processList = [
      { pid: 12092, parentPid: 54276, parentName: 'codex.exe', parentCommandLine: 'codex.exe app-server', startedAt: '2026-07-13T21:59:59.000Z' },
      { pid: 12094, parentPid: 54276, parentName: 'codex.exe', parentCommandLine: 'codex.exe app-server', startedAt: '2026-07-13T23:54:59.000Z' },
      { pid: 12093, parentPid: 54276, parentName: 'codex.exe', parentCommandLine: 'codex.exe app-server', startedAt: '2026-07-13T23:57:59.000Z' },
    ].map(processInfo => ({
      ...processInfo,
      commandLine: `"${process.execPath}" ${wrapperPath} ${expectedTarget} serve --mcp --path ${root}`,
    }));

    const result = context.runDoctor(
      root,
      [
        '--cleanup-stale-wrappers',
        '--cleanup-min-idle-ms',
        '600000',
        '--observed-at',
        '2026-07-14T00:00:00.000Z',
      ],
      {
        ...process.env,
        NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
        NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify(processList),
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const cleanup = JSON.parse(result.stdout);
    expect(cleanup).toEqual(expect.objectContaining({
      ok: true,
      command: 'cleanup-stale-wrappers',
      apply: false,
      minIdleMs: 600000,
      doctorOk: true,
    }));
    expect(cleanup.candidates).toEqual([
      expect.objectContaining({
        runId: 'stale-idle',
        pid: 12092,
        reasons: expect.arrayContaining([
          'wrapper-script-stale',
          'wrapper-env-mismatch',
          'daemon-lifetime-env-invalid',
          'codegraph-autosync-disabled',
        ]),
        activeWorkCount: 0,
      }),
    ]);
    expect(cleanup.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: 'stale-active',
        pid: 12094,
        skipReasons: expect.arrayContaining(['active-work', 'inside-min-idle-window']),
      }),
    ]));
    expect(cleanup.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'healthy-current' }),
    ]));
  });
}
