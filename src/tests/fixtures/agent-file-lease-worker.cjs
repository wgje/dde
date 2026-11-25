'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runId = process.env.NANOFLOW_LEASE_TEST_RUN_ID;
const configuredRoot = process.env.NANOFLOW_LEASE_TEST_ROOT;
const pausePoint = process.env.NANOFLOW_LEASE_TEST_PAUSE_POINT;
const [leaseScriptArgument, ...leaseArguments] = process.argv.slice(2);
const rootFlagIndex = leaseArguments.indexOf('--root');
const rootArgument = rootFlagIndex >= 0 ? leaseArguments[rootFlagIndex + 1] : null;
const OWNER_LOCK_PAUSE_POINT = 'after-owner-lock-acquired';
const COMMIT_PRE_RENAME_PAUSE_POINT = 'after-registry-temp-fsync-before-rename';
const PROVISIONAL_HELPER_PAUSE_POINT = 'after-owner-helper-created-before-publication';
const STATE_LOCK_PROTOCOL_PAUSE_POINT = 'before-state-lock-protocol';
const REGISTRY_CAS_PROTOCOL_PAUSE_POINT = 'registry-cas-protocol';
const HEARTBEAT_PROTOCOL_PAUSE_POINT = 'heartbeat-protocol';
const STALE_PROTOCOL_PAUSE_POINT = 'stale-protocol';
const RECONCILE_PROTOCOL_PAUSE_POINT = 'reconcile-command-protocol';

if (typeof runId !== 'string' || runId.length === 0
  || typeof configuredRoot !== 'string'
  || ![OWNER_LOCK_PAUSE_POINT, COMMIT_PRE_RENAME_PAUSE_POINT, PROVISIONAL_HELPER_PAUSE_POINT, STATE_LOCK_PROTOCOL_PAUSE_POINT, REGISTRY_CAS_PROTOCOL_PAUSE_POINT, HEARTBEAT_PROTOCOL_PAUSE_POINT, STALE_PROTOCOL_PAUSE_POINT, RECONCILE_PROTOCOL_PAUSE_POINT].includes(pausePoint)
  || !leaseScriptArgument
  || !rootArgument) {
  throw new Error('agent-file-lease worker requires a complete test checkpoint');
}

const canonicalRoot = fs.realpathSync(rootArgument);
const canonicalTmp = fs.realpathSync(os.tmpdir());
function isCanonicalNanoFlowTempRoot(candidate, original) {
  const relativeToTmp = path.relative(canonicalTmp, candidate);
  const outsideTmp = relativeToTmp === ''
    || relativeToTmp === '..'
    || relativeToTmp.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToTmp);
  return path.resolve(original) === candidate
    && !outsideTmp
    && path.basename(candidate).startsWith('nanoflow-agent-file-lease-');
}

if (configuredRoot !== canonicalRoot || !isCanonicalNanoFlowTempRoot(canonicalRoot, rootArgument)) {
  throw new Error('agent-file-lease worker root is not the canonical NanoFlow temp root');
}

const configuredTransactionRoot = process.env.NANOFLOW_LEASE_TEST_TRANSACTION_ROOT;
const transactionRoot = configuredTransactionRoot
  ? fs.realpathSync(configuredTransactionRoot)
  : canonicalRoot;
if (!isCanonicalNanoFlowTempRoot(transactionRoot, configuredTransactionRoot || canonicalRoot)) {
  throw new Error('agent-file-lease worker transaction root is not a canonical NanoFlow temp root');
}

const leaseScriptPath = fs.realpathSync(leaseScriptArgument);
const leaseStorePath = path.join(path.dirname(leaseScriptPath), 'lib', 'agent-file-lease-store.cjs');

function waitForResume() {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const onMessage = message => {
      if (!message
        || message.type !== 'NANOFLOW_LEASE_TEST_RESUME'
        || message.runId !== runId
        || message.pausePoint !== pausePoint) return;
      cleanup();
      resolve();
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error('agent-file-lease worker disconnected before resume'));
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    process.send({
      type: 'NANOFLOW_LEASE_TEST_CHECKPOINT',
      runId,
      pausePoint,
    }, error => {
      if (!error) return;
      cleanup();
      reject(error);
    });
  });
}

