import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

interface CodegraphMcpSmokeRepeatSpecContext {
  repoRoot: string;
  smokeScriptPath: string;
  makeFakeCodegraph(): string;
}

export function registerCodegraphMcpSmokeRepeatSpecs(
  context: CodegraphMcpSmokeRepeatSpecContext,
): void {
  const { repoRoot, smokeScriptPath, makeFakeCodegraph } = context;

  it('supports repeated context and overlay checks in one wrapper process', () => {
    const fakeCodegraph = makeFakeCodegraph();
    const result = spawnSync(
      process.execPath,
      [
        smokeScriptPath,
        '--root',
        repoRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'ProjectShellComponent',
        '--overlay-query',
        'sync-rule-keyword',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--repeat',
        '2',
        '--timeout-ms',
        '60000',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      ok?: boolean;
      repeat?: number;
      steps?: string[];
      logAnalysis?: {
        transportHealthy?: boolean;
        criticalTransportFailures?: number;
        overlayTimeouts?: { count?: number };
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.repeat).toBe(2);
    expect(summary.steps).toEqual([
      'tools/list:first',
      'resources/list',
      'resources/templates/list',
      'nanoflow_context_pack:1',
      'nanoflow_overlay_query:1',
      'tools/list:after-1',
      'nanoflow_context_pack:2',
      'nanoflow_overlay_query:2',
      'tools/list:after-2',
    ]);
    expect(summary.logAnalysis).toEqual(expect.objectContaining({
      transportHealthy: true,
      criticalTransportFailures: 0,
      overlayTimeouts: expect.objectContaining({ count: 0 }),
    }));
  }, 120_000);

  it('keeps the wrapper alive across delayed repeat rounds in one process', () => {
    const fakeCodegraph = makeFakeCodegraph();
    const result = spawnSync(
      process.execPath,
      [
        smokeScriptPath,
        '--root',
        repoRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'ProjectShellComponent',
        '--overlay-query',
        'sync-rule-keyword',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--repeat',
        '2',
        '--round-delay-ms',
        '25',
        '--timeout-ms',
        '60000',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      ok?: boolean;
      repeat?: number;
      roundDelayMs?: number;
      steps?: string[];
      logAnalysis?: {
        transportHealthy?: boolean;
        criticalTransportFailures?: number;
        overlayTimeouts?: { count?: number };
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.repeat).toBe(2);
    expect(summary.roundDelayMs).toBe(25);
    expect(summary.steps).toEqual([
      'tools/list:first',
      'resources/list',
      'resources/templates/list',
      'nanoflow_context_pack:1',
      'nanoflow_overlay_query:1',
      'tools/list:after-1',
      'round-delay:1',
      'nanoflow_context_pack:2',
      'nanoflow_overlay_query:2',
      'tools/list:after-2',
    ]);
    expect(summary.logAnalysis).toEqual(expect.objectContaining({
      transportHealthy: true,
      criticalTransportFailures: 0,
      overlayTimeouts: expect.objectContaining({ count: 0 }),
    }));
  }, 120_000);
}
