import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCodegraphAdapterDoctorConfigSpecs } from './codegraph-adapter-doctor-config.spec-helpers';
import { registerCodegraphAdapterDoctorHostSpecs } from './codegraph-adapter-doctor-host.spec-helpers';
import { registerCodegraphAdapterDoctorHostMcpSpecs } from './codegraph-adapter-doctor-host-mcp.spec-helpers';

const projectRoot = process.cwd();
const doctorScriptPath = path.join(projectRoot, 'scripts', 'codegraph-adapter-doctor.cjs');
const tempRoots: string[] = [];
const DOCTOR_SPEC_TIMEOUT_MS = 15_000;

vi.setConfig({ testTimeout: DOCTOR_SPEC_TIMEOUT_MS });

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-adapter-doctor-'));
  tempRoots.push(root);
  return root;
}

function runDoctor(root: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [doctorScriptPath, '--root', root, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env,
  });
}

function writePackage(root: string, scripts: Record<string, string>): void {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeCodexConfig(
  root: string,
  codexConfigPath: string,
  command = 'node',
  codegraphTarget = '@colbymchenry/codegraph@1.2.0',
): void {
  const tomlString = (value: string) => JSON.stringify(value);
  writeFileSync(
    codexConfigPath,
    [
      '[mcp_servers.codegraph]',
      `command = ${tomlString(command)}`,
      'args = [',
      `  ${tomlString(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))},`,
      `  ${tomlString(codegraphTarget)},`,
      '  "serve",',
      '  "--mcp",',
      `  ${tomlString('--path')},`,
      `  ${tomlString(root)},`,
      ']',
      '',
      '[mcp_servers.codegraph.env]',
      'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"',
      'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
      '',
    ].join('\n'),
  );
}

function requiredScripts(): Record<string, string> {
  return {
    'codegraph:adapter:gate': 'node scripts/run-codegraph-adapter-gate.cjs',
    'codegraph:adapter:quick-gate': 'node scripts/run-codegraph-adapter-gate.cjs --profile quick',
    'codegraph:adapter:context': 'node scripts/codegraph-adapter-context.cjs',
    'codegraph:adapter:doctor': 'node scripts/codegraph-adapter-doctor.cjs',
    'codegraph:adapter:preflight': 'node scripts/codegraph-adapter-preflight.cjs',
    'codegraph:overlay:validate': 'npm run codegraph:overlay && npm run codegraph:overlay:docs:validate',
    'codegraph:overlay:baseline:manifest': 'node scripts/generate-codegraph-overlay-baseline-manifest.cjs',
    'agent:file-lease': 'node scripts/agent-file-lease.cjs',
  };
}

describe('codegraph-adapter-doctor', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a machine-readable lightweight adapter health report', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-missing-codex-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.root).toBe(root);
    expect(report.mcpConfig).toEqual(expect.objectContaining({
      source: 'codex',
      path: codexConfigPath,
      exists: false,
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'package-script:codegraph:adapter:gate',
        ok: true,
      }),
      expect.objectContaining({
        name: 'package-script:agent:file-lease',
        ok: true,
      }),
      expect.objectContaining({
        name: 'package-script:codegraph:adapter:context',
        ok: true,
      }),
      expect.objectContaining({
        name: 'package-script:codegraph:adapter:doctor',
        ok: true,
      }),
      expect.objectContaining({
        name: 'overlay:file',
        ok: false,
      }),
      expect.objectContaining({
        name: 'lease:file',
        ok: true,
      }),
    ]));
  });

  it('accepts --json as an explicit machine-readable output mode', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-missing-codex-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');

    const result = runDoctor(root, ['--json'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toEqual(expect.objectContaining({
      ok: false,
      root,
      strict: false,
    }));
    expect(report.mcpConfig).toEqual(expect.objectContaining({
      source: 'codex',
      path: codexConfigPath,
    }));
  });

  it('rejects combined --json and --explain output modes', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());

    const result = runDoctor(root, ['--json', '--explain']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--json cannot be combined with --explain');
  });

  it('accepts --timeout-ms for shared MCP diagnostic command compatibility', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-missing-codex-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');

    const result = runDoctor(root, ['--timeout-ms', '90000'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(result.stderr).not.toContain('unknown argument: --timeout-ms');
    const report = JSON.parse(result.stdout);
    expect(report).toEqual(expect.objectContaining({
      ok: false,
      root,
      strict: false,
    }));
  });

  it('reports stale overlay age and lease state without mutating the overlay', () => {
    const root = makeRoot();
    const overlayDir = path.join(root, '.codegraph');
    const leaseDir = path.join(root, 'tmp');
    const scriptsDir = path.join(root, 'scripts');
    writePackage(root, requiredScripts());
    rmSync(overlayDir, { recursive: true, force: true });
    rmSync(leaseDir, { recursive: true, force: true });
    writeFileSync(path.join(root, 'AGENTS.md'), 'agent docs');
    writeFileSync(path.join(root, 'docs-placeholder'), 'doc');
    mkdirSync(overlayDir, { recursive: true });
    mkdirSync(leaseDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(path.join(scriptsDir, 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    writeFileSync(
      path.join(overlayDir, 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [1, 2], edges: [1] } }),
    );
    writeFileSync(
      path.join(leaseDir, 'agent-file-leases.json'),
      JSON.stringify({
        leases: {
          'AGENTS.md': {
            owner: 'agent-a',
            claimedAt: '2026-06-18T00:00:00.000Z',
            expiresAt: '2999-01-01T00:00:00.000Z',
            expiresAtMs: 32472144000000,
          },
        },
      }),
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath, process.execPath);

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.overlay).toEqual(expect.objectContaining({
      exists: true,
      graphNodes: 2,
      graphEdges: 1,
    }));
    expect(report.leases).toEqual(expect.objectContaining({
      activeCount: 1,
      owners: ['agent-a'],
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'mcp-config:command',
        ok: true,
        command: process.execPath,
      }),
    ]));
    expect(existsSync(path.join(overlayDir, 'nanoflow-overlay.json'))).toBe(true);
  });

  it('can print a human-readable explanation of failing checks', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());

    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);

    const result = runDoctor(root, ['--explain'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CodeGraph adapter doctor');
    expect(result.stdout).toContain('FAIL overlay:file');
    expect(result.stdout).toContain('package-script:codegraph:adapter:preflight');
  });

  it('reports configured MCP entrypoints so missing tool discovery is not blamed on the adapter', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
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
      runtimeToolDiscoveryVisible: 'unknown-host-state',
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mcp-config:file', ok: true }),
      expect.objectContaining({ name: 'mcp-config:codegraph-server', ok: true }),
      expect.objectContaining({ name: 'mcp-config:wrapper-script', ok: true }),
      expect.objectContaining({ name: 'mcp-config:codegraph-target', ok: true }),
    ]));
  });

  it('fails when Codex MCP config omits required NanoFlow wrapper environment', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeFileSync(
      codexConfigPath,
      [
        '[mcp_servers.codegraph]',
        'command = "node"',
        'args = [',
        `  ${JSON.stringify(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))},`,
        '  "@colbymchenry/codegraph@1.2.0",',
        '  "serve",',
        '  "--mcp",',
        `  ${JSON.stringify('--path')},`,
        `  ${JSON.stringify(root)},`,
        ']',
        '',
        '[mcp_servers.codegraph.env]',
        'CODEGRAPH_NO_DAEMON = "0"',
        '',
      ].join('\n'),
    );

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.mcpConfig.requiredEnv).toEqual({
      NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: {
        actual: null,
        expected: '30000',
        ok: false,
      },
      NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: {
        actual: null,
        expected: '0',
        ok: false,
      },
    });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'mcp-config:env:NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
        ok: false,
        expected: '30000',
        actual: null,
      }),
      expect.objectContaining({
        name: 'mcp-config:env:NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE',
        ok: false,
        expected: '0',
        actual: null,
      }),
    ]));
  });

  it('reports live wrapper processes that still use a command line different from Codex config', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    writeFileSync(wrapperPath, 'fresh wrapper\n');
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    const expectedCommand = path.join(root, 'codex-tools', 'node.exe');
    const expectedCodegraphTarget = path.join(root, 'vendor', 'codegraph.js');
    writeCodexConfig(root, codexConfigPath, expectedCommand, expectedCodegraphTarget);

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 7772,
          parentPid: 13880,
          commandLine: `"C:\\nvm4w\\nodejs\\node.exe" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.liveProcesses).toEqual(expect.objectContaining({
      checked: true,
      matchingWrapperCount: 1,
      commandMismatchCount: 1,
      targetMismatchCount: 1,
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:live-process-config',
        ok: false,
        expectedCommand,
        expectedCodegraphTarget,
      }),
    ]));
  });

  it('reports live wrapper processes that still use stale daemon env from an older Codex session', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperSource = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperSource);
    const wrapperSha256 = sha256(wrapperSource);
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      `${JSON.stringify({
        ts: '2026-06-29T13:00:00.000Z',
        runId: 'live-env-stale',
        pid: 7774,
        wrapperPid: 7774,
        event: 'wrapper.start',
        scriptPath: wrapperPath,
        scriptSha256: wrapperSha256,
          env: {
            CODEGRAPH_NO_DAEMON: '0',
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '30000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
      })}\n`,
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeFileSync(
      codexConfigPath,
      [
        '[mcp_servers.codegraph]',
        'command = "node"',
        'args = [',
        `  ${JSON.stringify(wrapperPath)},`,
        '  "@colbymchenry/codegraph@1.2.0",',
        '  "serve",',
        '  "--mcp",',
        `  ${JSON.stringify('--path')},`,
        `  ${JSON.stringify(root)},`,
        ']',
        '',
        '[mcp_servers.codegraph.env]',
        'CODEGRAPH_NO_DAEMON = "1"',
        'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"',
        'NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"',
        '',
      ].join('\n'),
    );

    const result = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 7774,
          parentPid: 13880,
          commandLine: `"${process.execPath}" ${wrapperPath} @colbymchenry/codegraph@1.2.0 serve --mcp --path ${root}`,
        },
      ]),
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.hostMcp.currentWrapperEnvMatchesConfig).toBe(false);
    expect(report.hostMcp.currentWrapperMatchesDisk).toBe(true);
    expect(report.hostMcp.scriptStaleAgainstDisk).toBe(false);
    expect(report.hostMcp.staleAgainstDisk).toBe(false);
    expect(report.hostMcp.hostConfigMismatch).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:current-wrapper-env',
        ok: false,
        expected: expect.objectContaining({
          CODEGRAPH_NO_DAEMON: '1',
        }),
        actual: expect.objectContaining({
          CODEGRAPH_NO_DAEMON: '0',
        }),
        investigation: expect.objectContaining({
          failureBoundary: 'mcp-host-config',
          failureClass: 'mcp-host-env',
        }),
      }),
    ]));
  });

  it('ignores historical wrapper target mismatch when live process listing is empty', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    const wrapperSource = 'fresh wrapper\n';
    writeFileSync(wrapperPath, wrapperSource);
    const wrapperSha256 = sha256(wrapperSource);
    const expectedCodegraphTarget = path.join(root, 'vendor', 'codegraph.js');
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-29T12:00:00.000Z',
          runId: 'historical-autosync-disabled',
          event: 'child.stderr',
          text: 'CodeGraph auto-sync is DISABLED - historical warning from an older wrapper run.',
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:00.000Z',
          runId: 'target-mismatch',
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: wrapperSha256,
          codegraphTarget: '@colbymchenry/codegraph@1.2.0',
        }),
      ].join('\n') + '\n',
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath, process.execPath, expectedCodegraphTarget);

    const result = runDoctor(root, ['--explain'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('hostConfigMismatch=no');
    expect(result.stdout).toContain('currentWrapper=unknown');
    expect(result.stdout).not.toContain('FAIL host-mcp:current-wrapper-target');
    expect(result.stdout).not.toContain('autoSyncDisabledTail=');
    const jsonResult = runDoctor(root, [], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    });
    const report = JSON.parse(jsonResult.stdout);
    expect(report.hostMcp.liveWrapperLogFilter).toEqual(expect.objectContaining({
      applied: true,
      liveWrapperPids: [],
      ignoredWrapperStarts: 1,
    }));
    expect(report.hostMcp.scriptStaleAgainstDisk).toBe(false);
    expect(report.hostMcp.hostConfigMismatch).toBe(false);
    expect(report.hostMcp.currentWrapperTargetMatchesConfig).toBeNull();
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'no-current-host-mcp-root-cause',
      directMcpTrust: 'current-host-log-clean',
      failureClasses: [],
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'host-mcp:live-process-config',
        ok: true,
      }),
    ]));
  });

  it('reports observed direct MCP transport closure even when no live wrapper remains', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    writeFileSync(wrapperPath, 'fresh wrapper\n');
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-29T13:00:00.000Z',
          runId: 'old-clean-wrapper',
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: 'old-wrapper-hash',
          codegraphTarget: '@colbymchenry/codegraph@1.1.1',
        }),
      ].join('\n') + '\n',
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const env = {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
    };

    const explainResult = runDoctor(root, ['--explain', '--direct-mcp-error', 'Transport closed'], env);

    expect(explainResult.status, explainResult.stderr || explainResult.stdout).toBe(1);
    expect(explainResult.stdout).toContain('host MCP recovery:');
    expect(explainResult.stdout).toContain('Direct CodeGraph MCP returned an error before fresh wrapper evidence was written');
    expect(explainResult.stdout).toContain('status=direct-mcp-host-transport-closed');
    expect(explainResult.stdout).toContain('failureClasses=observed-direct-mcp-transport-closed,direct-mcp-no-live-wrapper-process');
    expect(explainResult.stdout).toContain('observedDirectMcpError=Transport closed liveWrapperProcessCount=0');
    expect(explainResult.stdout).toContain('fallback=npm run codegraph:adapter:context -- --query "<query>" --json');

    const jsonResult = runDoctor(root, ['--direct-mcp-error', 'Transport closed'], env);
    const report = JSON.parse(jsonResult.stdout);
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-transport-closed',
      failureBoundary: 'codex-mcp-host-transport',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts',
      failureClasses: [
        'observed-direct-mcp-transport-closed',
        'direct-mcp-no-live-wrapper-process',
      ],
    }));
    expect(report.hostMcp.recommendation).toEqual(expect.arrayContaining([
      expect.stringContaining('connected Codex MCP host/session as closed'),
      expect.stringContaining('npm run codegraph:adapter:context'),
    ]));
  });

  it('summarizes stale direct MCP host root cause before adapter failures are misdiagnosed', () => {
    const root = makeRoot();
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, '.codegraph'), { recursive: true });
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-overlay.json'),
      JSON.stringify({ graph: { nodes: [], edges: [] } }),
    );
    const wrapperPath = path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs');
    writeFileSync(wrapperPath, 'fresh wrapper\n');
    writeFileSync(
      path.join(root, '.codegraph', 'nanoflow-mcp-wrapper.log'),
      [
        JSON.stringify({
          ts: '2026-06-29T13:00:00.000Z',
          runId: 'stale-direct-mcp',
          pid: 12092,
          event: 'wrapper.start',
          scriptPath: wrapperPath,
          scriptSha256: 'old-wrapper-hash',
          codegraphTarget: '@colbymchenry/codegraph@1.1.1',
          env: {
            NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
            NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
          },
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:01.000Z',
          runId: 'stale-direct-mcp',
          pid: 12092,
          event: 'child.stderr',
          text: 'CodeGraph auto-sync is DISABLED - live file watching stopped, so the index is frozen. Reason: CodeGraph file lock held by another process past the retry budget; auto-sync disabled.',
        }),
        JSON.stringify({
          ts: '2026-06-29T13:00:02.000Z',
          runId: 'stale-direct-mcp',
          pid: 12092,
          event: 'nanoflow.context.response',
          requestId: 'context-after-stale-host-warning',
          failureClass: 'success',
          responseWarnings: {
            codegraphAutoSyncDisabled: true,
            failureClass: 'codegraph-autosync-disabled',
            textTail: 'irrelevant source tail without the warning banner',
          },
          wrapperStart: {
            ts: '2026-06-29T13:00:00.000Z',
            runId: 'stale-direct-mcp',
            pid: 12092,
            scriptPath: wrapperPath,
            scriptSha256: 'old-wrapper-hash',
            codegraphTarget: '@colbymchenry/codegraph@1.1.1',
            env: {
              NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS: '60000',
              NANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE: '0',
            },
          },
        }),
      ].join('\n') + '\n',
    );
    const codexConfigDir = mkdtempSync(path.join(tmpdir(), 'nanoflow-codex-doctor-config-'));
    tempRoots.push(codexConfigDir);
    const codexConfigPath = path.join(codexConfigDir, 'config.toml');
    writeCodexConfig(root, codexConfigPath);
    const env = {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: JSON.stringify([
        {
          pid: 12092,
          parentPid: 3000,
          commandLine: `"C:\\nvm4w\\nodejs\\node.exe" ${wrapperPath} @colbymchenry/codegraph@1.1.1 serve --mcp --path ${root}`,
        },
      ]),
    };

    const explainResult = runDoctor(root, ['--explain'], env);

    expect(explainResult.status, explainResult.stderr || explainResult.stdout).toBe(1);
    expect(explainResult.stdout).toContain('host MCP root cause:');
    expect(explainResult.stdout).toContain('status=direct-mcp-host-stale-or-index-frozen');
    expect(explainResult.stdout).toContain('adapterFailureLikely=false');
    expect(explainResult.stdout).toContain('codegraphTarget expected=@colbymchenry/codegraph@1.2.0 current=@colbymchenry/codegraph@1.1.1');
    expect(explainResult.stdout).toContain('configuredWrapper current=<missing> context=<missing>');
    expect(explainResult.stdout).toContain(
      'envMismatches=2 current-wrapper.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS expected=30000 actual=60000; current-context-wrapper.NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS expected=30000 actual=60000',
    );
    expect(explainResult.stdout).toContain('liveProcessMismatches=1 pid=12092 target=@colbymchenry/codegraph@1.1.1');
    expect(explainResult.stdout).toContain('fallback=npm run codegraph:adapter:context -- --query "<query>" --json');

    const jsonResult = runDoctor(root, [], env);
    const report = JSON.parse(jsonResult.stdout);
    expect(report.hostMcp.rootCauseSummary).toEqual(expect.objectContaining({
      status: 'direct-mcp-host-stale-or-index-frozen',
      failureBoundary: 'codex-mcp-host-and-base-codegraph-index-watcher',
      adapterFailureLikely: false,
      directMcpTrust: 'do-not-trust-direct-mcp-until-host-restarts-or-index-syncs',
      fallback: 'npm run codegraph:adapter:context -- --query "<query>" --json',
      failureClasses: expect.arrayContaining([
        'mcp-host-wrapper-script-stale',
        'mcp-host-env-mismatch',
        'mcp-host-codegraph-target-mismatch',
        'mcp-host-live-process-config-mismatch',
        'codegraph-autosync-disabled',
      ]),
    }));
    expect(report.hostMcp.rootCauseSummary.expected).toEqual(expect.objectContaining({
      codegraphTarget: '@colbymchenry/codegraph@1.2.0',
    }));
    expect(report.hostMcp.rootCauseSummary.observed).toEqual(expect.objectContaining({
      currentWrapperTarget: '@colbymchenry/codegraph@1.1.1',
      currentConfiguredWrapper: null,
      currentConfiguredContextWrapper: null,
      liveProcessMismatchCount: 1,
      envMismatchCount: 2,
      envMismatches: [
        expect.objectContaining({
          scope: 'current-wrapper',
          key: 'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
          expected: '30000',
          actual: '60000',
        }),
        expect.objectContaining({
          scope: 'current-context-wrapper',
          key: 'NANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS',
          expected: '30000',
          actual: '60000',
        }),
      ],
      autoSyncDisabled: expect.objectContaining({
        failureClass: 'codegraph-autosync-disabled',
        textTail: expect.stringContaining('index is frozen'),
      }),
    }));
    expect(report.hostMcp.rootCauseSummary.observed.liveProcessMismatches[0]).toEqual(expect.objectContaining({
      pid: 12092,
      parentPid: 3000,
      observedCodegraphTarget: '@colbymchenry/codegraph@1.1.1',
      targetMatches: false,
    }));
  });

  registerCodegraphAdapterDoctorHostMcpSpecs({
    makeRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });

  registerCodegraphAdapterDoctorHostSpecs({
    makeRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });

  registerCodegraphAdapterDoctorConfigSpecs({
    projectRoot,
    doctorScriptPath,
    makeRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });
});
