import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

interface CodegraphMcpSmokeAdapterSpecContext {
  repoRoot: string;
  smokeScriptPath: string;
  analyzerScriptPath: string;
  makeFakeCodegraph(): string;
  trackTempRoot(root: string): void;
}

export function registerCodegraphMcpSmokeAdapterSpecs(
  context: CodegraphMcpSmokeAdapterSpecContext,
): void {
  const { repoRoot, smokeScriptPath, analyzerScriptPath, makeFakeCodegraph, trackTempRoot } = context;

  it('honors an explicit wrapper diagnostics log path for gate-owned evidence', () => {
    const fakeCodegraph = makeFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-log-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'codegraph-adapter-gate-mcp-wrapper.log');
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
        '--timeout-ms',
        '60000',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      ok?: boolean;
      logPath?: string;
      logAnalysis?: {
        currentWrapper?: { matchesDisk?: boolean };
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.logPath).toBe(logPath);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('"event":"wrapper.start"');
  }, 90_000);

  it('keeps the top-ranked overlay source first in smoke diagnostics', () => {
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
        'scripts/codegraph-adapter-context.cjs',
        '--overlay-query',
        'sync-required-field',
        '--overlay-limit',
        '5',
        '--overlay-query-limit',
        '5',
        '--timeout-ms',
        '90000',
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

    const summary = JSON.parse(result.stdout) as { logPath?: string };
    expect(summary.logPath).toEqual(expect.any(String));

    const analysis = spawnSync(
      process.execPath,
      [analyzerScriptPath, summary.logPath as string, '--json', '--fail-on-critical'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    expect(analysis.status, [
      `stdout: ${analysis.stdout}`,
      `stderr: ${analysis.stderr}`,
      `error: ${analysis.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const logSummary = JSON.parse(analysis.stdout) as {
      contextSourceOrdering?: {
        total?: number;
        withDiagnostics?: number;
        missingDiagnostics?: number;
        topRankedNotFirst?: number;
        topRankedMissing?: number;
        duplicateSourceSections?: number;
        latestIssue?: unknown;
      };
    };
    expect(logSummary.contextSourceOrdering).toEqual(expect.objectContaining({
      total: 1,
      withDiagnostics: 1,
      missingDiagnostics: 0,
      topRankedNotFirst: 0,
      topRankedMissing: 0,
      duplicateSourceSections: 0,
      latestIssue: null,
    }));
  }, 120_000);
}
