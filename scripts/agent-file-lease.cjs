#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const {
  withLeaseStateLock,
  withLeaseStateTransaction,
} = require('./lib/agent-file-lease-store.cjs');

const CLI_TRANSACTION_TEST_PAUSE_POINT = 'cli-transaction';
const CLI_TRANSACTION_TEST_STAGES = new Set([
  'after-acquire-before-commit',
  'after-commit-before-release',
]);
const BARRIER_ACTIVE_STATES = new Set(['CLOSING', 'WAITING', 'HELD']);
const BARRIER_WRITE_CLOSING_STATES = new Set(['CLOSING', 'WAITING']);
const BARRIER_CAPABILITY_PATTERN = /^[a-f0-9]{64}$/i;
const RESOURCE_LEASE_COMMANDS = new Set([
  'resource-lease-acquire',
  'resource-lease-heartbeat',
  'resource-lease-release',
]);
const RESOURCE_ID_MAX_LENGTH = 256;
const RESOURCE_TOKEN_STDIN_MAX_BYTES = 67;
const OWNER_MAX_LENGTH = 256;
const POSITIVE_DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;

function parseTtlMs(value) {
  if (!POSITIVE_DECIMAL_INTEGER_PATTERN.test(value)) {
    throw new Error('--ttl-ms must be a positive decimal integer');
  }
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('--ttl-ms must be a positive safe integer');
  }
  return ttlMs;
}

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    owner: process.env.CODEX_AGENT_ID
      || process.env.USERNAME
      || require('node:os').userInfo().username
      || 'unknown-agent',
    ttlMs: 30 * 60 * 1000,
    barrierToken: null,
    canonicalBarrierToken: null,
    barrierTokenFlagCount: 0,
    barrierTokenStdinCount: 0,
    resourceKind: null,
    resourceKindFlagCount: 0,
    resourceId: null,
    resourceIdFlagCount: 0,
    resourceToken: null,
    canonicalResourceToken: null,
    resourceTokenFlagCount: 0,
    resourceTokenStdinCount: 0,
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
      parsed.ttlMs = parseTtlMs(requireValue(argv, ++index, '--ttl-ms'));
      continue;
    }
    if (arg === '--barrier-token') {
      parsed.barrierTokenFlagCount += 1;
      parsed.barrierToken = requireValue(argv, ++index, '--barrier-token');
      continue;
    }
    if (arg === '--barrier-token-stdin') {
      parsed.barrierTokenStdinCount += 1;
      continue;
    }
    if (arg === '--resource-kind') {
      parsed.resourceKindFlagCount += 1;
      parsed.resourceKind = requireValue(argv, ++index, '--resource-kind');
      continue;
    }
    if (arg === '--resource-id') {
      parsed.resourceIdFlagCount += 1;
      parsed.resourceId = requireValue(argv, ++index, '--resource-id');
      continue;
    }
    if (arg === '--resource-token') {
      parsed.resourceTokenFlagCount += 1;
      requireValue(argv, ++index, '--resource-token');
      continue;
    }
    if (arg === '--resource-token-stdin') {
      parsed.resourceTokenStdinCount += 1;
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

function validateOwner(owner) {
  if (typeof owner !== 'string'
    || owner.length === 0
    || owner.length > OWNER_MAX_LENGTH
    || owner !== owner.trim()
    || /[\u0000-\u001f\u007f]/u.test(owner)) {
    throw new Error('--owner must be a non-empty trimmed string without control characters and at most 256 characters');
  }
  return owner;
}

function readBarrierAcquisitionTokenFromStdin() {
  const inputBuffer = Buffer.alloc(67);
  let inputLength = 0;
  while (inputLength < inputBuffer.length) {
    const bytesRead = fs.readSync(0, inputBuffer, inputLength, inputBuffer.length - inputLength, null);
    if (bytesRead === 0) break;
    inputLength += bytesRead;
  }
  const input = inputBuffer.subarray(0, inputLength);
  const tokenBytes = input.length === 64
    ? input
    : input.length === 66 && input[64] === 0x0d && input[65] === 0x0a
      ? input.subarray(0, 64)
      : null;
  const validHex = tokenBytes?.every(byte => (
    (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x46)
    || (byte >= 0x61 && byte <= 0x66)
  ));
  if (!tokenBytes || !validHex) {
    throw new Error('barrier acquisition token stdin must contain exactly 64 hexadecimal characters and an optional single CRLF');
  }
  return tokenBytes.toString('ascii');
}

function prepareBarrierToken(args) {
  if (args.barrierTokenFlagCount > 1) {
    throw new Error('barrier acquisition token source --barrier-token must not be repeated');
  }
  if (args.barrierTokenStdinCount > 1) {
    throw new Error('barrier acquisition token source --barrier-token-stdin must not be repeated');
  }
  if (args.barrierTokenFlagCount > 0
    && args.command !== 'barrier-acquire'
    && args.command !== 'barrier-heartbeat'
    && args.command !== 'barrier-release') {
    throw new Error('--barrier-token is only supported for barrier commands');
  }
  if (args.barrierTokenStdinCount > 0 && args.command !== 'barrier-acquire') {
    throw new Error('--barrier-token-stdin is only supported for barrier acquisition');
  }
  if (args.command === 'barrier-acquire') {
    const sourceCount = args.barrierTokenFlagCount + args.barrierTokenStdinCount;
    if (sourceCount !== 1) {
      throw new Error('barrier acquisition token must be supplied exactly once through --barrier-token or --barrier-token-stdin');
    }
    const token = args.barrierTokenStdinCount === 1
      ? readBarrierAcquisitionTokenFromStdin()
      : args.barrierToken;
    if (typeof token !== 'string' || !BARRIER_CAPABILITY_PATTERN.test(token)) {
      throw new Error('barrier acquisition token must contain exactly 64 hexadecimal characters');
    }
    args.barrierToken = token;
    args.canonicalBarrierToken = token.toLowerCase();
  }
  return args;
}

function readResourceTokenFromStdin() {
  const inputBuffer = Buffer.alloc(RESOURCE_TOKEN_STDIN_MAX_BYTES);
  let inputLength = 0;
  while (inputLength < inputBuffer.length) {
    const bytesRead = fs.readSync(
      0,
      inputBuffer,
      inputLength,
      inputBuffer.length - inputLength,
      null,
    );
    if (bytesRead === 0) break;
    inputLength += bytesRead;
  }
  const input = inputBuffer.subarray(0, inputLength);
  const hasBareToken = input.length === 64;
  const hasCrLfToken = input.length === 66
    && input[64] === 0x0d
    && input[65] === 0x0a;
  const tokenBytes = hasBareToken
    ? input
    : hasCrLfToken
      ? input.subarray(0, 64)
      : null;
  const containsOnlyAsciiHex = tokenBytes?.every(byte => (
    (byte >= 0x30 && byte <= 0x39)
    || (byte >= 0x41 && byte <= 0x46)
    || (byte >= 0x61 && byte <= 0x66)
  ));
  if (!tokenBytes || !containsOnlyAsciiHex) {
    throw new Error('resource token stdin must contain exactly 64 hexadecimal characters and an optional single CRLF');
  }
  return tokenBytes.toString('ascii');
}

function validateResourceId(resourceId) {
  if (typeof resourceId !== 'string'
    || resourceId.length === 0
    || resourceId.length > RESOURCE_ID_MAX_LENGTH
    || resourceId === '.'
    || resourceId === '..'
    || /[\u0000-\u001f\u007f/\\]/u.test(resourceId)) {
    throw new Error('resource id must be a nonempty bounded path-unambiguous string');
  }
  return resourceId;
}

function prepareResourceLeaseInputs(args) {
  validateOwner(args.owner);
  const isResourceCommand = RESOURCE_LEASE_COMMANDS.has(args.command);
  const resourceOptionCount = args.resourceKindFlagCount
    + args.resourceIdFlagCount
    + args.resourceTokenFlagCount
    + args.resourceTokenStdinCount;
  if (!isResourceCommand) {
    if (resourceOptionCount > 0) {
      throw new Error('resource lease options are only supported for resource-lease commands');
    }
    return args;
  }
  if (args.resourceKindFlagCount !== 1) {
    throw new Error('--resource-kind must be supplied exactly once');
  }
  if (args.resourceKind !== 'read' && args.resourceKind !== 'build') {
    throw new Error('--resource-kind must be read or build');
  }
  if (args.resourceIdFlagCount !== 1) {
    throw new Error('--resource-id must be supplied exactly once');
  }
  validateResourceId(args.resourceId);
  if (args.resourceTokenFlagCount > 0) {
    throw new Error('--resource-token is not supported; use --resource-token-stdin');
  }
  if (args.resourceTokenStdinCount > 1) {
    throw new Error('--resource-token-stdin must not be repeated');
  }
  if (args.resourceTokenStdinCount !== 1) {
    throw new Error('resource token must be supplied exactly once through --resource-token-stdin');
  }
  if (args.files.length > 0) {
    throw new Error('resource lease commands do not accept positional arguments');
  }
  const validationNow = Date.now();
  if (!Number.isSafeInteger(args.ttlMs)
    || args.ttlMs > 8_640_000_000_000_000 - validationNow
    || !Number.isSafeInteger(validationNow + args.ttlMs)) {
    throw new Error('--ttl-ms must be a positive safe integer for resource lease commands');
  }
  const token = readResourceTokenFromStdin();
  if (typeof token !== 'string' || !BARRIER_CAPABILITY_PATTERN.test(token)) {
    throw new Error('resource token must contain exactly 64 hexadecimal characters');
  }
  args.resourceToken = token;
  args.canonicalResourceToken = token.toLowerCase();
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function cliTransactionTestContext(root) {
  const runId = process.env.NANOFLOW_LEASE_TEST_RUN_ID;
  const configuredRoot = process.env.NANOFLOW_LEASE_TEST_ROOT;
  const canonicalRoot = fs.realpathSync(root);
  const canonicalTmp = fs.realpathSync(require('node:os').tmpdir());
  const relativeToTmp = path.relative(canonicalTmp, canonicalRoot);
  const outsideTmp = relativeToTmp === ''
    || relativeToTmp === '..'
    || relativeToTmp.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToTmp);
  if (typeof runId !== 'string'
    || runId.length === 0
    || typeof configuredRoot !== 'string'
    || configuredRoot !== canonicalRoot
    || path.resolve(root) !== canonicalRoot
    || outsideTmp
    || !path.basename(canonicalRoot).startsWith('nanoflow-agent-file-lease-')) {
    throw new Error('CLI transaction test checkpoint requires a runId and canonical NanoFlow temp root');
  }
  if (typeof process.send !== 'function' || process.connected !== true) {
    throw new Error('CLI transaction test checkpoint requires an active IPC channel');
  }
  return { canonicalRoot, runId };
}

function waitForCliTransactionTestCheckpoint(root, stage) {
  if (process.env.NANOFLOW_LEASE_TEST_PAUSE_POINT !== CLI_TRANSACTION_TEST_PAUSE_POINT) {
    return Promise.resolve();
  }
  if (!CLI_TRANSACTION_TEST_STAGES.has(stage)) {
    throw new Error(`unsupported CLI transaction test checkpoint stage: ${stage}`);
  }
  const { runId } = cliTransactionTestContext(root);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDisconnect = () => {
      finish(new Error(`CLI transaction test checkpoint disconnected before ${stage} resume`));
    };
    const onMessage = message => {
      if (!message
        || message.type !== 'NANOFLOW_LEASE_TEST_RESUME'
        || message.pausePoint !== CLI_TRANSACTION_TEST_PAUSE_POINT) return;
      if (message.runId !== runId || message.stage !== stage) {
        const reason = message.runId !== runId ? 'runId-mismatch' : 'stage-mismatch';
        process.send({
          type: 'NANOFLOW_LEASE_TEST_RESUME_IGNORED',
          runId,
          receivedRunId: message.runId,
          pausePoint: CLI_TRANSACTION_TEST_PAUSE_POINT,
          expectedStage: stage,
          receivedStage: message.stage,
          reason,
        }, error => {
          if (error) finish(error);
        });
        return;
      }
      finish();
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send({
      type: 'NANOFLOW_LEASE_TEST_CHECKPOINT',
      runId,
      pausePoint: CLI_TRANSACTION_TEST_PAUSE_POINT,
      stage,
    }, error => {
      if (error) finish(error);
    });
  });
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

function pruneExpiredLeasesForOwner(state, owner, now = Date.now()) {
  let changed = false;
  for (const [file, lease] of Object.entries(state.leases)) {
    if (lease?.owner === owner
      && Number.isFinite(lease.expiresAtMs)
      && lease.expiresAtMs <= now) {
      delete state.leases[file];
      changed = true;
    }
  }
  return changed;
}

function splitLeasesByExpiry(state, now = Date.now()) {
  const active = Object.create(null);
  const expired = Object.create(null);
  for (const [file, lease] of Object.entries(state.leases)) {
    if (Number.isFinite(lease?.expiresAtMs) && lease.expiresAtMs <= now) {
      expired[file] = lease;
    } else {
      active[file] = lease;
    }
  }
  return { active, expired };
}

function openBarrier() {
  return {
    state: 'OPEN',
    owner: null,
    tokenHash: null,
    tokenFingerprint: null,
    acquiredAt: null,
    heartbeatAt: null,
    heartbeatSequence: 0,
    heldEpoch: null,
    fence: null,
    releasedAt: null,
    transitions: [],
  };
}

function effectiveBarrier(state) {
  return state.barrier || openBarrier();
}

function effectiveFencingCounter(state) {
  return state.fencingCounter ?? 0;
}

function publicBarrier(barrier) {
  return {
    state: barrier.state,
    owner: barrier.owner,
    tokenFingerprint: barrier.tokenFingerprint,
    acquiredAt: barrier.acquiredAt,
    heartbeatAt: barrier.heartbeatAt,
    heartbeatSequence: barrier.heartbeatSequence,
    heldEpoch: barrier.heldEpoch,
    fence: barrier.fence,
    releasedAt: barrier.releasedAt,
    transitions: barrier.transitions.map(transition => ({ ...transition })),
  };
}

function barrierTokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function barrierTokenHashMatchKind(barrier, token) {
  if (typeof token !== 'string'
    || token.length === 0
    || typeof barrier.tokenHash !== 'string') {
    return null;
  }
  const expectedHash = Buffer.from(barrier.tokenHash, 'hex');
  const hashMatches = candidate => {
    const suppliedHash = Buffer.from(barrierTokenHash(candidate), 'hex');
    return suppliedHash.length === expectedHash.length
      && timingSafeEqual(suppliedHash, expectedHash);
  };
  const rawMatches = hashMatches(token);
  const canonicalMatches = BARRIER_CAPABILITY_PATTERN.test(token)
    ? hashMatches(token.toLowerCase())
    : false;
  if (rawMatches) return 'raw';
  if (canonicalMatches) return 'canonical';
  return null;
}

function barrierTokenMatchKind(barrier, owner, token) {
  if (typeof owner !== 'string' || owner !== barrier.owner) return null;
  return barrierTokenHashMatchKind(barrier, token);
}

function nextTimestampAtOrAfter(...timestamps) {
  const floor = timestamps.reduce((latest, timestamp) => {
    if (typeof timestamp !== 'string') return latest;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, Date.now());
  return new Date(floor).toISOString();
}

function nextHeartbeatTimestamp(previousTimestamp) {
  const previousMs = Date.parse(previousTimestamp);
  return new Date(Math.max(Date.now(), previousMs + 1)).toISOString();
}

function appendBarrierTransition(barrier, nextState, at) {
  const previousSequence = barrier.transitions.length === 0
    ? 0
    : barrier.transitions.at(-1).sequence;
  if (previousSequence === Number.MAX_SAFE_INTEGER) {
    throw new Error('lease registry barrier transition sequence cannot advance beyond Number.MAX_SAFE_INTEGER');
  }
  barrier.transitions.push({
    state: nextState,
    at,
    sequence: previousSequence + 1,
  });
  barrier.state = nextState;
}

function barrierBody(command, state, barrier, extra = {}) {
  const { active: leases } = splitLeasesByExpiry(state);
  return {
    ok: true,
    command,
    workspaceEpoch: state.workspaceEpoch,
    fencingCounter: effectiveFencingCounter(state),
    barrier: publicBarrier(barrier),
    leases,
    ...extra,
  };
}

function rejectedBarrierBody(command, state, barrier, reason, extra = {}) {
  const { active: leases } = splitLeasesByExpiry(state);
  return {
    status: 1,
    body: {
      ok: false,
      command,
      reason,
      workspaceEpoch: state.workspaceEpoch,
      fencingCounter: effectiveFencingCounter(state),
      barrier: publicBarrier(barrier),
      leases,
      ...extra,
    },
    stateChanged: false,
  };
}

function enterHeldBarrier(state, barrier, transitionAt) {
  const fencingCounter = effectiveFencingCounter(state);
  if (fencingCounter === Number.MAX_SAFE_INTEGER) {
    throw new Error('lease registry fencing counter cannot advance beyond Number.MAX_SAFE_INTEGER');
  }
  const fence = fencingCounter + 1;
  appendBarrierTransition(barrier, 'HELD', transitionAt);
  barrier.heldEpoch = state.workspaceEpoch;
  barrier.fence = fence;
  state.fencingCounter = fence;
}

function barrierAcquire(state, owner, barrierToken, canonicalBarrierToken) {
  const current = effectiveBarrier(state);
  if (current.state === 'RELEASED') {
    const tokenMatchKind = barrierTokenHashMatchKind(current, barrierToken);
    if (tokenMatchKind !== null) {
      if (owner !== current.owner) {
        return rejectedBarrierBody('barrier-acquire', state, current, 'barrier-already-active');
      }
      return {
        status: 0,
        body: barrierBody('barrier-acquire', state, current, {
          acquired: false,
          idempotent: true,
        }),
        stateChanged: false,
      };
    }
  }
  if (current.state === 'OPEN' || current.state === 'RELEASED') {
    const { active } = splitLeasesByExpiry(state);
    const enterHeld = Object.keys(active).length === 0;
    if (enterHeld && effectiveFencingCounter(state) === Number.MAX_SAFE_INTEGER) {
      throw new Error('lease registry fencing counter cannot advance beyond Number.MAX_SAFE_INTEGER');
    }

    const token = canonicalBarrierToken;
    const tokenHash = barrierTokenHash(token);
    const acquiredAt = new Date().toISOString();
    const barrier = {
      state: 'OPEN',
      owner,
      tokenHash,
      tokenFingerprint: tokenHash.slice(0, 12),
      acquiredAt,
      heartbeatAt: acquiredAt,
      heartbeatSequence: 1,
      heldEpoch: null,
      fence: null,
      releasedAt: null,
      transitions: [],
    };
    appendBarrierTransition(barrier, 'CLOSING', acquiredAt);
    appendBarrierTransition(barrier, 'WAITING', acquiredAt);
    pruneExpiredLeasesForOwner(state, owner);
    state.barrier = barrier;
    state.fencingCounter = effectiveFencingCounter(state);
    if (enterHeld) enterHeldBarrier(state, barrier, acquiredAt);
    return {
      status: 0,
      body: barrierBody('barrier-acquire', state, barrier),
      stateChanged: true,
      state,
    };
  }

  const tokenMatchKind = barrierTokenMatchKind(current, owner, barrierToken);
  if (tokenMatchKind === null) {
    return rejectedBarrierBody('barrier-acquire', state, current, 'barrier-already-active');
  }
  if (current.state === 'HELD') {
    return {
      status: 0,
      body: barrierBody('barrier-acquire', state, current),
      stateChanged: false,
    };
  }

  const { active } = splitLeasesByExpiry(state);
  const enterHeld = Object.keys(active).length === 0;
  if (enterHeld && effectiveFencingCounter(state) === Number.MAX_SAFE_INTEGER) {
    throw new Error('lease registry fencing counter cannot advance beyond Number.MAX_SAFE_INTEGER');
  }
  let stateChanged = pruneExpiredLeasesForOwner(state, owner);
  if (current.state === 'CLOSING') {
    appendBarrierTransition(
      current,
      'WAITING',
      nextTimestampAtOrAfter(current.transitions.at(-1).at),
    );
    stateChanged = true;
  }
  if (enterHeld) {
    enterHeldBarrier(
      state,
      current,
      nextTimestampAtOrAfter(current.transitions.at(-1).at),
    );
    stateChanged = true;
  }
  return {
    status: 0,
    body: barrierBody('barrier-acquire', state, current),
    stateChanged,
    state,
  };
}

function barrierHeartbeat(state, owner, barrierToken) {
  const barrier = effectiveBarrier(state);
  if (!BARRIER_ACTIVE_STATES.has(barrier.state)
    || barrierTokenMatchKind(barrier, owner, barrierToken) === null) {
    return rejectedBarrierBody(
      'barrier-heartbeat',
      state,
      barrier,
      'barrier-authentication-failed',
    );
  }
  if (barrier.heartbeatSequence === Number.MAX_SAFE_INTEGER) {
    throw new Error('lease registry barrier heartbeat sequence cannot advance beyond Number.MAX_SAFE_INTEGER');
  }
  barrier.heartbeatAt = nextHeartbeatTimestamp(barrier.heartbeatAt);
  barrier.heartbeatSequence += 1;
  return {
    status: 0,
    body: barrierBody('barrier-heartbeat', state, barrier),
    stateChanged: true,
    state,
  };
}

function barrierRelease(state, owner, barrierToken) {
  const barrier = effectiveBarrier(state);
  if (barrier.state === 'RELEASED') {
    if (barrierTokenMatchKind(barrier, owner, barrierToken) === null) {
      return rejectedBarrierBody(
        'barrier-release',
        state,
        barrier,
        'barrier-authentication-failed',
      );
    }
    const blockers = activeBuildResourceLeaseBlockers(state);
    if (blockers.length > 0) {
      return rejectedBarrierBody(
        'barrier-release',
        state,
        barrier,
        'active-build-resource-leases',
        { blockers },
      );
    }
    return {
      status: 0,
      body: barrierBody('barrier-release', state, barrier, { idempotent: true }),
      stateChanged: false,
    };
  }
  if (!BARRIER_ACTIVE_STATES.has(barrier.state)
    || barrierTokenMatchKind(barrier, owner, barrierToken) === null) {
    return rejectedBarrierBody(
      'barrier-release',
      state,
      barrier,
      'barrier-authentication-failed',
    );
  }
  const blockers = activeBuildResourceLeaseBlockers(state);
  if (blockers.length > 0) {
    return rejectedBarrierBody(
      'barrier-release',
      state,
      barrier,
      'active-build-resource-leases',
      { blockers },
    );
  }
  const releasedAt = nextTimestampAtOrAfter(
    barrier.heartbeatAt,
    barrier.transitions.at(-1).at,
  );
  appendBarrierTransition(barrier, 'RELEASED', releasedAt);
  barrier.releasedAt = releasedAt;
  return {
    status: 0,
    body: barrierBody('barrier-release', state, barrier, { idempotent: false }),
    stateChanged: true,
    state,
  };
}

function resourceTokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function effectiveResourceLeases(state) {
  return state.resourceLeases || Object.create(null);
}

function mutableResourceLeases(state) {
  if (!state.resourceLeases) state.resourceLeases = Object.create(null);
  return state.resourceLeases;
}

function publicResourceLease(resourceLease) {
  return {
    kind: resourceLease.kind,
    resourceId: resourceLease.resourceId,
    owner: resourceLease.owner,
    tokenFingerprint: resourceLease.tokenFingerprint,
    state: resourceLease.state,
    acquiredAt: resourceLease.acquiredAt,
    heartbeatAt: resourceLease.heartbeatAt,
    heartbeatSequence: resourceLease.heartbeatSequence,
    expiresAt: resourceLease.expiresAt,
    expiresAtMs: resourceLease.expiresAtMs,
    releasedAt: resourceLease.releasedAt,
    barrierOwner: resourceLease.barrierOwner ?? null,
    barrierTokenFingerprint: resourceLease.barrierTokenFingerprint ?? null,
    fence: resourceLease.fence ?? null,
    heldEpoch: resourceLease.heldEpoch ?? null,
  };
}

function comparePublicResourceLeases(left, right) {
  for (const field of ['resourceId', 'owner', 'kind', 'tokenFingerprint', 'state']) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

function splitResourceLeasesByStatus(state, now = Date.now()) {
  const active = [];
  const released = [];
  const expired = [];
  for (const resourceLease of Object.values(effectiveResourceLeases(state))) {
    const projected = publicResourceLease(resourceLease);
    if (resourceLease.expiresAtMs <= now) {
      expired.push(projected);
    } else if (resourceLease.state === 'RELEASED') {
      released.push(projected);
    } else {
      active.push(projected);
    }
  }
  active.sort(comparePublicResourceLeases);
  released.sort(comparePublicResourceLeases);
  expired.sort(comparePublicResourceLeases);
  return { active, released, expired };
}

function activeBuildResourceLeaseBlockers(state, now = Date.now()) {
  return Object.values(effectiveResourceLeases(state))
    .filter(resourceLease => (
      resourceLease.kind === 'build'
      && resourceLease.state === 'ACTIVE'
      && resourceLease.expiresAtMs > now
    ))
    .map(publicResourceLease)
    .sort(comparePublicResourceLeases);
}

function pruneExpiredResourceLeases() {
  return 0;
}

function resourceLeaseBody(command, state, resourceLease, extra = {}) {
  return {
    ok: true,
    command,
    workspaceEpoch: state.workspaceEpoch,
    fencingCounter: effectiveFencingCounter(state),
    barrier: publicBarrier(effectiveBarrier(state)),
    resourceLease: publicResourceLease(resourceLease),
    ...extra,
  };
}

function rejectedResourceLeaseBody(command, state, reason, resourceLease = null) {
  const body = {
    ok: false,
    command,
    reason,
    workspaceEpoch: state.workspaceEpoch,
    fencingCounter: effectiveFencingCounter(state),
    barrier: publicBarrier(effectiveBarrier(state)),
  };
  if (resourceLease) body.resourceLease = publicResourceLease(resourceLease);
  return { status: 1, body, stateChanged: false };
}

function resourceLeaseCredentialsMatch(resourceLease, kind, resourceId, owner) {
  return resourceLease.kind === kind
    && resourceLease.resourceId === resourceId
    && resourceLease.owner === owner;
}

function buildResourceBarrierBindingFailure(state, owner, token, resourceLease = null) {
  const barrier = effectiveBarrier(state);
  if (barrier.state !== 'HELD') return 'build-resource-barrier-not-held';
  if (!Number.isSafeInteger(barrier.fence)
    || barrier.fence < 1
    || !Number.isSafeInteger(barrier.heldEpoch)
    || barrier.heldEpoch < 0) {
    return 'build-resource-barrier-binding-invalid';
  }
  if (resourceLease && (
    resourceLease.barrierOwner !== barrier.owner
    || resourceLease.barrierTokenFingerprint !== barrier.tokenFingerprint
    || resourceLease.fence !== barrier.fence
    || resourceLease.heldEpoch !== barrier.heldEpoch
  )) {
    return 'build-resource-barrier-binding-stale';
  }
  if (barrierTokenMatchKind(barrier, owner, token) === null) {
    return 'build-resource-barrier-authentication-failed';
  }
  return null;
}

function resourceLeaseExpiry(heartbeatAt, ttlMs) {
  const expiresAtMs = Date.parse(heartbeatAt) + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs > 8_640_000_000_000_000) {
    throw new Error('resource lease expiry is outside the supported timestamp range');
  }
  return {
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function resourceLeaseAcquire(state, owner, kind, resourceId, token, ttlMs) {
  const tokenHash = resourceTokenHash(token);
  const existing = effectiveResourceLeases(state)[tokenHash];
  if (kind === 'build') {
    const bindingFailure = buildResourceBarrierBindingFailure(
      state,
      owner,
      token,
      existing?.kind === 'build' ? existing : null,
    );
    if (bindingFailure) {
      return rejectedResourceLeaseBody(
        'resource-lease-acquire',
        state,
        bindingFailure,
        existing?.kind === 'build' ? existing : null,
      );
    }
  }
  if (existing) {
    if (!resourceLeaseCredentialsMatch(existing, kind, resourceId, owner)) {
      return rejectedResourceLeaseBody(
        'resource-lease-acquire',
        state,
        'resource-lease-conflict',
        existing,
      );
    }
    if (existing.state === 'RELEASED') {
      return {
        status: 0,
        body: resourceLeaseBody('resource-lease-acquire', state, existing, {
          acquired: false,
          idempotent: true,
        }),
        stateChanged: false,
      };
    }
    if (existing.expiresAtMs <= Date.now()) {
      return rejectedResourceLeaseBody(
        'resource-lease-acquire',
        state,
        'resource-lease-expired',
        existing,
      );
    }
    return {
      status: 0,
      body: resourceLeaseBody('resource-lease-acquire', state, existing, {
        acquired: false,
        idempotent: true,
      }),
      stateChanged: false,
    };
  }

  const acquiredAt = new Date().toISOString();
  const expiry = resourceLeaseExpiry(acquiredAt, ttlMs);
  const barrier = effectiveBarrier(state);
  const resourceLease = {
    kind,
    resourceId,
    owner,
    tokenHash,
    tokenFingerprint: tokenHash.slice(0, 12),
    state: 'ACTIVE',
    acquiredAt,
    heartbeatAt: acquiredAt,
    heartbeatSequence: 1,
    ...expiry,
    releasedAt: null,
    barrierOwner: kind === 'build' ? barrier.owner : null,
    barrierTokenFingerprint: kind === 'build' ? barrier.tokenFingerprint : null,
    fence: kind === 'build' ? barrier.fence : null,
    heldEpoch: kind === 'build' ? barrier.heldEpoch : null,
  };
  mutableResourceLeases(state)[tokenHash] = resourceLease;
  return {
    status: 0,
    body: resourceLeaseBody('resource-lease-acquire', state, resourceLease, {
      acquired: true,
      idempotent: false,
    }),
    stateChanged: true,
    state,
  };
}

function resourceLeaseHeartbeat(state, owner, kind, resourceId, token, ttlMs) {
  const tokenHash = resourceTokenHash(token);
  const resourceLease = effectiveResourceLeases(state)[tokenHash];
  if (kind === 'build') {
    const bindingFailure = buildResourceBarrierBindingFailure(
      state,
      owner,
      token,
      resourceLease?.kind === 'build' ? resourceLease : null,
    );
    if (bindingFailure) {
      return rejectedResourceLeaseBody(
        'resource-lease-heartbeat',
        state,
        bindingFailure,
        resourceLease?.kind === 'build' ? resourceLease : null,
      );
    }
  }
  if (!resourceLease
    || !resourceLeaseCredentialsMatch(resourceLease, kind, resourceId, owner)) {
    return rejectedResourceLeaseBody(
      'resource-lease-heartbeat',
      state,
      'resource-lease-authentication-failed',
    );
  }
  if (resourceLease.state === 'RELEASED') {
    return rejectedResourceLeaseBody(
      'resource-lease-heartbeat',
      state,
      'resource-lease-released',
      resourceLease,
    );
  }
  if (resourceLease.expiresAtMs <= Date.now()) {
    return rejectedResourceLeaseBody(
      'resource-lease-heartbeat',
      state,
      'resource-lease-expired',
      resourceLease,
    );
  }
  if (resourceLease.heartbeatSequence === Number.MAX_SAFE_INTEGER) {
    throw new Error('lease registry resource lease heartbeat sequence cannot advance beyond Number.MAX_SAFE_INTEGER');
  }
  const heartbeatAt = nextHeartbeatTimestamp(resourceLease.heartbeatAt);
  const expiry = resourceLeaseExpiry(heartbeatAt, ttlMs);
  resourceLease.heartbeatAt = heartbeatAt;
  resourceLease.heartbeatSequence += 1;
  resourceLease.expiresAt = expiry.expiresAt;
  resourceLease.expiresAtMs = expiry.expiresAtMs;
  return {
    status: 0,
    body: resourceLeaseBody('resource-lease-heartbeat', state, resourceLease),
    stateChanged: true,
    state,
  };
}

function resourceLeaseRelease(state, owner, kind, resourceId, token) {
  const tokenHash = resourceTokenHash(token);
  const resourceLease = effectiveResourceLeases(state)[tokenHash];
  if (kind === 'build') {
    const bindingFailure = buildResourceBarrierBindingFailure(
      state,
      owner,
      token,
      resourceLease?.kind === 'build' ? resourceLease : null,
    );
    if (bindingFailure) {
      return rejectedResourceLeaseBody(
        'resource-lease-release',
        state,
        bindingFailure,
        resourceLease?.kind === 'build' ? resourceLease : null,
      );
    }
  }
  if (!resourceLease
    || !resourceLeaseCredentialsMatch(resourceLease, kind, resourceId, owner)) {
    return rejectedResourceLeaseBody(
      'resource-lease-release',
      state,
      'resource-lease-authentication-failed',
    );
  }
  if (resourceLease.state === 'RELEASED') {
    return {
      status: 0,
      body: resourceLeaseBody('resource-lease-release', state, resourceLease, {
        released: false,
        idempotent: true,
      }),
      stateChanged: false,
    };
  }
  if (resourceLease.expiresAtMs <= Date.now()) {
    return rejectedResourceLeaseBody(
      'resource-lease-release',
      state,
      'resource-lease-expired',
      resourceLease,
    );
  }
  resourceLease.state = 'RELEASED';
  resourceLease.releasedAt = nextTimestampAtOrAfter(
    resourceLease.acquiredAt,
    resourceLease.heartbeatAt,
  );
  return {
    status: 0,
    body: resourceLeaseBody('resource-lease-release', state, resourceLease, {
      released: true,
      idempotent: false,
    }),
    stateChanged: true,
    state,
  };
}

function claim(state, root, owner, files, ttlMs) {
  if (files.length === 0) {
    throw new Error('claim requires at least one file');
  }
  const now = Date.now();
  const normalizedFiles = files.map(file => normalizeLeaseFile(root, file));
  const { active: activeLeases } = splitLeasesByExpiry(state, now);
  const barrier = effectiveBarrier(state);
  if (barrier.state === 'HELD') {
    return {
      status: 1,
      body: {
        ok: false,
        command: 'claim',
        reason: 'barrier-held',
        workspaceEpoch: state.workspaceEpoch,
        barrier: publicBarrier(barrier),
        leases: activeLeases,
      },
      stateChanged: false,
    };
  }
  if (BARRIER_WRITE_CLOSING_STATES.has(barrier.state)) {
    const exactRenewal = normalizedFiles.every(file => (
      activeLeases[file]?.owner === owner
    ));
    if (!exactRenewal) {
      return {
        status: 1,
        body: {
          ok: false,
          command: 'claim',
          reason: 'barrier-write-admission-closed',
          workspaceEpoch: state.workspaceEpoch,
          barrier: publicBarrier(barrier),
          leases: activeLeases,
        },
        stateChanged: false,
      };
    }
  }
  const conflicts = normalizedFiles
    .map(file => ({ file, lease: activeLeases[file] }))
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
      body: { ok: false, command: 'claim', conflicts, workspaceEpoch: state.workspaceEpoch, leases: activeLeases },
      stateChanged: false,
    };
  }
  if (state.workspaceEpoch === Number.MAX_SAFE_INTEGER) {
    throw new Error('lease registry workspaceEpoch cannot advance beyond Number.MAX_SAFE_INTEGER');
  }

  const expiresAtMs = now + ttlMs;
  const claimedAt = new Date(now).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  // A claim may retire only this owner's expired receipts. Expired records
  // from other owners remain historical evidence until an explicit prune.
  pruneExpiredLeasesForOwner(state, owner, now);
  for (const file of normalizedFiles) {
    state.leases[file] = {
      owner,
      claimedAt,
      expiresAt,
      expiresAtMs,
    };
  }
  state.workspaceEpoch += 1;

  return {
    status: 0,
    body: {
      ok: true,
      command: 'claim',
      owner,
      claimed: normalizedFiles,
      expiresAt,
      workspaceEpoch: state.workspaceEpoch,
      leases: state.leases,
    },
    stateChanged: true,
    state,
  };
}

function reconcileTestCheckpoint(name) {
  const canonicalRoot = process.env.NANOFLOW_LEASE_TEST_ROOT
    ? fs.realpathSync(process.env.NANOFLOW_LEASE_TEST_ROOT)
    : null;
  const runId = process.env.NANOFLOW_LEASE_TEST_RUN_ID;
  const pausePoint = process.env.NANOFLOW_LEASE_TEST_PAUSE_POINT;
  const checkpointNames = new Set(['cas-after-read', 'throw-after-delete', 'after-commit-before-readback']);
  if (typeof process.send !== 'function' || !runId || !canonicalRoot || pausePoint !== 'reconcile-command-protocol' || !checkpointNames.has(name)) {
    return Promise.resolve(null);
  }
  if (fs.realpathSync(process.cwd()) !== canonicalRoot) {
    return Promise.reject(new Error('reconcile checkpoint root mismatch'));
  }
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (!message || message.type !== 'NANOFLOW_LEASE_TEST_RECONCILE_ACTION') return;
      if (message.runId !== runId || message.pausePoint !== pausePoint || message.name !== name) return;
      process.off('message', onMessage);
      resolve(message.action ?? null);
    };
    process.on('message', onMessage);
    process.send({ type: 'NANOFLOW_LEASE_TEST_RECONCILE_CHECKPOINT', runId, pausePoint, name }, error => {
      if (error) { process.off('message', onMessage); reject(error); }
    });
  });
}

