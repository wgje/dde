#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    owner: process.env.CODEX_AGENT_ID || process.env.USERNAME || 'unknown-agent',
    claims: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      parsed.root = path.resolve(requireValue(argv, ++index, '--root'));
      continue;
    }
    if (arg === '--owner') {
      parsed.owner = requireValue(argv, ++index, '--owner');
      continue;
    }
    if (arg === '--claim') {
      parsed.claims.push(requireValue(argv, ++index, '--claim'));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runGit(root, args) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    return '';
  }

  const result = run('git', ['-C', root, ...args], { cwd: root });
  if (result.status === 0) {
    return result.stdout;
  }

  throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function runJsonScript(root, scriptRelativePath, args) {
  const scriptPath = path.join(__dirname, scriptRelativePath);
  const result = run(process.execPath, [scriptPath, '--root', root, ...args], { cwd: root });
  let body = null;
  try {
    body = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    body = null;
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    body,
  };
}

function normalizeRelativePath(root, file) {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(root, file);
  const relative = path.relative(absoluteRoot, absoluteFile).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`file must stay inside root: ${file}`);
  }
  return relative;
}

function parseGitNameLines(text) {
  return new Set(String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/\\/g, '/')));
}

function parseGitStatusFiles(text) {
  const files = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    const body = rawLine.slice(3).trim();
    if (!body) {
      continue;
    }
    for (const part of body.split(' -> ')) {
      if (part) {
        files.add(part.replace(/\\/g, '/'));
      }
    }
  }
  return files;
}

function collectTargetFileReport(args, git, leaseStatus) {
  const files = [...new Set(args.claims.map(file => normalizeRelativePath(args.root, file)))];
  const diffFiles = parseGitNameLines(git.diffNameOnly);
  const statusFiles = parseGitStatusFiles(git.statusShort);
  const activeLeases = leaseStatus.body?.leases && typeof leaseStatus.body.leases === 'object'
    ? leaseStatus.body.leases
    : {};

  const details = files.map(file => {
    const lease = activeLeases[file] ?? null;
    const leaseConflict = Boolean(lease?.owner && lease.owner !== args.owner);
    const dirty = diffFiles.has(file) || statusFiles.has(file);
    return {
      file,
      dirty,
      leased: Boolean(lease),
      leaseOwner: lease?.owner ?? null,
      leaseConflict,
      ...(lease?.expiresAt ? { leaseExpiresAt: lease.expiresAt } : {}),
    };
  });

  return {
    files,
    dirtyFiles: details.filter(file => file.dirty).map(file => file.file),
    leaseConflicts: details
      .filter(file => file.leaseConflict)
      .map(file => ({
        file: file.file,
        owner: file.leaseOwner,
        expiresAt: file.leaseExpiresAt ?? null,
      })),
    details,
  };
}

function makeCheck(name, ok, details = {}) {
  return {
    name,
    ok,
    ...details,
  };
}

function buildReport(args) {
  const checks = [];
  const git = {
    statusShort: runGit(args.root, ['status', '--short']),
    diffNameOnly: runGit(args.root, ['diff', '--name-only']),
  };
  checks.push(makeCheck('git:status', true));

  const doctor = runJsonScript(args.root, 'codegraph-adapter-doctor.cjs', []);
  checks.push(makeCheck('doctor', doctor.body !== null, {
    status: doctor.status,
    healthy: doctor.body?.ok === true,
  }));

  const leaseStatus = runJsonScript(args.root, 'agent-file-lease.cjs', ['status']);
  checks.push(makeCheck('lease:status', leaseStatus.status === 0 && leaseStatus.body?.ok === true, {
    status: leaseStatus.status,
  }));

  const targetFiles = collectTargetFileReport(args, git, leaseStatus);
  if (args.claims.length > 0) {
    checks.push(makeCheck('target-files:lease-conflicts', targetFiles.leaseConflicts.length === 0, {
      conflicts: targetFiles.leaseConflicts,
    }));
    checks.push(makeCheck('target-files:dirty', true, {
      dirtyFiles: targetFiles.dirtyFiles,
    }));
  }

  let claim = null;
  if (args.claims.length > 0 && targetFiles.leaseConflicts.length === 0) {
    const claimResult = runJsonScript(args.root, 'agent-file-lease.cjs', [
      'claim',
      '--owner',
      args.owner,
      ...args.claims,
    ]);
    claim = claimResult.body;
    checks.push(makeCheck('lease:claim', claimResult.status === 0 && claim?.ok === true, {
      status: claimResult.status,
      files: args.claims,
    }));
  }

  return {
    ok: checks.every(check => check.ok),
    root: args.root,
    git,
    targetFiles,
    doctor: doctor.body,
    leases: leaseStatus.body,
    ...(claim ? { claim } : {}),
    checks,
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = buildReport(args);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
