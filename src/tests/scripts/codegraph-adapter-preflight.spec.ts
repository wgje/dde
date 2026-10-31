import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const preflightScriptPath = path.join(projectRoot, 'scripts', 'codegraph-adapter-preflight.cjs');
const tempRoots: string[] = [];
const PREFLIGHT_TEST_TIMEOUT_MS = 10_000;

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-codegraph-preflight-'));
  tempRoots.push(root);
  return root;
}

function seedRoot(root: string): void {
  mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'tmp'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'), 'fixture wrapper\n');
  writeFileSync(path.join(root, '.codegraph', 'codex-config.toml'), `[mcp_servers.codegraph]\ncommand = "node"\nargs = [${JSON.stringify(path.join(root, 'scripts', 'codegraph-nanoflow-mcp-stdio.cjs'))}, "@colbymchenry/codegraph@1.5.0", "serve", "--mcp", "--path", ${JSON.stringify(root)}]\n\n[mcp_servers.codegraph.env]\nCODEGRAPH_NO_DAEMON = "0"\nCODEGRAPH_NO_WATCH = "0"\nCODEGRAPH_DAEMON_IDLE_TIMEOUT_MS = "300000"\nCODEGRAPH_DAEMON_MAX_IDLE_MS = "1800000"\nNANOFLOW_CODEGRAPH_CONTEXT_PACK_TIMEOUT_MS = "30000"\nNANOFLOW_CODEGRAPH_STALE_WRAPPER_AUTO_RECYCLE = "0"\n`);
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: {
        'codegraph:adapter:gate': 'node scripts/run-codegraph-adapter-gate.cjs',
        'codegraph:adapter:quick-gate': 'node scripts/run-codegraph-adapter-gate.cjs --profile quick',
        'codegraph:adapter:context': 'node scripts/codegraph-adapter-context.cjs',
        'codegraph:adapter:doctor': 'node scripts/codegraph-adapter-doctor.cjs',
        'codegraph:adapter:preflight': 'node scripts/codegraph-adapter-preflight.cjs',
        'codegraph:overlay:validate': 'npm run codegraph:overlay:docs:assert-clean && npm run codegraph:overlay:docs:validate',
        'codegraph:overlay:baseline:manifest': 'node scripts/generate-codegraph-overlay-baseline-manifest.cjs',
        'agent:file-lease': 'node scripts/agent-file-lease.cjs',
      },
    }),
  );
  writeFileSync(
    path.join(root, '.codegraph', 'nanoflow-overlay.json'),
    JSON.stringify({ graph: { nodes: [], edges: [] } }),
  );
  writeFileSync(path.join(root, 'tmp', 'agent-file-leases.json'), JSON.stringify({ leases: {} }));
}

function runPreflight(
  root: string,
  args: string[] = [],
  options: { scriptPath?: string; env?: Record<string, string> } = {},
) {
  return spawnSync(process.execPath, [options.scriptPath ?? preflightScriptPath, '--root', root, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON: '[]',
      NANOFLOW_CODEGRAPH_CODEX_CONFIG: path.join(root, '.codegraph', 'codex-config.toml'),
      ...options.env,
    },
  });
}

