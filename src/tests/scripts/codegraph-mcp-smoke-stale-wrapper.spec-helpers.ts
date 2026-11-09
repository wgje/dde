import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

interface CodegraphMcpSmokeStaleWrapperSpecContext {
  repoRoot: string;
  smokeScriptPath: string;
  makeFakeCodegraph: () => string;
}

export function registerCodegraphMcpSmokeStaleWrapperSpecs(
  context: CodegraphMcpSmokeStaleWrapperSpecContext,
): void {
  const { repoRoot, smokeScriptPath, makeFakeCodegraph } = context;

  it('keeps NanoFlow tools usable when a long-lived wrapper becomes stale on disk', () => {
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
        '--simulate-stale-wrapper-script',
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
      simulateStaleWrapperScript?: boolean;
      staleWrapperVerified?: boolean;
      staleWrapperRecycled?: boolean;
      steps?: string[];
      logAnalysis?: {
        transportHealthy?: boolean;
        criticalTransportFailures?: number;
        currentWrapper?: { matchesDisk?: boolean };
        currentContextWrapper?: { matchesDisk?: boolean };
        wrapperExit?: { failureClass?: string; expectedExit?: boolean };
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.simulateStaleWrapperScript).toBe(true);
    expect(summary.staleWrapperVerified).toBe(true);
    expect(summary.staleWrapperRecycled).toBe(true);
    expect(summary.steps).toEqual([
      'tools/list:first',
      'wrapper-script:stale-on-disk',
      'resources/list',
      'resources/templates/list',
      'nanoflow_context_pack',
      'wrapper-script:stale-recycled',
    ]);
    expect(summary.logAnalysis).toEqual(expect.objectContaining({
      transportHealthy: true,
      criticalTransportFailures: 0,
      currentWrapper: expect.objectContaining({ matchesDisk: false }),
      currentContextWrapper: expect.objectContaining({ matchesDisk: false }),
      wrapperExit: expect.objectContaining({
        failureClass: 'stale-wrapper-script',
        expectedExit: true,
      }),
    }));
  }, 90_000);
}
