import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

interface CodegraphAdapterDoctorConfigSpecContext {
  projectRoot: string;
  doctorScriptPath: string;
  makeRoot(): string;
  trackTempRoot(root: string): void;
  runDoctor(root: string, args?: string[], env?: NodeJS.ProcessEnv): SpawnSyncReturns<string>;
  writePackage(root: string, scripts: Record<string, string>): void;
  requiredScripts(): Record<string, string>;
  writeCodexConfig(root: string, codexConfigPath: string): void;
}

export function registerCodegraphAdapterDoctorConfigSpecs(
  context: CodegraphAdapterDoctorConfigSpecContext,
): void {
  const {
    projectRoot,
    doctorScriptPath,
    makeRoot,
    trackTempRoot,
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  } = context;

  it('does not fall back to VS Code MCP config when Codex config is missing', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, '.vscode'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    writeFileSync(
      path.join(root, '.vscode', 'mcp.json'),
      JSON.stringify({
        servers: {
          codegraph: {
            command: 'node',
            args: [
              '${workspaceFolder}/scripts/codegraph-nanoflow-mcp-stdio.cjs',
              'stale-vscode-target',
              'serve',
              '--mcp',
              '--path',
              '${workspaceFolder}',
            ],
          },
        },
      }),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-missing-codex-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.mcpConfig).toEqual(expect.objectContaining({
      source: 'codex',
      path: codexConfigPath,
      exists: false,
      codegraphServerConfigured: false,
      codegraphTarget: null,
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mcp-config:file', ok: false }),
    ]));
  });

  it('prefers Codex config over VS Code config when diagnosing Codex MCP entrypoints', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, '.vscode'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    writeFileSync(
      path.join(root, '.vscode', 'mcp.json'),
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
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);

    const result = spawnSync(process.execPath, [doctorScriptPath, '--root', root], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.mcpConfig).toEqual(expect.objectContaining({
      source: 'codex',
      path: codexConfigPath,
      exists: true,
      codegraphServerConfigured: true,
      command: 'node',
      wrapperScriptExists: true,
      codegraphTarget: '@colbymchenry/codegraph@1.6.2',
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mcp-config:wrapper-script', ok: true }),
      expect.objectContaining({ name: 'mcp-config:codegraph-target', ok: true }),
    ]));
  });

  it('prefers the project Codex config over the user config and reports both candidate paths', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, '.codex'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');

    const codexHome = mkdtempSync(path.join(tmpdir(), 'nanoflow-user-codex-home-'));
    trackTempRoot(codexHome);
    const userConfigPath = path.join(codexHome, 'config.toml');
    writeCodexConfig(root, userConfigPath);

    const projectConfigPath = path.join(root, '.codex', 'config.toml');
    writeFileSync(projectConfigPath, [
      '[mcp_servers.codegraph]',
      'command = "node"',
      `args = [${JSON.stringify(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))}, "@colbymchenry/codegraph@1.1.1", "serve", "--mcp", "--path", ${JSON.stringify(root)}]`,
      '',
      '[mcp_servers.codegraph.env]',
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "60000"',
      'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
      '',
    ].join('\n'));

    const result = runDoctor(root, [], {
      ...process.env,
      CODEX_HOME: codexHome,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: undefined,
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.mcpConfig).toEqual(expect.objectContaining({
      source: 'codex',
      scope: 'project',
      path: projectConfigPath,
      userConfigPath,
      projectConfigPath,
      codegraphTarget: '@colbymchenry/codegraph@1.1.1',
    }));
    expect(report.mcpConfig.configuredEnv).toEqual(expect.objectContaining({
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mcp-config:scope', ok: true }),
      expect.objectContaining({ name: 'mcp-config:env:NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS', ok: false }),
    ]));
  });

  it('keeps a project CodeGraph declaration active when it does not apply to the current root', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, '.codex'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');

    const codexHome = mkdtempSync(path.join(tmpdir(), 'nanoflow-user-codex-home-'));
    trackTempRoot(codexHome);
    const userConfigPath = path.join(codexHome, 'config.toml');
    writeCodexConfig(root, userConfigPath);

    const projectConfigPath = path.join(root, '.codex', 'config.toml');
    const otherRoot = path.join(root, 'other-project');
    writeFileSync(projectConfigPath, [
      '[mcp_servers.codegraph]',
      'command = "node"',
      `args = [${JSON.stringify(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))}, "@colbymchenry/codegraph@1.6.2", "serve", "--mcp", "--path", ${JSON.stringify(otherRoot)}]`,
      '',
      '[mcp_servers.codegraph.env]',
      'CODEGRAPH_NO_DAEMON = "0"',
      'CODEGRAPH_NO_WATCH = "0"',
      'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS = "300000"',
      'CODEGRAPH_DAEMON_MAX_IDLE_MS = "1800000"',
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"',
      'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
      '',
    ].join('\n'));

    const result = runDoctor(root, [], {
      ...process.env,
      CODEX_HOME: codexHome,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: undefined,
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.mcpConfig).toEqual(expect.objectContaining({
      scope: 'project',
      path: projectConfigPath,
      userConfigPath,
      projectConfigPath,
      appliesToRoot: false,
      codegraphServerConfigured: true,
      codegraphTarget: '@colbymchenry/codegraph@1.6.2',
      contractMatchesRequired: false,
      contractMismatches: expect.arrayContaining([
        expect.objectContaining({ field: 'appliesToRoot', expected: true, actual: false }),
      ]),
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mcp-config:applies-to-root', ok: false }),
    ]));
  });

  it('repairs the active project Codex config contract without replacing unrelated settings', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, '.codex'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');

    const projectConfigPath = path.join(root, '.codex', 'config.toml');
    writeFileSync(projectConfigPath, [
      '[mcp_servers.context7]',
      'command = "npx"',
      'enabled = true',
      '',
      '[mcp_servers.codegraph]',
      'command = "node"',
      `args = [${JSON.stringify(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))}, "@colbymchenry/codegraph@1.1.1", "serve", "--mcp", "--path", ${JSON.stringify(root)}]`,
      'tool_timeout_sec = 120',
      '',
      '[mcp_servers.codegraph.env]',
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "60000"',
      'NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS = "60000"',
      '',
      '[mcp_servers.codegraph.tools.nanoflow_context_pack]',
      'approval_mode = "approve"',
      '',
    ].join('\n'));

    const codexHome = mkdtempSync(path.join(tmpdir(), 'nanoflow-repair-user-codex-home-'));
    trackTempRoot(codexHome);
    const result = runDoctor(root, ['--repair-config'], {
      ...process.env,
      CODEX_HOME: codexHome,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: undefined,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const updated = readFileSync(projectConfigPath, 'utf8');
    expect(updated).toContain('[mcp_servers.context7]');
    expect(updated).toContain('[mcp_servers.codegraph.tools.nanoflow_context_pack]');
    expect(updated).toContain('tool_timeout_sec = 120');
    expect(updated).toContain('"@colbymchenry/codegraph@1.6.2"');
    expect(updated).toContain('CODEGRAPH_NO_DAEMON = "0"');
    expect(updated).toContain('CODEGRAPH_NO_WATCH = "0"');
    expect(updated).toContain('CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS = "300000"');
    expect(updated).toContain('CODEGRAPH_DAEMON_MAX_IDLE_MS = "1800000"');
    expect(updated).toContain('NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"');
    expect(updated).toContain('NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"');
    expect(updated).toContain('NANOFLOW_CODEGRAPH_OVERLAY_QUERY_TIMEOUT_MS = "60000"');

    const report = JSON.parse(result.stdout);
    expect(report).toEqual(expect.objectContaining({
      ok: false,
      runtimeOk: false,
      pendingHostRestart: true,
    }));
    expect(report.mcpConfig).toEqual(expect.objectContaining({
      scope: 'project',
      path: projectConfigPath,
      codegraphTarget: '@colbymchenry/codegraph@1.6.2',
      contractMatchesRequired: true,
      repair: expect.objectContaining({
        changed: true,
        path: projectConfigPath,
      }),
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mcp-config:runtime-reloaded', ok: false }),
    ]));
  });

  it('strict mode fails when CI/gate topology is not wired into automation', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );

    const result = runDoctor(root, ['--strict']);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'topology:workflow', ok: false }),
      expect.objectContaining({ name: 'topology:infra-tests', ok: false }),
      expect.objectContaining({ name: 'topology:quick-gate', ok: false }),
    ]));
  });

  it('strict mode requires quick gate topology to run doctor strict checks', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    writeFileSync(
      path.join(root, '.github', 'workflows', 'test-full-suite.yml'),
      [
        'concurrency:',
        '  cancel-in-progress: true',
        'jobs:',
        '  codegraph-adapter-gate:',
        '    steps:',
        '      - run: npm run codegraph:adapter:gate',
        '        env:',
        '          NANOFLOW_CODEGRAPH_GATE_LOG_DIR: ${{ runner.temp }}',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'scripts', 'run-codegraph-adapter-gate.cjs'),
      [
        'const QUICK_GATE_STEPS = [',
        '  { name: "codegraph:adapter:preflight" },',
        '];',
        'const QUICK_INFRA_TEST_ARGS = ["agent-file-lease", "codegraph-adapter-preflight", "codegraph-overlay-baseline-manifest"];',
        'const profile = "--profile";',
        'const quick = "quick";',
        'const logGuard = "--fail-on-stale-current-wrapper";',
        'const logPath = "codegraph-adapter-gate-mcp-wrapper.log";',
      ].join('\n'),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    trackTempRoot(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);

    const result = runDoctor(root, ['--strict'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'topology:quick-gate', ok: false }),
    ]));
  });
}