async function reconcileExpiredExact(state, root, owner, files) {
  validateOwner(owner);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('reconcile-expired-exact requires at least one exact path');
  }
  const normalized = files.map(file => normalizeLeaseFile(root, file));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('reconcile-expired-exact paths must be unique');
  }
  const now = Date.now();
  const barrier = effectiveBarrier(state);
  if (barrier.state === 'HELD') {
    return { status: 1, stateChanged: false, body: { ok: false, command: 'reconcile-expired-exact', reason: 'barrier-held', owner, workspaceEpoch: state.workspaceEpoch, fencingCounter: effectiveFencingCounter(state), barrier: publicBarrier(barrier), removed: [], skipped: [] } };
  }
  if (BARRIER_WRITE_CLOSING_STATES.has(barrier.state)) {
    for (const file of normalized) {
      const lease = state.leases[file];
      if (!lease) {
        return { status: 1, stateChanged: false, body: { ok: false, command: 'reconcile-expired-exact', reason: 'missing-owner-row', path: file, owner, workspaceEpoch: state.workspaceEpoch, fencingCounter: effectiveFencingCounter(state), barrier: publicBarrier(barrier), removed: [], skipped: [] } };
      }
      if (lease.owner !== owner) {
        return { status: 1, stateChanged: false, body: { ok: false, command: 'reconcile-expired-exact', reason: 'wrong-owner-row', path: file, owner, workspaceEpoch: state.workspaceEpoch, fencingCounter: effectiveFencingCounter(state), barrier: publicBarrier(barrier), removed: [], skipped: [] } };
      }
      if (Number.isFinite(lease.expiresAtMs) && lease.expiresAtMs > now) {
        return { status: 1, stateChanged: false, body: { ok: false, command: 'reconcile-expired-exact', reason: 'active-owner-mismatch', path: file, owner, workspaceEpoch: state.workspaceEpoch, fencingCounter: effectiveFencingCounter(state), barrier: publicBarrier(barrier), removed: [], skipped: [] } };
      }
    }
  }
  const removed = [];
  const skipped = [];
  const casAction = await reconcileTestCheckpoint('cas-after-read');
  if (casAction === 'mutate') {
    // Worker already mutated the observed registry; resume so the store CAS rejects.
  }
  for (const file of normalized) {
    const lease = state.leases[file];
    if (!lease) { skipped.push({ file, reason: 'not-found' }); continue; }
    if (lease.owner !== owner) { skipped.push({ file, reason: 'foreign-skipped', owner: lease.owner }); continue; }
    if (Number.isFinite(lease.expiresAtMs) && lease.expiresAtMs > now) { skipped.push({ file, reason: 'active-skipped' }); continue; }
    delete state.leases[file];
    removed.push(file);
  }
  const deleteAction = await reconcileTestCheckpoint('throw-after-delete');
  if (deleteAction === 'throw') {
    throw new Error('reconcile injected failure');
  }
  const stateChanged = removed.length > 0;
  if (stateChanged) {
    if (state.workspaceEpoch === Number.MAX_SAFE_INTEGER) {
      throw new Error('lease registry workspaceEpoch cannot advance beyond Number.MAX_SAFE_INTEGER');
    }
    state.workspaceEpoch += 1;
  }
  removed.sort();
  skipped.sort((left, right) => left.file.localeCompare(right.file));
  return { status: 0, stateChanged, state, body: { ok: true, command: 'reconcile-expired-exact', owner, removed, skipped, workspaceEpoch: state.workspaceEpoch, fencingCounter: effectiveFencingCounter(state), barrier: publicBarrier(barrier), leases: state.leases, resourceLeases: splitResourceLeasesByStatus(state) } };
}

