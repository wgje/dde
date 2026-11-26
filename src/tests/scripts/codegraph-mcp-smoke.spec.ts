import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { registerCodegraphMcpSmokeAdapterSpecs } from './codegraph-mcp-smoke-adapter.spec-helpers';
import { registerCodegraphMcpSmokeDaemonSpecs } from './codegraph-mcp-smoke-daemon.spec-helpers';
import { registerCodegraphMcpSmokeRepeatSpecs } from './codegraph-mcp-smoke-repeat.spec-helpers';
import { registerCodegraphMcpSmokeStaleWrapperSpecs } from './codegraph-mcp-smoke-stale-wrapper.spec-helpers';
import { writeCodegraphOverlayCoreFixtureFiles } from './codegraph-nanoflow-overlay-fixture-core.spec-helpers';

const repoRoot = path.resolve(__dirname, '../../..');
const smokeScriptPath = path.join(repoRoot, 'scripts', 'smoke-codegraph-mcp-wrapper.cjs');
const adapterContextScriptPath = path.join(repoRoot, 'scripts', 'codegraph-adapter-context.cjs');
const analyzerScriptPath = path.join(repoRoot, 'scripts', 'analyze-codegraph-mcp-log.cjs');
const packageJsonPath = path.join(repoRoot, 'package.json');
const overlayGeneratorScriptPath = path.join(repoRoot, 'scripts', 'generate-codegraph-nanoflow-overlay.mjs');
const tempRoots: string[] = [];

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function makeFreshMcpProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-project-'));
  tempRoots.push(projectRoot);
  writeCodegraphOverlayCoreFixtureFiles(projectRoot, writeFixtureFile);
  writeFixtureFile(
    projectRoot,
    'src/app/core/shell/project-shell.component.ts',
    "export class ProjectShellComponent {}\n",
  );
  for (const relativePath of [
    'codegraph-nanoflow-mcp-stdio.cjs',
    'codegraph-nanoflow-dedup-query.cjs',
    'codegraph-nanoflow-specialized-query.cjs',
    'analyze-codegraph-mcp-log.cjs',
    'codegraph-adapter-context.cjs',
    'codegraph-codex-config.cjs',
    'query-codegraph-nanoflow-overlay.mjs',
    path.join('contracts', 'codegraph-nanoflow-overlay-v1.json'),
    path.join('contracts', 'codegraph-overlay-generation-v1.json'),
    path.join('lib', 'codegraph-context-outcome.cjs'),
    path.join('lib', 'codegraph-nanoflow-overlay-v1-schema.cjs'),
    path.join('lib', 'codegraph-nanoflow-overlay-v1-schema-angular-support.cjs'),
    path.join('lib', 'codegraph-nanoflow-overlay-v1-schema-graph.cjs'),
    path.join('lib', 'codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs'),
    path.join('lib', 'codegraph-nanoflow-overlay-v1-schema-typescript.cjs'),
    path.join('lib', 'codegraph-overlay-baseline.cjs'),
    path.join('lib', 'codegraph-overlay-candidate-index.mjs'),
    path.join('lib', 'codegraph-overlay-context-assembly.mjs'),
    path.join('lib', 'codegraph-overlay-current-receipt.cjs'),
    path.join('lib', 'codegraph-overlay-generation-format.cjs'),
    path.join('lib', 'codegraph-overlay-native-codeblock-evidence.mjs'),
    path.join('lib', 'codegraph-overlay-native-codeblock-selection.mjs'),
    path.join('lib', 'codegraph-overlay-output-projection.mjs'),
    path.join('lib', 'codegraph-overlay-query-terms.mjs'),
    path.join('lib', 'codegraph-overlay-semantic-selection.mjs'),
    path.join('lib', 'codegraph-source-policy.cjs'),
  ]) {
    const targetPath = path.join(projectRoot, 'scripts', relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'scripts', relativePath), targetPath);
  }
  const generated = spawnSync(
    process.execPath,
    [overlayGeneratorScriptPath, '--root', projectRoot, '--android-function-source', 'local'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  expect(generated.status, [
    `stdout: ${generated.stdout}`,
    `stderr: ${generated.stderr}`,
    `error: ${generated.error?.message ?? ''}`,
  ].join('\n')).toBe(0);
  return projectRoot;
}

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
      "let clientReady = false;",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'notifications/initialized') { clientReady = true; return; }",
      "  if (message.method === 'initialize') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-codegraph', version: '1.0.0' } } }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/list' && !clientReady) {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'server not initialized' } }));",
      "    return;",
      "  }",
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
      "let clientReady = false;",
      `const envName = ${JSON.stringify(envName)};`,
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'notifications/initialized') { clientReady = true; return; }",
      "  if (message.method === 'initialize') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-codegraph', version: '1.0.0' } } }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/list' && !clientReady) {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'server not initialized' } }));",
      "    return;",
      "  }",
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

