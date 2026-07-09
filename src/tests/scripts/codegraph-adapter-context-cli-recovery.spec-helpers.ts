import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterContextCliRecoverySpecContext {
  repoRoot: string;
  adapterContextScriptPath: string;
  trackTempRoot(root: string): void;
  makeConfigBackedAdapterProject(): string;
  makeContextReturningFakeCodegraph(): string;
  makeHangingExploreFakeCodegraph(): string;
  makeMaxFilesSensitiveFakeCodegraph(): string;
  makeTempAdapterProject(): string;
}

export function registerCodegraphAdapterContextCliRecoverySpecs(
  context: CodegraphAdapterContextCliRecoverySpecContext,
): void {
  const {
    repoRoot,
    adapterContextScriptPath,
    trackTempRoot,
    makeConfigBackedAdapterProject,
    makeContextReturningFakeCodegraph,
    makeHangingExploreFakeCodegraph,
    makeMaxFilesSensitiveFakeCodegraph,
    makeTempAdapterProject,
  } = context;

  it('fails required overlay quality checks when the provenance query returns no results', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-empty-overlay-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'empty overlay quality gate',
        '--overlay-query',
        'empty-overlay-result',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--max-files',
        '1',
        '--timeout-ms',
        '15000',
        '--json',
        '--require-overlay-match',
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

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Overlay query "empty-overlay-result" returned no usable results');
    expect(result.stderr).toContain('resultCount=0');
    expect(result.stderr).toContain(`logPath=${logPath}`);
  }, 60_000);

  it('does not spend a second base retry after tooling overlay-only timeout recovery', () => {
    const fakeCodegraph = makeHangingExploreFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-overlay-only-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
        '--root',
        repoRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'codegraph mcp wrapper timeout truncation source ordering log guard',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '8000',
        '--json',
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
      toolingTriageFastTimeout?: boolean;
      wrapperRequestTimeoutMs?: number;
      diagnostics?: {
        contextAttempts?: Array<{
          maxFiles?: number;
          maxFilesOmitted?: boolean;
          partial?: boolean;
          failureClass?: string;
        }>;
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.wrapperRequestTimeoutMs).toBeLessThan(8000);
    expect(summary.diagnostics?.contextAttempts).toEqual([
      expect.objectContaining({
        maxFiles: 8,
        maxFilesOmitted: true,
        partial: true,
        failureClass: 'base-codegraph-timeout-overlay-only',
      }),
    ]);
    const logText = fs.readFileSync(logPath, 'utf8');
    const contextRequestCount = (logText.match(/"event":"nanoflow\.context\.child\.request"/g) ?? []).length;
    expect(contextRequestCount).toBe(1);
  }, 60_000);

  it('keeps context output when the standalone overlay provenance query exceeds the output budget', () => {
    const projectRoot = makeTempAdapterProject();
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-overlay-max-buffer-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'codegraph adapter gate log guard oversized overlay provenance',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--max-files',
        '1',
        '--timeout-ms',
        '15000',
        '--json',
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
      contextText?: string;
      overlay?: { unavailable?: boolean; failureClass?: string; message?: string };
      diagnostics?: {
        overlayUnavailable?: boolean;
        overlayFailureClass?: string;
        overlayTextBytes?: number;
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.contextText).toContain('scripts/analyze-codegraph-mcp-log.cjs');
    expect(summary.overlay).toEqual(expect.objectContaining({
      unavailable: true,
      failureClass: 'overlay-mcp-error',
    }));
    expect(summary.overlay?.message).toContain('exceeded 16777216 bytes');
    expect(summary.diagnostics).toEqual(expect.objectContaining({
      overlayUnavailable: true,
      overlayFailureClass: 'overlay-mcp-error',
      overlayTextBytes: 0,
    }));
  }, 60_000);

  it('retries base CodeGraph timeouts with a narrower maxFiles budget', () => {
    const fakeCodegraph = makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-retry-'));
    trackTempRoot(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
        '--root',
        repoRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'WorkspaceShellBeforeUnloadController setup cleanup beforeUnloadGuard beforeUnloadManager isBrowser',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--max-files',
        '8',
        '--timeout-ms',
        '10000',
        '--json',
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
      maxFiles?: number;
      contextText?: string;
      diagnostics?: {
        contextAttempts?: Array<{ maxFiles?: number; isError?: boolean; failureClass?: string }>;
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.maxFiles).toBe(8);
    expect(summary.contextText).toContain('base maxFiles=1');
    const attempts = summary.diagnostics?.contextAttempts ?? [];
    expect(attempts[0]).toEqual(expect.objectContaining({
      maxFiles: 8,
      isError: false,
      mcpIsError: false,
      partial: true,
      failureClass: 'base-codegraph-timeout-overlay-only',
    }));
    expect(attempts.at(-1)).toEqual(expect.objectContaining({
      maxFiles: 1,
      isError: false,
    }));
    expect(['success', 'overlay-timeout']).toContain(attempts.at(-1)?.failureClass);
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"event":"nanoflow.context.timeout"');
    expect(logText).toContain('"maxFiles":8');
    expect(logText).toContain('"maxFiles":1');
  }, 60_000);
}