function sendHeartbeatCheckpoint(stage, evidence) {
  return new Promise((resolve, reject) => {
    process.send({
      type: 'NANOFLOW_LEASE_TEST_HEARTBEAT_CHECKPOINT',
      runId,
      pausePoint,
      stage,
      evidence,
    }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForHeartbeatRelease() {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const onMessage = message => {
      if (!message
        || message.type !== 'NANOFLOW_LEASE_TEST_RESUME'
        || message.runId !== runId
        || message.pausePoint !== pausePoint
        || message.stage !== 'release') return;
      cleanup();
      resolve();
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error('agent-file-lease heartbeat worker disconnected before release'));
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

function waitForStaleHolderAction() {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const onMessage = message => {
      if (!message
        || message.type !== 'NANOFLOW_LEASE_TEST_STALE_ACTION'
        || message.runId !== runId
        || message.pausePoint !== pausePoint
        || !['exit-normal', 'exit-crash'].includes(message.action)) return;
      cleanup();
      resolve(message.action);
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error('agent-file-lease stale holder disconnected before action'));
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

function waitForStaleBarrierAction(action) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
    };
    const onMessage = message => {
      if (!message
        || message.type !== 'NANOFLOW_LEASE_TEST_STALE_BARRIER'
        || message.runId !== runId
        || message.pausePoint !== pausePoint
        || message.action !== action) return;
      cleanup();
      resolve();
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error(`agent-file-lease stale contender disconnected before ${action}`));
    };
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

function sendStaleBarrierStage(stage) {
  return new Promise((resolve, reject) => {
    process.send({
      type: 'NANOFLOW_LEASE_TEST_STALE_BARRIER_STAGE',
      runId,
      pausePoint,
      stage,
    }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function readHeartbeatEvidence() {
  const canonicalPath = path.join(canonicalRoot, 'tmp', 'agent-file-leases.json.lock');
  const canonicalBytes = fs.readFileSync(canonicalPath);
  const canonical = JSON.parse(canonicalBytes.toString('utf8'));
  const heartbeatPath = `${canonicalPath}.heartbeat.${canonical.token}`;
  const heartbeatBytes = fs.readFileSync(heartbeatPath);
  const canonicalStat = fs.statSync(canonicalPath, { bigint: true });
  return {
    canonical: {
      bytesBase64: canonicalBytes.toString('base64'),
      dev: canonicalStat.dev.toString(),
      ino: canonicalStat.ino.toString(),
    },
    heartbeat: JSON.parse(heartbeatBytes.toString('utf8')),
    heartbeatBytesBase64: heartbeatBytes.toString('base64'),
    heartbeatName: path.basename(heartbeatPath),
  };
}

function readBeforeFirstHeartbeatEvidence() {
  const canonicalPath = path.join(canonicalRoot, 'tmp', 'agent-file-leases.json.lock');
  const canonicalBytes = fs.readFileSync(canonicalPath);
  const owner = JSON.parse(canonicalBytes.toString('utf8'));
  const heartbeatPath = `${canonicalPath}.heartbeat.${owner.token}`;
  const heartbeatExists = fs.existsSync(heartbeatPath);
  const canonicalStat = fs.statSync(canonicalPath, { bigint: true });
  const initialHeartbeat = owner.initialHeartbeat || {};
  return {
    canonical: {
      bytesBase64: canonicalBytes.toString('base64'),
      dev: canonicalStat.dev.toString(),
      ino: canonicalStat.ino.toString(),
    },
    heartbeat: {
      schema: initialHeartbeat.schema ?? 1,
      token: initialHeartbeat.token ?? owner.token,
      pid: initialHeartbeat.pid ?? owner.pid,
      processStartIdentity: initialHeartbeat.processStartIdentity ?? owner.processStartIdentity,
      sequence: initialHeartbeat.sequence ?? -1,
      updatedAtMs: initialHeartbeat.heartbeatAtMs ?? Date.parse(owner.createdAt),
    },
    heartbeatBytesBase64: heartbeatExists
      ? fs.readFileSync(heartbeatPath).toString('base64')
      : '',
    heartbeatName: path.basename(heartbeatPath),
    heartbeatExists,
    owner,
  };
}

async function waitForHeartbeatEvidence() {
  while (true) {
    try {
      return readHeartbeatEvidence();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

async function waitForHeartbeatAdvance(initialSequence, minimumAdvance) {
  while (true) {
    const evidence = readHeartbeatEvidence();
    if (evidence.heartbeat.sequence >= initialSequence + minimumAdvance) return evidence;
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function runOwnerLockWorker() {
  const {
    acquireLeaseStateLock,
    assertLeaseStateLock,
    releaseLeaseStateLock,
    withLeaseStateTransaction,
  } = require(leaseStorePath);
  if (process.env.NANOFLOW_LEASE_TEST_DISCONNECT_BEFORE_ACQUIRE === '1') {
    process.disconnect();
  }
  const ownerRef = acquireLeaseStateLock(
    canonicalRoot,
    process.env.NANOFLOW_LEASE_TEST_OWNER || 'owner-lock-worker',
  );
  if (pausePoint === OWNER_LOCK_PAUSE_POINT) await waitForResume();
  if (process.env.NANOFLOW_LEASE_TEST_PROBE_OWNER_REF === '1') {
    const assertionResult = assertLeaseStateLock(ownerRef);
    if (assertionResult !== undefined) {
      throw new Error('assertLeaseStateLock exposed private OwnerRef state');
    }
    let forgedRefError;
    try {
      releaseLeaseStateLock(Object.freeze(Object.create(null)));
    } catch (error) {
      forgedRefError = error;
    }
    if (!forgedRefError || !String(forgedRefError.message).includes('invalid lease state lock OwnerRef')) {
      throw new Error('releaseLeaseStateLock accepted a forged OwnerRef');
    }
  }
  const canonicalPath = path.join(canonicalRoot, 'tmp', 'agent-file-leases.json.lock');
  const lockDirectory = path.dirname(canonicalPath);
  const registryPath = path.join(lockDirectory, 'agent-file-leases.json');
  const heartbeatPrefix = `${path.basename(canonicalPath)}.heartbeat.`;
  const captureFile = filePath => {
    try {
      const stat = fs.lstatSync(filePath, { bigint: true });
      return {
        exists: true,
        bytesBase64: stat.isFile() ? fs.readFileSync(filePath).toString('base64') : null,
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false };
      throw error;
    }
  };
  const captureTransactionNamespace = () => ({
    canonical: captureFile(canonicalPath),
    registry: captureFile(registryPath),
    entries: fs.readdirSync(lockDirectory).sort(),
  });
  let transactionError;
  let transactionFailureEvidence;
  if (process.env.NANOFLOW_LEASE_TEST_RUN_TRANSACTION === '1') {
    const beforeTransaction = process.env.NANOFLOW_LEASE_TEST_PROBE_TRANSACTION_FAILURE_STATE === '1'
      ? captureTransactionNamespace()
      : undefined;
    if (process.env.NANOFLOW_LEASE_TEST_DISCONNECT_BEFORE_TRANSACTION === '1') {
      process.disconnect();
    }
    try {
      await withLeaseStateTransaction(transactionRoot, state => {
        const claimedAtMs = Date.now();
        const expiresAtMs = claimedAtMs + 30 * 60 * 1_000;
        state.leases['after-owner-loss.ts'] = {
          owner: 'owner-lock-worker',
          claimedAt: new Date(claimedAtMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
          expiresAtMs,
        };
        return { stateChanged: true, state };
      }, ownerRef);
    } catch (error) {
      transactionError = error;
    }
    if (beforeTransaction) {
      transactionFailureEvidence = {
        before: beforeTransaction,
        after: captureTransactionNamespace(),
      };
    }
  }
  let heartbeatFailureBeforeRelease;
  if (process.env.NANOFLOW_LEASE_TEST_WAIT_FOR_HEARTBEAT_FAILURE_BEFORE_RELEASE === '1') {
    while (!heartbeatFailureBeforeRelease) {
      await new Promise(resolve => setImmediate(resolve));
      try {
        assertLeaseStateLock(ownerRef);
      } catch (error) {
        if (!String(error?.message).includes('injected heartbeat syscall failure')) throw error;
        heartbeatFailureBeforeRelease = error;
      }
    }
    delete process.env.NANOFLOW_LEASE_TEST_HEARTBEAT_FAULT;
  }
  const postHeartbeatFailureMutation = process.env.NANOFLOW_LEASE_TEST_POST_HEARTBEAT_FAILURE_MUTATION;
  if (postHeartbeatFailureMutation) {
    if (process.env.NANOFLOW_LEASE_TEST_WAIT_FOR_HEARTBEAT_FAILURE_BEFORE_RELEASE !== '1'
      || !heartbeatFailureBeforeRelease) {
      throw new Error('post-heartbeat release mutation requires an observed heartbeat failure');
    }
    if (![
      'replace-canonical-successor',
      'replace-canonical-successor-and-helper',
      'replace-canonical-directory',
    ].includes(postHeartbeatFailureMutation)) {
      throw new Error(`unsupported post-heartbeat release mutation: ${postHeartbeatFailureMutation}`);
    }
    if (postHeartbeatFailureMutation === 'replace-canonical-successor-and-helper') {
      const ownerFiles = fs.readdirSync(lockDirectory)
        .filter(name => name.startsWith(`${path.basename(canonicalPath)}.owner.`));
      if (ownerFiles.length !== 1) throw new Error('post-heartbeat helper mutation requires one owner helper');
      const ownerPath = path.join(lockDirectory, ownerFiles[0]);
      fs.unlinkSync(ownerPath);
      fs.writeFileSync(ownerPath, 'post-heartbeat-helper-successor', { flag: 'wx' });
    }
    fs.unlinkSync(canonicalPath);
    if (postHeartbeatFailureMutation === 'replace-canonical-directory') {
      fs.mkdirSync(canonicalPath);
    } else {
      fs.writeFileSync(
        canonicalPath,
        '{"schema":2,"token":"post-heartbeat-canonical-successor"}',
        { flag: 'wx' },
      );
    }
  }
  const heartbeatExistedBeforeRelease = fs.readdirSync(lockDirectory)
    .some(name => name.startsWith(heartbeatPrefix));
  if (process.env.NANOFLOW_LEASE_TEST_DISCONNECT_BEFORE_RELEASE === '1') {
    process.disconnect();
  }
  const releaseCount = Number.parseInt(process.env.NANOFLOW_LEASE_TEST_RELEASE_COUNT || '1', 10);
  let releaseError;
  try {
    for (let attempt = 0; attempt < releaseCount; attempt += 1) {
      releaseLeaseStateLock(ownerRef);
    }
  } catch (error) {
    releaseError = error;
  }
  if (releaseError && process.env.NANOFLOW_LEASE_TEST_PROBE_RELEASE_STATE_AFTER_FAILURE === '1') {
    let stateProbeError;
    try {
      assertLeaseStateLock(ownerRef);
    } catch (error) {
      stateProbeError = error;
    }
    const ownerFiles = fs.readdirSync(path.dirname(canonicalPath))
      .filter(name => name.startsWith(`${path.basename(canonicalPath)}.owner.`));
    const ownerPath = ownerFiles.length === 1
      ? path.join(path.dirname(canonicalPath), ownerFiles[0])
      : null;
    const canonicalStat = fs.lstatSync(canonicalPath);
    const heartbeatNames = fs.readdirSync(lockDirectory)
      .filter(name => name.startsWith(heartbeatPrefix));
    const quarantineNames = fs.readdirSync(lockDirectory)
      .filter(name => name.startsWith(`${path.basename(canonicalPath)}.release.`));
    const evidenceAfterFirstFailure = {
      canonicalIsDirectory: canonicalStat.isDirectory(),
      canonicalIsSymbolicLink: canonicalStat.isSymbolicLink(),
      helperExists: ownerPath ? fs.existsSync(ownerPath) : false,
      heartbeatFailureBeforeRelease: heartbeatFailureBeforeRelease?.message ?? null,
      heartbeatExistedBeforeRelease,
      heartbeatNames,
      heartbeatRestored: !heartbeatExistedBeforeRelease && heartbeatNames.length === 1,
      quarantineNames,
    };
    if (process.env.NANOFLOW_LEASE_TEST_WAIT_FOR_HEARTBEAT_FAILURE_BEFORE_RELEASE === '1'
      && process.env.NANOFLOW_LEASE_TEST_RELEASE_FAULT === 'throw-on-canonical-unlink'
      && heartbeatNames.length === 1) {
      const restored = readHeartbeatEvidence();
      const renewed = await waitForHeartbeatAdvance(restored.heartbeat.sequence, 2);
      evidenceAfterFirstFailure.retryableHeartbeatAdvance = {
        initialSequence: restored.heartbeat.sequence,
        renewedSequence: renewed.heartbeat.sequence,
        initialUpdatedAtMs: restored.heartbeat.updatedAtMs,
        renewedUpdatedAtMs: renewed.heartbeat.updatedAtMs,
      };
    }
    if (process.env.NANOFLOW_LEASE_TEST_RELEASE_FAULT === 'replace-canonical-with-directory-before-unlink'
      && evidenceAfterFirstFailure.canonicalIsDirectory
      && evidenceAfterFirstFailure.helperExists) {
      fs.rmdirSync(canonicalPath);
      fs.linkSync(ownerPath, canonicalPath);
    }
    if ([
      'throw-on-canonical-unlink',
      'throw-on-quarantine-unlink',
      'replace-quarantine-with-successor-before-readback',
    ].includes(process.env.NANOFLOW_LEASE_TEST_RELEASE_FAULT)) {
      delete process.env.NANOFLOW_LEASE_TEST_RELEASE_FAULT;
    }
    let retryReleaseError;
    try {
      releaseLeaseStateLock(ownerRef);
    } catch (error) {
      retryReleaseError = error;
    }
    process.stdout.write(`${JSON.stringify({
      releaseError: releaseError.message,
      releaseErrorCode: releaseError.code ?? null,
      releaseErrorFailure: releaseError.leaseStateFailure ?? null,
      releaseErrorCause: releaseError.cause?.message ?? null,
      releaseErrorHeartbeatError: releaseError.heartbeatError?.message ?? null,
      releaseErrorCleanupError: releaseError.cleanupError?.message ?? null,
      releaseErrorHeartbeatRestoreError: releaseError.heartbeatRestoreError?.message ?? null,
      releaseErrorSecondaryChain: [
        ['cause', releaseError.cause],
        ['heartbeatError', releaseError.heartbeatError],
        ['cleanupError', releaseError.cleanupError],
        ['heartbeatRestoreError', releaseError.heartbeatRestoreError],
      ].filter(([, error]) => error).map(([slot, error]) => ({
        slot,
        message: error.message,
      })),
      stateProbeError: stateProbeError?.message ?? null,
      evidenceAfterFirstFailure,
      retryReleaseError: retryReleaseError?.message ?? null,
    })}\n`);
  }
  if (transactionFailureEvidence) {
    process.stdout.write(`${JSON.stringify({ transactionFailureEvidence })}\n`);
  }
  if (transactionError) throw transactionError;
  if (releaseError) throw releaseError;
}

async function runStateLockProtocolWorker() {
  const {
    assertLeaseStateLock,
    withLeaseStateLock,
    withLeaseStateTransaction,
  } = require(leaseStorePath);
  await waitForResume();
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'async-success') {
    const lockPath = path.join(canonicalRoot, 'tmp', 'agent-file-leases.json.lock');
    const registryPath = path.join(canonicalRoot, 'tmp', 'agent-file-leases.json');
    const evidence = {};
    const callbackResult = await withLeaseStateLock(
      canonicalRoot,
      'state-lock-protocol-worker',
      async ownerRef => {
        evidence.heldBeforeCallbackAwait = fs.existsSync(lockPath);
        assertLeaseStateLock(ownerRef);
        await new Promise(resolve => setImmediate(resolve));
        evidence.heldAfterCallbackAwait = fs.existsSync(lockPath);
        assertLeaseStateLock(ownerRef);
        const transactionResult = await withLeaseStateTransaction(canonicalRoot, async state => {
          evidence.registryBeforeTransactionSettlement = fs.existsSync(registryPath);
          await new Promise(resolve => setImmediate(resolve));
          assertLeaseStateLock(ownerRef);
          const now = Date.now();
          const expiresAtMs = now + 30 * 60 * 1000;
          state.leases['async.ts'] = {
            owner: 'state-lock-protocol-worker',
            claimedAt: new Date(now).toISOString(),
            expiresAt: new Date(expiresAtMs).toISOString(),
            expiresAtMs,
          };
          return {
            stateChanged: true,
            state,
            callbackResult: 'async-state-lock-callback-result',
          };
        }, ownerRef);
        evidence.heldAfterTransactionAwait = fs.existsSync(lockPath);
        evidence.registryAfterTransactionSettlement = fs.existsSync(registryPath);
        await new Promise(resolve => setImmediate(resolve));
        assertLeaseStateLock(ownerRef);
        evidence.heldBeforeCallbackSettlement = fs.existsSync(lockPath);
        return transactionResult.callbackResult;
      },
    );
    evidence.heldAfterCallbackSettlement = fs.existsSync(lockPath);
    evidence.registryAfterCallbackSettlement = fs.existsSync(registryPath);
    process.stdout.write(`${JSON.stringify({ callbackResult, ...evidence })}\n`);
    return;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'double-error') {
    let observedError;
    try {
      await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => {
        assertLeaseStateLock(ownerRef);
        const canonicalPath = path.join(canonicalRoot, 'tmp', 'agent-file-leases.json.lock');
        const successorBytes = Buffer.from('{"schema":2,"token":"double-error-successor"}', 'utf8');
        fs.unlinkSync(canonicalPath);
        fs.writeFileSync(canonicalPath, successorBytes, { flag: 'wx' });
        const successorStat = fs.statSync(canonicalPath, { bigint: true });
        fs.writeFileSync(
          path.join(canonicalRoot, 'state-lock-double-error-evidence.json'),
          JSON.stringify({
            dev: successorStat.dev.toString(),
            ino: successorStat.ino.toString(),
            mtimeNs: successorStat.mtimeNs.toString(),
          }),
          { flag: 'wx' },
        );
        return {
          then(_resolve, reject) {
            setImmediate(() => reject(new Error('state-lock-callback-primary-sentinel')));
          },
        };
      });
    } catch (error) {
      observedError = error;
    }
    if (!observedError) {
      throw new Error('withLeaseStateLock unexpectedly returned from the double-error scenario');
    }
    process.stdout.write(`${JSON.stringify({
      message: observedError.message,
      causeMessage: observedError.cause?.message ?? null,
    })}\n`);
    throw observedError;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'invalid-candidate') {
    await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => (
      withLeaseStateTransaction(canonicalRoot, state => ({
        stateChanged: 'yes',
        state,
      }), ownerRef)
    ));
    return;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'foreign-state-candidate') {
    await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => (
      withLeaseStateTransaction(canonicalRoot, state => ({
        stateChanged: true,
        state: { ...state, leases: {} },
      }), ownerRef)
    ));
    return;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'invalid-registry-candidate') {
    await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => (
      withLeaseStateTransaction(canonicalRoot, state => {
        state.leases = [];
        return { stateChanged: true, state };
      }, ownerRef)
    ));
    return;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'workspace-epoch-rollback') {
    await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => (
      withLeaseStateTransaction(canonicalRoot, state => {
        state.workspaceEpoch -= 1;
        return { stateChanged: true, state };
      }, ownerRef)
    ));
    return;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'fencing-counter-rollback') {
    await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => (
      withLeaseStateTransaction(canonicalRoot, state => {
        state.fencingCounter -= 1;
        return { stateChanged: true, state };
      }, ownerRef)
    ));
    return;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'transition-prefix-rewrite') {
    await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => (
      withLeaseStateTransaction(canonicalRoot, state => {
        const rewrittenAt = new Date(Date.parse(state.barrier.acquiredAt) + 1).toISOString();
        state.barrier.acquiredAt = rewrittenAt;
        state.barrier.heartbeatAt = rewrittenAt;
        state.barrier.transitions[0].at = rewrittenAt;
        return { stateChanged: true, state };
      }, ownerRef)
    ));
    return;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'owner-helper-replaced-before-commit') {
    await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => (
      withLeaseStateTransaction(canonicalRoot, state => {
        const transactionDirectory = path.join(canonicalRoot, 'tmp');
        const ownerHelperName = fs.readdirSync(transactionDirectory)
          .find(entry => entry.startsWith('agent-file-leases.json.lock.owner.'));
        if (!ownerHelperName) throw new Error('owner helper was unavailable for replacement');
        const ownerHelperPath = path.join(transactionDirectory, ownerHelperName);
        fs.unlinkSync(ownerHelperPath);
        fs.writeFileSync(ownerHelperPath, 'owner-helper-successor', { flag: 'wx' });
        state.workspaceEpoch += 1;
        return { stateChanged: true, state };
      }, ownerRef)
    ));
    return;
  }
  if (process.env.NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE === 'heartbeat-replaced-before-commit') {
    await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', async ownerRef => {
      const transactionDirectory = path.join(canonicalRoot, 'tmp');
      await withLeaseStateTransaction(canonicalRoot, state => {
        state.workspaceEpoch += 1;
        return { stateChanged: true, state };
      }, ownerRef);
      fs.unlinkSync(path.join(transactionDirectory, 'agent-file-leases.json'));
      const heartbeatName = fs.readdirSync(transactionDirectory)
        .find(entry => entry.startsWith('agent-file-leases.json.lock.heartbeat.'));
      if (!heartbeatName) throw new Error('heartbeat was unavailable for replacement');
      return withLeaseStateTransaction(canonicalRoot, state => {
        const heartbeatPath = path.join(transactionDirectory, heartbeatName);
        fs.unlinkSync(heartbeatPath);
        fs.writeFileSync(heartbeatPath, '{"schema":1}', { flag: 'wx' });
        state.workspaceEpoch += 1;
        return { stateChanged: true, state };
      }, ownerRef);
    });
    return;
  }
  const result = await withLeaseStateLock(canonicalRoot, 'state-lock-protocol-worker', ownerRef => {
    assertLeaseStateLock(ownerRef);
    return 'state-lock-callback-result';
  });
  if (result !== 'state-lock-callback-result') {
    throw new Error('withLeaseStateLock did not return the callback result');
  }
}

async function runHeartbeatProtocolWorker() {
  const {
    assertLeaseStateLock,
    withLeaseStateLock,
  } = require(leaseStorePath);
  const mode = process.env.NANOFLOW_LEASE_TEST_HEARTBEAT_MODE;
  if (!['observe-renewal', 'crash-before-first-tick', 'crash-before-rename', 'failure-before-fsync', 'failure-on-rename'].includes(mode)) {
    throw new Error(`unsupported heartbeat protocol mode: ${mode}`);
  }

  await withLeaseStateLock(canonicalRoot, 'heartbeat-protocol-worker', async ownerRef => {
    assertLeaseStateLock(ownerRef);
    if (mode === 'crash-before-first-tick') {
      await sendHeartbeatCheckpoint('before-first-tick', readBeforeFirstHeartbeatEvidence());
      process.exit(85);
    }

    const initial = await waitForHeartbeatEvidence();
    if (mode === 'failure-before-fsync' || mode === 'failure-on-rename') {
      process.env.NANOFLOW_LEASE_TEST_HEARTBEAT_FAULT = mode === 'failure-before-fsync'
        ? 'throw-before-temp-fsync'
        : 'throw-on-heartbeat-rename';
    }
    await sendHeartbeatCheckpoint('initial', initial);

    if (mode === 'crash-before-rename') {
      process.env.NANOFLOW_LEASE_TEST_HEARTBEAT_FAULT = 'exit-after-temp-fsync-before-rename';
      await sendHeartbeatCheckpoint('fault-armed', readHeartbeatEvidence());
      await waitForHeartbeatRelease();
      return;
    }

    if (mode === 'failure-before-fsync' || mode === 'failure-on-rename') {
      while (true) {
        await new Promise(resolve => setImmediate(resolve));
        try {
          assertLeaseStateLock(ownerRef);
        } catch (error) {
          await sendHeartbeatCheckpoint('failed', readHeartbeatEvidence());
          throw new Error(`heartbeat renewal failure observed: ${error.message}`, { cause: error });
        }
      }
    }

    const renewed = await waitForHeartbeatAdvance(initial.heartbeat.sequence, 2);
    assertLeaseStateLock(ownerRef);
    await sendHeartbeatCheckpoint('renewed', renewed);
    await waitForHeartbeatRelease();
    assertLeaseStateLock(ownerRef);
  });

  process.stdout.write(`${JSON.stringify({
    directoryEntries: fs.readdirSync(path.join(canonicalRoot, 'tmp')),
  })}\n`);
}

async function runRegistryCasProtocolWorker() {
  const {
    withLeaseStateLock,
    withLeaseStateTransaction,
  } = require(leaseStorePath);
  const callbackResult = await withLeaseStateLock(
    canonicalRoot,
    'registry-cas-protocol-worker',
    ownerRef => withLeaseStateTransaction(canonicalRoot, async state => {
      await waitForResume();
      const now = Date.now();
      const expiresAtMs = now + 30 * 60 * 1000;
      state.leases['registry-cas.ts'] = {
        owner: 'registry-cas-protocol-worker',
        claimedAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };
      state.workspaceEpoch += 1;
      return {
        callbackResult: 'registry-cas-committed',
        state,
        stateChanged: true,
      };
    }, ownerRef).then(result => result.callbackResult),
  );
  process.stdout.write(`${JSON.stringify({ callbackResult })}\n`);
}

async function runStaleProtocolWorker() {
  const {
    acquireLeaseStateLock,
    releaseLeaseStateLock,
    withLeaseStateTransaction,
  } = require(leaseStorePath);
  const role = process.env.NANOFLOW_LEASE_TEST_STALE_ROLE;
  if (role === 'barrier-contender') {
    await sendStaleBarrierStage('ready');
    await waitForStaleBarrierAction('go');
    await sendStaleBarrierStage('attempting');
    await waitForStaleBarrierAction('acquire');
    const ownerRef = acquireLeaseStateLock(canonicalRoot, `barrier-contender-${runId}`);
    await sendStaleBarrierStage('won');
    await waitForStaleBarrierAction('commit');
    await withLeaseStateTransaction(canonicalRoot, state => {
      const now = Date.now();
      const expiresAtMs = now + 30 * 60 * 1000;
      state.leases['concurrent-reclaim.ts'] = {
        owner: runId,
        claimedAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };
      return { stateChanged: true, state };
    }, ownerRef);
    releaseLeaseStateLock(ownerRef);
    process.stdout.write(`${JSON.stringify({ acquired: true, runId })}\n`);
    return;
  }
  if (role === 'contender') {
    const systemRootOverride = process.env.NANOFLOW_LEASE_TEST_SYSTEM_ROOT_OVERRIDE;
    const winDirOverride = process.env.NANOFLOW_LEASE_TEST_WIN_DIR_OVERRIDE;
    if (systemRootOverride !== undefined || winDirOverride !== undefined) {
      if (process.platform !== 'win32'
        || typeof process.send !== 'function'
        || process.connected !== true
        || typeof systemRootOverride !== 'string'
        || systemRootOverride.length === 0
        || typeof winDirOverride !== 'string'
        || winDirOverride.length === 0) {
        throw new Error('system-root override requires an active Windows test IPC channel');
      }
      process.env.SystemRoot = systemRootOverride;
      process.env.windir = winDirOverride;
    }
    const childNodeOptions = process.env.NANOFLOW_LEASE_TEST_CHILD_NODE_OPTIONS;
    if (childNodeOptions !== undefined && childNodeOptions !== '') {
      if (process.platform !== 'win32'
        || typeof process.send !== 'function'
        || process.connected !== true) {
        throw new Error('child Node options probe requires an active Windows test IPC channel');
      }
      process.env.NODE_OPTIONS = childNodeOptions;
    }
    const ownerRef = acquireLeaseStateLock(canonicalRoot, 'stale-protocol-contender');
    releaseLeaseStateLock(ownerRef);
    process.stdout.write(`${JSON.stringify({ acquired: true })}\n`);
    return;
  }
  if (role !== 'holder') throw new Error(`unsupported stale protocol role: ${role}`);

  acquireLeaseStateLock(canonicalRoot, 'stale-protocol-holder');
  const evidence = await waitForHeartbeatEvidence();
  await new Promise((resolve, reject) => {
    process.send({
      type: 'NANOFLOW_LEASE_TEST_STALE_CHECKPOINT',
      runId,
      pausePoint,
      stage: 'held',
      evidence,
    }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
  const action = await waitForStaleHolderAction();
  process.exit(action === 'exit-normal' ? 0 : 85);
}

async function runReconcileCommandWorker() {
  const scenario = await new Promise((resolve, reject) => {
    const onMessage = message => {
      if (!message || message.type !== 'NANOFLOW_LEASE_TEST_RECONCILE_SCENARIO') return;
      if (message.runId !== runId || message.root !== canonicalRoot || message.pausePoint !== RECONCILE_PROTOCOL_PAUSE_POINT) {
        reject(new Error('reconcile scenario authentication mismatch'));
        return;
      }
      const action = message.action;
      if (!['cas-after-read', 'callback-rollback', 'postwrite-mismatch'].includes(action)) {
        reject(new Error('unknown reconcile scenario action'));
        return;
      }
      process.off('message', onMessage);
      resolve(action);
    };
    process.on('message', onMessage);
  });
  const child = require('node:child_process').fork(leaseScriptPath, [
    '--root', canonicalRoot,
    '--owner', process.env.NANOFLOW_LEASE_TEST_OWNER || 'owner',
    'reconcile-expired-exact',
    ...leaseArguments.filter(arg => arg !== '--root' && arg !== rootArgument),
  ], {
    cwd: canonicalRoot,
    env: {
      ...process.env,
      NANOFLOW_LEASE_TEST_RUN_ID: runId,
      NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
      NANOFLOW_LEASE_TEST_PAUSE_POINT: RECONCILE_PROTOCOL_PAUSE_POINT,
    },
    silent: true,
  });
  const registryPath = path.join(canonicalRoot, 'tmp', 'agent-file-leases.json');
  const actionByCheckpoint = {
    'cas-after-read': 'mutate',
    'throw-after-delete': 'throw',
    'after-commit-before-readback': 'mutate',
  };
  let mutatedRegistrySha = null;
  let mutatedRegistryIdentity = null;
  const expectedCheckpoint = scenario === 'cas-after-read'
    ? 'cas-after-read'
    : scenario === 'callback-rollback'
      ? 'throw-after-delete'
      : scenario === 'postwrite-mismatch'
        ? 'after-commit-before-readback'
        : null;
  const onMessage = message => {
    if (!message || message.type !== 'NANOFLOW_LEASE_TEST_RECONCILE_CHECKPOINT') return;
    if (message.runId !== runId || message.pausePoint !== RECONCILE_PROTOCOL_PAUSE_POINT) {
      child.send({ type: 'NANOFLOW_LEASE_TEST_RECONCILE_ACTION', runId, pausePoint: RECONCILE_PROTOCOL_PAUSE_POINT, name: message.name, action: 'fail-closed' });
      return;
    }
    const action = message.name === expectedCheckpoint
      ? actionByCheckpoint[message.name]
      : 'fail-closed';
    if (message.name === expectedCheckpoint
      && (message.name === 'cas-after-read' || message.name === 'after-commit-before-readback')) {
      const state = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      state.workspaceEpoch += 1;
      fs.writeFileSync(registryPath, `${JSON.stringify(state, null, 2)}\n`);
      if (message.name === 'after-commit-before-readback' || message.name === 'cas-after-read') {
        const bytes = fs.readFileSync(registryPath);
        mutatedRegistrySha = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
        mutatedRegistryIdentity = {
          workspaceEpoch: state.workspaceEpoch,
          fencingCounter: state.fencingCounter,
          barrier: state.barrier,
          leases: state.leases,
          resourceLeases: state.resourceLeases,
        };
      }
    }
    child.send({ type: 'NANOFLOW_LEASE_TEST_RECONCILE_ACTION', runId, pausePoint: RECONCILE_PROTOCOL_PAUSE_POINT, name: message.name, action });
  };
  child.on('message', onMessage);
  child.on('error', error => { throw error; });
  let cliStdout = '';
  let cliStderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { cliStdout += chunk; });
  child.stderr?.on('data', chunk => { cliStderr += chunk; });
  await new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      process.stdout.write(`${JSON.stringify({ reconcileExitCode: code, signal, cliStdout, cliStderr, mutatedRegistrySha, mutatedRegistryIdentity })}\n`);
      if (code === 0) resolve();
      else reject(new Error(`reconcile CLI exited ${code} ${signal}`));
    });
  });
}


if (pausePoint === OWNER_LOCK_PAUSE_POINT
  || pausePoint === COMMIT_PRE_RENAME_PAUSE_POINT
  || pausePoint === PROVISIONAL_HELPER_PAUSE_POINT) {
  void runOwnerLockWorker().catch(error => {
    if (pausePoint === PROVISIONAL_HELPER_PAUSE_POINT) {
      process.stdout.write(`${JSON.stringify({
        message: error?.message ?? String(error),
        causeMessage: error?.cause?.message ?? null,
      })}\n`);
    }
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else if (pausePoint === STATE_LOCK_PROTOCOL_PAUSE_POINT) {
  void runStateLockProtocolWorker().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else if (pausePoint === REGISTRY_CAS_PROTOCOL_PAUSE_POINT) {
  void runRegistryCasProtocolWorker().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else if (pausePoint === HEARTBEAT_PROTOCOL_PAUSE_POINT) {
  void runHeartbeatProtocolWorker().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else if (pausePoint === STALE_PROTOCOL_PAUSE_POINT) {
  void runStaleProtocolWorker().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
} else if (pausePoint === RECONCILE_PROTOCOL_PAUSE_POINT) {
  void runReconcileCommandWorker().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