function makeEnvCaptureFakeCodegraph(envName: string, capturePath: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-env-capture-'));
  tempRoots.push(root);
  const fakePath = path.join(root, 'fake-codegraph-env-capture.cjs');
  fs.writeFileSync(
    fakePath,
    [
      "'use strict';",
      "const fs = require('node:fs');",
      "const readline = require('node:readline');",
      `fs.writeFileSync(${JSON.stringify(capturePath)}, process.env[${JSON.stringify(envName)}] ?? '');`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "let clientReady = false;",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'notifications/initialized') { clientReady = true; return; }",
      "  if (message.method === 'initialize') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-codegraph', version: '1.0.0' } } }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/list' && !clientReady) {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'server not initialized' } }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'codegraph_explore', description: 'fake', inputSchema: { type: 'object' } }] } }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/call' && message.params?.name === 'codegraph_explore') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '## Exploration: daemon env\\nbase context' }] } }));",
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
      "let clientReady = false;",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'notifications/initialized') { clientReady = true; return; }",
      "  if (message.method === 'initialize') {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-codegraph', version: '1.0.0' } } }));",
      "    return;",
      "  }",
      "  if (message.method === 'tools/list' && !clientReady) {",
      "    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'server not initialized' } }));",
      "    return;",
      "  }",
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
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'codegraph-nanoflow-dedup-query.cjs'),
    path.join(scriptsRoot, 'codegraph-nanoflow-dedup-query.cjs'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'codegraph-nanoflow-specialized-query.cjs'),
    path.join(scriptsRoot, 'codegraph-nanoflow-specialized-query.cjs'),
  );
  const libraryRoot = path.join(scriptsRoot, 'lib');
  fs.mkdirSync(libraryRoot, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'lib', 'codegraph-context-outcome.cjs'),
    path.join(libraryRoot, 'codegraph-context-outcome.cjs'),
  );
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'lib', 'codegraph-overlay-worker-pool.cjs'),
    path.join(libraryRoot, 'codegraph-overlay-worker-pool.cjs'),
  );
  fs.writeFileSync(
    path.join(scriptsRoot, 'query-codegraph-nanoflow-overlay.mjs'),
    [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      "import readline from 'node:readline';",
      'const argv = process.argv.slice(2);',
      "const trace = value => process.env.OVERLAY_WORKER_TEST_TRACE && fs.appendFileSync(process.env.OVERLAY_WORKER_TEST_TRACE, value + '\\n');",
      "const payload = query => ({ query, matches: [], nodes: [], relationshipGroups: {}, coverage: { graphNodes: 1, graphEdges: 0 } });",
      "if (argv[0] === '--worker') {",
      "  trace('worker-start');",
      "  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      '  input.on(\"line\", line => {',
      '    if (!line.trim()) return;',
      '    const request = JSON.parse(line);',
      "    if (process.env.OVERLAY_WORKER_TEST_FAIL_ONCE === '1' && !fs.existsSync(process.env.OVERLAY_WORKER_TEST_CRASH_MARKER)) {",
      "      fs.writeFileSync(process.env.OVERLAY_WORKER_TEST_CRASH_MARKER, 'crashed');",
      "      trace('worker-failure');",
      "      process.stderr.write('synthetic worker failure\\n');",
      '      process.exit(19);',
      '    }',
      '    const args = request.args || [];',
      "    const queryIndex = args.indexOf('--query');",
      "    const query = queryIndex >= 0 ? args[queryIndex + 1] ?? '' : '';",
      "    trace('worker-query:' + query);",
      "    const prewarm = args.includes('--prewarm');",
      "    const outputText = prewarm ? '' : JSON.stringify(payload(query));",
      "    process.stdout.write(JSON.stringify({ id: request.id, ok: true, outputText, generationId: 'smoke-generation', cacheHit: false, profileEvents: [] }) + '\\n');",
      '  });',
      '} else {',
      "  const queryIndex = argv.indexOf('--query');",
      "  const query = queryIndex >= 0 ? argv[queryIndex + 1] ?? '' : '';",
      "  trace('legacy-query:' + query);",
      '  process.stdout.write(JSON.stringify(payload(query)));',
      '}',
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

function runLocalWorkerPoolSmoke(failWorkerOnce: boolean) {
  const projectRoot = makeConfigBackedAdapterProject();
  const fakeCodegraph = makeFakeCodegraph();
  const tracePath = path.join(projectRoot, 'worker-trace.log');
  const crashMarker = path.join(projectRoot, 'worker-crashed.marker');
  const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph, {
    NANOFLOW_CODEGRAPH_OVERLAY_WORKER_ENABLED: '1',
    OVERLAY_WORKER_TEST_TRACE: tracePath,
    OVERLAY_WORKER_TEST_CRASH_MARKER: crashMarker,
    ...(failWorkerOnce ? { OVERLAY_WORKER_TEST_FAIL_ONCE: '1' } : {}),
  });
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-smoke-worker-log-'));
  tempRoots.push(logRoot);
  const wrapperLog = path.join(logRoot, 'wrapper.log');
  const result = spawnSync(process.execPath, [
    smokeScriptPath,
    '--root', projectRoot,
    '--query', 'ProjectShellComponent',
    '--overlay-query', 'sync-rule-keyword',
    '--overlay-limit', '1',
    '--overlay-query-limit', '1',
    '--timeout-ms', '15000',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    env: {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_MCP_LOG: wrapperLog,
    },
  });
  return {
    result,
    trace: fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8') : '',
    wrapperLog: fs.existsSync(wrapperLog) ? fs.readFileSync(wrapperLog, 'utf8') : '',
  };
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

  it('uses the process-local worker pool for a normal overlay query', () => {
    const { result, trace, wrapperLog } = runLocalWorkerPoolSmoke(false);
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).contextOutcome.overlay).toMatchObject({ status: 'available', isError: false });
    expect(trace.match(/^worker-start$/gm)?.length ?? 0).toBeGreaterThan(0);
    expect(trace).toContain('worker-query:ProjectShellComponent');
    expect(trace).toContain('worker-query:sync-rule-keyword');
    expect(trace).not.toContain('legacy-query:');
    expect(wrapperLog).toContain('overlay.worker.pool.selected');
    expect(wrapperLog).toContain('process-local');
  }, 60_000);

  it('falls back to the one-shot CLI after a worker process failure', () => {
    const { result, trace, wrapperLog } = runLocalWorkerPoolSmoke(true);
    expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout).contextOutcome.overlay).toMatchObject({ status: 'available', isError: false });
    expect(trace).toContain('worker-failure');
    expect(trace.includes('legacy-query:ProjectShellComponent') || trace.includes('worker-query:ProjectShellComponent')).toBe(true);
    expect(trace).toContain('worker-query:sync-rule-keyword');
    expect(wrapperLog).toContain('overlay-worker.response');
  }, 60_000);

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
      contextOutcome?: {
        schemaVersion?: number;
        status?: string;
        usableContext?: boolean;
        primaryFailureClass?: string | null;
        base?: { status?: string; isError?: boolean; textBytes?: number };
        overlay?: { status?: string; isError?: boolean; failureClass?: string | null };
      };
    };
    expect(summary.ok).toBe(true);
    expect(summary.steps).toContain('nanoflow_context_pack');
    expect(summary.contextOutcome).toEqual(expect.objectContaining({
      schemaVersion: 1,
      status: 'complete',
      usableContext: true,
      primaryFailureClass: null,
      base: expect.objectContaining({
        status: 'available',
        isError: false,
        textBytes: expect.any(Number),
      }),
      overlay: expect.objectContaining({
        status: 'available',
        isError: false,
        failureClass: null,
      }),
    }));
    expect(summary.contextOutcome?.base?.textBytes).toBeGreaterThan(0);
  }, 60_000);

  it('rejects a noncanonical structured outcome from the configured wrapper', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    fs.writeFileSync(
      path.join(projectRoot, 'scripts', 'lib', 'codegraph-context-outcome.cjs'),
      [
        "'use strict';",
        'function buildNanoFlowContextOutcomeV1() {',
        "  return { schemaVersion: 1, status: 'complete' };",
        '}',
        'module.exports = {',
        '  buildNanoFlowContextOutcomeV1,',
        '  isNanoFlowContextOutcomeError: () => false,',
        '};',
        '',
      ].join('\n'),
    );
    const fakeCodegraph = makeFakeCodegraph();
    const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph);
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
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'nanoflow_context_pack round 1 returned no canonical NanoFlow context outcome',
    );
  }, 60_000);

  it('rejects a canonical partial outcome when MCP isError is false', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    fs.writeFileSync(
      path.join(projectRoot, 'scripts', 'lib', 'codegraph-context-outcome.cjs'),
      [
        "'use strict';",
        'function buildNanoFlowContextOutcomeV1() {',
        '  return {',
        '    schemaVersion: 1,',
        "    status: 'partial',",
        '    usableContext: true,',
        "    primaryFailureClass: 'overlay-stale-skip-refresh',",
        "    base: { status: 'available', isError: false, textBytes: 1 },",
        "    overlay: { status: 'stale', isError: true, failureClass: 'overlay-stale-skip-refresh', generationId: null },",
        '  };',
        '}',
        'module.exports = {',
        '  buildNanoFlowContextOutcomeV1,',
        '  isNanoFlowContextOutcomeError: () => false,',
        '};',
        '',
      ].join('\n'),
    );
    const fakeCodegraph = makeFakeCodegraph();
    const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph);
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
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'nanoflow_context_pack round 1 returned MCP isError=false for partial NanoFlow context outcome',
    );
  }, 60_000);

  registerCodegraphMcpSmokeDaemonSpecs({
    repoRoot,
    adapterContextScriptPath,
    smokeScriptPath,
    makeConfigBackedAdapterProject,
    makeEnvEchoFakeCodegraph,
    makeEnvCaptureFakeCodegraph,
    writeCodexConfig,
  });

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

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).not.toBe(0);
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

  it('runs the repository fake MCP through the gate stale-wrapper smoke', () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-stale-smoke-fixture-'));
    tempRoots.push(logRoot);
    const fakeCodegraph = path.join(repoRoot, 'scripts', 'fake-codegraph-mcp.cjs');
    const result = spawnSync(process.execPath, [
      smokeScriptPath,
      '--root', repoRoot,
      '--codegraph-target', fakeCodegraph,
      '--query', 'scripts/codegraph-adapter-context.cjs parseArgs',
      '--overlay-query', 'sync-required-field',
      '--repeat', '1',
      '--overlay-limit', '1',
      '--overlay-query-limit', '1',
      '--simulate-stale-wrapper-script',
      '--timeout-ms',
      '90000',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NANOFLOW_CODEGRAPH_MCP_LOG: path.join(logRoot, 'wrapper.log'),
      },
    });

    expect(result.status, [
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
      `error: ${result.error?.message ?? ''}`,
    ].join('\n')).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: true,
      staleWrapperVerified: true,
      staleWrapperRecycled: true,
    }));
  }, 90_000);

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
    expect(result.stderr).toContain('Wrapper process exited before initialize');
    expect(result.stderr).toContain('exitCode=2');
    expect(result.stderr).toContain(`logPath=${logPath}`);
    expect(result.stderr).toContain('Local codegraph entry not found');
    expect(result.stderr).not.toContain('Timed out waiting for initialize');
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"event":"child.spawn.error"');
    expect(logText).toContain('"failureClass":"child-spawn-missing-target"');
  }, 15_000);

  it('keeps one wrapper process alive across tools/list, resource discovery, context pack, overlay query, and tools/list', () => {
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
    const projectRoot = makeFreshMcpProject();
    const result = spawnSync(
      process.execPath,
      [
        adapterContextScriptPath,
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

  it('returns partial overlay context after the wrapper reports a base CodeGraph timeout', () => {
    const fakeCodegraph = makeHangingExploreFakeCodegraph();
    const projectRoot = makeFreshMcpProject();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-timeout-'));
    tempRoots.push(logRoot);
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
        'codegraph adapter doctor stale host MCP Transport closed context-pack source ordering quality issue registry',
        '--overlay-limit',
        '1',
        '--timeout-ms',
        '6000',
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
      partial?: boolean;
      contextUsable?: boolean;
      outcome?: {
        status?: string;
        usableContext?: boolean;
        primaryFailureClass?: string;
      };
      contextText?: string;
      diagnostics?: {
        transportHealthy?: boolean;
        criticalTransportFailures?: number;
        contextAttempts?: Array<{
          mcpIsError?: boolean;
          partial?: boolean;
          failureClass?: string;
        }>;
      };
    };
    expect(summary.ok).toBe(false);
    expect(summary.partial).toBe(true);
    expect(summary.contextUsable).toBe(true);
    expect(summary.outcome).toEqual(expect.objectContaining({
      status: 'partial',
      usableContext: true,
      primaryFailureClass: 'base-codegraph-timeout-overlay-only',
    }));
    expect(summary.contextText).toContain('### Base CodeGraph Error');
    expect(summary.diagnostics).toEqual(expect.objectContaining({
      transportHealthy: true,
      criticalTransportFailures: 0,
      contextAttempts: [expect.objectContaining({
        mcpIsError: true,
        partial: true,
        failureClass: 'base-codegraph-timeout-overlay-only',
      })],
    }));
    const logText = fs.readFileSync(logPath, 'utf8');
    expect(logText).toContain('"event":"nanoflow.context.timeout"');
    expect(logText).toContain('"failureClass":"base-codegraph-timeout-overlay-only"');
  }, 30_000);

  it('bounds the smoke client when base CodeGraph never responds', () => {
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
    expect(result.stderr).toMatch(/(?:Timed out waiting for nanoflow_context_pack round 1|nanoflow_context_pack round 1 returned MCP isError)/);
    expect(fs.existsSync(logPath)).toBe(true);
  }, 30_000);

  registerCodegraphMcpSmokeRepeatSpecs({
    repoRoot,
    smokeScriptPath,
    makeFakeCodegraph,
    makeFreshMcpProject,
  });

  registerCodegraphMcpSmokeAdapterSpecs({
    repoRoot,
    smokeScriptPath,
    analyzerScriptPath,
    makeFakeCodegraph,
    makeFreshMcpProject,
    trackTempRoot: root => tempRoots.push(root),
  });

  registerCodegraphMcpSmokeStaleWrapperSpecs({
    repoRoot,
    smokeScriptPath,
    makeFakeCodegraph,
  });
});
