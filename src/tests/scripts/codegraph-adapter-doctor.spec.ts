import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCodegraphAdapterDoctorConfigSpecs } from './codegraph-adapter-doctor-config.spec-helpers';
import { registerCodegraphAdapterDoctorCleanupSpecs } from './codegraph-adapter-doctor-cleanup.spec-helpers';
import { registerCodegraphAdapterDoctorHostSpecs } from './codegraph-adapter-doctor-host.spec-helpers';
import { registerCodegraphAdapterDoctorHostRuntimeSpecs } from './codegraph-adapter-doctor-host-runtime.spec-helpers';
import { registerCodegraphAdapterDoctorHostMcpSpecs } from './codegraph-adapter-doctor-host-mcp.spec-helpers';
import { registerCodegraphAdapterDoctorLiveProcessSpecs } from './codegraph-adapter-doctor-live-process.spec-helpers';
import {
  createOverlay,
  publishOverlayAtRoot,
  publishOverlayFixture,
} from './codegraph-overlay-generation-test-helpers';

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

function makePublishedRoot(): string {
  const root = makeRoot();
  publishOverlayAtRoot(root, createOverlay(root, 'doctor'));
  return root;
}

function runDoctor(root: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [doctorScriptPath, '--root', root, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...env,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON:
        env.NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON ?? '[]',
    },
  });
}

function writePackage(root: string, scripts: Record<string, string>): void {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts }));
}

function writeCodexConfig(
  root: string,
  codexConfigPath: string,
  command = 'node',
  codegraphTarget = '@colbymchenry/codegraph@1.6.2',
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
      'CODEGRAPH_NO_DAEMON = "0"',
      'CODEGRAPH_NO_WATCH = "0"',
      'CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS = "300000"',
      'CODEGRAPH_DAEMON_MAX_IDLE_MS = "1800000"',
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
    'codegraph:overlay:validate': 'npm run codegraph:overlay:docs:assert-clean && npm run codegraph:overlay:docs:validate',
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
    expect(report.hostMcp.liveProcesses).toEqual(expect.objectContaining({
      available: true,
      source: 'env',
      totalProcessCount: 0,
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
        ok: true,
        stateExists: false,
        parseError: 'CURRENT_MISSING',
      }),
      expect.objectContaining({
        name: 'overlay:freshness',
        ok: true,
        phase: 'pre-generation',
        reason: 'missing-current-state',
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

  it('treats overlay age as a hint and applies phase-aware manifest freshness without mutation', () => {
    const published = publishOverlayFixture('doctor-age');
    const root = published.root;
    tempRoots.push(root);
    const overlayDir = path.join(root, '.codegraph');
    const leaseDir = path.join(root, 'tmp');
    const scriptsDir = path.join(root, 'scripts');
    writePackage(root, requiredScripts());
    rmSync(leaseDir, { recursive: true, force: true });
    writeFileSync(path.join(root, 'AGENTS.md'), 'agent docs');
    writeFileSync(path.join(root, 'docs-placeholder'), 'doc');
    mkdirSync(leaseDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(path.join(scriptsDir, 'codegraph-nanoflow-mcp-stdio.cjs'), 'fresh wrapper\n');
    const currentPath = path.join(overlayDir, 'nanoflow-generations', 'CURRENT.json');
    const oldOverlayTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(currentPath, oldOverlayTime, oldOverlayTime);
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
      graphNodes: 1,
      graphEdges: 0,
      freshness: 'fresh',
      freshnessReason: null,
      ageHintOver24h: true,
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
      expect.objectContaining({
        name: 'overlay:freshness',
        ok: true,
        phase: 'pre-generation',
        freshness: 'fresh',
      }),
    ]));
    expect(existsSync(path.join(
      published.publication.generationPath,
      'compatibility',
      'nanoflow-overlay.json',
    ))).toBe(true);

    rmSync(currentPath);
    const postResult = runDoctor(root, ['--phase', 'post-generation'], {
      ...process.env,
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: codexConfigPath,
    });
    expect(postResult.status, postResult.stderr || postResult.stdout).toBe(1);
    const postReport = JSON.parse(postResult.stdout);
    expect(postReport.phase).toBe('post-generation');
    expect(postReport.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'overlay:freshness',
        ok: false,
        phase: 'post-generation',
        freshness: 'unknown',
      }),
    ]));
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
    expect(result.stdout).toContain('PASS overlay:file');
    expect(result.stdout).toContain('FAIL mcp-config:wrapper-script');
    expect(result.stdout).toContain('package-script:codegraph:adapter:preflight');
  });

  it('reports configured MCP entrypoints so missing tool discovery is not blamed on the adapter', () => {
    const published = publishOverlayFixture('doctor-mcp');
    const root = published.root;
    tempRoots.push(root);
    writePackage(root, requiredScripts());
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
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
      codegraphTarget: '@colbymchenry/codegraph@1.6.2',
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
        '  "@colbymchenry/codegraph@1.6.2",',
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
      CODEGRAPH_NO_DAEMON: {
        actual: '0',
        expected: '0',
        ok: true,
      },
      CODEGRAPH_NO_WATCH: {
        actual: null,
        expected: '0',
        ok: false,
      },
      CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: {
        actual: null,
        expected: '300000',
        ok: false,
      },
      CODEGRAPH_DAEMON_MAX_IDLE_MS: {
        actual: null,
        expected: '1800000',
        ok: false,
      },
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
        name: 'mcp-config:env:CODEGRAPH_NO_WATCH',
        ok: false,
        expected: '0',
        actual: null,
      }),
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

  registerCodegraphAdapterDoctorLiveProcessSpecs({
    makeRoot: makePublishedRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });

  registerCodegraphAdapterDoctorCleanupSpecs({
    makeRoot: makePublishedRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });

  registerCodegraphAdapterDoctorHostMcpSpecs({
    makeRoot: makePublishedRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });

  registerCodegraphAdapterDoctorHostSpecs({
    makeRoot: makePublishedRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });

  registerCodegraphAdapterDoctorHostRuntimeSpecs({
    makeRoot: makePublishedRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });

  registerCodegraphAdapterDoctorConfigSpecs({
    projectRoot,
    doctorScriptPath,
    makeRoot: makePublishedRoot,
    trackTempRoot: root => tempRoots.push(root),
    runDoctor,
    writePackage,
    requiredScripts,
    writeCodexConfig,
  });
});
