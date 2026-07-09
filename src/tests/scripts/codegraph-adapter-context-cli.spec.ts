import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCodegraphAdapterContextCliRecoverySpecs } from './codegraph-adapter-context-cli-recovery.spec-helpers';

const repoRoot = path.resolve(__dirname, '../../..');
const adapterContextScriptPath = path.join(repoRoot, 'scripts', 'codegraph-adapter-context.cjs');
const tempRoots: string[] = [];

function makeMaxFilesSensitiveFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-fake-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph-max-files.cjs');
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
      "    const maxFiles = Number(message.params?.arguments?.maxFiles ?? 8);",
      "    if (maxFiles > 1) return;",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { content: [{ type: 'text', text: '## Exploration: ' + message.params.arguments.query + '\\nbase maxFiles=' + maxFiles }] },",
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-hanging-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph-hanging.cjs');
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
      "});",
      '',
    ].join('\n'),
  );
  return fakePath;
}

function makeContextReturningFakeCodegraph(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-returning-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph-returning.cjs');
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
      "    const query = message.params.arguments.query;",
      "    const text = [",
      "      '## Exploration: ' + query,",
      "      '',",
      "      '### Source Code',",
      "      '',",
      "      '#### scripts/analyze-codegraph-mcp-log.cjs — analyzeLog(function)',",
      "      '',",
      "      '```javascript',",
      "      '1\\tfunction analyzeLog(entries) { return entries.length; }',",
      "      '```',",
      "    ].join('\\n');",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } }));",
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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-codex-config-'));
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

function writeCodexConfig(projectRoot: string, fakeCodegraph: string, command = 'node'): string {
  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codex-config-'));
  tempRoots.push(codexRoot);
  const configPath = path.join(codexRoot, 'config.toml');
  const tomlString = (value: string) => JSON.stringify(value);
  fs.writeFileSync(
    configPath,
    [
      '[mcp_servers.codegraph]',
      `command = ${tomlString(command)}`,
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
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "10000"',
      'NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS = "10000"',
      'NANOFLOW_CODEGRAPH_REFRESH_ON_STARTUP = "0"',
      'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
      '',
    ].join('\n'),
  );
  return configPath;
}

function makeTempAdapterProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-project-'));
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
      "const payload = 'x'.repeat(17 * 1024 * 1024);",
      'process.stdout.write(JSON.stringify({',
      "  query: 'oversized-overlay-provenance',",
      "  matches: [{ kind: 'file', name: payload, file: 'oversized.ts' }],",
      '  nodes: [],',
      '  relationshipGroups: {},',
      '  coverage: { graphNodes: 1, graphEdges: 0 }',
      '}));',
      '',
    ].join('\n'),
  );
  return projectRoot;
}

