import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCodegraphAdapterContextCliQueryFocusSpecs } from './codegraph-adapter-context-cli-query-focus.spec-helpers';
import { registerCodegraphAdapterContextCliRecoverySpecs } from './codegraph-adapter-context-cli-recovery.spec-helpers';
import { registerCodegraphAdapterContextCliStaleWrapperSpecs } from './codegraph-adapter-context-cli-stale-wrapper.spec-helpers';

const repoRoot = path.resolve(__dirname, '../../..');
const adapterContextScriptPath = path.join(repoRoot, 'scripts', 'codegraph-adapter-context.cjs');
const tempRoots: string[] = [];
const requireCjs = createRequire(import.meta.url);
const { buildNanoFlowContextOutcomeV1, parseNanoFlowContextOutcomeV1 } = requireCjs(
  path.join(repoRoot, 'scripts', 'lib', 'codegraph-context-outcome.cjs'),
) as {
  buildNanoFlowContextOutcomeV1(input: Record<string, unknown>): {
    status: string;
    usableContext: boolean;
    base: { status: string };
    overlay: { status: string };
  };
  parseNanoFlowContextOutcomeV1(input: unknown): unknown | null;
};

interface AdapterRunOptions {
  projectRoot: string;
  query: string;
  codegraphTarget?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

function runAdapterContext(options: AdapterRunOptions): SpawnSyncReturns<string> {
  const args = [adapterContextScriptPath, '--root', options.projectRoot];
  if (options.codegraphTarget) args.push('--codegraph-target', options.codegraphTarget);
  args.push('--query', options.query, ...(options.args ?? []), '--json');
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    timeout: options.timeout,
  });
}

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

function copyAdapterFixtureScripts(scriptsRoot: string): void {
  const relativePaths = [
    'codegraph-nanoflow-mcp-stdio.cjs',
    'codegraph-nanoflow-dedup-query.cjs',
    'codegraph-nanoflow-specialized-query.cjs',
    'analyze-codegraph-mcp-log.cjs',
    'codegraph-codex-config.cjs',
    path.join('lib', 'codegraph-context-outcome.cjs'),
  ];
  for (const relativePath of relativePaths) {
    const targetPath = path.join(scriptsRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'scripts', relativePath), targetPath);
  }
}

function makeConfigBackedAdapterProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-codex-config-'));
  tempRoots.push(projectRoot);
  const scriptsRoot = path.join(projectRoot, 'scripts');
  fs.mkdirSync(scriptsRoot, { recursive: true });
  copyAdapterFixtureScripts(scriptsRoot);
  fs.writeFileSync(
    path.join(scriptsRoot, 'query-codegraph-nanoflow-overlay.mjs'),
    [
      '#!/usr/bin/env node',
      "const queryIndex = process.argv.indexOf('--query');",
      "const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : '';",
      'process.stdout.write(JSON.stringify({',
      '  query,',
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

function makeStubbornProcessTreeAdapterProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-process-tree-'));
  tempRoots.push(projectRoot);
  const scriptsRoot = path.join(projectRoot, 'scripts');
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsRoot, 'codegraph-nanoflow-mcp-stdio.cjs'),
    [
      "'use strict';",
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const readline = require('node:readline');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });",
      "descendant.unref();",
      "fs.writeFileSync(process.env.NANOFLOW_TEST_DESCENDANT_PID_FILE, String(descendant.pid));",
      "const rl = readline.createInterface({ input: process.stdin });",
      "rl.on('line', line => {",
      "  if (!line.trim()) return;",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'tools/list') {",
      "    console.log(JSON.stringify({",
      "      jsonrpc: '2.0',",
      "      id: message.id,",
      "      result: { tools: [",
      "        { name: 'codegraph_explore', inputSchema: { type: 'object' } },",
      "        { name: 'nanoflow_context_pack', inputSchema: { type: 'object' } },",
      "        { name: 'nanoflow_overlay_query', inputSchema: { type: 'object' } },",
      "      ] },",
      "    }));",
      "  }",
      "});",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'),
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
  copyAdapterFixtureScripts(scriptsRoot);
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

  it.each([
    {
      label: 'both available',
      input: {
        base: { status: 'available', isError: false, textBytes: 12 },
        overlay: { status: 'available', isError: false },
      },
      expected: {
        status: 'complete', usableContext: true, primaryFailureClass: null,
        base: 'available', overlay: 'available',
      },
    },
    {
      label: 'base only with stale overlay',
      input: {
        base: { status: 'available', isError: false, textBytes: 12 },
        overlay: {
          status: 'unavailable',
          isError: true,
          failureClass: 'overlay-stale-skip-refresh',
        },
      },
      expected: {
        status: 'partial', usableContext: true,
        primaryFailureClass: 'overlay-stale-skip-refresh', base: 'available', overlay: 'stale',
      },
    },
    {
      label: 'overlay only',
      input: {
        base: { status: 'unavailable', isError: true, textBytes: 0 },
        overlay: { status: 'available', isError: false },
      },
      expected: {
        status: 'partial', usableContext: true,
        primaryFailureClass: 'base-codegraph-unavailable', base: 'unavailable', overlay: 'available',
      },
    },
    {
      label: 'neither available',
      input: {
        base: { status: 'unavailable', isError: true, textBytes: 0 },
        overlay: { status: 'unavailable', isError: true, failureClass: 'overlay-error' },
      },
      expected: {
        status: 'failed', usableContext: false,
        primaryFailureClass: 'overlay-error', base: 'unavailable', overlay: 'unavailable',
      },
    },
  ])('classifies the canonical context outcome matrix for $label', ({ input, expected }) => {
    const outcome = buildNanoFlowContextOutcomeV1(input);
    expect(outcome).toEqual(expect.objectContaining({
      status: expected.status,
      usableContext: expected.usableContext,
      primaryFailureClass: expected.primaryFailureClass,
      base: expect.objectContaining({ status: expected.base }),
      overlay: expect.objectContaining({ status: expected.overlay }),
    }));
  });

  it.each([
    {
      label: 'errored available base',
      input: {
        base: { status: 'available', isError: true, textBytes: 12 },
        overlay: { status: 'available', isError: false },
      },
      expected: { status: 'partial', base: 'unavailable', overlay: 'available' },
    },
    {
      label: 'zero-byte available base',
      input: {
        base: { status: 'available', isError: false, textBytes: 0 },
        overlay: { status: 'available', isError: false },
      },
      expected: { status: 'partial', base: 'unavailable', overlay: 'available' },
    },
    {
      label: 'errored available overlay',
      input: {
        base: { status: 'available', isError: false, textBytes: 12 },
        overlay: { status: 'available', isError: true, failureClass: 'overlay-error' },
      },
      expected: { status: 'partial', base: 'available', overlay: 'unavailable' },
    },
  ])('normalizes a contradictory canonical component for $label', ({ input, expected }) => {
    const outcome = buildNanoFlowContextOutcomeV1(input);
    expect(outcome).toEqual(expect.objectContaining({
      status: expected.status,
      base: expect.objectContaining({ status: expected.base }),
      overlay: expect.objectContaining({ status: expected.overlay }),
    }));
  });

  it('derives canonical base bytes from retained text instead of a conflicting byte claim', () => {
    const outcome = buildNanoFlowContextOutcomeV1({
      base: { status: 'available', isError: false, text: 'retained-base', textBytes: 1 },
      overlay: { status: 'available', isError: false },
    });
    expect(outcome.base).toEqual(expect.objectContaining({
      status: 'available',
      textBytes: Buffer.byteLength('retained-base', 'utf8'),
    }));
  });

  it.each([
    ['available base with an error', { base: { status: 'available', isError: true, textBytes: 12 } }],
    ['available overlay with an error', { overlay: { status: 'available', isError: true } }],
    ['available base without bytes', { base: { status: 'available', isError: false, textBytes: 0 } }],
    ['complete outcome marked unusable', { usableContext: false }],
    ['partial outcome with both components available', { status: 'partial' }],
  ])('rejects a contradictory parsed outcome: %s', (_label, overrides) => {
    const valid = {
      schemaVersion: 1,
      status: 'complete',
      usableContext: true,
      primaryFailureClass: null,
      base: { status: 'available', isError: false, textBytes: 12 },
      overlay: { status: 'available', isError: false, failureClass: null, generationId: null },
    };
    const candidate = {
      ...valid,
      ...overrides,
      base: { ...valid.base, ...('base' in overrides ? overrides.base : {}) },
      overlay: { ...valid.overlay, ...('overlay' in overrides ? overrides.overlay : {}) },
    };
    expect(parseNanoFlowContextOutcomeV1(candidate)).toBeNull();
  });

  it.each([
    ['partial', {
      status: 'partial', usableContext: true, primaryFailureClass: null,
      base: { status: 'unavailable', isError: true, textBytes: 0 },
      overlay: { status: 'available', isError: false, failureClass: null, generationId: null },
    }],
    ['failed', {
      status: 'failed', usableContext: false, primaryFailureClass: null,
      base: { status: 'unavailable', isError: true, textBytes: 0 },
      overlay: { status: 'unavailable', isError: true, failureClass: null, generationId: null },
    }],
  ])('rejects a %s parsed outcome without a primary failure class', (_label, candidate) => {
    expect(parseNanoFlowContextOutcomeV1({ schemaVersion: 1, ...candidate })).toBeNull();
  });

  it.each([
    ['root', { unexpected: true }, {}, {}],
    ['base', {}, { unexpected: true }, {}],
    ['overlay', {}, {}, { unexpected: true }],
  ])('rejects unknown fields on the canonical %s object', (_label, rootExtra, baseExtra, overlayExtra) => {
    expect(parseNanoFlowContextOutcomeV1({
      schemaVersion: 1,
      status: 'complete',
      usableContext: true,
      primaryFailureClass: null,
      base: { status: 'available', isError: false, textBytes: 12, ...baseExtra },
      overlay: {
        status: 'available', isError: false, failureClass: null, generationId: null, ...overlayExtra,
      },
      ...rootExtra,
    })).toBeNull();
  });

  it.each([
    { label: 'config-backed', makeProject: makeConfigBackedAdapterProject },
    { label: 'temporary oversized-overlay', makeProject: makeTempAdapterProject },
  ])('copies the canonical context outcome dependency into the $label fixture', ({ makeProject }) => {
    const projectRoot = makeProject();
    const fixtureModulePath = path.join(projectRoot, 'scripts', 'lib', 'codegraph-context-outcome.cjs');
    expect(fs.existsSync(fixtureModulePath)).toBe(true);
    expect(fs.readFileSync(fixtureModulePath, 'utf8')).toBe(fs.readFileSync(
      path.join(repoRoot, 'scripts', 'lib', 'codegraph-context-outcome.cjs'),
      'utf8',
    ));
  });

  it('prefers Codex MCP config over a stale VS Code MCP config for fresh adapter fallback', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph, process.execPath);
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-codex-config-log-'));
    tempRoots.push(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = runAdapterContext({
      projectRoot,
      query: 'ProjectShellComponent',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--timeout-ms', '15000'],
      env: { NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath, NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    });

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
    expect(fs.readFileSync(logPath, 'utf8')).toContain('"CODEGRAPH_NO_WATCH":"1"');
  }, 60_000);

  it('passes the requested project root to the MCP log analyzer', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const codexConfigPath = writeCodexConfig(projectRoot, fakeCodegraph, process.execPath);
    const analyzerPath = path.join(projectRoot, 'scripts', 'analyze-codegraph-mcp-log.cjs');
    fs.writeFileSync(
      analyzerPath,
      [
        "'use strict';",
        'const args = process.argv.slice(2);',
        "const rootIndex = args.indexOf('--project-root');",
        `const expectedRoot = ${JSON.stringify(projectRoot)};`,
        'if (rootIndex < 0 || args[rootIndex + 1] !== expectedRoot) {',
        "  process.stderr.write('missing explicit project root: ' + JSON.stringify(args));",
        '  process.exit(7);',
        '}',
        'process.stdout.write(JSON.stringify({',
        '  transportHealthy: true,',
        '  criticalTransportFailures: 0,',
        '  overlayTimeouts: 0,',
        '}));',
        '',
      ].join('\n'),
    );
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-root-log-'));
    tempRoots.push(logRoot);
    const result = runAdapterContext({
      projectRoot,
      query: 'ProjectShellComponent',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--timeout-ms', '15000'],
      env: {
        NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
        NANOFLOW_CODEGRAPH_MCP_LOG: path.join(logRoot, 'wrapper.log'),
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 60_000);

  it('fails on a missing Codex MCP config instead of reading stale VS Code MCP config for fresh adapter fallback', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codex-missing-config-'));
    tempRoots.push(codexRoot);
    const codexConfigPath = path.join(codexRoot, 'config.toml');
    const result = runAdapterContext({
      projectRoot,
      query: 'ProjectShellComponent',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--timeout-ms', '1000'],
      env: { NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Codex MCP config not found: ${codexConfigPath}`);
    expect(result.stderr).not.toContain('.vscode');
  }, 10_000);

  it('forces the pinned fresh fallback target when the active project Codex config violates the contract', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const projectCodexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(projectCodexDir, { recursive: true });
    fs.writeFileSync(path.join(projectCodexDir, 'config.toml'), [
      '[mcp_servers.codegraph]',
      'command = "node"',
      `args = [${JSON.stringify(path.join(projectRoot, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))}, "@colbymchenry/codegraph@1.1.1", "serve", "--mcp", "--path", ${JSON.stringify(projectRoot)}]`,
      '',
      '[mcp_servers.codegraph.env]',
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "60000"',
      '',
    ].join('\n'));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-empty-codex-home-'));
    tempRoots.push(codexHome);
    const probe = [
      `const adapter = require(${JSON.stringify(adapterContextScriptPath)});`,
      `const invocation = adapter.resolveWrapperInvocation({ root: ${JSON.stringify(projectRoot)}, codegraphTarget: null });`,
      'process.stdout.write(JSON.stringify(invocation));',
    ].join(' ');

    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        NANOFLOW_CODEGRAPH_CODEX_CONFIG: undefined,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const invocation = JSON.parse(result.stdout) as {
      codegraphTarget?: string;
      configEnv?: Record<string, string>;
      configScope?: string;
      configPath?: string;
      configContractOverride?: boolean;
      configContractMismatches?: Array<{ field?: string }>;
    };
    expect(invocation).toEqual(expect.objectContaining({
      codegraphTarget: '@colbymchenry/codegraph@1.5.0',
      configScope: 'project',
      configPath: path.join(projectRoot, '.codex', 'config.toml'),
      configContractOverride: true,
    }));
    expect(invocation.configEnv).toEqual(expect.objectContaining({
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
    }));
    expect(invocation.configContractMismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'codegraphTarget' }),
      expect.objectContaining({ field: 'env.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS' }),
      expect.objectContaining({ field: 'env.NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE' }),
    ]));
  }, 10_000);

  it('rejects a project CodeGraph config for another root instead of falling back to user config', () => {
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeContextReturningFakeCodegraph();
    const userConfigPath = writeCodexConfig(projectRoot, fakeCodegraph, process.execPath);
    const projectCodexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(projectCodexDir, { recursive: true });
    fs.writeFileSync(path.join(projectCodexDir, 'config.toml'), [
      '[mcp_servers.codegraph]',
      'command = "node"',
      `args = [${JSON.stringify(path.join(projectRoot, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))}, "@colbymchenry/codegraph@1.5.0", "serve", "--mcp", "--path", ${JSON.stringify(path.join(projectRoot, 'other-root'))}]`,
      '',
    ].join('\n'));
    const probe = [
      `const adapter = require(${JSON.stringify(adapterContextScriptPath)});`,
      `adapter.resolveWrapperInvocation({ root: ${JSON.stringify(projectRoot)}, codegraphTarget: null });`,
    ].join(' ');

    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_HOME: path.dirname(userConfigPath),
        NANOFLOW_CODEGRAPH_CODEX_CONFIG: undefined,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Active project Codex CodeGraph config does not apply');
    expect(result.stderr).toContain(path.join(projectRoot, '.codex', 'config.toml'));
  }, 10_000);

  it('preserves context when the standalone overlay provenance request times out', () => {
    const probe = [
      `const adapter = require(${JSON.stringify(adapterContextScriptPath)});`,
      "const error = Object.assign(new Error('Timed out waiting for nanoflow_overlay_query. logPath=C:/tmp/wrapper.log stderrTail='), { code: 'ETIMEDOUT' });",
      'const client = { request: async () => { throw error; } };',
      'adapter.requestOverlayProvenance(client, { jsonrpc: \'2.0\', id: 7, method: \'tools/call\' })',
      '  .then(result => process.stdout.write(JSON.stringify(result)));',
    ].join(' ');

    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: false,
      failureClass: 'overlay-request-timeout',
      error: expect.objectContaining({
        name: 'Error',
        code: 'ETIMEDOUT',
        message: expect.stringContaining('Timed out waiting for nanoflow_overlay_query'),
      }),
      output: expect.objectContaining({
        unavailable: true,
        failureClass: 'overlay-request-timeout',
      }),
    }));
  }, 10_000);

  it('only relaxes the critical log guard for an overlay transport failure', () => {
    const probe = [
      `const adapter = require(${JSON.stringify(adapterContextScriptPath)});`,
      "const results = ['overlay-request-timeout', 'overlay-request-error', 'overlay-transport-error']",
      '  .map(failureClass => adapter.shouldPreserveContextAcrossCriticalLogFailure({ failureClass }));',
      'process.stdout.write(JSON.stringify(results));',
    ].join(' ');

    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([false, false, true]);
  }, 10_000);

  it('reports wrapper startup exits with log evidence instead of masking them as context request timeouts', () => {
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-missing-target-'));
    tempRoots.push(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const missingTarget = path.join(logRoot, 'missing-codegraph-entry.cjs');
    const result = runAdapterContext({
      projectRoot: repoRoot,
      codegraphTarget: missingTarget,
      query: 'runtime diagnostics',
      args: ['--overlay-limit', '1', '--timeout-ms', '5000'],
      env: { NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    });

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
    const projectRoot = makeConfigBackedAdapterProject();
    const fakeCodegraph = makeMaxFilesSensitiveFakeCodegraph();
    const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoflow-codegraph-adapter-context-default-'));
    tempRoots.push(logRoot);
    const logPath = path.join(logRoot, 'wrapper.log');
    const result = runAdapterContext({
      projectRoot,
      codegraphTarget: fakeCodegraph,
      query: 'codegraph wrapper mcp stdio output results truncation tokens',
      args: ['--overlay-limit', '1', '--overlay-query-limit', '1', '--timeout-ms', '10000'],
      env: { NANOFLOW_CODEGRAPH_MCP_LOG: logPath },
    });

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

  registerCodegraphAdapterContextCliQueryFocusSpecs({
    repoRoot,
    adapterContextScriptPath,
    trackTempRoot: root => tempRoots.push(root),
    makeContextReturningFakeCodegraph,
    makeMaxFilesSensitiveFakeCodegraph,
    makeConfigBackedAdapterProject,
  });

  registerCodegraphAdapterContextCliStaleWrapperSpecs({
    repoRoot,
    adapterContextScriptPath,
    trackTempRoot: root => tempRoots.push(root),
    makeMaxFilesSensitiveFakeCodegraph,
    makeConfigBackedAdapterProject,
  });

  registerCodegraphAdapterContextCliRecoverySpecs({
    repoRoot,
    trackTempRoot: root => tempRoots.push(root),
    makeConfigBackedAdapterProject,
    makeContextReturningFakeCodegraph,
    makeHangingExploreFakeCodegraph,
    makeMaxFilesSensitiveFakeCodegraph,
    makeTempAdapterProject,
    makeStubbornProcessTreeAdapterProject,
    runAdapterContext,
  });
});
