import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
      codegraphTarget: '@colbymchenry/codegraph@1.2.0',
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mcp-config:wrapper-script', ok: true }),
      expect.objectContaining({ name: 'mcp-config:codegraph-target', ok: true }),
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