function release(state, root, owner, files) {
  // An owner-scoped release must never prune another owner's expired record.
  // Generic `prune` remains the explicit whole-registry cleanup command.
  pruneExpiredLeasesForOwner(state, owner);
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
    body: { ok: true, command: 'release', owner, released, skipped, workspaceEpoch: state.workspaceEpoch, leases: state.leases },
    stateChanged: true,
    state,
  };
}

function status(state) {
  const { active, expired } = splitLeasesByExpiry(state);
  const barrier = effectiveBarrier(state);
  return {
    status: 0,
    body: {
      ok: true,
      command: 'status',
      workspaceEpoch: state.workspaceEpoch,
      fencingCounter: effectiveFencingCounter(state),
      barrier: publicBarrier(barrier),
      leases: active,
      expired,
      resourceLeases: splitResourceLeasesByStatus(state),
    },
    stateChanged: false,
  };
}

function prune(state) {
  const changed = pruneExpiredLeases(state);
  const resourcePruned = pruneExpiredResourceLeases(state);
  return {
    status: 0,
    body: {
      ok: true,
      command: 'prune',
      pruned: changed || resourcePruned > 0,
      resourcePruned,
      workspaceEpoch: state.workspaceEpoch,
      leases: state.leases,
      resourceLeases: splitResourceLeasesByStatus(state),
    },
    stateChanged: true,
    state,
  };
}

