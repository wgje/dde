import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphMcpSmokeDaemonSpecContext {
  repoRoot: string;
  adapterContextScriptPath: string;
  smokeScriptPath: string;
  makeConfigBackedAdapterProject: () => string;
  makeEnvEchoFakeCodegraph: (envName: string) => string;
  makeEnvCaptureFakeCodegraph: (envName: string, capturePath: string) => string;
  writeCodexConfig: (
    projectRoot: string,
    fakeCodegraph: string,
    extraEnv?: Record<string, string>,
  ) => string;
}

export function registerCodegraphMcpSmokeDaemonSpecs(
  context: CodegraphMcpSmokeDaemonSpecContext,
): void {
  it('passes CodeGraph daemon env from Codex MCP config to the base child process', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const fakeCodegraph = context.makeEnvEchoFakeCodegraph('CODEGRAPH_NO_DAEMON');
    const codexConfigPath = context.writeCodexConfig(projectRoot, fakeCodegraph, {
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '60000',
      CODEGRAPH_DAEMON_MAX_IDLE_MS: '60000',
    });
    const result = spawnSync(
      process.execPath,
      [
        context.adapterContextScriptPath,
        '--root',
        projectRoot,
        '--query',
        'env',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--json',
        '--timeout-ms',
        '15000',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as { contextText?: string };
    expect(summary.contextText).toContain('CODEGRAPH_NO_DAEMON=1');
  }, 30_000);

  it('preserves shared daemon mode for the direct Codex MCP wrapper', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const capturePath = path.join(projectRoot, 'codegraph-no-daemon.txt');
    const fakeCodegraph = context.makeEnvCaptureFakeCodegraph('CODEGRAPH_NO_DAEMON', capturePath);
    const codexConfigPath = context.writeCodexConfig(projectRoot, fakeCodegraph, {
      CODEGRAPH_NO_DAEMON: '0',
    });
    const result = spawnSync(
      process.execPath,
      [
        context.smokeScriptPath,
        '--root',
        projectRoot,
        '--query',
        'daemon env',
        '--overlay-query',
        'sync-rule-keyword',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '15000',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);
    expect(fs.readFileSync(capturePath, 'utf8')).toBe('0');
  }, 60_000);

  it('forces the adapter fallback child to run without the shared daemon', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const fakeCodegraph = context.makeEnvEchoFakeCodegraph('CODEGRAPH_NO_DAEMON');
    const codexConfigPath = context.writeCodexConfig(projectRoot, fakeCodegraph, {
      CODEGRAPH_NO_DAEMON: '0',
    });
    const result = spawnSync(
      process.execPath,
      [
        context.adapterContextScriptPath,
        '--root',
        projectRoot,
        '--query',
        'env',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--json',
        '--timeout-ms',
        '15000',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    const summary = JSON.parse(result.stdout) as { contextText?: string };
    expect(summary.contextText).toContain('CODEGRAPH_NO_DAEMON=1');
  }, 30_000);

  it('normalizes stale non-positive daemon lifetime env before spawning the base child', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const capturePath = path.join(projectRoot, 'codegraph-daemon-idle-timeout.txt');
    const logPath = path.join(projectRoot, 'daemon-lifetime-normalization-wrapper.log');
    const fakeCodegraph = context.makeEnvCaptureFakeCodegraph(
      'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
      capturePath,
    );
    const codexConfigPath = context.writeCodexConfig(projectRoot, fakeCodegraph, {
      CODEGRAPH_NO_DAEMON: '0',
      CODEGRAPH_NO_WATCH: '0',
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
      CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
    });
    const result = spawnSync(
      process.execPath,
      [
        context.smokeScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'daemon lifetime normalization',
        '--overlay-query',
        'sync-rule-keyword',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '15000',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '0',
          CODEGRAPH_DAEMON_MAX_IDLE_MS: '0',
        },
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(fs.readFileSync(capturePath, 'utf8')).toBe('300000');
    const events = fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => JSON.parse(line) as {
        event?: string;
        corrections?: Array<{ key?: string; received?: string; effective?: string }>;
        effectiveChildEnv?: Record<string, string>;
      });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'wrapper.env.normalized',
        corrections: expect.arrayContaining([
          expect.objectContaining({
            key: 'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS',
            received: '0',
            effective: '300000',
          }),
          expect.objectContaining({
            key: 'CODEGRAPH_DAEMON_MAX_IDLE_MS',
            received: '0',
            effective: '1800000',
          }),
        ]),
      }),
      expect.objectContaining({
        event: 'wrapper.start',
        effectiveChildEnv: expect.objectContaining({
          CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '300000',
          CODEGRAPH_DAEMON_MAX_IDLE_MS: '1800000',
        }),
      }),
    ]));
  }, 60_000);

  it('keeps the shared wrapper diagnostic log within a bounded active and archive budget', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const capturePath = path.join(projectRoot, 'codegraph-no-daemon-log-budget.txt');
    const fakeCodegraph = context.makeEnvCaptureFakeCodegraph('CODEGRAPH_NO_DAEMON', capturePath);
    const logPath = path.join(projectRoot, 'bounded-wrapper.log');
    const maxLogBytes = 64 * 1024;
    const result = spawnSync(
      process.execPath,
      [
        context.smokeScriptPath,
        '--root',
        projectRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'bounded wrapper diagnostics',
        '--overlay-query',
        'sync-rule-keyword',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--repeat',
        '6',
        '--timeout-ms',
        '15000',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
          NANOFLOW_CODEGRAPH_MCP_LOG_MAX_BYTES: String(maxLogBytes),
        },
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const archivePath = `${logPath}.1`;
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(maxLogBytes);
    expect(fs.statSync(archivePath).size).toBeLessThanOrEqual(maxLogBytes);
    const currentEvents = fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => JSON.parse(line) as { diagnosticLogRotation?: unknown });
    expect(currentEvents.some(event => event.diagnosticLogRotation)).toBe(true);
  }, 60_000);

  it('restarts a shared-daemon proxy after it falls back to an in-process watcher', () => {
    const projectRoot = context.makeConfigBackedAdapterProject();
    const spawnCountPath = path.join(projectRoot, 'shared-daemon-fallback-spawn-count.txt');
    const fakeCodegraph = path.join(projectRoot, 'fake-codegraph-shared-daemon-fallback.cjs');
    const logPath = path.join(projectRoot, 'shared-daemon-fallback-wrapper.log');
    fs.writeFileSync(
      fakeCodegraph,
      [
        "'use strict';",
        "const fs = require('node:fs');",
        "const readline = require('node:readline');",
        `const spawnCountPath = ${JSON.stringify(spawnCountPath)};`,
        "const previousCount = fs.existsSync(spawnCountPath) ? Number.parseInt(fs.readFileSync(spawnCountPath, 'utf8'), 10) || 0 : 0;",
        'const spawnCount = previousCount + 1;',
        "fs.writeFileSync(spawnCountPath, String(spawnCount));",
        'let fallbackLogged = false;',
        "const rl = readline.createInterface({ input: process.stdin });",
        "rl.on('line', line => {",
        "  if (!line.trim()) return;",
        '  const message = JSON.parse(line);',
        "  if (message.method === 'tools/list') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] } }));",
        '    return;',
        '  }',
        "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
        "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '## Exploration: ' + message.params.arguments.query + '\\nbase codegraph context' }] } }));",
        '    if (spawnCount === 1 && !fallbackLogged) {',
        '      fallbackLogged = true;',
        '      setTimeout(() => {',
        "        process.stderr.write('[CodeGraph MCP] Shared daemon connection lost; serving this session in-process (degraded), re-serving 0 in-flight request(s).\\n');",
        '        setTimeout(() => {',
        "          process.stderr.write('[CodeGraph MCP] File watcher active - graph will auto-sync on changes\\n');",
        '        }, 10);',
        '      }, 5);',
        '    }',
        '    return;',
        '  }',
        "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
        '});',
        '',
      ].join('\n'),
    );
    const codexConfigPath = context.writeCodexConfig(projectRoot, fakeCodegraph, {
      CODEGRAPH_NO_DAEMON: '0',
      CODEGRAPH_NO_WATCH: '0',
      NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DELAY_MS: '50',
      NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_DEFER_MS: '25',
      NANOFLOW_CODEGRAPH_SHARED_DAEMON_FALLBACK_RECOVERY_MAX_WAIT_MS: '2000',
    });
    const result = spawnSync(
      process.execPath,
      [
        context.smokeScriptPath,
        '--root',
        projectRoot,
        '--query',
        'shared daemon fallback recovery',
        '--overlay-query',
        'sync-rule-keyword',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--repeat',
        '2',
        '--round-delay-ms',
        '150',
        '--timeout-ms',
        '15000',
      ],
      {
        cwd: context.repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
          NANOFLOW_CODEGRAPH_MCP_LOG: logPath,
        },
      },
    );

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);
    expect(Number.parseInt(fs.readFileSync(spawnCountPath, 'utf8'), 10)).toBeGreaterThanOrEqual(2);

    type WrapperLogEvent = {
      event?: string;
      reason?: string;
      failureClass?: string;
      to?: { mode?: string };
    };
    const events = fs.readFileSync(logPath, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => JSON.parse(line) as WrapperLogEvent);
    const hasEvent = (predicate: (event: WrapperLogEvent) => boolean) =>
      events.some(predicate);
    const eventSummary = events.map(event => ({
      event: event.event,
      reason: event.reason,
      failureClass: event.failureClass,
      topologyMode: event.to?.mode,
    }));
    expect(
      hasEvent(event => event.event === 'child.runtime-topology.transition'
        && event.to?.mode === 'in-process-fallback'),
      JSON.stringify(eventSummary),
    ).toBe(true);
    expect(
      hasEvent(event => event.event === 'child.runtime-topology.transition'
        && event.to?.mode === 'in-process-fallback-watcher'),
      JSON.stringify(eventSummary),
    ).toBe(true);
    expect(
      hasEvent(event => event.event === 'child.shared-daemon-fallback.recovery.request'
        && event.failureClass === 'shared-daemon-fallback'),
      JSON.stringify(eventSummary),
    ).toBe(true);
    expect(
      hasEvent(event => event.event === 'child.restart'
        && event.reason === 'shared-daemon-fallback'),
      JSON.stringify(eventSummary),
    ).toBe(true);

    const summary = JSON.parse(result.stdout) as {
      logAnalysis?: {
        transportHealthy?: boolean;
        activeWrappers?: {
          inProcessFallbackCount?: number;
          inProcessFallbackWatcherCount?: number;
        };
      };
    };
    expect(summary.logAnalysis).toEqual(expect.objectContaining({ transportHealthy: true }));
    expect(summary.logAnalysis?.activeWrappers).toEqual(expect.objectContaining({
      inProcessFallbackCount: 0,
      inProcessFallbackWatcherCount: 0,
    }));
  }, 60_000);
}
