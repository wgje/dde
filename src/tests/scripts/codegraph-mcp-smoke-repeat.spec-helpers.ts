import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphMcpSmokeRepeatSpecContext {
  repoRoot: string;
  smokeScriptPath: string;
  makeFakeCodegraph(): string;
  makeFreshMcpProject(): string;
}

export function registerCodegraphMcpSmokeRepeatSpecs(
  context: CodegraphMcpSmokeRepeatSpecContext,
): void {
  const { repoRoot, smokeScriptPath, makeFakeCodegraph, makeFreshMcpProject } = context;

  it('supports repeated context and overlay checks in one wrapper process', () => {
    const fakeCodegraph = makeFakeCodegraph();
    const projectRoot = makeFreshMcpProject();
    const result = spawnSync(
      process.execPath,
      [
        smokeScriptPath,
        '--root',
        projectRoot,
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
    const projectRoot = makeFreshMcpProject();
    const result = spawnSync(
      process.execPath,
      [
        smokeScriptPath,
        '--root',
        projectRoot,
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

  it.each([
    { label: 'nonzero', hook: 'process.exit = code => originalExit(code === 0 ? 23 : code);', expected: 'exitCode=23 signal=none', unexpected: 'exitCode=timeout' },
    { label: 'signal', hook: 'process.exit = code => originalExit(code === 0 ? 23 : code);', expected: 'exitCode=null signal=SIGTERM', unexpected: 'exitCode=timeout' },
    { label: 'timeout', hook: 'process.exit = code => { if (code === 0) setInterval(() => {}, 1_000); else originalExit(code); };', expected: 'exitCode=timeout signal=none', unexpected: 'exitCode=null' },
  ])('fails closed for $label wrapper shutdown after completing responses', ({ label, hook, expected, unexpected }) => {
    const fakeCodegraph = makeFakeCodegraph();
    const projectRoot = makeFreshMcpProject();
    const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-smoke-wrapper-exit-'));
    const hookPath = path.join(hookRoot, 'force-wrapper-exit.cjs');
    fs.writeFileSync(hookPath, [
      "'use strict';",
      "const path = require('node:path');",
      ...(label === 'signal' ? [`const childProcess = require('node:child_process'); const originalSpawn = childProcess.spawn.bind(childProcess); childProcess.spawn = (...args) => { const child = originalSpawn(...args); if (path.basename(args[1]?.[0] ?? '') === 'codegraph-nanoflow-mcp-stdio.cjs' && path.resolve(args[1]?.[1] ?? '') === ${JSON.stringify(path.resolve(fakeCodegraph))}) { const originalOnce = child.once.bind(child); child.once = (event, listener) => originalOnce(event, event === 'exit' ? () => listener(null, 'SIGTERM') : listener); } return child; };`] : []),
      `if (path.basename(process.argv[1] ?? '') === 'codegraph-nanoflow-mcp-stdio.cjs'`,
      `    && path.resolve(process.argv[2] ?? '') === ${JSON.stringify(path.resolve(fakeCodegraph))}) {`,
      '  const originalExit = process.exit.bind(process);',
      `  ${hook}`,
      '}',
    ].join('\n'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          smokeScriptPath,
          '--root',
          projectRoot,
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
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${hookPath}`].filter(Boolean).join(' '),
          },
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('wrapper-shutdown-failure');
      expect(result.stderr).toContain(expected);
      expect(result.stderr).not.toContain(unexpected);
      expect(result.stdout).toBe('');
    } finally {
      fs.rmSync(hookRoot, { recursive: true, force: true });
    }
  }, 120_000);
}
