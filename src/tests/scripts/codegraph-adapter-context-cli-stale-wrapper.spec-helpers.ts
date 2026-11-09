import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterContextCliStaleWrapperSpecContext {
  repoRoot: string;
  adapterContextScriptPath: string;
  trackTempRoot: (root: string) => void;
  makeMaxFilesSensitiveFakeCodegraph: () => string;
  makeConfigBackedAdapterProject: () => string;
}

export function registerCodegraphAdapterContextCliStaleWrapperSpecs(
  context: CodegraphAdapterContextCliStaleWrapperSpecContext,
): void {
  it('focuses stale wrapper lifecycle queries and keeps JSON overlay output compact', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const fakeCodegraph = context.makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-stale-wrapper-'));
    context.trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        context.adapterContextScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'stale wrapper host restart',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '10000',
        '--json',
      ],
      {
        cwd: context.repoRoot,
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
      contextText?: string;
      overlayQuery?: string;
      overlay?: {
        query?: string;
        matches?: unknown[];
        markdown?: string;
        omittedFields?: string[];
      };
      diagnostics?: {
        overlayCompacted?: boolean;
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.contextText).toContain('base maxFiles=1');
    expect(summary.overlayQuery).toBe('stale wrapper host restart');
    expect(summary.overlay?.query).toBe('stale wrapper host restart');
    expect(summary.overlay?.matches).toEqual(expect.any(Array));
    expect(summary.overlay?.markdown).toBeUndefined();
    expect(summary.overlay?.omittedFields).toContain('markdown');
    expect(summary.diagnostics?.overlayCompacted).toBe(true);
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"baseQuery":"stale wrapper"');
    expect(logText).toContain('"overlayQuery":"stale wrapper"');
    expect(logText).toContain('"baseMaxFiles":1');
  }, 60_000);
}