function makeControlledPreflight(root: string): string {
  const scriptsDir = path.join(root, 'scripts');
  const controlledPath = path.join(scriptsDir, 'codegraph-adapter-preflight.cjs');
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(preflightScriptPath, controlledPath);
  writeFileSync(path.join(scriptsDir, 'codegraph-adapter-doctor.cjs'), `
const scenario = JSON.parse(process.env.PREFLIGHT_CHILD_DOCTOR);
process.stdout.write(scenario.stdout);
process.exit(scenario.status);
`);
  writeFileSync(path.join(scriptsDir, 'agent-file-lease.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = args[args.indexOf('--root') + 1];
const command = args[args.indexOf('--root') + 2];
const scenario = JSON.parse(process.env['PREFLIGHT_CHILD_LEASE_' + command.toUpperCase()]);
if (command === 'claim') fs.writeFileSync(path.join(root, 'tmp', 'agent-file-leases.json'), 'claim-invoked');
process.stdout.write(scenario.stdout);
process.exit(scenario.status);
`);
  return controlledPath;
}

function runGit(root: string, args: string[]) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
}

function initGit(root: string): void {
  expect(runGit(root, ['init']).status).toBe(0);
  expect(runGit(root, ['config', 'user.email', 'preflight@example.invalid']).status).toBe(0);
  expect(runGit(root, ['config', 'user.name', 'Preflight Test']).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), 'tmp/\n');
  expect(runGit(root, ['add', '.gitignore']).status).toBe(0);
  expect(runGit(root, ['commit', '-m', 'seed']).status).toBe(0);
}

describe('codegraph-adapter-preflight', () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }, PREFLIGHT_TEST_TIMEOUT_MS);

  it('prints a machine-readable shared-tree preflight report', () => {
    const root = makeRoot();
    seedRoot(root);

    const result = runPreflight(root);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'git:status', ok: true }),
      expect.objectContaining({ name: 'doctor', ok: true }),
      expect.objectContaining({ name: 'lease:status', ok: true }),
    ]));
    expect(report.git).toEqual(expect.objectContaining({
      statusShort: expect.any(String),
      diffNameOnly: expect.any(String),
    }));
    expect(report.doctor.hostMcp.liveProcesses).toEqual(expect.objectContaining({
      available: true,
      source: 'env',
      totalProcessCount: 0,
    }));
  }, PREFLIGHT_TEST_TIMEOUT_MS);

  it('can claim target files as part of preflight', () => {
    const root = makeRoot();
    seedRoot(root);

    const result = runPreflight(root, ['--owner', 'agent-a', '--claim', 'AGENTS.md']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.claim).toEqual(expect.objectContaining({
      ok: true,
      claimed: ['AGENTS.md'],
    }));
  }, PREFLIGHT_TEST_TIMEOUT_MS);

  it('reports dirty target files before claiming them', () => {
    const root = makeRoot();
    seedRoot(root);
    initGit(root);
    writeFileSync(path.join(root, 'AGENTS.md'), 'changed docs\n');

    const result = runPreflight(root, ['--owner', 'agent-a', '--claim', 'AGENTS.md']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.targetFiles).toEqual(expect.objectContaining({
      files: ['AGENTS.md'],
      dirtyFiles: ['AGENTS.md'],
    }));
    expect(report.targetFiles.details).toContainEqual(expect.objectContaining({
      file: 'AGENTS.md',
      dirty: true,
      leased: false,
      leaseConflict: false,
    }));
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'target-files:dirty',
        ok: true,
        dirtyFiles: ['AGENTS.md'],
      }),
    ]));
    expect(report.claim).toEqual(expect.objectContaining({
      ok: true,
      claimed: ['AGENTS.md'],
    }));
  }, PREFLIGHT_TEST_TIMEOUT_MS);

  it('blocks claiming files leased by another owner and reports the conflict', () => {
    const root = makeRoot();
    seedRoot(root);
    writeFileSync(
      path.join(root, 'tmp', 'agent-file-leases.json'),
      JSON.stringify({
        leases: {
          'AGENTS.md': {
            owner: 'agent-b',
            claimedAt: '2026-06-18T00:00:00.000Z',
            expiresAt: '2999-01-01T00:00:00.000Z',
            expiresAtMs: 32472144000000,
          },
        },
      }),
    );

    const result = runPreflight(root, ['--owner', 'agent-a', '--claim', 'AGENTS.md']);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.targetFiles.leaseConflicts).toEqual([
      expect.objectContaining({
        file: 'AGENTS.md',
        owner: 'agent-b',
      }),
    ]);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'target-files:lease-conflicts',
        ok: false,
      }),
    ]));
    expect(report.claim).toBeUndefined();
  }, PREFLIGHT_TEST_TIMEOUT_MS);

  it.each([
    ['doctor nonzero', 17, '{"ok":false,"marker":"kept"}\n', 0, '{"ok":true,"leases":{}}\n', 'doctor'],
    ['doctor body false', 0, '{"ok":false}\n', 0, '{"ok":true,"leases":{}}\n', 'doctor'],
    ['doctor status nonzero', 17, '{"ok":true}\n', 0, '{"ok":true,"leases":{}}\n', 'doctor'],
    ['malformed doctor', 0, '{', 0, '{"ok":true,"leases":{}}\n', 'doctor'],
    ['lease nonzero', 0, '{"ok":true}\n', 17, '{"ok":true,"leases":{}}\n', 'lease:status'],
    ['lease body false', 0, '{"ok":true}\n', 0, '{"ok":false,"leases":{}}\n', 'lease:status'],
    ['malformed lease', 0, '{"ok":true}\n', 0, '{', 'lease:status'],
  ])('does not claim when %s fails', (_name, doctorStatus, doctorStdout, leaseStatus, leaseStdout, failedCheck) => {
    const root = makeRoot();
    seedRoot(root);
    const scriptPath = makeControlledPreflight(root);
    const registryPath = path.join(root, 'tmp', 'agent-file-leases.json');
    const registryBefore = readFileSync(registryPath);
    const result = runPreflight(root, ['--owner', 'agent-a', '--claim', 'AGENTS.md'], {
      scriptPath,
      env: {
        PREFLIGHT_CHILD_DOCTOR: JSON.stringify({ status: doctorStatus, stdout: doctorStdout }),
        PREFLIGHT_CHILD_LEASE_STATUS: JSON.stringify({ status: leaseStatus, stdout: leaseStdout }),
        PREFLIGHT_CHILD_LEASE_CLAIM: JSON.stringify({ status: 0, stdout: '{"ok":true}\n' }),
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(readFileSync(registryPath)).toEqual(registryBefore);
    const report = JSON.parse(result.stdout);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: failedCheck, ok: false }));
    expect(report.claim).toBeUndefined();
    if (doctorStdout.includes('"marker"')) {
      expect(report.doctor).toEqual({ ok: false, marker: 'kept' });
      expect(report.checks).toContainEqual(expect.objectContaining({
        name: 'doctor', ok: false, status: 17, healthy: false,
      }));
    }
  }, PREFLIGHT_TEST_TIMEOUT_MS);
});
