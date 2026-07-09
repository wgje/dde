import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCodegraphMcpSmokeAdapterSpecs } from './codegraph-mcp-smoke-adapter.spec-helpers';
import { registerCodegraphMcpSmokeRepeatSpecs } from './codegraph-mcp-smoke-repeat.spec-helpers';
import { registerCodegraphMcpSmokeStaleWrapperSpecs } from './codegraph-mcp-smoke-stale-wrapper.spec-helpers';

const repoRoot = path.resolve(__dirname, '../../..');
const smokeScriptPath = path.join(repoRoot, 'scripts', 'smoke-codegraph-mcp-wrapper.cjs');
const adapterContextScriptPath = path.join(repoRoot, 'scripts', 'codegraph-adapter-context.cjs');
const analyzerScriptPath = path.join(repoRoot, 'scripts', 'analyze-codegraph-mcp-log.cjs');
const packageJsonPath = path.join(repoRoot, 'package.json');
const tempRoots: string[] = [];

function makeFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { content: [{ type: 'text', text: '## Exploration: ' + message.params.arguments.query + '\\nbase codegraph context' }] },",
      "    }));",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeEnvEchoFakeCodegraph(envName: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-env-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph-env.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      `const envName = ${JSON.stringify(envName)};`,
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { content: [{ type: 'text', text: '## Exploration: env\\n' + envName + '=' + (process.env[envName] ?? '') }] },",
      "    }));",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeHangingExploreFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-hanging-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph-hanging-explore.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const readline = require('node:readline');",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] },",
      "    }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      "    return;",
      "  }",
      "  console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));",
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeConfigBackedAdapterProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-codex-config-'));
  tempRoots.push(projectRoot);
  const scriptsRoot = path.join(projectRoot, 'scripts');
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'),
    path.join(scriptsRoot, 'codegraph-nanoflow-mcp-stdio.cjs'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'analyze-codegraph-mcp-log.cjs'),
    path.join(scriptsRoot, 'analyze-codegraph-mcp-log.cjs'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'codegraph-codex-config.cjs'),
    path.join(scriptsRoot, 'codegraph-codex-config.cjs'),
  );
  fs.writeFileSync(
    path.join(scriptsRoot, 'query-codegraph-nanoflow-overlay.mjs'),
    [
      '#!/usr/bin/env node',
      'process.stdout.write(JSON.stringify({',
      "  query: 'sync-rule-keyword',",
      '  matches: [],',
      '  nodes: [],',
      '  relationshipGroups: {},',
      '  coverage: { graphNodes: 1, graphEdges: 0 }',
      '}));',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(projectRoot, '.vscode'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, '.vscode', 'mcp.json'),
    JSON.stringify({
      servers: {
        codegraph: {
          command: 'node',
          args: [
            '${workspaceFolder}/scripts/missing-wrapper.cjs',
            'missing-codegraph-target',
            'serve',
            '--mcp',
            '--path',
            '${workspaceFolder}',
          ],
        },
      },
    }),
  );
  return projectRoot;
}

function writeCodexConfig(
  projectRoot: string,
  fakeCodegraph: string,
  extraEnv: Record<string, string> = {},
): string {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codex-smoke-config-'));
  tempRoots.push(codexRoot);
  const configPath = path.join(codexRoot, 'config.toml');
  const tomlString = (value: string) => JSON.stringify(value);
  fs.writeFileSync(
    configPath,
    [
      '[mcp_servers.codegraph]',
      'command = "node"',
      'args = [',
      `  ${tomlString(path.join(projectRoot, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))},`,
      `  ${tomlString(fakeCodegraph)},`,
      '  "serve",',
      '  "--mcp",',
      `  ${tomlString('--path')},`,
      `  ${tomlString(projectRoot)},`,
      ']',
      '',
      '[mcp_servers.codegraph.env]',
      ...Object.entries(extraEnv).map(([key, value]) => `${key} = ${tomlString(value)}`),
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "10000"',
      'NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS = "10000"',
      'NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP = "0"',
      'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
      '',
    ].join('\n'),
  );
  return configPath;
}