async function main() {
  const args = prepareResourceLeaseInputs(
    prepareBarrierToken(parseArgs(process.argv.slice(2))),
  );
  let result;
  result = await withLeaseStateLock(args.root, args.owner, async ownerRef => {
    await waitForCliTransactionTestCheckpoint(args.root, 'after-acquire-before-commit');
    const transactionResult = await withLeaseStateTransaction(args.root, state => {
      if (args.command === 'reconcile-expired-exact') {
        return reconcileExpiredExact(state, args.root, args.owner, args.files);
      }
      if (args.command === 'claim') {
        return claim(state, args.root, args.owner, args.files, args.ttlMs);
      }
      if (args.command === 'release') {
        return release(state, args.root, args.owner, args.files);
      }
      if (args.command === 'status') {
        return status(state);
      }
      if (args.command === 'prune') {
        return prune(state);
      }
      if (args.command === 'barrier-acquire') {
        return barrierAcquire(
          state,
          args.owner,
          args.barrierToken,
          args.canonicalBarrierToken,
        );
      }
      if (args.command === 'barrier-heartbeat') {
        return barrierHeartbeat(state, args.owner, args.barrierToken);
      }
      if (args.command === 'barrier-release') {
        return barrierRelease(state, args.owner, args.barrierToken);
      }
      if (args.command === 'resource-lease-acquire') {
        return resourceLeaseAcquire(
          state,
          args.owner,
          args.resourceKind,
          args.resourceId,
          args.canonicalResourceToken,
          args.ttlMs,
        );
      }
      if (args.command === 'resource-lease-heartbeat') {
        return resourceLeaseHeartbeat(
          state,
          args.owner,
          args.resourceKind,
          args.resourceId,
          args.canonicalResourceToken,
          args.ttlMs,
        );
      }
      if (args.command === 'resource-lease-release') {
        return resourceLeaseRelease(
          state,
          args.owner,
          args.resourceKind,
          args.resourceId,
          args.canonicalResourceToken,
        );
      }
      throw new Error('usage: agent-file-lease [--root <dir>] [--owner <id>] [--barrier-token <token>|--barrier-token-stdin] [--resource-kind <read|build> --resource-id <id> --resource-token-stdin] <claim|release|status|prune|reconcile-expired-exact|barrier-acquire|barrier-heartbeat|barrier-release|resource-lease-acquire|resource-lease-heartbeat|resource-lease-release> [files...]');
    }, ownerRef);
    await waitForCliTransactionTestCheckpoint(args.root, 'after-commit-before-release');
    return transactionResult;
  });

  if (args.command === 'reconcile-expired-exact' && result.status === 0) {
    const postAction = await reconcileTestCheckpoint('after-commit-before-readback');
    const registryPath = path.join(args.root, 'tmp', 'agent-file-leases.json');
    const published = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const expected = {
      workspaceEpoch: result.state.workspaceEpoch,
      fencingCounter: result.state.fencingCounter,
      barrier: result.state.barrier,
      leases: result.state.leases ?? {},
      resourceLeases: result.state.resourceLeases ?? {},
    };
    const observed = {
      workspaceEpoch: published.workspaceEpoch,
      fencingCounter: published.fencingCounter,
      barrier: {
        state: published.barrier?.state,
        owner: published.barrier?.owner,
        tokenHash: published.barrier?.tokenHash,
        tokenFingerprint: published.barrier?.tokenFingerprint,
        acquiredAt: published.barrier?.acquiredAt,
        heartbeatAt: published.barrier?.heartbeatAt,
        heartbeatSequence: published.barrier?.heartbeatSequence,
        heldEpoch: published.barrier?.heldEpoch,
        fence: published.barrier?.fence,
        releasedAt: published.barrier?.releasedAt,
        transitions: published.barrier?.transitions ?? [],
      },
      leases: published.leases ?? {},
      resourceLeases: published.resourceLeases ?? {},
    };
    const matches = JSON.stringify(observed) === JSON.stringify(expected);
    if (!matches) {
      result = {
        status: 1,
        body: {
          ok: false,
          command: 'reconcile-expired-exact',
          reason: 'postwrite-readback-mismatch',
          owner: args.owner,
          removed: result.body.removed ?? [],
          skipped: result.body.skipped ?? [],
          workspaceEpoch: result.body.workspaceEpoch,
          fencingCounter: result.body.fencingCounter,
          barrier: result.body.barrier,
        },
      };
    }
  }
  process.exitCode = result.status;
  await writeOutput(process.stdout, `${JSON.stringify(result.body, null, 2)}\n`);
}

function writeOutput(stream, payload) {
  return new Promise((resolve, reject) => {
    stream.write(payload, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function reportFatalError(error) {
  process.exitCode = 1;
  const payload = error?.leaseStateFailure === 'repair-required' && error?.leaseStateDiagnostic
    ? `${JSON.stringify(error.leaseStateDiagnostic)}\n`
    : `${error?.stack || error}\n`;
  try {
    await writeOutput(process.stderr, payload);
  } catch {
    // The original failure remains authoritative even when stderr is unavailable.
  }
}

void main().catch(error => reportFatalError(error));
