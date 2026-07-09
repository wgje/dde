#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_LEASE_PATH = path.join('tmp', 'agent-file-leases.json');
const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    owner: process.env.CODEX_AGENT_ID || process.env.USERNAME || os.userInfo().username || 'unknown-agent',
    ttlMs: 30 * 60 * 1000,
    command: null,
    files: [],
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
    if (arg === '--ttl-ms') {
      const ttlMs = Number.parseInt(requireValue(argv, ++index, '--ttl-ms'), 10);
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error('--ttl-ms must be a positive integer');
      }
      parsed.ttlMs = ttlMs;
      continue;
    }
    if (!parsed.command) {
      parsed.command = arg;
      continue;
    }
    parsed.files.push(arg);
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

function leasePath(root) {
  return path.join(root, DEFAULT_LEASE_PATH);
}

function lockPath(root) {
  return `${leasePath(root)}.lock`;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeStaleLock(root, now = Date.now()) {
  const filePath = lockPath(root);
  if (!fs.existsSync(filePath)) {
    return false;
  }

  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fs.rmSync(filePath, { force: true });
    return true;
  }

  const createdAtMs = Number(lock?.createdAtMs);
  const staleByAge = Number.isFinite(createdAtMs) && now - createdAtMs > DEFAULT_LOCK_STALE_MS;
  const staleByPid = !isProcessAlive(Number(lock?.pid));
  if (staleByAge || staleByPid) {
    fs.rmSync(filePath, { force: true });
    return true;
  }

  return false;
}

function acquireLock(root, owner) {
  const filePath = lockPath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  removeStaleLock(root);

  try {
    const fd = fs.openSync(filePath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      owner,
      createdAtMs: Date.now(),
    }));
    return fd;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`lease state is locked: ${filePath}`);
    }
    throw error;
  }
}

function releaseLock(root, fd) {
  try {
    fs.closeSync(fd);
  } finally {
    fs.rmSync(lockPath(root), { force: true });
  }
}

function withLeaseLock(root, owner, callback) {
  const fd = acquireLock(root, owner);
  try {
    return callback();
  } finally {
    releaseLock(root, fd);
  }
}

function normalizeLeaseFile(root, file) {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(root, file);
  const relative = path.relative(absoluteRoot, absoluteFile).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`file must stay inside root: ${file}`);
  }
  return relative;
}

function readLeaseState(root) {
  const filePath = leasePath(root);
  if (!fs.existsSync(filePath)) {
    return { version: 1, leases: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    version: 1,
    leases: parsed?.leases && typeof parsed.leases === 'object' ? parsed.leases : {},
  };
}

function writeLeaseState(root, state) {
  const filePath = leasePath(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function pruneExpiredLeases(state, now = Date.now()) {
  let changed = false;
  for (const [file, lease] of Object.entries(state.leases)) {
    if (Number.isFinite(lease?.expiresAtMs) && lease.expiresAtMs <= now) {
      delete state.leases[file];
      changed = true;
    }
  }
  return changed;
}

function splitLeasesByExpiry(state, now = Date.now()) {
  const active = {};
  const expired = {};
  for (const [file, lease] of Object.entries(state.leases)) {
    if (Number.isFinite(lease?.expiresAtMs) && lease.expiresAtMs <= now) {
      expired[file] = lease;
    } else {
      active[file] = lease;
    }
  }
  return { active, expired };
}

function claim(root, owner, files, ttlMs) {
  if (files.length === 0) {
    throw new Error('claim requires at least one file');
  }
  const state = readLeaseState(root);
  const now = Date.now();
  pruneExpiredLeases(state, now);

  const normalizedFiles = files.map(file => normalizeLeaseFile(root, file));
  const conflicts = normalizedFiles
    .map(file => ({ file, lease: state.leases[file] }))
    .filter(entry => entry.lease && entry.lease.owner !== owner)
    .map(entry => ({
      file: entry.file,
      owner: entry.lease.owner,
      claimedAt: entry.lease.claimedAt,
      expiresAt: entry.lease.expiresAt,
    }));

  if (conflicts.length > 0) {
    return {
      status: 1,
      body: { ok: false, command: 'claim', conflicts, leases: state.leases },
      stateChanged: false,
    };
  }

  const expiresAtMs = now + ttlMs;
  const claimedAt = new Date(now).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  for (const file of normalizedFiles) {
    state.leases[file] = {
      owner,
      claimedAt,
      expiresAt,
      expiresAtMs,
    };
  }

  return {
    status: 0,
    body: { ok: true, command: 'claim', owner, claimed: normalizedFiles, expiresAt, leases: state.leases },
    stateChanged: true,
    state,
  };
}

function release(root, owner, files) {
  const state = readLeaseState(root);
  pruneExpiredLeases(state);
  const normalizedFiles = files.length > 0
    ? files.map(file => normalizeLeaseFile(root, file))
    : Object.entries(state.leases)
      .filter(([, lease]) => lease?.owner === owner)
      .map(([file]) => file);
  const released = [];
  const skipped = [];

  for (const file of normalizedFiles) {
    const lease = state.leases[file];
    if (!lease) {
      skipped.push({ file, reason: 'not-claimed' });
      continue;
    }
    if (lease.owner !== owner) {
      skipped.push({ file, reason: 'owner-mismatch', owner: lease.owner });
      continue;
    }
    delete state.leases[file];
    released.push(file);
  }

  return {
    status: 0,
    body: { ok: true, command: 'release', owner, released, skipped, leases: state.leases },
    stateChanged: true,
    state,
  };
}

function status(root) {
  const state = readLeaseState(root);
  const { active, expired } = splitLeasesByExpiry(state);
  return {
    status: 0,
    body: { ok: true, command: 'status', leases: active, expired },
    stateChanged: false,
  };
}

function prune(root) {
  const state = readLeaseState(root);
  const changed = pruneExpiredLeases(state);
  return {
    status: 0,
    body: { ok: true, command: 'prune', pruned: changed, leases: state.leases },
    stateChanged: true,
    state,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let result;
  result = withLeaseLock(args.root, args.owner, () => {
    if (args.command === 'claim') {
      return claim(args.root, args.owner, args.files, args.ttlMs);
    }
    if (args.command === 'release') {
      return release(args.root, args.owner, args.files);
    }
    if (args.command === 'status') {
      return status(args.root);
    }
    if (args.command === 'prune') {
      return prune(args.root);
    }
    throw new Error('usage: agent-file-lease [--root <dir>] [--owner <id>] <claim|release|status|prune> [files...]');
  });

  if (result.stateChanged) {
    writeLeaseState(args.root, result.state);
  }
  process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
  process.exit(result.status);
}

main();