describe('smoke-codegraph-mcp-wrapper', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is exposed as the CodeGraph MCP smoke npm guard', () => {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['codegraph:mcp:smoke']).toBe('node scripts/smoke-codegraph-mcp-wrapper.cjs');
    expect(pkg.scripts?.['codegraph:adapter:context']).toBe('node scripts/codegraph-adapter-context.cjs');
  });

  it('prefers Codex MCP config over a stale VS Code MCP config for smoke verification', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeFakeCodegraph();
    const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph);
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-codex-config-log-'));
    tempRoots.push(logRoot);
    const result = spawnSync(
      process.execPath,
      [
        smokeScriptPath,
        '--root',
        projectRoot,
        '--query',
        'ProjectShellComponent',
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
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
          NANOFLOW_CODEGRAPH_MCP_LOG: path.join(logRoot, 'wrapper.log'),
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
      steps?: string[];
    };
    expect(summary.ok).toBe(true);
    expect(summary.steps).toContain('nanoflow_context_pack');
  }, 60_000);

  it('passes CodeGraph daemon env from Codex MCP config to the base child process', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeEnvEchoFakeCodegraph('CODEGRAPH_NO_DAEMON');
    const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph, {
      CODEGRAPH_NO_DAEMON: '1',
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '60000',
      CODEGRAPH_DAEMON_MAX_IDLE_MS: '60000',
    });
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
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
        cwd: repoRoot,
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

    const summary = JSON.parse(result.stdout) as {
      contextText?: string;
    };
    expect(summary.contextText).toContain('CODEGRAPH_NO_DAEMON=1');
  }, 30_000);

  it('forces the base CodeGraph child to run without the shared daemon by default', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeEnvEchoFakeCodegraph('CODEGRAPH_NO_DAEMON');
    const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph, {
      CODEGRAPH_NO_DAEMON: '0',
    });
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
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
        cwd: repoRoot,
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

    const summary = JSON.parse(result.stdout) as {
      contextText?: string;
    };
    expect(summary.contextText).toContain('CODEGRAPH_NO_DAEMON=1');
  }, 30_000);

  it('fails on a missing Codex MCP config instead of reading stale VS Code MCP config for smoke verification', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codex-smoke-missing-config-'));
    tempRoots.push(codexRoot);
    const codexConfigPath = path.join(codexRoot, 'config.toml');
    const result = spawnSync(
      process.execPath,
      [
        smokeScriptPath,
        '--root',
        projectRoot,
        '--query',
        'ProjectShellComponent',
        '--overlay-query',
        'sync-rule-keyword',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '1000',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Codex MCP config not found: ${codexConfigPath}`);
    expect(result.stderr).not.toContain('.vscode');
  }, 10_000);

  it('removes pending MCP response waiters after request timeout', () => {
    const result = spawnSync(process.execPath, [smokeScriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NANOFLOW_MCP_SMOKE_SELF_TEST_TIMEOUT_CLEANUP: '1',
      },
    });

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);

    expect(JSON.parse(result.stdout)).toEqual({ pendingWaiters: 0 });
  }, 30_000);

  it('reports wrapper startup exits with log evidence instead of masking them as request timeouts', () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-missing-target-'));
    tempRoots.push(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const missingTarget = path.join(logRoot, 'missing-codegraph-entry.cjs');
    const result = spawnSync(
      process.execPath,
      [
        smokeScriptPath,
        '--root',
        repoRoot,
        '--codegraph-target',
        missingTarget,
        '--query',
        'runtime diagnostics',
        '--overlay-limit',
        '1',
        '--timeout-ms',
        '5000',
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
    expect(result.stderr).toContain('Wrapper process exited before first tools/list');
    expect(result.stderr).toContain('exitCode=2');
    expect(result.stderr).toContain(`logPath=${logPath}`);
    expect(result.stderr).toContain('Local codegraph entry not found');
    expect(result.stderr).not.toContain('Timed out waiting for first tools/list');
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"event":"child.spawn.error"');
    expect(logText).toContain('"failureClass":"child-spawn-missing-target"');
  }, 15_000);

  it('keeps one wrapper process alive across tools/list, resource discovery, context pack, overlay query, and tools/list', () => {
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
        '40',
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
      steps?: string[];
      logAnalysis?: {
        transportHealthy?: boolean;
        criticalTransportFailures?: number;
        overlayTimeouts?: { count?: number };
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.steps).toEqual([
      'tools/list:first',
      'resources/list',
      'resources/templates/list',
      'nanoflow_context_pack',
      'nanoflow_overlay_query',
      'tools/list:second',
    ]);
    expect(summary.logAnalysis).toEqual(expect.objectContaining({
      transportHealthy: true,
      criticalTransportFailures: 0,
      overlayTimeouts: expect.objectContaining({ count: 0 }),
    }));
  }, 90_000);

  it('provides an adapter-preserving context CLI fallback through a fresh wrapper', () => {
    const fakeCodegraph = makeFakeCodegraph();
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
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
        '3',
        '--json',
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
      contextText?: string;
      overlay?: { matches?: unknown[] };
      diagnostics?: {
        transportHealthy?: boolean;
        criticalTransportFailures?: number;
        overlayMatchCount?: number;
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.contextText).toContain('## Exploration: ProjectShellComponent');
    expect(summary.overlay?.matches).toEqual(expect.any(Array));
    expect(summary.diagnostics).toEqual(expect.objectContaining({
      transportHealthy: true,
      criticalTransportFailures: 0,
      overlayMatchCount: expect.any(Number),
    }));
  }, 90_000);

  it('lets the wrapper report base CodeGraph timeout before the adapter CLI gives up', () => {
    const fakeCodegraph = makeHangingExploreFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-timeout-'));
    tempRoots.push(logRoot);
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
        'codegraph adapter doctor stale host MCP Transport closed context-pack source ordering quality issue registry',
        '--overlay-limit',
        '1',
        '--timeout-ms',
        '2000',
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

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/nanoflow_(?:context_pack|overlay_query) returned MCP isError/);
    expect(result.stderr).not.toContain('Timed out waiting for nanoflow_context_pack');
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"event":"nanoflow.context.timeout"');
    expect(logText).toContain('"failureClass":"base-codegraph-timeout"');
  }, 30_000);

  it('lets the wrapper report base CodeGraph timeout before the smoke client gives up', () => {
    const fakeCodegraph = makeHangingExploreFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-timeout-'));
    tempRoots.push(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = spawnSync(
      process.execPath,
      [
        smokeScriptPath,
        '--root',
        repoRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        'codegraph adapter doctor stale host MCP Transport closed context-pack source ordering quality issue registry',
        '--overlay-limit',
        '1',
        '--timeout-ms',
        '2000',
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
    expect(result.stderr).toContain('nanoflow_context_pack round 1 returned MCP isError');
    expect(result.stderr).toMatch(/(?:timed out waiting for base CodeGraph|Base CodeGraph timed out before returning source)/);
    expect(result.stderr).not.toContain('Timed out waiting for nanoflow_context_pack round 1');
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"event":"nanoflow.context.timeout"');
    expect(logText).toContain('"failureClass":"base-codegraph-timeout"');
  }, 30_000);

  registerCodegraphMcpSmokeRepeatSpecs({
    repoRoot,
    smokeScriptPath,
    makeFakeCodegraph,
  });

  registerCodegraphMcpSmokeAdapterSpecs({
    repoRoot,
    smokeScriptPath,
    analyzerScriptPath,
    makeFakeCodegraph,
    trackTempRoot: root => tempRoots.push(root),
  });

  registerCodegraphMcpSmokeStaleWrapperSpecs({
    repoRoot,
    smokeScriptPath,
    makeFakeCodegraph,
  });
});