describe('codegraph-adapter-context CLI', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers Codex MCP config over a stale VS Code MCP config for fresh adapter fallback', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph, process.execPath);
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-codex-config-log-'));
    tempRoots.push(logRoot);
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
        '--root',
        projectRoot,
        '--query',
        'ProjectShellComponent',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
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
      contextText?: string;
    };
    expect(summary.ok).toBe(true);
    expect(summary.contextText).toContain('## Exploration: ProjectShellComponent');
  }, 60_000);

  it('fails on a missing Codex MCP config instead of reading stale VS Code MCP config for fresh adapter fallback', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codex-missing-config-'));
    tempRoots.push(codexRoot);
    const codexConfigPath = path.join(codexRoot, 'config.toml');
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
        '--root',
        projectRoot,
        '--query',
        'ProjectShellComponent',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
        '--timeout-ms',
        '1000',
        '--json',
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

  it('reports wrapper startup exits with log evidence instead of masking them as context request timeouts', () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-missing-target-'));
    tempRoots.push(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const missingTarget = path.join(logRoot, 'missing-codegraph-entry.cjs');
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
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
    expect(result.stderr).toContain('Wrapper process exited before tools/list');
    expect(result.stderr).toContain('exitCode=2');
    expect(result.stderr).toContain(`logPath=${logPath}`);
    expect(result.stderr).toContain('Local codegraph entry not found');
    expect(result.stderr).not.toContain('Timed out waiting for nanoflow_context_pack');
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"event":"child.spawn.error"');
    expect(logText).toContain('"failureClass":"child-spawn-missing-target"');
  }, 15_000);

  it('lets the wrapper auto-narrow default maxFiles for focused tooling queries', () => {
    const fakeCodegraph = makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-default-'));
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
        'codegraph wrapper mcp stdio output results truncation tokens',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
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
      maxFilesExplicit?: boolean;
      overlayQuery?: string;
      contextText?: string;
      diagnostics?: {
        contextAttempts?: Array<{
          maxFiles?: number;
          maxFilesExplicit?: boolean;
          maxFilesOmitted?: boolean;
          isError?: boolean;
          failureClass?: string;
        }>;
      };
    };

    expect(summary.ok).toBe(true);
    expect(summary.maxFiles).toBe(8);
    expect(summary.maxFilesExplicit).toBe(false);
    expect(summary.overlayQuery).toBe('wrapper mcp stdio');
    expect(summary.contextText).toContain('base maxFiles=1');
    expect(summary.diagnostics?.contextAttempts).toHaveLength(1);
    expect(summary.diagnostics?.contextAttempts?.[0]).toEqual(expect.objectContaining({
      maxFiles: 8,
      maxFilesExplicit: false,
      maxFilesOmitted: true,
      isError: false,
      failureClass: 'success',
    }));
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"baseQuery":"wrapper mcp stdio"');
    expect(logText).toContain('"maxFiles":8');
    expect(logText).toContain('"baseMaxFiles":1');
    expect(logText).not.toContain('"event":"nanoflow.context.timeout"');
  }, 60_000);

  it('focuses camel-cased NanoFlow CodeGraph quality queries before provenance overlay lookup', () => {
    const fakeCodegraph = makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-quality-focus-'));
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
        'NanoFlow CodeGraph adapter output quality source ordering duplicate sections low value sourceSelection',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
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
      overlayQuery?: string;
      toolingTriageFastTimeout?: boolean;
      contextText?: string;
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.overlayQuery).toBe('codegraph adapter context wrapper log guard sourceOrdering sourceSelection');
    expect(summary.contextText).toContain('base maxFiles=1');
  }, 60_000);

  it('does not rewrite de-duplication contract maintenance queries into generic source-ordering diagnostics', () => {
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-dedup-quality-'));
    tempRoots.push(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const query = 'NanoFlow CodeGraph dedup contract context-pack quality source ordering adapter gate current duplicate hotspots project semantic coverage';
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
        '--root',
        repoRoot,
        '--codegraph-target',
        fakeCodegraph,
        '--query',
        query,
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
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
      overlayQuery?: string;
      toolingTriageFastTimeout?: boolean;
      contextText?: string;
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.overlayQuery).toBe(query);
    expect(summary.overlayQuery).not.toBe('codegraph adapter context wrapper log guard sourceOrdering sourceSelection');
    expect(summary.contextText).toContain('## Exploration: ' + query);
  }, 60_000);

  it('focuses NanoFlow CodeGraph quality issue registry queries on the adaptation issue registry', () => {
    const fakeCodegraph = makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-quality-registry-'));
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
        'NanoFlow CodeGraph quality issue registry',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
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
      overlayQuery?: string;
      toolingTriageFastTimeout?: boolean;
      contextText?: string;
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.overlayQuery).toBe('docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues');
    expect(summary.contextText).toContain('base maxFiles=1');
    expect(summary.contextText).toContain('codegraph-nanoflow-adaptation-issues.md');
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"baseQuery":"docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues"');
  }, 60_000);

  it('focuses Chinese NanoFlow CodeGraph issue registry queries on the adaptation issue registry', () => {
    const fakeCodegraph = makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-quality-registry-cjk-'));
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
        'NanoFlow适配错误问题记录文档',
        '--overlay-limit',
        '1',
        '--overlay-query-limit',
        '1',
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
      overlayQuery?: string;
      toolingTriageFastTimeout?: boolean;
      contextText?: string;
    };

    expect(summary.ok).toBe(true);
    expect(summary.toolingTriageFastTimeout).toBe(true);
    expect(summary.overlayQuery).toBe('docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues');
    expect(summary.contextText).toContain('codegraph-nanoflow-adaptation-issues.md');
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"baseQuery":"docs/codegraph-nanoflow-adaptation-issues.md codegraph nanoflow adaptation issues"');
  }, 60_000);

  it('focuses stale wrapper lifecycle queries and keeps JSON overlay output compact', () => {
    const fakeCodegraph = makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-stale-wrapper-'));
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

  registerCodegraphAdapterContextCliRecoverySpecs({
    repoRoot,
    adapterContextScriptPath,
    trackTempRoot: root => tempRoots.push(root),
    makeConfigBackedAdapterProject,
    makeContextReturningFakeCodegraph,
    makeHangingExploreFakeCodegraph,
    makeMaxFilesSensitiveFakeCodegraph,
    makeTempAdapterProject,
  });
});
