import { fork, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const leaseScriptPath = path.join(projectRoot, 'scripts', 'agent-file-lease.cjs');
const leaseWorkerPath = path.join(projectRoot, 'src', 'tests', 'fixtures', 'agent-file-lease-worker.cjs');
const tempRoots: string[] = [];
const activeLeaseWorkers = new Map<ReturnType<typeof fork>, () => Promise<void>>();
const SERIALIZATION_SCENARIO_DEADLINE_MS = 5_000;
const SERIALIZATION_CHILD_TIMEOUT_MS = 2_000;
const OWNER_LOCK_SCENARIO_DEADLINE_MS = 3_000;
const LEASE_WORKER_TEARDOWN_DEADLINE_MS = 1_000;
const LEASE_SPAWN_SYNC_TIMEOUT_MS = 5_000;
const PARTIAL_JSON_BLOCKER_TIMEOUT_MS = 1_000;
const RESOURCE_TOKEN_BOUNDED_STDIN_DEADLINE_MS = 1_000;
const CONCURRENT_WORKSPACE_EPOCH_CLAIM_COUNT = 12;
type LeaseWorkerProcessHandle = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once: (event: 'exit' | 'close', listener: () => void) => unknown;
  off: (event: 'exit' | 'close', listener: () => void) => unknown;
};
type WorkerCommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CheckedSpawnSyncError = Error & {
  code: string;
  partialStderr: string;
  partialStdout: string;
  signal: NodeJS.Signals | null;
};

function leaseSpawnSyncTimeout(requestedTimeout?: number): number {
  if (requestedTimeout === undefined) return LEASE_SPAWN_SYNC_TIMEOUT_MS;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    throw new Error('lease child timeout must be a positive finite number');
  }
  return Math.min(Math.ceil(requestedTimeout), LEASE_SPAWN_SYNC_TIMEOUT_MS);
}

function requireCompletedSpawnSync(
  result: SpawnSyncReturns<string>,
  context: string,
  timeoutMs: number,
): SpawnSyncReturns<string> {
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  let code;
  let message;
  if (spawnError?.code === 'ETIMEDOUT') {
    code = 'ETIMEDOUT';
    message = `${context} timed out after ${timeoutMs}ms`;
  } else if (spawnError) {
    code = spawnError.code || 'CHILD_PROCESS_ERROR';
    message = `${context} failed to execute: ${spawnError.message}`;
  } else if (result.signal !== null) {
    code = 'CHILD_PROCESS_SIGNAL';
    message = `${context} terminated by signal ${result.signal}`;
  } else if (result.status === null) {
    code = 'CHILD_PROCESS_NO_STATUS';
    message = `${context} completed without an exit status`;
  } else {
    return result;
  }

  const failure = new Error(message, spawnError ? { cause: spawnError } : undefined) as CheckedSpawnSyncError;
  failure.code = code;
  failure.partialStdout = String(result.stdout ?? '');
  failure.partialStderr = String(result.stderr ?? '');
  failure.signal = result.signal;
  throw failure;
}

function observeScenarioProcessOutput(
  worker: ReturnType<typeof fork>,
  onComplete: (result: WorkerCommandResult) => void,
  onError: (error: Error) => void,
): { detach: () => void; snapshot: () => Pick<WorkerCommandResult, 'stdout' | 'stderr'> } {
  let stdout = '';
  let stderr = '';
  let detached = false;
  const onStdout = (chunk: string) => {
    stdout += chunk;
  };
  const onStderr = (chunk: string) => {
    stderr += chunk;
  };
  const detach = () => {
    if (detached) return;
    detached = true;
    worker.stdout?.off('data', onStdout);
    worker.stderr?.off('data', onStderr);
    worker.off('error', onProcessError);
    worker.off('close', onClose);
  };
  const onProcessError = (error: Error) => {
    detach();
    onError(error);
  };
  const onClose = (status: number | null, signal: NodeJS.Signals | null) => {
    const result = { status, signal, stdout, stderr };
    detach();
    try {
      onComplete(result);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  worker.stdout?.setEncoding('utf8');
  worker.stdout?.on('data', onStdout);
  worker.stderr?.setEncoding('utf8');
  worker.stderr?.on('data', onStderr);
  worker.once('error', onProcessError);
  worker.once('close', onClose);
  return {
    detach,
    snapshot: () => ({ stdout, stderr }),
  };
}

type SerializationWorkerResult = {
  runId: string;
  a: WorkerCommandResult;
  bBeforeCommit: WorkerCommandResult;
  bBeforeRelease: WorkerCommandResult;
  bAfterRelease: WorkerCommandResult;
  registryExistedBeforeCommit: boolean;
  lockExistedBeforeRelease: boolean;
  registryBeforeRelease: string;
  registryAfterRejectedClaim: string;
  wrongRunIdIgnoredBeforeCommit: boolean;
  wrongStageIgnoredBeforeCommit: boolean;
};

type SerializationScenarioOptions = {
  contenderArgs?: string[];
  deadlineMs?: number;
  leaseScriptPath?: string;
  finalRetry?: () => ReturnType<typeof runLease>;
  workerArgs?: string[];
};

type RunLeaseOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  leaseScriptPath?: string;
  timeout?: number;
};

const READ_RESOURCE_TOKEN_STDIN_INPUT = Symbol('read-resource-token-stdin-input');
type ReadResourceLeaseArgs = string[] & {
  [READ_RESOURCE_TOKEN_STDIN_INPUT]?: string | Buffer;
};

function withReadResourceTokenStdin(
  args: string[],
  input: string | Buffer,
): ReadResourceLeaseArgs {
  Object.defineProperty(args, READ_RESOURCE_TOKEN_STDIN_INPUT, {
    configurable: false,
    enumerable: false,
    value: input,
    writable: false,
  });
  return args as ReadResourceLeaseArgs;
}

function markedReadResourceTokenInput(args: string[]): string | Buffer | undefined {
  return (args as ReadResourceLeaseArgs)[READ_RESOURCE_TOKEN_STDIN_INPUT];
}

function endMarkedReadResourceTokenInput(
  worker: ReturnType<typeof fork>,
  args: string[],
): void {
  const input = markedReadResourceTokenInput(args);
  if (input === undefined) return;
  worker.stdin?.end(input);
}

type OwnerLockScenarioOptions = {
  allowMissingCheckpoint?: boolean;
  deadlineMs?: number;
  disconnectBeforeAcquire?: boolean;
  disconnectBeforeRelease?: boolean;
  disconnectBeforeTransaction?: boolean;
  heartbeatFault?: 'throw-before-temp-fsync';
  heartbeatIntervalMs?: number;
  onCheckpoint: () => void;
  owner?: string;
  pausePoint?:
    | 'after-owner-helper-created-before-publication'
    | 'after-owner-lock-acquired'
    | 'after-registry-temp-fsync-before-rename'
    | 'before-state-lock-protocol'
    | 'registry-cas-protocol';
  probeOwnerRef?: boolean;
  probeReleaseStateAfterFailure?: boolean;
  probeTransactionFailureState?: boolean;
  provisionalHelperFaultMode?: 'throw' | 'replace-helper';
  postHeartbeatFailureMutation?:
    | 'replace-canonical-successor'
    | 'replace-canonical-successor-and-helper'
    | 'replace-canonical-directory';
  protocolMode?:
    | 'normal'
    | 'async-success'
    | 'double-error'
    | 'invalid-candidate'
    | 'foreign-state-candidate'
    | 'invalid-registry-candidate'
    | 'workspace-epoch-rollback'
    | 'fencing-counter-rollback'
    | 'transition-prefix-rewrite'
    | 'owner-helper-replaced-before-commit'
    | 'heartbeat-replaced-before-commit';
  releaseCount?: number;
  releaseFault?:
    | 'replace-canonical-with-directory-before-unlink'
    | 'throw-on-canonical-unlink'
    | 'throw-on-quarantine-unlink'
    | 'replace-quarantine-with-successor-before-readback';
  runTransaction?: boolean;
  testRunId?: string;
  transactionRoot?: string;
  waitForHeartbeatFailureBeforeRelease?: boolean;
};

type HeartbeatEvidence = {
  canonical: {
    bytesBase64: string;
    dev: string;
    ino: string;
  };
  heartbeat: {
    schema: number;
    token: string;
    pid: number;
    processStartIdentity: {
      kind: string;
      unit: string;
      value: number;
    };
    sequence: number;
    updatedAtMs: number;
  };
  heartbeatBytesBase64: string;
  heartbeatName: string;
  heartbeatExists?: boolean;
  owner?: {
    schema: number;
    token: string;
    owner: string;
    pid: number;
    processStartIdentity: {
      kind: string;
      unit: string;
      value: number;
    };
    createdAt: string;
    initialHeartbeat?: {
      schema?: number;
      token?: string;
      pid?: number;
      processStartIdentity?: {
        kind: string;
        unit: string;
        value: number;
      };
      sequence?: number;
      heartbeatAtMs?: number;
    };
  };
};

type HeartbeatScenarioResult = {
  checkpoints: Array<{ stage: string; evidence: HeartbeatEvidence }>;
  process: WorkerCommandResult;
};

type StaleScenarioOptions = {
  afterHolderExit?: (root: string, evidence: HeartbeatEvidence) => void;
  contenderCwd?: string;
  contenderEnv?: NodeJS.ProcessEnv;
  disposition: 'live' | 'normal-exit' | 'crash';
  mutate?: (root: string, evidence: HeartbeatEvidence) => void;
  processProbeMode?: 'eperm' | 'unobserved';
  staleAfterMs?: number;
};

type StaleScenarioResult = {
  evidence: HeartbeatEvidence;
  holder?: WorkerCommandResult;
  contender: WorkerCommandResult;
  processProbeCount: number;
};

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nanoflow-agent-file-lease-'));
  tempRoots.push(root);
  return root;
}

function writePreservedLeaseRegistry(root: string, file: string): string {
  const registryPath = path.join(root, 'tmp', 'agent-file-leases.json');
  const claimedAtMs = Date.now();
  const expiresAtMs = claimedAtMs + 30 * 60 * 1000;
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify({
    version: 1,
    leases: {
      [file]: {
        owner: 'preserved',
        claimedAt: new Date(claimedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      },
    },
  }, null, 2)}\n`, { flag: 'wx' });
  return registryPath;
}

type PlantedPowerShellScenario = {
  contenderEnv: NodeJS.ProcessEnv;
  cwdPowerShellPath: string;
  cwdPowerShellSnapshot: { bytes: Buffer; dev: bigint; ino: bigint };
  markerBytes: Buffer;
  markerPath: string;
  pathDirectory: string;
  pathPowerShellPath: string;
  pathPowerShellSnapshot: { bytes: Buffer; dev: bigint; ino: bigint };
};

function preparePlantedPowerShellScenario(
  root: string,
  systemRoot = process.env.SystemRoot,
  winDir = process.env.windir,
): PlantedPowerShellScenario {
  if (!systemRoot || !winDir) throw new Error('Windows system root is required for slow-probe coverage');
  const pathDirectory = path.join(root, 'planted-path');
  const cwdPowerShellPath = path.join(root, 'powershell.exe');
  const pathPowerShellPath = path.join(pathDirectory, 'powershell.exe');
  const markerPath = path.join(root, 'planted-powershell-marker.txt');
  const preloadPath = path.join(root, 'planted-powershell-preload.cjs');
  const markerBytes = Buffer.from('planted-powershell-not-executed', 'utf8');
  mkdirSync(pathDirectory, { recursive: true });
  copyFileSync(process.execPath, cwdPowerShellPath);
  copyFileSync(process.execPath, pathPowerShellPath);
  writeFileSync(markerPath, markerBytes, { flag: 'wx' });
  writeFileSync(
    preloadPath,
    `'use strict';\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'planted-powershell-executed');\n`,
    { flag: 'wx' },
  );
  const snapshot = (filePath: string) => {
    const stat = statSync(filePath, { bigint: true });
    return { bytes: readFileSync(filePath), dev: stat.dev, ino: stat.ino };
  };
  return {
    contenderEnv: {
      NANOFLOW_LEASE_TEST_CHILD_NODE_OPTIONS: `--require=${preloadPath}`,
      PATH: `${pathDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      SystemRoot: systemRoot,
      windir: winDir,
    },
    cwdPowerShellPath,
    cwdPowerShellSnapshot: snapshot(cwdPowerShellPath),
    markerBytes,
    markerPath,
    pathDirectory,
    pathPowerShellPath,
    pathPowerShellSnapshot: snapshot(pathPowerShellPath),
  };
}

function expectPlantedPowerShellScenarioUntouched(plants: PlantedPowerShellScenario): void {
  const expectFileUnchanged = (
    filePath: string,
    expected: { bytes: Buffer; dev: bigint; ino: bigint },
  ) => {
    const stat = statSync(filePath, { bigint: true });
    expect.soft(readFileSync(filePath).equals(expected.bytes)).toBe(true);
    expect.soft({ dev: stat.dev, ino: stat.ino }).toEqual({
      dev: expected.dev,
      ino: expected.ino,
    });
  };
  expect.soft(readFileSync(plants.markerPath).equals(plants.markerBytes)).toBe(true);
  expectFileUnchanged(plants.cwdPowerShellPath, plants.cwdPowerShellSnapshot);
  expectFileUnchanged(plants.pathPowerShellPath, plants.pathPowerShellSnapshot);
}

function runLease(root: string, args: string[], options: RunLeaseOptions = {}) {
  const {
    input: explicitInput,
    leaseScriptPath: scenarioLeaseScriptPath = leaseScriptPath,
    timeout: requestedTimeout,
    ...spawnOptions
  } = options;
  const markedInput = markedReadResourceTokenInput(args);
  if (explicitInput !== undefined && markedInput !== undefined) {
    throw new Error('lease CLI input must be supplied either explicitly or through the READ token marker');
  }
  const timeout = leaseSpawnSyncTimeout(requestedTimeout);
  const result = spawnSync(process.execPath, [scenarioLeaseScriptPath, '--root', root, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    input: explicitInput ?? markedInput,
    ...spawnOptions,
    timeout,
  });
  return requireCompletedSpawnSync(result, 'agent-file-lease CLI', timeout);
}

function untrackLeaseWorkerIfExited(worker: ReturnType<typeof fork>): void {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    activeLeaseWorkers.delete(worker);
  }
}

function runLeaseAsync(root: string, args: string[]): Promise<WorkerCommandResult> {
  const canonicalRoot = realpathSync(root);
  return new Promise((resolve, reject) => {
    const worker = fork(leaseScriptPath, ['--root', canonicalRoot, ...args], {
      cwd: projectRoot,
      silent: true,
    });
    let settled = false;
    let outputCollector: ReturnType<typeof observeScenarioProcessOutput> | undefined;
    const deadline = setTimeout(() => {
      const timeoutError = new Error(`async agent-file-lease CLI exceeded ${LEASE_SPAWN_SYNC_TIMEOUT_MS}ms`);
      void terminateLeaseWorker(worker).then(
        () => settle(timeoutError),
        teardownError => settle(leaseWorkerSettlementError(timeoutError, teardownError)),
      );
    }, LEASE_SPAWN_SYNC_TIMEOUT_MS);

    const cleanup = () => terminateLeaseWorker(worker);
    activeLeaseWorkers.set(worker, cleanup);

    function settle(error?: Error, result?: WorkerCommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      outputCollector?.detach();
      untrackLeaseWorkerIfExited(worker);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('async agent-file-lease CLI settled without a result'));
    }

    outputCollector = observeScenarioProcessOutput(
      worker,
      result => settle(undefined, result),
      error => settle(error),
    );
    endMarkedReadResourceTokenInput(worker, args);
  });
}

const READ_RESOURCE_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function readResourceToken(seed: string): string {
  if (!/^[a-f0-9]$/i.test(seed)) throw new Error('resource token seed must be hexadecimal');
  return seed.repeat(64);
}

function readResourceTokenHash(token: string): string {
  if (!READ_RESOURCE_TOKEN_PATTERN.test(token)) throw new Error('resource token must be 64 hexadecimal characters');
  return createHash('sha256').update(token.toLowerCase(), 'utf8').digest('hex');
}

function readResourceLeaseArgs(
  command: 'resource-lease-acquire' | 'resource-lease-heartbeat' | 'resource-lease-release',
  owner: string,
  resourceId: string,
  token: string,
  extra: string[] = [],
): ReadResourceLeaseArgs {
  return withReadResourceTokenStdin([
    command,
    '--owner', owner,
    '--resource-kind', 'read',
    '--resource-id', resourceId,
    '--resource-token-stdin',
    ...extra,
  ], token);
}

function buildResourceLeaseArgs(
  command: 'resource-lease-acquire' | 'resource-lease-heartbeat' | 'resource-lease-release',
  owner: string,
  resourceId: string,
  barrierToken: string,
  extra: string[] = [],
): ReadResourceLeaseArgs {
  return withReadResourceTokenStdin([
    command,
    '--owner', owner,
    '--resource-kind', 'build',
    '--resource-id', resourceId,
    '--resource-token-stdin',
    ...extra,
  ], barrierToken);
}

function leaseRegistryPath(root: string): string {
  return path.join(root, 'tmp', 'agent-file-leases.json');
}

function writeLeaseRegistry(root: string, registry: unknown): string {
  const registryPath = leaseRegistryPath(root);
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return registryPath;
}

function storedReadResourceLease(
  token: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const tokenHash = readResourceTokenHash(token);
  return {
    kind: 'read',
    resourceId: 'generation-a',
    owner: 'reader-a',
    tokenHash,
    tokenFingerprint: tokenHash.slice(0, 12),
    state: 'ACTIVE',
    acquiredAt: '2026-01-01T00:00:00.000Z',
    heartbeatAt: '2026-01-01T00:00:01.000Z',
    heartbeatSequence: 1,
    expiresAt: '2999-01-01T00:00:00.000Z',
    expiresAtMs: Date.parse('2999-01-01T00:00:00.000Z'),
    releasedAt: null,
    ...overrides,
  };
}

async function readResourceAcquireWithLockRetry(
  root: string,
  owner: string,
  resourceId: string,
  token: string,
): Promise<WorkerCommandResult> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await runLeaseAsync(root, readResourceLeaseArgs(
      'resource-lease-acquire',
      owner,
      resourceId,
      token,
    ));
    if (result.status === 0) return result;
    if (!result.stderr.includes('lease state is locked')) {
      throw new Error(result.stderr || result.stdout || 'resource lease acquire failed without diagnostics');
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('resource lease acquire did not settle after lock retries');
}

async function claimWithLockRetry(root: string, index: number): Promise<WorkerCommandResult> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await runLeaseAsync(root, [
      'claim', '--owner', `epoch-agent-${index}`, `epoch-${index}.ts`,
    ]);
    if (result.status === 0) return result;
    if (!result.stderr.includes('lease state is locked')) {
      throw new Error(result.stderr || result.stdout || `concurrent claim ${index} failed without diagnostics`);
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`concurrent claim ${index} did not acquire the lease state lock`);
}

function crashCommandBeforeCommit(
  root: string,
  args: string[],
  scenario: string,
): Promise<WorkerCommandResult> {
  const canonicalRoot = realpathSync(root);
  const runId = `${scenario}-${process.pid}-${path.basename(root)}`;
  const pausePoint = 'after-registry-temp-fsync-before-rename';
  return new Promise((resolve, reject) => {
    const worker = fork(leaseScriptPath, [
      '--root', canonicalRoot,
      ...args,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NANOFLOW_LEASE_TEST_RUN_ID: runId,
        NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
        NANOFLOW_LEASE_TEST_PAUSE_POINT: pausePoint,
        NANOFLOW_LEASE_TEST_COMMIT_CRASH_MODE: 'pause-before-rename',
      },
      silent: true,
    });
    let observedCheckpoint = false;
    let settled = false;
    let outputCollector: ReturnType<typeof observeScenarioProcessOutput> | undefined;
    const deadline = setTimeout(() => {
      const timeoutError = new Error(`${scenario} crash scenario exceeded ${SERIALIZATION_SCENARIO_DEADLINE_MS}ms`);
      void terminateLeaseWorker(worker).then(
        () => settle(timeoutError),
        teardownError => settle(leaseWorkerSettlementError(timeoutError, teardownError)),
      );
    }, SERIALIZATION_SCENARIO_DEADLINE_MS);

    const cleanup = () => terminateLeaseWorker(worker);
    activeLeaseWorkers.set(worker, cleanup);

    function settle(error?: Error, result?: WorkerCommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      worker.off('message', onMessage);
      outputCollector?.detach();
      untrackLeaseWorkerIfExited(worker);
      if (error) reject(error);
      else if (!observedCheckpoint) reject(new Error('claim exited before its pre-commit checkpoint'));
      else if (result) resolve(result);
      else reject(new Error(`${scenario} crash scenario settled without a result`));
    }

    function onMessage(message: unknown): void {
      if (!message || typeof message !== 'object') return;
      const payload = message as { type?: string; runId?: string; pausePoint?: string; stage?: string };
      if (payload.type !== 'NANOFLOW_LEASE_TEST_CHECKPOINT'
        || payload.runId !== runId
        || payload.pausePoint !== pausePoint) return;
      observedCheckpoint = true;
      worker.kill();
    }

    worker.on('message', onMessage);
    outputCollector = observeScenarioProcessOutput(
      worker,
      result => settle(undefined, result),
      error => settle(error),
    );
    endMarkedReadResourceTokenInput(worker, args);
  });
}

function crashClaimBeforeCommit(root: string): Promise<WorkerCommandResult> {
  return crashCommandBeforeCommit(
    root,
    ['claim', '--owner', 'crashing-agent', 'after-crash.ts'],
    'workspace-epoch-crash',
  );
}

function crashCommandAfterCommit(
  root: string,
  args: string[],
  scenario: string,
): Promise<WorkerCommandResult> {
  const canonicalRoot = realpathSync(root);
  const runId = `${scenario}-${process.pid}-${path.basename(root)}`;
  const pausePoint = 'cli-transaction';
  return new Promise((resolve, reject) => {
    const worker = fork(leaseScriptPath, ['--root', canonicalRoot, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NANOFLOW_LEASE_TEST_RUN_ID: runId,
        NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
        NANOFLOW_LEASE_TEST_PAUSE_POINT: pausePoint,
      },
      silent: true,
    });
    let committedCheckpoint = false;
    let settled = false;
    let outputCollector: ReturnType<typeof observeScenarioProcessOutput> | undefined;
    const deadline = setTimeout(() => {
      const timeoutError = new Error(`${scenario} post-commit crash scenario exceeded ${SERIALIZATION_SCENARIO_DEADLINE_MS}ms`);
      void terminateLeaseWorker(worker).then(
        () => settle(timeoutError),
        teardownError => settle(leaseWorkerSettlementError(timeoutError, teardownError)),
      );
    }, SERIALIZATION_SCENARIO_DEADLINE_MS);

    const cleanup = () => terminateLeaseWorker(worker);
    activeLeaseWorkers.set(worker, cleanup);

    function settle(error?: Error, result?: WorkerCommandResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      worker.off('message', onMessage);
      outputCollector?.detach();
      untrackLeaseWorkerIfExited(worker);
      if (error) reject(error);
      else if (!committedCheckpoint) reject(new Error(`${scenario} exited before its post-commit checkpoint`));
      else if (result) resolve(result);
      else reject(new Error(`${scenario} post-commit crash scenario settled without a result`));
    }

    function onMessage(message: unknown): void {
      if (!message || typeof message !== 'object') return;
      const payload = message as { type?: string; runId?: string; pausePoint?: string; stage?: string };
      if (payload.type !== 'NANOFLOW_LEASE_TEST_CHECKPOINT'
        || payload.runId !== runId
        || payload.pausePoint !== pausePoint) return;
      if (payload.stage === 'after-acquire-before-commit') {
        worker.send({
          type: 'NANOFLOW_LEASE_TEST_RESUME',
          runId,
          pausePoint,
          stage: payload.stage,
        });
        return;
      }
      if (payload.stage === 'after-commit-before-release') {
        committedCheckpoint = true;
        worker.kill();
      }
    }

    worker.on('message', onMessage);
    outputCollector = observeScenarioProcessOutput(
      worker,
      result => settle(undefined, result),
      error => settle(error),
    );
    endMarkedReadResourceTokenInput(worker, args);
  });
}

async function barrierAcquireWithLockRetry(
  root: string,
  owner: string,
  barrierToken: string,
): Promise<WorkerCommandResult> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await runLeaseAsync(root, [
      'barrier-acquire', '--owner', owner, '--barrier-token', barrierToken,
    ]);
    if (!result.stderr.includes('lease state is locked')) return result;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`barrier acquire for ${owner} did not settle after lock retries`);
}

function runProvisionalHelperFaultWithoutIpc(
  root: string,
  faultMode: 'throw' | 'replace-helper' = 'throw',
): WorkerCommandResult {
  const canonicalRoot = realpathSync(root);
  const runId = `provisional-helper-${process.pid}-${path.basename(root)}`;
  const timeout = leaseSpawnSyncTimeout();
  const result = spawnSync(process.execPath, [
    leaseWorkerPath,
    leaseScriptPath,
    '--root', canonicalRoot,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NANOFLOW_LEASE_TEST_RUN_ID: runId,
      NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
      NANOFLOW_LEASE_TEST_PAUSE_POINT: 'after-owner-helper-created-before-publication',
      NANOFLOW_LEASE_TEST_PROVISIONAL_HELPER_FAULT_MODE: faultMode,
    },
    timeout,
  });
  requireCompletedSpawnSync(result, 'agent-file-lease provisional helper worker', timeout);
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runProvisionalHelperFaultScenario(
  root: string,
  faultMode: 'throw' | 'replace-helper' = 'throw',
): Promise<WorkerCommandResult> {
  return runOwnerLockScenario(root, {
    allowMissingCheckpoint: true,
    onCheckpoint: () => undefined,
    pausePoint: 'after-owner-helper-created-before-publication',
    provisionalHelperFaultMode: faultMode,
  });
}

function observeLeaseWorkerExitOrClose(worker: LeaseWorkerProcessHandle): {
  cancel: () => void;
  terminated: Promise<void>;
} {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return { cancel: () => undefined, terminated: Promise.resolve() };
  }
  let cancel = () => undefined;
  const terminated = new Promise<void>(resolve => {
    const onTermination = () => {
      cancel();
      resolve();
    };
    cancel = () => {
      worker.off('exit', onTermination);
      worker.off('close', onTermination);
    };
    worker.once('exit', onTermination);
    worker.once('close', onTermination);
  });
  return { cancel, terminated };
}

function waitForLeaseWorkerTermination(
  terminated: Promise<void>,
  deadlineMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`lease worker teardown exceeded ${deadlineMs}ms`));
    }, deadlineMs);
    void terminated.then(() => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

function waitForLeaseWorkerExitOrClose(
  worker: LeaseWorkerProcessHandle,
  deadlineMs = LEASE_WORKER_TEARDOWN_DEADLINE_MS,
): Promise<void> {
  const observation = observeLeaseWorkerExitOrClose(worker);
  return waitForLeaseWorkerTermination(observation.terminated, deadlineMs).catch(error => {
    observation.cancel();
    throw error;
  });
}

async function terminateLeaseWorker(worker: ReturnType<typeof fork>): Promise<void> {
  const observation = observeLeaseWorkerExitOrClose(worker);
  void observation.terminated.then(() => {
    activeLeaseWorkers.delete(worker);
  });
  const terminated = waitForLeaseWorkerTermination(
    observation.terminated,
    LEASE_WORKER_TEARDOWN_DEADLINE_MS,
  );
  if (worker.connected) {
    try {
      worker.disconnect();
    } catch {
      // The IPC channel may already be closing after an early worker failure.
    }
  }
  if (worker.exitCode === null && worker.signalCode === null) {
    try {
      worker.kill();
    } catch {
      // Cleanup is best-effort after the scenario has already settled.
    }
  }
  await terminated;
  activeLeaseWorkers.delete(worker);
}

function leaseWorkerSettlementError(primaryError: Error | undefined, teardownError: unknown): Error {
  const secondaryError = teardownError instanceof Error
    ? teardownError
    : new Error(String(teardownError));
  if (!primaryError) return secondaryError;
  try {
    if (primaryError.cause === undefined) {
      Object.defineProperty(primaryError, 'cause', {
        configurable: true,
        value: secondaryError,
      });
    } else if ((primaryError as Error & { teardownError?: Error }).teardownError === undefined) {
      Object.defineProperty(primaryError, 'teardownError', {
        configurable: true,
        value: secondaryError,
      });
    }
  } catch {
    // A frozen scenario error remains primary even when teardown also fails.
  }
  return primaryError;
}

function runSerializationScenario(
  root: string,
  options: SerializationScenarioOptions = {},
): Promise<SerializationWorkerResult> {
  const runId = `serialization-${process.pid}-${path.basename(root)}`;
  const canonicalRoot = realpathSync(root);
  const scenarioLeaseScriptPath = options.leaseScriptPath ?? leaseScriptPath;
  const workerArgs = options.workerArgs ?? ['claim', '--owner', 'agent-a', 'a.ts'];
  const contenderArgs = options.contenderArgs ?? ['claim', '--owner', 'agent-b', 'b.ts'];
  const pausePoint = 'cli-transaction';
  const registryPath = path.join(canonicalRoot, 'tmp', 'agent-file-leases.json');
  const lockPath = `${registryPath}.lock`;

  return new Promise((resolve, reject) => {
    const worker = fork(scenarioLeaseScriptPath, [
      '--root', canonicalRoot,
      ...workerArgs,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NANOFLOW_LEASE_TEST_RUN_ID: runId,
        NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
        NANOFLOW_LEASE_TEST_PAUSE_POINT: pausePoint,
      },
      silent: true,
    });
    activeLeaseWorkers.set(worker, () => terminateLeaseWorker(worker));
    const expectedStages = ['after-acquire-before-commit', 'after-commit-before-release'] as const;
    let stageIndex = 0;
    let bBeforeCommit: WorkerCommandResult | undefined;
    let bBeforeRelease: WorkerCommandResult | undefined;
    let registryExistedBeforeCommit = false;
    let lockExistedBeforeRelease = false;
    let registryBeforeRelease: string | undefined;
    let registryAfterRejectedClaim: string | undefined;
    let pendingWrongRunIdCheckpoint: { pausePoint?: string; stage?: string } | undefined;
    let checkpointProbe: 'wrong-run-id' | 'wrong-stage' | undefined;
    let wrongRunIdIgnoredBeforeCommit = false;
    let wrongStageIgnoredBeforeCommit = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let outputCollector: ReturnType<typeof observeScenarioProcessOutput> | undefined;

    let cleanupPromise: Promise<void> | undefined;
    function cleanup(): Promise<void> {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        if (deadline) {
          clearTimeout(deadline);
          deadline = undefined;
        }
        worker.off('message', onMessage);
        try {
          await terminateLeaseWorker(worker);
        } finally {
          outputCollector?.detach();
        }
      })();
      return cleanupPromise;
    }

    activeLeaseWorkers.set(worker, cleanup);

    function settle(error?: Error, result?: SerializationWorkerResult): void {
      if (settled) return;
      settled = true;
      void cleanup().then(() => {
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error('serialization scenario settled without a result'));
      }, teardownError => {
        reject(leaseWorkerSettlementError(error, teardownError));
      });
    }

    function advanceCheckpoint(payload: { pausePoint?: string; stage?: string }): void {
      const expectedStage = expectedStages[stageIndex];
      if (!expectedStage || payload.stage !== expectedStage) {
        settle(new Error(`serialization CLI emitted unexpected stage: ${payload.stage ?? '<missing>'}`));
        return;
      }

      try {
        if (expectedStage === 'after-commit-before-release') {
          lockExistedBeforeRelease = existsSync(lockPath);
          registryBeforeRelease = readFileSync(registryPath, 'utf8');
        }
        const claim = runLease(
          canonicalRoot,
          contenderArgs,
          { timeout: SERIALIZATION_CHILD_TIMEOUT_MS },
        );
        if (claim.error) throw claim.error;
        const claimResult = {
          status: claim.status,
          signal: claim.signal,
          stdout: claim.stdout,
          stderr: claim.stderr,
        };
        if (expectedStage === 'after-acquire-before-commit') {
          bBeforeCommit = claimResult;
          registryExistedBeforeCommit = existsSync(registryPath);
        } else {
          bBeforeRelease = claimResult;
          registryAfterRejectedClaim = readFileSync(registryPath, 'utf8');
        }
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      stageIndex += 1;
      worker.send({
        type: 'NANOFLOW_LEASE_TEST_RESUME',
        runId,
        pausePoint: payload.pausePoint,
        stage: expectedStage,
      }, error => {
        if (!error) return;
        settle(error);
      });
    }

    function onMessage(message: unknown): void {
      if (!message || typeof message !== 'object') return;
      const payload = message as {
        type?: string;
        runId?: string;
        receivedRunId?: string;
        pausePoint?: string;
        stage?: string;
        expectedStage?: string;
        receivedStage?: string;
        reason?: string;
      };
      if (payload.type === 'NANOFLOW_LEASE_TEST_RESUME_IGNORED') {
        if (!pendingWrongRunIdCheckpoint
          || payload.runId !== runId
          || payload.pausePoint !== pausePoint
          || payload.expectedStage !== 'after-acquire-before-commit') {
          settle(new Error('serialization CLI emitted an invalid resume rejection acknowledgement'));
          return;
        }
        if (checkpointProbe === 'wrong-run-id') {
          if (payload.reason !== 'runId-mismatch'
            || payload.receivedRunId !== `${runId}-wrong`
            || payload.receivedStage !== 'after-acquire-before-commit') {
            settle(new Error('serialization CLI did not reject the wrong runId precisely'));
            return;
          }
          wrongRunIdIgnoredBeforeCommit = existsSync(lockPath) && !existsSync(registryPath);
          checkpointProbe = 'wrong-stage';
          worker.send({
            type: 'NANOFLOW_LEASE_TEST_RESUME',
            runId,
            pausePoint,
            stage: 'unexpected-stage',
          }, error => {
            if (!error) return;
            settle(error);
          });
          return;
        }
        if (checkpointProbe !== 'wrong-stage'
          || payload.reason !== 'stage-mismatch'
          || payload.receivedRunId !== runId
          || payload.receivedStage !== 'unexpected-stage') {
          settle(new Error('serialization CLI did not reject the wrong stage precisely'));
          return;
        }
        wrongStageIgnoredBeforeCommit = existsSync(lockPath) && !existsSync(registryPath);
        const checkpoint = pendingWrongRunIdCheckpoint;
        pendingWrongRunIdCheckpoint = undefined;
        checkpointProbe = undefined;
        advanceCheckpoint(checkpoint);
        return;
      }
      if (payload.type !== 'NANOFLOW_LEASE_TEST_CHECKPOINT'
        || payload.runId !== runId
        || payload.pausePoint !== pausePoint) return;
      if (stageIndex === 0 && !pendingWrongRunIdCheckpoint && !wrongRunIdIgnoredBeforeCommit) {
        pendingWrongRunIdCheckpoint = payload;
        checkpointProbe = 'wrong-run-id';
        worker.send({
          type: 'NANOFLOW_LEASE_TEST_RESUME',
          runId: `${runId}-wrong`,
          pausePoint: payload.pausePoint,
          stage: payload.stage,
        }, error => {
          if (!error) return;
          settle(error);
        });
        return;
      }
      advanceCheckpoint(payload);
    }

    function onProcessComplete(processResult: WorkerCommandResult): void {
      const { status: code, signal, stdout, stderr } = processResult;
      if (stageIndex !== expectedStages.length
        || !bBeforeCommit
        || !bBeforeRelease
        || registryBeforeRelease === undefined
        || registryAfterRejectedClaim === undefined) {
        settle(new Error(stderr || `serialization CLI closed before all checkpoints (code=${code}, signal=${signal})`));
        return;
      }
      let retry: ReturnType<typeof runLease>;
      try {
        retry = options.finalRetry
          ? options.finalRetry()
          : runLease(
            canonicalRoot,
            contenderArgs,
            { timeout: SERIALIZATION_CHILD_TIMEOUT_MS },
          );
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (retry.error) {
        settle(retry.error);
        return;
      }
      settle(undefined, {
        runId,
        a: processResult,
        bBeforeCommit,
        bBeforeRelease,
        bAfterRelease: {
          status: retry.status,
          signal: retry.signal,
          stdout: retry.stdout,
          stderr: retry.stderr,
        },
        registryExistedBeforeCommit,
        lockExistedBeforeRelease,
        registryBeforeRelease,
        registryAfterRejectedClaim,
        wrongRunIdIgnoredBeforeCommit,
        wrongStageIgnoredBeforeCommit,
      });
    }

    outputCollector = observeScenarioProcessOutput(worker, onProcessComplete, error => settle(error));
    worker.on('message', onMessage);
    const deadlineMs = options.deadlineMs ?? SERIALIZATION_SCENARIO_DEADLINE_MS;
    deadline = setTimeout(() => {
      settle(new Error(`serialization scenario exceeded ${deadlineMs}ms`));
    }, deadlineMs);
  });
}

function runOwnerLockScenario(
  root: string,
  options: OwnerLockScenarioOptions,
): Promise<WorkerCommandResult> {
  const runId = `owner-lock-${process.pid}-${path.basename(root)}`;
  const canonicalRoot = realpathSync(root);
  const scenarioPausePoint = options.pausePoint ?? 'after-owner-lock-acquired';

  return new Promise((resolve, reject) => {
    const worker = fork(leaseWorkerPath, [
      leaseScriptPath,
      '--root', canonicalRoot,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NANOFLOW_LEASE_TEST_RUN_ID: options.testRunId ?? runId,
        NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
        NANOFLOW_LEASE_TEST_PAUSE_POINT: scenarioPausePoint,
        NANOFLOW_LEASE_TEST_OWNER: options.owner ?? 'agent-owner-token',
        NANOFLOW_LEASE_TEST_DISCONNECT_BEFORE_ACQUIRE: options.disconnectBeforeAcquire ? '1' : '0',
        NANOFLOW_LEASE_TEST_DISCONNECT_BEFORE_RELEASE: options.disconnectBeforeRelease ? '1' : '0',
        NANOFLOW_LEASE_TEST_DISCONNECT_BEFORE_TRANSACTION:
          options.disconnectBeforeTransaction ? '1' : '0',
        NANOFLOW_LEASE_TEST_HEARTBEAT_FAULT: options.heartbeatFault ?? '',
        NANOFLOW_LEASE_TEST_HEARTBEAT_INTERVAL_MS: options.heartbeatIntervalMs === undefined
          ? ''
          : String(options.heartbeatIntervalMs),
        NANOFLOW_LEASE_TEST_PROBE_OWNER_REF: options.probeOwnerRef ? '1' : '0',
        NANOFLOW_LEASE_TEST_PROBE_RELEASE_STATE_AFTER_FAILURE: options.probeReleaseStateAfterFailure ? '1' : '0',
        NANOFLOW_LEASE_TEST_PROBE_TRANSACTION_FAILURE_STATE:
          options.probeTransactionFailureState ? '1' : '0',
        NANOFLOW_LEASE_TEST_PROVISIONAL_HELPER_FAULT_MODE:
          options.provisionalHelperFaultMode ?? '',
        NANOFLOW_LEASE_TEST_STATE_LOCK_PROTOCOL_MODE: options.protocolMode ?? 'normal',
        NANOFLOW_LEASE_TEST_RELEASE_COUNT: String(options.releaseCount ?? 1),
        NANOFLOW_LEASE_TEST_RELEASE_FAULT: options.releaseFault ?? '',
        NANOFLOW_LEASE_TEST_RUN_TRANSACTION: options.runTransaction ? '1' : '0',
        NANOFLOW_LEASE_TEST_TRANSACTION_ROOT: options.transactionRoot
          ? realpathSync(options.transactionRoot)
          : '',
        NANOFLOW_LEASE_TEST_WAIT_FOR_HEARTBEAT_FAILURE_BEFORE_RELEASE:
          options.waitForHeartbeatFailureBeforeRelease ? '1' : '0',
        NANOFLOW_LEASE_TEST_POST_HEARTBEAT_FAILURE_MUTATION:
          options.postHeartbeatFailureMutation ?? '',
      },
      silent: true,
    });
    activeLeaseWorkers.set(worker, () => terminateLeaseWorker(worker));
    let checkpointSeen = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let outputCollector: ReturnType<typeof observeScenarioProcessOutput> | undefined;

    let cleanupPromise: Promise<void> | undefined;
    function cleanup(): Promise<void> {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        if (deadline) {
          clearTimeout(deadline);
          deadline = undefined;
        }
        worker.off('message', onMessage);
        try {
          await terminateLeaseWorker(worker);
        } finally {
          outputCollector?.detach();
        }
      })();
      return cleanupPromise;
    }

    activeLeaseWorkers.set(worker, cleanup);

    function settle(error?: Error, result?: WorkerCommandResult): void {
      if (settled) return;
      settled = true;
      void cleanup().then(() => {
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error('owner-lock scenario settled without a result'));
      }, teardownError => {
        reject(leaseWorkerSettlementError(error, teardownError));
      });
    }

    function onMessage(message: unknown): void {
      if (!message || typeof message !== 'object' || checkpointSeen) return;
      const payload = message as { type?: string; runId?: string; pausePoint?: string };
      if (payload.type !== 'NANOFLOW_LEASE_TEST_CHECKPOINT'
        || payload.runId !== runId
        || payload.pausePoint !== scenarioPausePoint) return;

      checkpointSeen = true;
      try {
        options.onCheckpoint();
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      worker.send({
        type: 'NANOFLOW_LEASE_TEST_RESUME',
        runId,
        pausePoint: payload.pausePoint,
      }, error => {
        if (!error) return;
        settle(error);
      });
    }

    function onProcessComplete(processResult: WorkerCommandResult): void {
      const { status: code, signal, stderr } = processResult;
      if (!checkpointSeen && !options.allowMissingCheckpoint) {
        settle(new Error(stderr || `owner-lock worker closed before checkpoint (code=${code}, signal=${signal})`));
        return;
      }
      settle(undefined, processResult);
    }

    outputCollector = observeScenarioProcessOutput(worker, onProcessComplete, error => settle(error));
    worker.on('message', onMessage);
    const deadlineMs = options.deadlineMs ?? OWNER_LOCK_SCENARIO_DEADLINE_MS;
    deadline = setTimeout(() => {
      settle(new Error(`owner-lock scenario exceeded ${deadlineMs}ms`));
    }, deadlineMs);
  });
}

function runHeartbeatScenario(
  root: string,
  mode: 'observe-renewal' | 'crash-before-first-tick' | 'crash-before-rename' | 'failure-before-fsync' | 'failure-on-rename',
): Promise<HeartbeatScenarioResult> {
  const runId = `heartbeat-${process.pid}-${path.basename(root)}-${mode}`;
  const canonicalRoot = realpathSync(root);
  const pausePoint = 'heartbeat-protocol';

  return new Promise((resolve, reject) => {
    const worker = fork(leaseWorkerPath, [
      leaseScriptPath,
      '--root', canonicalRoot,
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NANOFLOW_LEASE_TEST_RUN_ID: runId,
        NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
        NANOFLOW_LEASE_TEST_PAUSE_POINT: pausePoint,
        NANOFLOW_LEASE_TEST_HEARTBEAT_MODE: mode,
        NANOFLOW_LEASE_TEST_HEARTBEAT_INTERVAL_MS: mode === 'crash-before-first-tick' ? '1000' : '20',
      },
      silent: true,
    });
    const checkpoints: HeartbeatScenarioResult['checkpoints'] = [];
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let outputCollector: ReturnType<typeof observeScenarioProcessOutput> | undefined;

    let cleanupPromise: Promise<void> | undefined;
    function cleanup(): Promise<void> {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        if (deadline) {
          clearTimeout(deadline);
          deadline = undefined;
        }
        worker.off('message', onMessage);
        try {
          await terminateLeaseWorker(worker);
        } finally {
          outputCollector?.detach();
        }
      })();
      return cleanupPromise;
    }

    activeLeaseWorkers.set(worker, cleanup);

    function settle(error?: Error, processResult?: WorkerCommandResult): void {
      if (settled) return;
      settled = true;
      void cleanup().then(() => {
        if (error) reject(error);
        else if (processResult) resolve({ checkpoints, process: processResult });
        else reject(new Error('heartbeat scenario settled without a process result'));
      }, teardownError => {
        reject(leaseWorkerSettlementError(error, teardownError));
      });
    }

    function onMessage(message: unknown): void {
      if (!message || typeof message !== 'object') return;
      const payload = message as {
        type?: string;
        runId?: string;
        pausePoint?: string;
        stage?: string;
        evidence?: HeartbeatEvidence;
      };
      if (payload.type !== 'NANOFLOW_LEASE_TEST_HEARTBEAT_CHECKPOINT'
        || payload.runId !== runId
        || payload.pausePoint !== pausePoint
        || typeof payload.stage !== 'string'
        || !payload.evidence) return;
      checkpoints.push({ stage: payload.stage, evidence: payload.evidence });
      if (mode === 'observe-renewal' && payload.stage === 'renewed') {
        worker.send({
          type: 'NANOFLOW_LEASE_TEST_RESUME',
          runId,
          pausePoint,
          stage: 'release',
        }, error => {
          if (error) settle(error);
        });
      }
    }

    function onProcessComplete(processResult: WorkerCommandResult): void {
      const requiredStage = mode === 'crash-before-first-tick' ? 'before-first-tick' : 'initial';
      if (!checkpoints.some(checkpoint => checkpoint.stage === requiredStage)) {
        settle(new Error(processResult.stderr
          || `heartbeat worker closed before ${requiredStage} checkpoint (code=${processResult.status}, signal=${processResult.signal})`));
        return;
      }
      settle(undefined, processResult);
    }

    outputCollector = observeScenarioProcessOutput(worker, onProcessComplete, error => settle(error));
    worker.on('message', onMessage);
    deadline = setTimeout(() => {
      settle(new Error(`heartbeat scenario exceeded ${OWNER_LOCK_SCENARIO_DEADLINE_MS}ms`));
    }, OWNER_LOCK_SCENARIO_DEADLINE_MS);
  });
}

function spawnStaleWorker(
  root: string,
  role: 'holder' | 'contender' | 'barrier-contender',
  extraEnv: NodeJS.ProcessEnv = {},
  cwd = projectRoot,
): {
  barrierEvents: EventEmitter;
  barrierStages: Set<string>;
  completion: Promise<WorkerCommandResult>;
  processProbeCount: number;
  runId: string;
  worker: ReturnType<typeof fork>;
} {
  const canonicalRoot = realpathSync(root);
  const runId = `stale-${role}-${process.pid}-${path.basename(root)}-${Math.random().toString(16).slice(2)}`;
  const worker = fork(leaseWorkerPath, [
    leaseScriptPath,
    '--root', canonicalRoot,
  ], {
    cwd,
    env: {
      ...process.env,
      NANOFLOW_LEASE_TEST_RUN_ID: runId,
      NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
      NANOFLOW_LEASE_TEST_PAUSE_POINT: 'stale-protocol',
      NANOFLOW_LEASE_TEST_STALE_ROLE: role,
      NANOFLOW_LEASE_TEST_HEARTBEAT_INTERVAL_MS: '1000',
      NANOFLOW_LEASE_TEST_STALE_AFTER_MS: '50',
      ...extraEnv,
    },
    silent: true,
  });
  const barrierEvents = new EventEmitter();
  const barrierStages = new Set<string>();
  const descriptor = {
    barrierEvents,
    barrierStages,
    completion: undefined as unknown as Promise<WorkerCommandResult>,
    processProbeCount: 0,
    runId,
    worker,
  };
  worker.on('message', message => {
    if (!message || typeof message !== 'object') return;
    const payload = message as {
      type?: string;
      runId?: string;
      pausePoint?: string;
      stage?: string;
    };
    if (payload.type === 'NANOFLOW_LEASE_TEST_PROCESS_START_PROBE_SPAWN'
      && payload.runId === runId
      && payload.pausePoint === 'stale-protocol') {
      descriptor.processProbeCount += 1;
      return;
    }
    if (payload.type !== 'NANOFLOW_LEASE_TEST_STALE_BARRIER_STAGE'
      || payload.runId !== runId
      || payload.pausePoint !== 'stale-protocol'
      || typeof payload.stage !== 'string') return;
    barrierStages.add(payload.stage);
    barrierEvents.emit(payload.stage);
  });
  const completion = new Promise<WorkerCommandResult>((resolve, reject) => {
    const outputCollector = observeScenarioProcessOutput(worker, result => {
      activeLeaseWorkers.delete(worker);
      resolve(result);
    }, error => {
      activeLeaseWorkers.delete(worker);
      reject(error);
    });
    activeLeaseWorkers.set(worker, async () => {
      try {
        await terminateLeaseWorker(worker);
      } finally {
        outputCollector.detach();
      }
    });
  });
  descriptor.completion = completion;
  return descriptor;
}

function waitForStaleBarrierStage(
  contender: ReturnType<typeof spawnStaleWorker>,
  stage: string,
  deadlineMs = 15_000,
): Promise<void> {
  if (contender.barrierStages.has(stage)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`stale barrier ${stage} exceeded ${deadlineMs}ms for ${contender.runId}`));
    }, deadlineMs);
    const cleanup = () => {
      clearTimeout(deadline);
      contender.barrierEvents.off(stage, onStage);
    };
    const onStage = () => {
      cleanup();
      resolve();
    };
    contender.barrierEvents.once(stage, onStage);
  });
}

function sendStaleBarrier(
  contender: ReturnType<typeof spawnStaleWorker>,
  action: 'go' | 'acquire' | 'commit',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const settleSendError = (error: Error): void => {
      if (action !== 'acquire') {
        reject(error);
        return;
      }
      void contender.completion.then(result => {
        if (result.status !== 0
          && result.stdout === ''
          && result.stderr.includes('lease state is locked')) {
          resolve();
          return;
        }
        reject(error);
      }, reject);
    };
    try {
      contender.worker.send({
        type: 'NANOFLOW_LEASE_TEST_STALE_BARRIER',
        runId: contender.runId,
        pausePoint: 'stale-protocol',
        action,
      }, error => {
        if (error) settleSendError(error);
        else resolve();
      });
    } catch (error) {
      settleSendError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function waitForStaleWinner(
  contenders: Array<ReturnType<typeof spawnStaleWorker>>,
  deadlineMs = 15_000,
): Promise<ReturnType<typeof spawnStaleWorker>> {
  const alreadyWon = contenders.find(contender => contender.barrierStages.has('won'));
  if (alreadyWon) return Promise.resolve(alreadyWon);
  return new Promise((resolve, reject) => {
    const listeners = new Map<ReturnType<typeof spawnStaleWorker>, () => void>();
    const cleanup = () => {
      clearTimeout(deadline);
      for (const [contender, listener] of listeners) {
        contender.barrierEvents.off('won', listener);
      }
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`stale winner election exceeded ${deadlineMs}ms`));
    }, deadlineMs);
    for (const contender of contenders) {
      const listener = () => {
        cleanup();
        resolve(contender);
      };
      listeners.set(contender, listener);
      contender.barrierEvents.once('won', listener);
    }
  });
}

function waitForStaleHolderCheckpoint(
  holder: ReturnType<typeof spawnStaleWorker>,
): Promise<HeartbeatEvidence> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`stale holder checkpoint exceeded ${OWNER_LOCK_SCENARIO_DEADLINE_MS}ms`));
    }, OWNER_LOCK_SCENARIO_DEADLINE_MS);
    const cleanup = () => {
      clearTimeout(deadline);
      holder.worker.off('message', onMessage);
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const payload = message as {
        type?: string;
        runId?: string;
        pausePoint?: string;
        stage?: string;
        evidence?: HeartbeatEvidence;
      };
      if (payload.type !== 'NANOFLOW_LEASE_TEST_STALE_CHECKPOINT'
        || payload.runId !== holder.runId
        || payload.pausePoint !== 'stale-protocol'
        || payload.stage !== 'held'
        || !payload.evidence) return;
      cleanup();
      resolve(payload.evidence);
    };
    holder.worker.on('message', onMessage);
    void holder.completion.then(result => {
      cleanup();
      reject(new Error(result.stderr
        || `stale holder closed before checkpoint (code=${result.status}, signal=${result.signal})`));
    }, error => {
      cleanup();
      reject(error);
    });
  });
}

async function runStaleScenario(
  root: string,
  options: StaleScenarioOptions,
): Promise<StaleScenarioResult> {
  const holder = spawnStaleWorker(root, 'holder');
  const evidence = await waitForStaleHolderCheckpoint(holder);
  options.mutate?.(root, evidence);

  let holderResult: WorkerCommandResult | undefined;
  if (options.disposition !== 'live') {
    holder.worker.send({
      type: 'NANOFLOW_LEASE_TEST_STALE_ACTION',
      runId: holder.runId,
      pausePoint: 'stale-protocol',
      action: options.disposition === 'normal-exit' ? 'exit-normal' : 'exit-crash',
    });
    holderResult = await holder.completion;
    options.afterHolderExit?.(root, evidence);
  }

  const contender = spawnStaleWorker(root, 'contender', {
    NANOFLOW_LEASE_TEST_PROCESS_PROBE_MODE: options.processProbeMode ?? '',
    NANOFLOW_LEASE_TEST_STALE_AFTER_MS: String(options.staleAfterMs ?? 50),
    ...options.contenderEnv,
  }, options.contenderCwd);
  let contenderResult: WorkerCommandResult;
  try {
    contenderResult = await contender.completion;
  } finally {
    if (options.disposition === 'live') await terminateLeaseWorker(holder.worker);
  }
  return {
    evidence,
    holder: holderResult,
    contender: contenderResult,
    processProbeCount: contender.processProbeCount,
  };
}

async function prepareDeadStaleHolder(root: string, disposition: 'normal-exit' | 'crash' = 'crash') {
  const holder = spawnStaleWorker(root, 'holder');
  const evidence = await waitForStaleHolderCheckpoint(holder);
  rewriteStaleHeartbeat(root, evidence);
  holder.worker.send({
    type: 'NANOFLOW_LEASE_TEST_STALE_ACTION',
    runId: holder.runId,
    pausePoint: 'stale-protocol',
    action: disposition === 'normal-exit' ? 'exit-normal' : 'exit-crash',
  });
  const result = await holder.completion;
  return { evidence, result };
}

async function runConcurrentStaleReclaim(root: string, contenderCount: number) {
  await prepareDeadStaleHolder(root);
  const contenders = Array.from({ length: contenderCount }, () => (
    spawnStaleWorker(root, 'barrier-contender')
  ));
  await Promise.all(contenders.map(contender => waitForStaleBarrierStage(contender, 'ready')));
  await Promise.all(contenders.map(contender => sendStaleBarrier(contender, 'go')));
  await Promise.all(contenders.map(contender => waitForStaleBarrierStage(contender, 'attempting')));

  const winnerPromise = waitForStaleWinner(contenders);
  await Promise.all(contenders.map(contender => sendStaleBarrier(contender, 'acquire')));
  const winner = await winnerPromise;
  const losers = contenders.filter(contender => contender !== winner);
  const loserResults = await Promise.all(losers.map(contender => contender.completion));
  await sendStaleBarrier(winner, 'commit');
  const winnerResult = await winner.completion;
  return { loserResults, winner, winnerResult };
}

function rewriteStaleHeartbeat(
  root: string,
  evidence: HeartbeatEvidence,
  mutate: (heartbeat: HeartbeatEvidence['heartbeat']) => unknown = heartbeat => heartbeat,
): void {
  const heartbeatPath = path.join(root, 'tmp', evidence.heartbeatName);
  const canonicalPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
  const updatedAtMs = Date.now() - 10 * 60 * 1000;
  const owner = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  if (owner.schema === 3 && owner.initialHeartbeat) {
    const initialHeartbeatAtMs = updatedAtMs - 60_000;
    owner.createdAt = new Date(initialHeartbeatAtMs).toISOString();
    owner.initialHeartbeat.heartbeatAtMs = initialHeartbeatAtMs;
    writeFileSync(canonicalPath, JSON.stringify(owner));
  }
  const heartbeat = {
    ...evidence.heartbeat,
    updatedAtMs,
  };
  writeFileSync(heartbeatPath, JSON.stringify(mutate(heartbeat)));
}

function rewriteHeartbeatMetadata(
  root: string,
  evidence: HeartbeatEvidence,
  mutate: (heartbeat: Record<string, any>) => void,
): void {
  const heartbeatPath = path.join(root, 'tmp', evidence.heartbeatName);
  const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
  mutate(heartbeat);
  writeFileSync(heartbeatPath, JSON.stringify(heartbeat));
}

function rewriteOwnerStartIdentity(
  root: string,
  evidence: HeartbeatEvidence,
  value: number,
): void {
  const canonicalPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
  const owner = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  owner.processStartIdentity = { ...owner.processStartIdentity, value };
  owner.createdAt = new Date(value + 1_000).toISOString();
  if (owner.initialHeartbeat) {
    owner.initialHeartbeat.processStartIdentity = {
      ...owner.initialHeartbeat.processStartIdentity,
      value,
    };
    owner.initialHeartbeat.heartbeatAtMs = Date.parse(owner.createdAt);
  }
  writeFileSync(canonicalPath, JSON.stringify(owner));
  rewriteStaleHeartbeat(root, evidence, heartbeat => ({
    ...heartbeat,
    processStartIdentity: { ...heartbeat.processStartIdentity, value },
  }));
}

function rewriteOwnerMetadata(
  root: string,
  mutate: (owner: Record<string, any>) => void,
): void {
  const canonicalPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
  const owner = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  mutate(owner);
  writeFileSync(canonicalPath, JSON.stringify(owner));
}

type StaleArtifactSnapshot = {
  artifacts: Array<{
    path: string;
    bytes: Buffer;
    identity: { dev: bigint; ino: bigint };
  }>;
  namespace: string[];
  qPath: string;
};

function captureStaleArtifacts(
  root: string,
  evidence: HeartbeatEvidence,
): StaleArtifactSnapshot {
  const lockDirectory = path.join(root, 'tmp');
  const canonicalPath = path.join(lockDirectory, 'agent-file-leases.json.lock');
  const owner = JSON.parse(readFileSync(canonicalPath, 'utf8'));
  const ownerPath = path.join(
    lockDirectory,
    `${path.basename(canonicalPath)}.owner.${owner.pid}.${owner.token}`,
  );
  const heartbeatPath = path.join(lockDirectory, evidence.heartbeatName);
  const registryPath = path.join(lockDirectory, 'agent-file-leases.json');
  const capture = (filePath: string) => {
    const identity = lstatSync(filePath, { bigint: true });
    return {
      path: filePath,
      bytes: readFileSync(filePath),
      identity: { dev: identity.dev, ino: identity.ino },
    };
  };
  return {
    artifacts: [canonicalPath, ownerPath, heartbeatPath, registryPath]
      .filter(filePath => existsSync(filePath))
      .map(capture),
    namespace: readdirSync(lockDirectory).sort(),
    qPath: `${canonicalPath}.reclaim.${evidence.heartbeat.token}`,
  };
}

function expectStaleArtifactsUnchanged(snapshot: StaleArtifactSnapshot): void {
  for (const artifact of snapshot.artifacts) {
    const stillExists = existsSync(artifact.path);
    expect.soft(stillExists, `${artifact.path} must remain present`).toBe(true);
    if (!stillExists) continue;
    const identity = lstatSync(artifact.path, { bigint: true });
    expect.soft({ dev: identity.dev, ino: identity.ino }).toEqual(artifact.identity);
    expect.soft(readFileSync(artifact.path).equals(artifact.bytes)).toBe(true);
  }
  expect.soft(existsSync(snapshot.qPath)).toBe(false);
  expect.soft(readdirSync(path.dirname(snapshot.qPath)).sort()).toEqual(snapshot.namespace);
}

describe('agent-file-lease', () => {
  afterEach(async () => {
    await Promise.all([...activeLeaseWorkers.values()].map(cleanup => cleanup()));
    if (activeLeaseWorkers.size === 0) {
      while (tempRoots.length > 0) {
        const root = tempRoots.pop();
        if (root) rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('claims, reports, and releases machine-readable file leases', () => {
    const root = makeRoot();

    const claim = runLease(root, ['claim', '--owner', 'agent-a', 'AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']);

    expect(claim.status, claim.stderr || claim.stdout).toBe(0);
    const claimed = JSON.parse(claim.stdout);
    expect(claimed.ok).toBe(true);
    expect(claimed.claimed).toEqual(['AGENTS.md', 'docs/codegraph-nanoflow-adaptation.md']);
    expect(claimed.workspaceEpoch).toBe(1);

    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    expect(existsSync(leasePath)).toBe(true);
    const leaseFile = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(leaseFile).toEqual(expect.objectContaining({ version: 1, workspaceEpoch: 1 }));
    expect(leaseFile.leases['AGENTS.md'].owner).toBe('agent-a');

    const status = runLease(root, ['status']);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    const statusReport = JSON.parse(status.stdout);
    expect(statusReport.workspaceEpoch).toBe(1);
    expect(statusReport.leases['AGENTS.md'].owner).toBe('agent-a');

    const release = runLease(root, ['release', '--owner', 'agent-a', 'AGENTS.md']);
    expect(release.status, release.stderr || release.stdout).toBe(0);
    const releaseReport = JSON.parse(release.stdout);
    expect(releaseReport.released).toEqual(['AGENTS.md']);
    expect(releaseReport.workspaceEpoch).toBe(1);
    expect(JSON.parse(readFileSync(leasePath, 'utf8')).workspaceEpoch).toBe(1);
  });

  it('owner-scoped release preserves a foreign expired lease record', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    mkdirSync(path.dirname(leasePath), { recursive: true });
    const now = Date.now();
    writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      workspaceEpoch: 7,
      leases: {
        'owner.ts': {
          owner: 'owner-a',
          claimedAt: new Date(now - 1000).toISOString(),
          expiresAt: new Date(now + 60_000).toISOString(),
          expiresAtMs: now + 60_000,
        },
        'foreign-expired.ts': {
          owner: 'owner-b',
          claimedAt: '1970-01-01T00:00:00.000Z',
          expiresAt: '1970-01-01T00:00:00.001Z',
          expiresAtMs: 1,
        },
      },
    }, null, 2)}\n`);

    const release = runLease(root, ['release', '--owner', 'owner-a', 'owner.ts']);

    expect(release.status, release.stderr || release.stdout).toBe(0);
    const state = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(state.leases).not.toHaveProperty('owner.ts');
    expect(state.leases['foreign-expired.ts']).toEqual(expect.objectContaining({
      owner: 'owner-b',
      expiresAtMs: 1,
    }));
  });

  it('owner-scoped claim preserves a foreign expired lease record', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      workspaceEpoch: 7,
      leases: {
        'owner-expired.ts': {
          owner: 'owner-a',
          claimedAt: '1970-01-01T00:00:00.000Z',
          expiresAt: '1970-01-01T00:00:00.001Z',
          expiresAtMs: 1,
        },
        'foreign-expired.ts': {
          owner: 'owner-b',
          claimedAt: '1970-01-01T00:00:00.000Z',
          expiresAt: '1970-01-01T00:00:00.001Z',
          expiresAtMs: 1,
        },
      },
    }, null, 2)}\n`);

    const claim = runLease(root, ['claim', '--owner', 'owner-a', 'new.ts']);

    expect(claim.status, claim.stderr || claim.stdout).toBe(0);
    const state = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(state.leases).not.toHaveProperty('owner-expired.ts');
    expect(state.leases['foreign-expired.ts']).toEqual(expect.objectContaining({
      owner: 'owner-b',
      expiresAtMs: 1,
    }));
    expect(state.leases['new.ts']).toEqual(expect.objectContaining({ owner: 'owner-a' }));
  });

  it('barrier acquire preserves foreign expired lease records', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      workspaceEpoch: 7,
      leases: {
        'foreign-expired.ts': {
          owner: 'owner-b', claimedAt: '1970-01-01T00:00:00.000Z',
          expiresAt: '1970-01-01T00:00:00.001Z', expiresAtMs: 1,
        },
      },
    }, null, 2)}\n`);

    const acquire = runLease(root, ['barrier-acquire', '--owner', 'owner-a', '--barrier-token', 'a'.repeat(64)]);
    expect(acquire.status, acquire.stderr || acquire.stdout).toBe(0);
    const state = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(state.barrier.state).toBe('HELD');
    expect(state.leases['foreign-expired.ts']).toEqual(expect.objectContaining({ owner: 'owner-b' }));
  });

  it('fails closed when the transaction directory is a junction outside the canonical root', () => {
    const root = makeRoot();
    const externalRoot = makeRoot();
    const transactionDirectory = path.join(root, 'tmp');
    const externalRegistryPath = path.join(externalRoot, 'agent-file-leases.json');
    symlinkSync(externalRoot, transactionDirectory, 'junction');

    const claim = runLease(root, ['claim', '--owner', 'agent-a', 'a.ts']);

    expect.soft(claim.status, claim.stderr || claim.stdout).not.toBe(0);
    expect.soft(claim.stdout).toBe('');
    expect.soft(existsSync(externalRegistryPath)).toBe(false);
    expect.soft(lstatSync(transactionDirectory).isSymbolicLink()).toBe(true);
    expect(realpathSync(transactionDirectory)).toBe(realpathSync(externalRoot));
  });

  it('rejects conflicting claims unless the same owner refreshes the lease', () => {
    const root = makeRoot();

    const initial = runLease(root, ['claim', '--owner', 'agent-a', 'AGENTS.md']);
    expect(initial.status, initial.stderr || initial.stdout).toBe(0);
    expect(JSON.parse(initial.stdout).workspaceEpoch).toBe(1);
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const registryBeforeConflict = JSON.parse(readFileSync(leasePath, 'utf8'));
    registryBeforeConflict.leases['expired.ts'] = {
      owner: 'expired-owner',
      claimedAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:00:00.001Z',
      expiresAtMs: 1,
    };
    writeFileSync(leasePath, `${JSON.stringify(registryBeforeConflict, null, 2)}\n`);
    const beforeConflict = readFileSync(leasePath, 'utf8');

    const conflict = runLease(root, ['claim', '--owner', 'agent-b', 'AGENTS.md']);
    expect(conflict.status).toBe(1);
    const conflictReport = JSON.parse(conflict.stdout);
    expect(conflictReport.workspaceEpoch).toBe(1);
    expect(conflictReport.conflicts).toEqual([
      expect.objectContaining({
        file: 'AGENTS.md',
        owner: 'agent-a',
      }),
    ]);
    expect(conflictReport.leases).not.toHaveProperty('expired.ts');
    expect(readFileSync(leasePath, 'utf8')).toBe(beforeConflict);

    const refresh = runLease(root, ['claim', '--owner', 'agent-a', 'AGENTS.md']);
    expect(refresh.status, refresh.stderr || refresh.stdout).toBe(0);
    const refreshReport = JSON.parse(refresh.stdout);
    expect(refreshReport.claimed).toEqual(['AGENTS.md']);
    expect(refreshReport.workspaceEpoch).toBe(2);
    expect(JSON.parse(readFileSync(leasePath, 'utf8')).workspaceEpoch).toBe(2);
  });

  it.each([
    ['versioned v1', true],
    ['unversioned legacy', false],
  ])('reads a valid %s registry without rewriting it', (_shape, includeVersion) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const expiresAt = '2999-01-01T00:00:00.000Z';
    const lease = {
      owner: 'agent-a',
      claimedAt: '2026-01-01T00:00:00.000Z',
      expiresAt,
      expiresAtMs: Date.parse(expiresAt),
      note: 'preserved-extra-field',
    };
    const registry = includeVersion
      ? { version: 1, leases: { 'held.ts': lease } }
      : { leases: { 'held.ts': lease } };
    const originalBytes = `${JSON.stringify(registry, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);

    const status = runLease(root, ['status']);

    expect(status.status, status.stderr || status.stdout).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.workspaceEpoch).toBe(0);
    expect(report.leases['held.ts']).toEqual(lease);
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
  });

  const validRegistryLease = {
    owner: 'agent-a',
    claimedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    expiresAtMs: Date.parse('2999-01-01T00:00:00.000Z'),
  };
  const withoutLeaseField = (field: keyof typeof validRegistryLease) => Object.fromEntries(
    Object.entries(validRegistryLease).filter(([key]) => key !== field),
  );
  const registryWithLease = (lease: unknown, version: unknown = 1) => ({
    version,
    leases: { 'held.ts': lease },
  });
  const registryWithWorkspaceEpoch = (workspaceEpoch: unknown) => ({
    version: 1,
    workspaceEpoch,
    leases: { 'held.ts': validRegistryLease },
  });
  const invalidRegistryCases: Array<[string, unknown]> = [
    ['unsupported version', registryWithLease(validRegistryLease, 2)],
    ['wrong version type', registryWithLease(validRegistryLease, '1')],
    ['null lease record', registryWithLease(null)],
    ['missing owner', registryWithLease(withoutLeaseField('owner'))],
    ['missing claimedAt', registryWithLease(withoutLeaseField('claimedAt'))],
    ['missing expiresAt', registryWithLease(withoutLeaseField('expiresAt'))],
    ['missing expiresAtMs', registryWithLease(withoutLeaseField('expiresAtMs'))],
    ['wrong owner type', registryWithLease({ ...validRegistryLease, owner: 7 })],
    ['empty owner', registryWithLease({ ...validRegistryLease, owner: '' })],
    ['wrong claimedAt type', registryWithLease({ ...validRegistryLease, claimedAt: 7 })],
    ['wrong expiresAt type', registryWithLease({ ...validRegistryLease, expiresAt: false })],
    ['wrong expiresAtMs type', registryWithLease({ ...validRegistryLease, expiresAtMs: 'never' })],
    ['unparseable claimedAt', registryWithLease({ ...validRegistryLease, claimedAt: 'not-a-date' })],
    ['unparseable expiresAt', registryWithLease({ ...validRegistryLease, expiresAt: 'not-a-date' })],
    ['inconsistent expiresAtMs', registryWithLease({
      ...validRegistryLease,
      expiresAtMs: validRegistryLease.expiresAtMs + 1,
    })],
    ['negative workspaceEpoch', registryWithWorkspaceEpoch(-1)],
    ['fractional workspaceEpoch', registryWithWorkspaceEpoch(1.5)],
    ['string workspaceEpoch', registryWithWorkspaceEpoch('1')],
    ['null workspaceEpoch', registryWithWorkspaceEpoch(null)],
    ['boolean workspaceEpoch', registryWithWorkspaceEpoch(true)],
    ['unsafe workspaceEpoch', registryWithWorkspaceEpoch(Number.MAX_SAFE_INTEGER + 1)],
  ];
  const invalidRegistryCommands: Array<[string, string[]]> = [
    ['claim', ['claim', '--owner', 'agent-a', 'new.ts']],
    ['release', ['release', '--owner', 'agent-a', 'held.ts']],
    ['status', ['status']],
    ['prune', ['prune']],
  ];
  const invalidRegistryMatrix: Array<[string, unknown, string[]]> = invalidRegistryCases.flatMap(
    ([caseName, registry]) => invalidRegistryCommands.map(
      ([command, args]): [string, unknown, string[]] => [
      `${caseName} through ${command}`,
      registry,
      args,
      ],
    ),
  );

  it.each(invalidRegistryMatrix)('fails closed for a registry with %s', (_caseName, registry, args) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const originalBytes = `${JSON.stringify(registry, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);

    const result = runLease(root, args);

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(result.stdout).toBe('');
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
  });

  it('fails closed without rewriting a registry whose leases is an array', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const originalBytes = '{\n  "version": 1,\n  "leases": []\n}\n';
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);

    const claim = runLease(root, ['claim', '--owner', 'agent-a', 'a.ts']);

    expect(claim.status).not.toBe(0);
    expect(claim.stdout).toBe('');
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
  });

  it.each(['NaN', 'Infinity', '-Infinity'])(
    'fails closed without rewriting a registry whose workspaceEpoch is the JSON token %s',
    workspaceEpochToken => {
      const root = makeRoot();
      const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
      const originalBytes = `{"version":1,"workspaceEpoch":${workspaceEpochToken},"leases":{}}\n`;
      mkdirSync(path.dirname(leasePath), { recursive: true });
      writeFileSync(leasePath, originalBytes);

      const status = runLease(root, ['status']);

      expect.soft(status.status, status.stderr || status.stdout).not.toBe(0);
      expect.soft(status.stdout).toBe('');
      expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
    },
  );

  it('fails a claim at MAX_SAFE_INTEGER before changing leases or registry bytes', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const originalBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: Number.MAX_SAFE_INTEGER,
      leases: { 'held.ts': validRegistryLease },
    }, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);

    const claim = runLease(root, ['claim', '--owner', 'agent-a', 'new.ts']);

    expect.soft(claim.status, claim.stderr || claim.stdout).not.toBe(0);
    expect.soft(claim.stdout).toBe('');
    expect.soft(claim.stderr).toContain('workspaceEpoch');
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
  });

  it('does not persist an epoch change when a claim is rejected before commit', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const originalBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 7,
      leases: { 'held.ts': validRegistryLease },
    }, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);

    const rejected = runLease(root, ['claim', '--owner', 'agent-a', '../outside.ts']);

    expect.soft(rejected.status, rejected.stderr || rejected.stdout).not.toBe(0);
    expect.soft(rejected.stdout).toBe('');
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
  });

  it.each([
    ['versioned v1', true],
    ['unversioned legacy', false],
  ])('normalizes missing %s barrier state to OPEN/0 without rewriting legacy bytes', (_shape, includeVersion) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const registry = includeVersion
      ? { version: 1, workspaceEpoch: 4, leases: {} }
      : { workspaceEpoch: 4, leases: {} };
    const originalBytes = `${JSON.stringify(registry, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);

    const result = runLease(root, ['status']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.workspaceEpoch).toBe(4);
    expect(report.fencingCounter).toBe(0);
    expect(report.barrier).toEqual(expect.objectContaining({
      state: 'OPEN',
      owner: null,
      tokenFingerprint: null,
      heartbeatSequence: 0,
      heldEpoch: null,
      fence: null,
      transitions: [],
    }));
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
  });

  describe('READ resource leases', () => {
    it.each([
      ['versioned v1', true],
      ['unversioned legacy', false],
    ])('projects missing resourceLeases as empty for %s status without rewriting bytes', (_shape, includeVersion) => {
      const root = makeRoot();
      const registry = includeVersion
        ? { version: 1, workspaceEpoch: 4, leases: {} }
        : { workspaceEpoch: 4, leases: {} };
      const registryPath = writeLeaseRegistry(root, registry);
      const originalBytes = readFileSync(registryPath, 'utf8');
      const originalStat = statSync(registryPath, { bigint: true });

      const result = runLease(root, ['status']);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).resourceLeases).toEqual({
        active: [],
        released: [],
        expired: [],
      });
      expect(readFileSync(registryPath, 'utf8')).toBe(originalBytes);
      const afterStat = statSync(registryPath, { bigint: true });
      expect({ dev: afterStat.dev, ino: afterStat.ino, mtimeNs: afterStat.mtimeNs }).toEqual({
        dev: originalStat.dev,
        ino: originalStat.ino,
        mtimeNs: originalStat.mtimeNs,
      });
    });

    it('acquires, replays, releases, and supersedes a caller-token READ resource lease without epoch or barrier drift', () => {
      const root = makeRoot();
      const firstRawToken = readResourceToken('A');
      const firstToken = firstRawToken.toLowerCase();
      const firstTokenHash = readResourceTokenHash(firstRawToken);
      const secondToken = readResourceToken('b');
      const secondTokenHash = readResourceTokenHash(secondToken);

      const acquire = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-a',
        'generation-a',
        firstRawToken,
        ['--ttl-ms', '60000'],
      ));

      expect(acquire.status, acquire.stderr || acquire.stdout).toBe(0);
      const acquired = JSON.parse(acquire.stdout);
      expect(acquired).toEqual(expect.objectContaining({
        ok: true,
        command: 'resource-lease-acquire',
        acquired: true,
        idempotent: false,
        workspaceEpoch: 0,
        fencingCounter: 0,
      }));
      expect(acquired.barrier).toEqual(expect.objectContaining({ state: 'OPEN' }));
      expect(acquired.resourceLease).toEqual(expect.objectContaining({
        kind: 'read',
        resourceId: 'generation-a',
        owner: 'reader-a',
        tokenFingerprint: firstTokenHash.slice(0, 12),
        state: 'ACTIVE',
        heartbeatSequence: 1,
        releasedAt: null,
      }));
      expect(acquired.resourceLease).not.toHaveProperty('tokenHash');
      expect(acquire.stdout).not.toContain(firstRawToken);
      expect(acquire.stdout).not.toContain(firstTokenHash);

      const registryPath = leaseRegistryPath(root);
      const registryBytes = readFileSync(registryPath, 'utf8');
      const registry = JSON.parse(registryBytes);
      expect(registry).toEqual(expect.objectContaining({
        version: 1,
        workspaceEpoch: 0,
        leases: {},
      }));
      expect(registry).not.toHaveProperty('fencingCounter');
      expect(registry).not.toHaveProperty('barrier');
      expect(Object.keys(registry.resourceLeases)).toEqual([firstTokenHash]);
      expect(registry.resourceLeases[firstTokenHash]).toEqual(expect.objectContaining({
        kind: 'read',
        resourceId: 'generation-a',
        owner: 'reader-a',
        tokenHash: firstTokenHash,
        tokenFingerprint: firstTokenHash.slice(0, 12),
        state: 'ACTIVE',
        heartbeatSequence: 1,
        releasedAt: null,
      }));
      expect(registryBytes).not.toContain(firstRawToken);

      const replay = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-a',
        'generation-a',
        firstToken,
        ['--ttl-ms', '1'],
      ));
      expect(replay.status, replay.stderr || replay.stdout).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual(expect.objectContaining({
        acquired: false,
        idempotent: true,
      }));
      expect(readFileSync(registryPath, 'utf8')).toBe(registryBytes);

      const release = runLease(root, readResourceLeaseArgs(
        'resource-lease-release',
        'reader-a',
        'generation-a',
        firstToken,
      ));
      expect(release.status, release.stderr || release.stdout).toBe(0);
      expect(JSON.parse(release.stdout)).toEqual(expect.objectContaining({
        released: true,
        idempotent: false,
      }));
      expect(JSON.parse(release.stdout).resourceLease.state).toBe('RELEASED');
      const releasedBytes = readFileSync(registryPath, 'utf8');

      const terminalAcquireReplay = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-a',
        'generation-a',
        firstRawToken,
      ));
      expect(terminalAcquireReplay.status, terminalAcquireReplay.stderr || terminalAcquireReplay.stdout).toBe(0);
      expect(JSON.parse(terminalAcquireReplay.stdout)).toEqual(expect.objectContaining({
        acquired: false,
        idempotent: true,
      }));
      expect(JSON.parse(terminalAcquireReplay.stdout).resourceLease.state).toBe('RELEASED');
      expect(readFileSync(registryPath, 'utf8')).toBe(releasedBytes);

      const successor = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-a',
        'generation-a',
        secondToken,
      ));
      expect(successor.status, successor.stderr || successor.stdout).toBe(0);
      expect(JSON.parse(successor.stdout).acquired).toBe(true);
      const successorBytes = readFileSync(registryPath, 'utf8');
      const successorRegistry = JSON.parse(successorBytes);
      expect(Object.keys(successorRegistry.resourceLeases).sort()).toEqual([
        firstTokenHash,
        secondTokenHash,
      ].sort());
      expect(successorRegistry.resourceLeases[firstTokenHash].state).toBe('RELEASED');
      expect(successorRegistry.resourceLeases[secondTokenHash].state).toBe('ACTIVE');

      const oldHeartbeat = runLease(root, readResourceLeaseArgs(
        'resource-lease-heartbeat',
        'reader-a',
        'generation-a',
        firstToken,
      ));
      expect(oldHeartbeat.status).toBe(1);
      expect(readFileSync(registryPath, 'utf8')).toBe(successorBytes);
      const oldReleaseRetry = runLease(root, readResourceLeaseArgs(
        'resource-lease-release',
        'reader-a',
        'generation-a',
        firstToken,
      ));
      expect(oldReleaseRetry.status, oldReleaseRetry.stderr || oldReleaseRetry.stdout).toBe(0);
      expect(JSON.parse(oldReleaseRetry.stdout).idempotent).toBe(true);
      expect(readFileSync(registryPath, 'utf8')).toBe(successorBytes);

      const status = runLease(root, ['status']);
      expect(status.status, status.stderr || status.stdout).toBe(0);
      expect(status.stdout).not.toContain(firstRawToken);
      expect(status.stdout).not.toContain(firstTokenHash);
      expect(status.stdout).not.toContain(secondToken);
      expect(status.stdout).not.toContain(secondTokenHash);
      const statusReport = JSON.parse(status.stdout);
      expect(statusReport.resourceLeases.active).toEqual([
        expect.objectContaining({
          resourceId: 'generation-a',
          tokenFingerprint: secondTokenHash.slice(0, 12),
          state: 'ACTIVE',
        }),
      ]);
      expect(statusReport.resourceLeases.released).toEqual([
        expect.objectContaining({
          resourceId: 'generation-a',
          tokenFingerprint: firstTokenHash.slice(0, 12),
          state: 'RELEASED',
        }),
      ]);
      expect(statusReport.resourceLeases.expired).toEqual([]);
    });

    it.each([
      'resource-lease-acquire',
      'resource-lease-heartbeat',
      'resource-lease-release',
    ] as const)('rejects an argv bearer token for %s before owner locking without disclosing or persisting it', command => {
      const root = makeRoot();
      const token = readResourceToken('d');
      const result = runLease(root, [
        command,
        '--owner', 'reader-argv-rejected',
        '--resource-kind', 'read',
        '--resource-id', 'generation-argv-rejected',
        '--resource-token', token,
      ], {
        env: {
          ...process.env,
          NANOFLOW_LEASE_TEST_PAUSE_POINT: 'cli-transaction',
          NANOFLOW_LEASE_TEST_RUN_ID: `resource-argv-token-${command}`,
          NANOFLOW_LEASE_TEST_ROOT: realpathSync(root),
        },
      });

      expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
      expect.soft(result.stdout).toBe('');
      expect.soft(result.stderr).toContain('--resource-token');
      expect.soft(result.stderr).not.toContain(token);
      expect.soft(result.stderr).not.toContain('checkpoint');
      expect.soft(existsSync(leaseRegistryPath(root))).toBe(false);
      expect.soft(existsSync(`${leaseRegistryPath(root)}.lock`)).toBe(false);
    });

    it('accepts strict caller tokens only from stdin and validates every required resource input before owner locking', () => {
      const token = readResourceToken('c');
      const root = makeRoot();
      const acquireFromStdin = runLease(root, [
        'resource-lease-acquire',
        '--owner', 'reader-a',
        '--resource-kind', 'read',
        '--resource-id', '__proto__',
        '--resource-token-stdin',
      ], { input: token });
      expect(acquireFromStdin.status, acquireFromStdin.stderr || acquireFromStdin.stdout).toBe(0);
      expect(JSON.parse(acquireFromStdin.stdout).resourceLease.resourceId).toBe('__proto__');

      const heartbeatFromStdin = runLease(root, [
        'resource-lease-heartbeat',
        '--owner', 'reader-a',
        '--resource-kind', 'read',
        '--resource-id', '__proto__',
        '--resource-token-stdin',
      ], { input: `${token}\r\n` });
      expect(heartbeatFromStdin.status, heartbeatFromStdin.stderr || heartbeatFromStdin.stdout).toBe(0);
      const releaseFromStdin = runLease(root, [
        'resource-lease-release',
        '--owner', 'reader-a',
        '--resource-kind', 'read',
        '--resource-id', '__proto__',
        '--resource-token-stdin',
      ], { input: token });
      expect(releaseFromStdin.status, releaseFromStdin.stderr || releaseFromStdin.stdout).toBe(0);

      const optionsFirstRoot = makeRoot();
      const optionsFirst = runLease(optionsFirstRoot, withReadResourceTokenStdin([
        '--owner', 'reader-options-first',
        '--resource-kind', 'read',
        '--resource-id', 'Generation-A',
        '--resource-token-stdin',
        '--ttl-ms', '60000',
        'resource-lease-acquire',
      ], readResourceToken('d')));
      expect(optionsFirst.status, optionsFirst.stderr || optionsFirst.stdout).toBe(0);
      expect(JSON.parse(optionsFirst.stdout).resourceLease.resourceId).toBe('Generation-A');

      const invalidStdinCases: Array<[string, string | Buffer]> = [
        ['LF', `${token}\n`],
        ['space', `${token} `],
        ['bare CR', `${token}\r`],
        ['multiline', `${token}\r\n${token}`],
        ['short', token.slice(1)],
        ['high-bit bytes', Buffer.alloc(64, 0xe1)],
      ];
      for (const [caseName, input] of invalidStdinCases) {
        const invalidRoot = makeRoot();
        const result = runLease(invalidRoot, [
          'resource-lease-acquire',
          '--owner', 'reader-invalid',
          '--resource-kind', 'read',
          '--resource-id', 'generation-invalid',
          '--resource-token-stdin',
        ], {
          input,
          env: {
            ...process.env,
            NANOFLOW_LEASE_TEST_PAUSE_POINT: 'cli-transaction',
            NANOFLOW_LEASE_TEST_RUN_ID: `resource-invalid-stdin-${caseName}`,
            NANOFLOW_LEASE_TEST_ROOT: realpathSync(invalidRoot),
          },
        });
        expect.soft(result.status, `${caseName}: ${result.stderr || result.stdout}`).not.toBe(0);
        expect.soft(result.stdout, caseName).toBe('');
        expect.soft(result.stderr, caseName).toContain('resource token stdin');
        expect.soft(result.stderr, caseName).not.toContain('checkpoint');
        expect.soft(existsSync(leaseRegistryPath(invalidRoot)), caseName).toBe(false);
        expect.soft(existsSync(`${leaseRegistryPath(invalidRoot)}.lock`), caseName).toBe(false);
      }

      const invalidArgsCases: Array<[string, string[], string]> = [
        ['missing kind', withReadResourceTokenStdin(['resource-lease-acquire', '--owner', 'reader-a', '--resource-id', 'generation-a', '--resource-token-stdin'], token), '--resource-kind'],
        ['unsupported kind', withReadResourceTokenStdin(['resource-lease-acquire', '--owner', 'reader-a', '--resource-kind', 'write', '--resource-id', 'generation-a', '--resource-token-stdin'], token), 'read or build'],
        ['missing id', withReadResourceTokenStdin(['resource-lease-acquire', '--owner', 'reader-a', '--resource-kind', 'read', '--resource-token-stdin'], token), '--resource-id'],
        ['missing token', ['resource-lease-acquire', '--owner', 'reader-a', '--resource-kind', 'read', '--resource-id', 'generation-a'], 'resource token'],
        ['repeated kind', withReadResourceTokenStdin(['resource-lease-acquire', '--owner', 'reader-a', '--resource-kind', 'read', '--resource-kind', 'read', '--resource-id', 'generation-a', '--resource-token-stdin'], token), '--resource-kind'],
        ['repeated id', withReadResourceTokenStdin(['resource-lease-acquire', '--owner', 'reader-a', '--resource-kind', 'read', '--resource-id', 'generation-a', '--resource-id', 'generation-b', '--resource-token-stdin'], token), '--resource-id'],
        ['repeated token source', withReadResourceTokenStdin(['resource-lease-acquire', '--owner', 'reader-a', '--resource-kind', 'read', '--resource-id', 'generation-a', '--resource-token-stdin', '--resource-token-stdin'], token), '--resource-token-stdin'],
        ['positional tail', withReadResourceTokenStdin([...readResourceLeaseArgs('resource-lease-acquire', 'reader-a', 'generation-a', token), 'unexpected'], token), 'positional'],
        ['dot id', readResourceLeaseArgs('resource-lease-acquire', 'reader-a', '.', token), 'resource id'],
        ['parent id', readResourceLeaseArgs('resource-lease-acquire', 'reader-a', '..', token), 'resource id'],
        ['slash id', readResourceLeaseArgs('resource-lease-acquire', 'reader-a', 'parent/child', token), 'resource id'],
        ['backslash id', readResourceLeaseArgs('resource-lease-acquire', 'reader-a', 'parent\\child', token), 'resource id'],
        ['control id', readResourceLeaseArgs('resource-lease-acquire', 'reader-a', 'generation\u0001a', token), 'resource id'],
        ['oversized id', readResourceLeaseArgs('resource-lease-acquire', 'reader-a', 'g'.repeat(257), token), 'resource id'],
      ];
      for (const [caseName, args, expectedError] of invalidArgsCases) {
        const invalidRoot = makeRoot();
        const result = runLease(invalidRoot, args, {
          env: {
            ...process.env,
            NANOFLOW_LEASE_TEST_PAUSE_POINT: 'cli-transaction',
            NANOFLOW_LEASE_TEST_RUN_ID: `resource-invalid-args-${caseName.replace(/\s+/g, '-')}`,
            NANOFLOW_LEASE_TEST_ROOT: realpathSync(invalidRoot),
          },
        });
        expect.soft(result.status, `${caseName}: ${result.stderr || result.stdout}`).not.toBe(0);
        expect.soft(result.stdout, caseName).toBe('');
        expect.soft(result.stderr, caseName).toContain(expectedError);
        expect.soft(result.stderr, caseName).not.toContain('checkpoint');
        expect.soft(existsSync(leaseRegistryPath(invalidRoot)), caseName).toBe(false);
        expect.soft(existsSync(`${leaseRegistryPath(invalidRoot)}.lock`), caseName).toBe(false);
      }
    }, 15_000);

    it.each([
      ['decimal', '1.5'],
      ['exponent notation', '1e3'],
      ['junk suffix', '60000junk'],
      ['positive sign', '+1'],
      ['negative sign', '-1'],
      ['leading space', ' 1'],
      ['trailing space', '1 '],
      ['zero', '0'],
      ['unsafe integer', '9007199254740992'],
      ['timestamp-out-of-range integer', '8640000000000000'],
    ])('rejects a noncanonical %s READ ttl before owner locking', (caseName, ttl) => {
      const root = makeRoot();
      const result = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-invalid-ttl',
        'generation-invalid-ttl',
        readResourceToken('e'),
        ['--ttl-ms', ttl],
      ), {
        env: {
          ...process.env,
          NANOFLOW_LEASE_TEST_PAUSE_POINT: 'cli-transaction',
          NANOFLOW_LEASE_TEST_RUN_ID: `resource-invalid-ttl-${caseName.replace(/\s+/g, '-')}`,
          NANOFLOW_LEASE_TEST_ROOT: realpathSync(root),
        },
      });

      expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
      expect.soft(result.stdout).toBe('');
      expect.soft(result.stderr).toContain('--ttl-ms');
      expect.soft(result.stderr).not.toContain('checkpoint');
      expect.soft(existsSync(leaseRegistryPath(root))).toBe(false);
      expect.soft(existsSync(`${leaseRegistryPath(root)}.lock`)).toBe(false);
    });

    it('rejects 67 resource-token bytes promptly without waiting for stdin EOF', async () => {
      const root = makeRoot();
      const oversizedInput = 'a'.repeat(67);
      const worker = fork(leaseScriptPath, [
        '--root', realpathSync(root),
        'resource-lease-acquire',
        '--owner', 'reader-oversized-stdin',
        '--resource-kind', 'read',
        '--resource-id', 'generation-oversized-stdin',
        '--resource-token-stdin',
      ], {
        cwd: projectRoot,
        silent: true,
      });
      const cleanup = () => terminateLeaseWorker(worker);
      activeLeaseWorkers.set(worker, cleanup);
      let outputCollector: ReturnType<typeof observeScenarioProcessOutput> | undefined;
      const outcome = await new Promise<{
        completed: boolean;
        result?: WorkerCommandResult;
        snapshot: Pick<WorkerCommandResult, 'stdout' | 'stderr'>;
      }>((resolve, reject) => {
        let settled = false;
        const deadline = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({
            completed: false,
            snapshot: outputCollector?.snapshot() ?? { stdout: '', stderr: '' },
          });
        }, RESOURCE_TOKEN_BOUNDED_STDIN_DEADLINE_MS);
        outputCollector = observeScenarioProcessOutput(
          worker,
          result => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            activeLeaseWorkers.delete(worker);
            resolve({ completed: true, result, snapshot: result });
          },
          error => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            reject(error);
          },
        );
        if (!worker.stdin) {
          clearTimeout(deadline);
          settled = true;
          reject(new Error('resource token bounded-stdin child has no stdin pipe'));
          return;
        }
        worker.stdin.on('error', () => undefined);
        worker.stdin.write(oversizedInput);
      });

      if (!outcome.completed) {
        await terminateLeaseWorker(worker);
        outputCollector?.detach();
      }
      expect.soft(
        outcome.completed,
        `resource token reader remained blocked with stdout=${JSON.stringify(outcome.snapshot.stdout)} stderr=${JSON.stringify(outcome.snapshot.stderr)}`,
      ).toBe(true);
      if (!outcome.result) return;
      expect.soft(outcome.result.status, outcome.result.stderr || outcome.result.stdout).not.toBe(0);
      expect.soft(outcome.result.stdout).toBe('');
      expect.soft(outcome.result.stderr).toContain('resource token stdin');
      expect.soft(outcome.result.stderr).not.toContain(oversizedInput);
      expect.soft(existsSync(leaseRegistryPath(root))).toBe(false);
      expect.soft(existsSync(`${leaseRegistryPath(root)}.lock`)).toBe(false);
    }, RESOURCE_TOKEN_BOUNDED_STDIN_DEADLINE_MS + LEASE_WORKER_TEARDOWN_DEADLINE_MS + 1_000);

    it.each([
      ['empty', ''],
      ['outer whitespace', ' owner-with-space '],
      ['control character', 'owner\u0001control'],
      ['oversized', 'o'.repeat(257)],
    ] as const)('rejects an invalid %s owner before acquiring the registry lock', (_caseName, owner) => {
      const root = makeRoot();
      const result = runLease(root, ['claim', '--owner', owner, 'owner-validation.ts']);
      expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
      expect.soft(result.stdout).toBe('');
      expect.soft(result.stderr).toContain('owner');
      expect.soft(existsSync(leaseRegistryPath(root))).toBe(false);
      expect.soft(existsSync(`${leaseRegistryPath(root)}.lock`)).toBe(false);
    });

    it('accepts Unicode, internal spaces, and slash characters in an owner', () => {
      const root = makeRoot();
      const owner = '/root/context7 轮换';
      const result = runLease(root, ['claim', '--owner', owner, 'owner-validation.ts']);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).owner).toBe(owner);
    });

    it('rejects oversized barrier-token stdin promptly without waiting for stdin EOF', async () => {
      const root = makeRoot();
      const worker = fork(leaseScriptPath, [
        '--root', realpathSync(root),
        'barrier-acquire', '--owner', 'bounded-barrier', '--barrier-token-stdin',
      ], { cwd: projectRoot, silent: true });
      activeLeaseWorkers.set(worker, () => terminateLeaseWorker(worker));
      let outputCollector: ReturnType<typeof observeScenarioProcessOutput> | undefined;
      const outcome = await new Promise<{ completed: boolean; result?: WorkerCommandResult }>((resolve, reject) => {
        let settled = false;
        const deadline = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({ completed: false });
        }, RESOURCE_TOKEN_BOUNDED_STDIN_DEADLINE_MS);
        outputCollector = observeScenarioProcessOutput(
          worker,
          result => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            activeLeaseWorkers.delete(worker);
            resolve({ completed: true, result });
          },
          error => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            reject(error);
          },
        );
        worker.stdin?.on('error', () => undefined);
        worker.stdin?.write('a'.repeat(67));
      });
      if (!outcome.completed) {
        await terminateLeaseWorker(worker);
        outputCollector?.detach();
      }
      expect(outcome.completed).toBe(true);
      expect(outcome.result?.status).not.toBe(0);
      expect(outcome.result?.stdout).toBe('');
      expect(outcome.result?.stderr).toContain('barrier acquisition token stdin');
      expect(existsSync(leaseRegistryPath(root))).toBe(false);
    }, RESOURCE_TOKEN_BOUNDED_STDIN_DEADLINE_MS + LEASE_WORKER_TEARDOWN_DEADLINE_MS + 1_000);

    it('fails closed on malformed or unknown resource lease schema while preserving registry bytes', () => {
      const token = readResourceToken('a');
      const tokenHash = readResourceTokenHash(token);
      const validRecord = storedReadResourceLease(token);
      const baseRegistry = () => ({
        version: 1,
        workspaceEpoch: 7,
        leases: {},
        resourceLeases: { [tokenHash]: structuredClone(validRecord) },
      });
      const mutateRecord = (mutate: (record: Record<string, any>) => void) => {
        const registry = baseRegistry();
        mutate(registry.resourceLeases[tokenHash] as Record<string, any>);
        return registry;
      };
      const malformedCases: Array<[string, unknown]> = [
        ['resourceLeases array', { version: 1, workspaceEpoch: 7, leases: {}, resourceLeases: [] }],
        ['null record', { version: 1, workspaceEpoch: 7, leases: {}, resourceLeases: { [tokenHash]: null } }],
        ['missing field', mutateRecord(record => { delete record.heartbeatAt; })],
        ['unknown field', mutateRecord(record => { record.fence = 1; })],
        ['unsupported kind', mutateRecord(record => { record.kind = 'build'; })],
        ['empty resourceId', mutateRecord(record => { record.resourceId = ''; })],
        ['NUL resourceId', mutateRecord(record => { record.resourceId = 'generation\u0000a'; })],
        ['traversal resourceId', mutateRecord(record => { record.resourceId = '../generation'; })],
        ['empty owner', mutateRecord(record => { record.owner = ''; })],
        ['uppercase tokenHash', mutateRecord(record => { record.tokenHash = tokenHash.toUpperCase(); })],
        ['mismatched token fingerprint', mutateRecord(record => { record.tokenFingerprint = '0'.repeat(12); })],
        ['invalid state', mutateRecord(record => { record.state = 'EXPIRED'; })],
        ['noncanonical acquiredAt', mutateRecord(record => { record.acquiredAt = '2026-01-01'; })],
        ['heartbeat before acquire', mutateRecord(record => { record.heartbeatAt = '2025-01-01T00:00:00.000Z'; })],
        ['zero heartbeat sequence', mutateRecord(record => { record.heartbeatSequence = 0; })],
        ['unsafe heartbeat sequence', mutateRecord(record => { record.heartbeatSequence = Number.MAX_SAFE_INTEGER + 1; })],
        ['mismatched expiresAtMs', mutateRecord(record => { record.expiresAtMs += 1; })],
        ['expiry not after heartbeat', mutateRecord(record => {
          record.expiresAt = record.heartbeatAt;
          record.expiresAtMs = Date.parse(record.heartbeatAt);
        })],
        ['ACTIVE with releasedAt', mutateRecord(record => { record.releasedAt = '2026-01-01T00:00:02.000Z'; })],
        ['RELEASED without releasedAt', mutateRecord(record => { record.state = 'RELEASED'; })],
        ['RELEASED before heartbeat', mutateRecord(record => {
          record.state = 'RELEASED';
          record.releasedAt = '2026-01-01T00:00:00.500Z';
        })],
        ['dictionary key/hash mismatch', {
          version: 1,
          workspaceEpoch: 7,
          leases: {},
          resourceLeases: { ['0'.repeat(64)]: structuredClone(validRecord) },
        }],
        ['unknown top-level field', { ...baseRegistry(), resourceLeaseVersion: 2 }],
      ];

      for (const [caseName, registry] of malformedCases) {
        const root = makeRoot();
        const registryPath = writeLeaseRegistry(root, registry);
        const originalBytes = readFileSync(registryPath, 'utf8');

        const result = runLease(root, ['status']);

        expect.soft(result.status, `${caseName}: ${result.stderr || result.stdout}`).not.toBe(0);
        expect.soft(result.stdout, caseName).toBe('');
        expect.soft(readFileSync(registryPath, 'utf8'), caseName).toBe(originalBytes);
      }
    }, 10_000);

    it('authenticates exact READ credentials with at-least-once heartbeat retry renewal semantics', () => {
      const root = makeRoot();
      const token = readResourceToken('e');
      const tokenHash = readResourceTokenHash(token);
      const acquire = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-a',
        'Generation-A',
        token,
        ['--ttl-ms', '60000'],
      ));
      expect(acquire.status, acquire.stderr || acquire.stdout).toBe(0);
      const registryPath = leaseRegistryPath(root);
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      registry.resourceLeases[tokenHash].acquiredAt = '2026-01-01T00:00:00.000Z';
      registry.resourceLeases[tokenHash].heartbeatAt = '2026-01-01T00:00:01.000Z';
      registry.resourceLeases[tokenHash].expiresAt = '2999-01-01T00:00:00.000Z';
      registry.resourceLeases[tokenHash].expiresAtMs = Date.parse('2999-01-01T00:00:00.000Z');
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      const beforeRejected = readFileSync(registryPath, 'utf8');

      const rejectedArgs = [
        readResourceLeaseArgs('resource-lease-acquire', 'reader-b', 'Generation-A', token),
        readResourceLeaseArgs('resource-lease-acquire', 'reader-a', 'generation-a', token),
        readResourceLeaseArgs('resource-lease-heartbeat', 'reader-b', 'Generation-A', token),
        readResourceLeaseArgs('resource-lease-heartbeat', 'reader-a', 'generation-a', token),
        readResourceLeaseArgs('resource-lease-heartbeat', 'reader-a', 'Generation-A', readResourceToken('f')),
        readResourceLeaseArgs('resource-lease-release', 'reader-b', 'Generation-A', token),
        readResourceLeaseArgs('resource-lease-release', 'reader-a', 'generation-a', token),
        readResourceLeaseArgs('resource-lease-release', 'reader-a', 'Generation-A', readResourceToken('f')),
      ];
      for (const args of rejectedArgs) {
        const rejected = runLease(root, args);
        expect.soft(rejected.status, rejected.stderr || rejected.stdout).toBe(1);
        expect.soft(rejected.stdout).not.toContain(token);
        expect.soft(rejected.stdout).not.toContain(tokenHash);
        expect.soft(readFileSync(registryPath, 'utf8')).toBe(beforeRejected);
      }

      const heartbeat = runLease(root, readResourceLeaseArgs(
        'resource-lease-heartbeat',
        'reader-a',
        'Generation-A',
        token,
        ['--ttl-ms', '12345'],
      ));
      expect(heartbeat.status, heartbeat.stderr || heartbeat.stdout).toBe(0);
      const heartbeatReport = JSON.parse(heartbeat.stdout);
      expect(heartbeatReport.resourceLease).toEqual(expect.objectContaining({
        resourceId: 'Generation-A',
        heartbeatSequence: 2,
        state: 'ACTIVE',
      }));
      expect(heartbeatReport.workspaceEpoch).toBe(0);
      expect(heartbeatReport.fencingCounter).toBe(0);
      const renewed = JSON.parse(readFileSync(registryPath, 'utf8'));
      expect(renewed.workspaceEpoch).toBe(0);
      expect(renewed).not.toHaveProperty('fencingCounter');
      expect(renewed).not.toHaveProperty('barrier');
      expect(renewed.resourceLeases[tokenHash].acquiredAt).toBe('2026-01-01T00:00:00.000Z');
      expect(renewed.resourceLeases[tokenHash].heartbeatSequence).toBe(2);
      expect(renewed.resourceLeases[tokenHash].expiresAtMs).toBe(
        Date.parse(renewed.resourceLeases[tokenHash].heartbeatAt) + 12345,
      );
      expect(renewed.resourceLeases[tokenHash].expiresAt).toBe(
        new Date(renewed.resourceLeases[tokenHash].expiresAtMs).toISOString(),
      );
    });

    it('fails heartbeat overflow and every expired ACTIVE retry before mutation', () => {
      const root = makeRoot();
      const token = readResourceToken('a');
      const tokenHash = readResourceTokenHash(token);
      expect(runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-a',
        'generation-a',
        token,
      )).status).toBe(0);
      const registryPath = leaseRegistryPath(root);
      const overflowRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
      overflowRegistry.resourceLeases[tokenHash].heartbeatSequence = Number.MAX_SAFE_INTEGER;
      writeFileSync(registryPath, `${JSON.stringify(overflowRegistry, null, 2)}\n`);
      const overflowBytes = readFileSync(registryPath, 'utf8');

      const overflow = runLease(root, readResourceLeaseArgs(
        'resource-lease-heartbeat',
        'reader-a',
        'generation-a',
        token,
      ));
      expect(overflow.status).not.toBe(0);
      expect(overflow.stdout).toBe('');
      expect(overflow.stderr).toContain('heartbeat sequence');
      expect(readFileSync(registryPath, 'utf8')).toBe(overflowBytes);

      const expiredRegistry = structuredClone(overflowRegistry);
      expiredRegistry.resourceLeases[tokenHash].acquiredAt = '1970-01-01T00:00:00.000Z';
      expiredRegistry.resourceLeases[tokenHash].heartbeatAt = '1970-01-01T00:00:00.001Z';
      expiredRegistry.resourceLeases[tokenHash].heartbeatSequence = 1;
      expiredRegistry.resourceLeases[tokenHash].expiresAt = '1970-01-01T00:00:00.002Z';
      expiredRegistry.resourceLeases[tokenHash].expiresAtMs = 2;
      writeFileSync(registryPath, `${JSON.stringify(expiredRegistry, null, 2)}\n`);
      const expiredBytes = readFileSync(registryPath, 'utf8');

      for (const command of [
        'resource-lease-acquire',
        'resource-lease-heartbeat',
        'resource-lease-release',
      ] as const) {
        const expired = runLease(root, readResourceLeaseArgs(
          command,
          'reader-a',
          'generation-a',
          token,
        ));
        expect.soft(expired.status, expired.stderr || expired.stdout).toBe(1);
        expect.soft(JSON.parse(expired.stdout).reason).toBe('resource-lease-expired');
        expect.soft(readFileSync(registryPath, 'utf8')).toBe(expiredBytes);
      }
    });

    it('supports concurrent independent readers and serializes a shared caller token to one record', async () => {
      const root = makeRoot();
      const sharedToken = readResourceToken('a');
      const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (
        readResourceAcquireWithLockRetry(root, 'reader-a', 'generation-a', sharedToken)
          .then(result => ({ index, result }))
      )));
      const reports = results.map(({ result }) => {
        expect(result.status, result.stderr || result.stdout).toBe(0);
        return JSON.parse(result.stdout);
      });
      expect(reports.filter(report => report.acquired === true)).toHaveLength(1);
      expect(reports.filter(report => report.idempotent === true)).toHaveLength(11);
      const registryPath = leaseRegistryPath(root);
      const sharedRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
      expect(Object.keys(sharedRegistry.resourceLeases)).toEqual([readResourceTokenHash(sharedToken)]);
      expect(sharedRegistry.workspaceEpoch).toBe(0);

      const independent = [
        ['reader-a', 'generation-a', readResourceToken('b')],
        ['reader-b', 'generation-a', readResourceToken('c')],
        ['reader-a', 'generation-b', readResourceToken('d')],
      ] as const;
      for (const [owner, resourceId, token] of independent) {
        const result = runLease(root, readResourceLeaseArgs(
          'resource-lease-acquire',
          owner,
          resourceId,
          token,
        ));
        expect(result.status, result.stderr || result.stdout).toBe(0);
      }
      const finalRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
      expect(Object.keys(finalRegistry.resourceLeases)).toHaveLength(4);
      expect(finalRegistry.workspaceEpoch).toBe(0);
    });

    it('projects and preserves expired ACTIVE/RELEASED tombstones through generic prune and stale retries', () => {
      const tokens = {
        active: readResourceToken('a'),
        released: readResourceToken('b'),
        expiredActive: readResourceToken('c'),
        expiredReleased: readResourceToken('d'),
      };
      const entries = {
        [readResourceTokenHash(tokens.active)]: storedReadResourceLease(tokens.active, {
          resourceId: 'active-generation',
        }),
        [readResourceTokenHash(tokens.released)]: storedReadResourceLease(tokens.released, {
          resourceId: 'released-generation',
          state: 'RELEASED',
          releasedAt: '2026-01-01T00:00:02.000Z',
        }),
        [readResourceTokenHash(tokens.expiredActive)]: storedReadResourceLease(tokens.expiredActive, {
          resourceId: 'expired-active-generation',
          acquiredAt: '1970-01-01T00:00:00.000Z',
          heartbeatAt: '1970-01-01T00:00:00.001Z',
          expiresAt: '1970-01-01T00:00:00.002Z',
          expiresAtMs: 2,
        }),
        [readResourceTokenHash(tokens.expiredReleased)]: storedReadResourceLease(tokens.expiredReleased, {
          resourceId: 'expired-released-generation',
          state: 'RELEASED',
          acquiredAt: '1970-01-01T00:00:00.000Z',
          heartbeatAt: '1970-01-01T00:00:00.001Z',
          expiresAt: '1970-01-01T00:00:00.003Z',
          expiresAtMs: 3,
          releasedAt: '1970-01-01T00:00:00.002Z',
        }),
      };
      const root = makeRoot();
      const registryPath = writeLeaseRegistry(root, {
        version: 1,
        workspaceEpoch: 9,
        fencingCounter: 0,
        leases: {},
        resourceLeases: entries,
      });
      const beforeStatus = readFileSync(registryPath, 'utf8');

      const status = runLease(root, ['status']);
      expect(status.status, status.stderr || status.stdout).toBe(0);
      const report = JSON.parse(status.stdout);
      expect(report.resourceLeases.active).toEqual([
        expect.objectContaining({ resourceId: 'active-generation', state: 'ACTIVE' }),
      ]);
      expect(report.resourceLeases.released).toEqual([
        expect.objectContaining({ resourceId: 'released-generation', state: 'RELEASED' }),
      ]);
      expect(report.resourceLeases.expired).toEqual([
        expect.objectContaining({ resourceId: 'expired-active-generation', state: 'ACTIVE' }),
        expect.objectContaining({ resourceId: 'expired-released-generation', state: 'RELEASED' }),
      ]);
      for (const projection of [
        ...report.resourceLeases.active,
        ...report.resourceLeases.released,
        ...report.resourceLeases.expired,
      ]) {
        expect(Object.keys(projection).sort()).toEqual([
          'acquiredAt',
          'barrierOwner',
          'barrierTokenFingerprint',
          'expiresAt',
          'expiresAtMs',
          'fence',
          'heartbeatAt',
          'heartbeatSequence',
          'heldEpoch',
          'kind',
          'owner',
          'releasedAt',
          'resourceId',
          'state',
          'tokenFingerprint',
        ]);
        expect(projection).not.toHaveProperty('tokenHash');
        expect(projection).toEqual(expect.objectContaining({
          barrierOwner: null,
          barrierTokenFingerprint: null,
          fence: null,
          heldEpoch: null,
        }));
      }
      expect(readFileSync(registryPath, 'utf8')).toBe(beforeStatus);

      const prune = runLease(root, ['prune']);
      expect(prune.status, prune.stderr || prune.stdout).toBe(0);
      const pruneReport = JSON.parse(prune.stdout);
      expect(pruneReport).toEqual(expect.objectContaining({
        workspaceEpoch: 9,
        resourcePruned: 0,
      }));
      const pruned = JSON.parse(readFileSync(registryPath, 'utf8'));
      expect(pruned.workspaceEpoch).toBe(9);
      expect(pruned.fencingCounter).toBe(0);
      expect(pruned.resourceLeases).toEqual(entries);
      const tombstoneBytes = readFileSync(registryPath, 'utf8');

      const expiredActiveRetries = [
        ['resource-lease-acquire', tokens.expiredActive],
        ['resource-lease-heartbeat', tokens.expiredActive.toUpperCase()],
        ['resource-lease-release', tokens.expiredActive],
      ] as const;
      for (const [command, token] of expiredActiveRetries) {
        const retry = runLease(root, readResourceLeaseArgs(
          command,
          'reader-a',
          'expired-active-generation',
          token,
        ));
        expect.soft(retry.status, `${command}: ${retry.stderr || retry.stdout}`).toBe(1);
        expect.soft(JSON.parse(retry.stdout).reason, command).toBe('resource-lease-expired');
        expect.soft(readFileSync(registryPath, 'utf8'), command).toBe(tombstoneBytes);
      }

      const expiredReleasedRetries = [
        ['resource-lease-acquire', tokens.expiredReleased.toUpperCase()],
        ['resource-lease-heartbeat', tokens.expiredReleased],
        ['resource-lease-release', tokens.expiredReleased.toUpperCase()],
      ] as const;
      for (const [command, token] of expiredReleasedRetries) {
        const retry = runLease(root, readResourceLeaseArgs(
          command,
          'reader-a',
          'expired-released-generation',
          token,
        ));
        const body = JSON.parse(retry.stdout);
        expect.soft(body.resourceLease?.state, command).toBe('RELEASED');
        expect.soft(readFileSync(registryPath, 'utf8'), command).toBe(tombstoneBytes);
      }

      const successorToken = readResourceToken('e');
      const successor = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-a',
        'expired-active-generation',
        successorToken,
      ));
      expect(successor.status, successor.stderr || successor.stdout).toBe(0);
      expect(JSON.parse(successor.stdout)).toEqual(expect.objectContaining({
        acquired: true,
        idempotent: false,
      }));
      const withSuccessor = JSON.parse(readFileSync(registryPath, 'utf8'));
      for (const token of [tokens.expiredActive, tokens.expiredReleased]) {
        const tokenHash = readResourceTokenHash(token);
        expect(withSuccessor.resourceLeases[tokenHash]).toEqual(entries[tokenHash]);
      }
      expect(withSuccessor.resourceLeases[readResourceTokenHash(successorToken)]).toEqual(
        expect.objectContaining({ state: 'ACTIVE' }),
      );
    });

    it.each(['OPEN', 'CLOSING', 'WAITING', 'HELD', 'RELEASED'] as const)(
      'allows READ resource lifecycle in %s without changing barrier, fence, or epoch',
      barrierState => {
        const root = makeRoot();
        const barrierToken = readResourceToken('f');
        if (barrierState === 'CLOSING' || barrierState === 'WAITING') {
          expect(runLease(root, ['claim', '--owner', 'writer-a', 'held.ts']).status).toBe(0);
          expect(runLease(root, [
            'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', barrierToken,
          ]).status).toBe(0);
          if (barrierState === 'CLOSING') {
            const registryPath = leaseRegistryPath(root);
            const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
            registry.barrier.state = 'CLOSING';
            registry.barrier.transitions = registry.barrier.transitions.slice(0, 1);
            writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
          }
        } else if (barrierState === 'HELD' || barrierState === 'RELEASED') {
          expect(runLease(root, [
            'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', barrierToken,
          ]).status).toBe(0);
          if (barrierState === 'RELEASED') {
            expect(runLease(root, [
              'barrier-release', '--owner', 'barrier-a', '--barrier-token', barrierToken,
            ]).status).toBe(0);
          }
        }
        const before = JSON.parse(runLease(root, ['status']).stdout);
        expect(before.barrier.state).toBe(barrierState);
        const token = readResourceToken('a');
        for (const command of [
          'resource-lease-acquire',
          'resource-lease-heartbeat',
          'resource-lease-release',
        ] as const) {
          const result = runLease(root, readResourceLeaseArgs(
            command,
            'reader-a',
            `generation-${barrierState}`,
            token,
          ));
          expect(result.status, result.stderr || result.stdout).toBe(0);
        }
        const after = JSON.parse(runLease(root, ['status']).stdout);
        expect(after.workspaceEpoch).toBe(before.workspaceEpoch);
        expect(after.fencingCounter).toBe(before.fencingCounter);
        expect(after.barrier).toEqual(before.barrier);
        expect(after.resourceLeases.released).toEqual([
          expect.objectContaining({
            resourceId: `generation-${barrierState}`,
            state: 'RELEASED',
          }),
        ]);
      },
    );

    it('does not block barrier acquisition or release while an ACTIVE READ resource lease exists', () => {
      const root = makeRoot();
      const resourceToken = readResourceToken('a');
      const resourceAcquire = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-a',
        'generation-a',
        resourceToken,
      ));
      expect(resourceAcquire.status, resourceAcquire.stderr || resourceAcquire.stdout).toBe(0);

      const barrierToken = readResourceToken('b');
      const barrierAcquire = runLease(root, [
        'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', barrierToken,
      ]);
      expect(barrierAcquire.status, barrierAcquire.stderr || barrierAcquire.stdout).toBe(0);
      expect(JSON.parse(barrierAcquire.stdout).barrier).toEqual(expect.objectContaining({
        state: 'HELD',
        heldEpoch: 0,
        fence: 1,
      }));
      const heldStatus = JSON.parse(runLease(root, ['status']).stdout);
      expect(heldStatus.resourceLeases.active).toEqual([
        expect.objectContaining({ resourceId: 'generation-a', state: 'ACTIVE' }),
      ]);

      const barrierRelease = runLease(root, [
        'barrier-release', '--owner', 'barrier-a', '--barrier-token', barrierToken,
      ]);
      expect(barrierRelease.status, barrierRelease.stderr || barrierRelease.stdout).toBe(0);
      const releasedStatus = JSON.parse(runLease(root, ['status']).stdout);
      expect(releasedStatus.barrier.state).toBe('RELEASED');
      expect(releasedStatus.resourceLeases.active).toEqual(heldStatus.resourceLeases.active);
    });

    it('keeps complete old/new resource snapshots across commit crashes and reconciles caller-token retries', async () => {
      const oldRoot = makeRoot();
      const oldRegistryPath = writeLeaseRegistry(oldRoot, {
        version: 1,
        workspaceEpoch: 7,
        leases: {},
      });
      const oldBytes = readFileSync(oldRegistryPath, 'utf8');
      const oldToken = readResourceToken('a');
      const preCommitCrash = await crashCommandBeforeCommit(
        oldRoot,
        readResourceLeaseArgs('resource-lease-acquire', 'reader-old', 'generation-old', oldToken),
        'resource-lease-pre-commit',
      );
      expect(preCommitCrash.status === null || preCommitCrash.status !== 0).toBe(true);
      expect(preCommitCrash.stdout).toBe('');
      expect(readFileSync(oldRegistryPath, 'utf8')).toBe(oldBytes);
      const preparedTemps = readdirSync(path.dirname(oldRegistryPath)).filter(entry => entry.endsWith('.tmp'));
      expect(preparedTemps).toHaveLength(1);
      const prepared = JSON.parse(readFileSync(path.join(path.dirname(oldRegistryPath), preparedTemps[0]), 'utf8'));
      expect(prepared.workspaceEpoch).toBe(7);
      expect(prepared.resourceLeases[readResourceTokenHash(oldToken)]).toEqual(expect.objectContaining({
        resourceId: 'generation-old',
        state: 'ACTIVE',
      }));
      await new Promise(resolve => setTimeout(resolve, 5));
      const oldReclaimer = spawnStaleWorker(oldRoot, 'contender', {
        NANOFLOW_LEASE_TEST_STALE_AFTER_MS: '1',
      });
      const oldReclaimResult = await oldReclaimer.completion;
      expect(oldReclaimResult.status, oldReclaimResult.stderr || oldReclaimResult.stdout).toBe(0);
      const oldRetry = runLease(oldRoot, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-old',
        'generation-old',
        oldToken,
      ));
      expect(oldRetry.status, oldRetry.stderr || oldRetry.stdout).toBe(0);
      expect(JSON.parse(oldRetry.stdout).acquired).toBe(true);

      const newRoot = makeRoot();
      const newRegistryPath = writeLeaseRegistry(newRoot, {
        version: 1,
        workspaceEpoch: 7,
        leases: {},
      });
      const newToken = readResourceToken('b');
      const postCommitCrash = await crashCommandAfterCommit(
        newRoot,
        readResourceLeaseArgs('resource-lease-acquire', 'reader-new', 'generation-new', newToken),
        'resource-lease-post-commit',
      );
      expect(postCommitCrash.status === null || postCommitCrash.status !== 0).toBe(true);
      const committedBytes = readFileSync(newRegistryPath, 'utf8');
      const committed = JSON.parse(committedBytes);
      expect(committed.workspaceEpoch).toBe(7);
      expect(committed.resourceLeases[readResourceTokenHash(newToken)]).toEqual(expect.objectContaining({
        resourceId: 'generation-new',
        state: 'ACTIVE',
      }));
      await new Promise(resolve => setTimeout(resolve, 5));
      const newReclaimer = spawnStaleWorker(newRoot, 'contender', {
        NANOFLOW_LEASE_TEST_STALE_AFTER_MS: '1',
      });
      const newReclaimResult = await newReclaimer.completion;
      expect(newReclaimResult.status, newReclaimResult.stderr || newReclaimResult.stdout).toBe(0);
      const newRetry = runLease(newRoot, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-new',
        'generation-new',
        newToken,
      ));
      expect(newRetry.status, newRetry.stderr || newRetry.stdout).toBe(0);
      expect(JSON.parse(newRetry.stdout)).toEqual(expect.objectContaining({
        acquired: false,
        idempotent: true,
      }));
      expect(readFileSync(newRegistryPath, 'utf8')).toBe(committedBytes);

      const releasedRoot = makeRoot();
      const releasedToken = readResourceToken('c');
      expect(runLease(releasedRoot, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-released',
        'generation-released',
        releasedToken,
      )).status).toBe(0);
      const releasedRegistryPath = leaseRegistryPath(releasedRoot);
      const releaseCrash = await crashCommandAfterCommit(
        releasedRoot,
        readResourceLeaseArgs('resource-lease-release', 'reader-released', 'generation-released', releasedToken),
        'resource-lease-release-post-commit',
      );
      expect(releaseCrash.status === null || releaseCrash.status !== 0).toBe(true);
      const releaseCommittedBytes = readFileSync(releasedRegistryPath, 'utf8');
      expect(JSON.parse(releaseCommittedBytes).resourceLeases[readResourceTokenHash(releasedToken)].state).toBe('RELEASED');
      await new Promise(resolve => setTimeout(resolve, 5));
      const releaseReclaimer = spawnStaleWorker(releasedRoot, 'contender', {
        NANOFLOW_LEASE_TEST_STALE_AFTER_MS: '1',
      });
      const releaseReclaimResult = await releaseReclaimer.completion;
      expect(releaseReclaimResult.status, releaseReclaimResult.stderr || releaseReclaimResult.stdout).toBe(0);
      const releaseRetry = runLease(releasedRoot, readResourceLeaseArgs(
        'resource-lease-release',
        'reader-released',
        'generation-released',
        releasedToken,
      ));
      expect(releaseRetry.status, releaseRetry.stderr || releaseRetry.stdout).toBe(0);
      expect(JSON.parse(releaseRetry.stdout).idempotent).toBe(true);
      expect(readFileSync(releasedRegistryPath, 'utf8')).toBe(releaseCommittedBytes);
    });
  });

  describe('BUILD resource leases', () => {
    function acquireHeldBarrier(root: string, owner: string, token: string) {
      const result = runLease(root, [
        'barrier-acquire', '--owner', owner, '--barrier-token', token,
      ]);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.barrier.state).toBe('HELD');
      return report;
    }

    it('binds BUILD lifecycle to the current HELD barrier without epoch, fence, or secret drift', () => {
      const root = makeRoot();
      const barrierOwner = 'builder-a';
      const rawBarrierToken = readResourceToken('A');
      const barrierToken = rawBarrierToken.toLowerCase();
      const held = acquireHeldBarrier(root, barrierOwner, rawBarrierToken);
      const beforeResource = JSON.parse(runLease(root, ['status']).stdout);

      const acquired = runLease(root, buildResourceLeaseArgs(
        'resource-lease-acquire',
        barrierOwner,
        'generation-build-a',
        rawBarrierToken,
        ['--ttl-ms', '60000'],
      ));
      expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
      const acquiredReport = JSON.parse(acquired.stdout);
      expect(acquiredReport).toEqual(expect.objectContaining({
        acquired: true,
        idempotent: false,
        workspaceEpoch: beforeResource.workspaceEpoch,
        fencingCounter: beforeResource.fencingCounter,
      }));
      expect(acquiredReport.barrier).toEqual(beforeResource.barrier);
      expect(acquiredReport.resourceLease).toEqual(expect.objectContaining({
        kind: 'build',
        resourceId: 'generation-build-a',
        owner: barrierOwner,
        barrierOwner,
        barrierTokenFingerprint: held.barrier.tokenFingerprint,
        fence: held.barrier.fence,
        heldEpoch: held.barrier.heldEpoch,
        state: 'ACTIVE',
        heartbeatSequence: 1,
      }));
      expect(acquiredReport.resourceLease).not.toHaveProperty('tokenHash');
      expect(acquired.stdout).not.toContain(rawBarrierToken);
      expect(acquired.stdout).not.toContain(barrierToken);

      const registryPath = leaseRegistryPath(root);
      const acquiredBytes = readFileSync(registryPath, 'utf8');
      const acquiredRegistry = JSON.parse(acquiredBytes);
      const buildTokenHash = readResourceTokenHash(barrierToken);
      expect(acquiredRegistry.resourceLeases[buildTokenHash]).toEqual(expect.objectContaining({
        kind: 'build',
        barrierOwner,
        barrierTokenFingerprint: held.barrier.tokenFingerprint,
        fence: held.barrier.fence,
        heldEpoch: held.barrier.heldEpoch,
      }));
      expect(acquiredBytes).not.toContain(rawBarrierToken);
      expect(acquiredBytes).not.toContain(barrierToken);

      const replay = runLease(root, buildResourceLeaseArgs(
        'resource-lease-acquire',
        barrierOwner,
        'generation-build-a',
        barrierToken,
        ['--ttl-ms', '1'],
      ));
      expect(replay.status, replay.stderr || replay.stdout).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual(expect.objectContaining({
        acquired: false,
        idempotent: true,
      }));
      expect(readFileSync(registryPath, 'utf8')).toBe(acquiredBytes);

      const heartbeat = runLease(root, buildResourceLeaseArgs(
        'resource-lease-heartbeat',
        barrierOwner,
        'generation-build-a',
        barrierToken,
        ['--ttl-ms', '12345'],
      ));
      expect(heartbeat.status, heartbeat.stderr || heartbeat.stdout).toBe(0);
      const heartbeatReport = JSON.parse(heartbeat.stdout);
      expect(heartbeatReport.resourceLease).toEqual(expect.objectContaining({
        heartbeatSequence: 2,
        barrierOwner,
        barrierTokenFingerprint: held.barrier.tokenFingerprint,
        fence: held.barrier.fence,
        heldEpoch: held.barrier.heldEpoch,
      }));
      expect(heartbeatReport.workspaceEpoch).toBe(beforeResource.workspaceEpoch);
      expect(heartbeatReport.fencingCounter).toBe(beforeResource.fencingCounter);
      expect(heartbeatReport.barrier).toEqual(beforeResource.barrier);

      const readToken = readResourceToken('c');
      const readAcquire = runLease(root, readResourceLeaseArgs(
        'resource-lease-acquire',
        'reader-during-build',
        'generation-read-during-build',
        readToken,
      ));
      expect(readAcquire.status, readAcquire.stderr || readAcquire.stdout).toBe(0);
      expect(JSON.parse(readAcquire.stdout).resourceLease).toEqual(expect.objectContaining({
        barrierOwner: null,
        barrierTokenFingerprint: null,
        fence: null,
        heldEpoch: null,
      }));

      const beforeBlockedRelease = readFileSync(registryPath, 'utf8');
      const blockedRelease = runLease(root, [
        'barrier-release', '--owner', barrierOwner, '--barrier-token', barrierToken,
      ]);
      expect(blockedRelease.status).toBe(1);
      const blockedReport = JSON.parse(blockedRelease.stdout);
      expect(blockedReport.reason).toBe('active-build-resource-leases');
      expect(blockedReport.blockers).toEqual([
        expect.objectContaining({
          kind: 'build',
          resourceId: 'generation-build-a',
          barrierOwner,
          fence: held.barrier.fence,
          heldEpoch: held.barrier.heldEpoch,
          state: 'ACTIVE',
        }),
      ]);
      expect(blockedRelease.stdout).not.toContain(barrierToken);
      expect(blockedRelease.stdout).not.toContain(readToken);
      expect(readFileSync(registryPath, 'utf8')).toBe(beforeBlockedRelease);

      const pruned = runLease(root, ['prune']);
      expect(pruned.status, pruned.stderr || pruned.stdout).toBe(0);
      expect(JSON.parse(pruned.stdout)).toEqual(expect.objectContaining({
        workspaceEpoch: beforeResource.workspaceEpoch,
        resourcePruned: 0,
      }));
      expect(JSON.parse(pruned.stdout).resourceLeases.active).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'build', resourceId: 'generation-build-a' }),
      ]));

      const released = runLease(root, buildResourceLeaseArgs(
        'resource-lease-release',
        barrierOwner,
        'generation-build-a',
        barrierToken,
      ));
      expect(released.status, released.stderr || released.stdout).toBe(0);
      expect(JSON.parse(released.stdout)).toEqual(expect.objectContaining({
        released: true,
        idempotent: false,
        workspaceEpoch: beforeResource.workspaceEpoch,
        fencingCounter: beforeResource.fencingCounter,
      }));
      const releasedBytes = readFileSync(registryPath, 'utf8');
      const releaseRetry = runLease(root, buildResourceLeaseArgs(
        'resource-lease-release',
        barrierOwner,
        'generation-build-a',
        barrierToken,
      ));
      expect(releaseRetry.status, releaseRetry.stderr || releaseRetry.stdout).toBe(0);
      expect(JSON.parse(releaseRetry.stdout).idempotent).toBe(true);
      expect(readFileSync(registryPath, 'utf8')).toBe(releasedBytes);

      const barrierRelease = runLease(root, [
        'barrier-release', '--owner', barrierOwner, '--barrier-token', barrierToken,
      ]);
      expect(barrierRelease.status, barrierRelease.stderr || barrierRelease.stdout).toBe(0);
      const finalStatus = JSON.parse(runLease(root, ['status']).stdout);
      expect(finalStatus.barrier.state).toBe('RELEASED');
      expect(finalStatus.workspaceEpoch).toBe(beforeResource.workspaceEpoch);
      expect(finalStatus.fencingCounter).toBe(beforeResource.fencingCounter);
      expect(finalStatus.resourceLeases.active).toEqual([
        expect.objectContaining({ kind: 'read', resourceId: 'generation-read-during-build' }),
      ]);
      expect(finalStatus.resourceLeases.released).toEqual([
        expect.objectContaining({ kind: 'build', resourceId: 'generation-build-a' }),
      ]);
    }, 15_000);

    it.each(['OPEN', 'CLOSING', 'WAITING', 'RELEASED'] as const)(
      'rejects BUILD admission while the barrier is %s without registry mutation',
      barrierState => {
        const root = makeRoot();
        const barrierOwner = 'builder-state';
        const barrierToken = readResourceToken('a');
        if (barrierState === 'CLOSING' || barrierState === 'WAITING') {
          expect(runLease(root, ['claim', '--owner', 'writer-state', 'held.ts']).status).toBe(0);
          const barrierAcquire = runLease(root, [
            'barrier-acquire', '--owner', barrierOwner, '--barrier-token', barrierToken,
          ]);
          expect(barrierAcquire.status, barrierAcquire.stderr || barrierAcquire.stdout).toBe(0);
          expect(JSON.parse(barrierAcquire.stdout).barrier.state).toBe('WAITING');
          if (barrierState === 'CLOSING') {
            const registryPath = leaseRegistryPath(root);
            const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
            registry.barrier.state = 'CLOSING';
            registry.barrier.transitions = registry.barrier.transitions.slice(0, 1);
            writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
          }
        } else if (barrierState === 'RELEASED') {
          acquireHeldBarrier(root, barrierOwner, barrierToken);
          expect(runLease(root, [
            'barrier-release', '--owner', barrierOwner, '--barrier-token', barrierToken,
          ]).status).toBe(0);
        }
        const registryPath = leaseRegistryPath(root);
        const before = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null;

        const rejected = runLease(root, buildResourceLeaseArgs(
          'resource-lease-acquire',
          barrierOwner,
          `generation-${barrierState}`,
          barrierToken,
        ));
        expect(rejected.status).toBe(1);
        const report = JSON.parse(rejected.stdout);
        expect(report.reason).toBe('build-resource-barrier-not-held');
        expect(report.barrier.state).toBe(barrierState);
        if (barrierState === 'CLOSING' || barrierState === 'WAITING') {
          expect(report.barrier).toEqual(expect.objectContaining({ heldEpoch: null, fence: null }));
        }
        expect(existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null).toBe(before);
      },
    );

    it('fails closed when RELEASED barrier state is observed with an unexpired ACTIVE BUILD blocker', () => {
      const root = makeRoot();
      const barrierOwner = 'builder-released-invariant';
      const barrierToken = readResourceToken('a');
      acquireHeldBarrier(root, barrierOwner, barrierToken);
      expect(runLease(root, buildResourceLeaseArgs(
        'resource-lease-acquire',
        barrierOwner,
        'generation-released-invariant',
        barrierToken,
      )).status).toBe(0);
      const registryPath = leaseRegistryPath(root);
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const releasedAt = registry.barrier.heartbeatAt;
      registry.barrier.transitions.push({
        state: 'RELEASED',
        at: releasedAt,
        sequence: registry.barrier.transitions.length + 1,
      });
      registry.barrier.state = 'RELEASED';
      registry.barrier.releasedAt = releasedAt;
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      const malformedBytes = readFileSync(registryPath, 'utf8');

      const rejected = runLease(root, [
        'barrier-release', '--owner', barrierOwner, '--barrier-token', barrierToken,
      ]);
      expect(rejected.status).toBe(1);
      expect(JSON.parse(rejected.stdout)).toEqual(expect.objectContaining({
        reason: 'active-build-resource-leases',
        blockers: [expect.objectContaining({
          kind: 'build',
          resourceId: 'generation-released-invariant',
          state: 'ACTIVE',
        })],
      }));
      expect(readFileSync(registryPath, 'utf8')).toBe(malformedBytes);
    });

    it.each([
      ['resource-lease-acquire', 'build'],
      ['resource-lease-heartbeat', 'read'],
      ['resource-lease-release', 'build'],
    ] as const)('rejects --barrier-token argv bearer injection for %s %s without mutation', (command, kind) => {
      const root = makeRoot();
      const owner = kind === 'build' ? 'builder-barrier-argv-rejected' : 'reader-barrier-argv-rejected';
      const resourceId = `generation-${kind}-barrier-argv-rejected`;
      const resourceToken = readResourceToken(kind === 'build' ? 'a' : 'c');
      const argvBearerToken = readResourceToken('f');
      if (kind === 'build') acquireHeldBarrier(root, owner, resourceToken);
      if (command !== 'resource-lease-acquire') {
        const acquireArgs = kind === 'build'
          ? buildResourceLeaseArgs('resource-lease-acquire', owner, resourceId, resourceToken)
          : readResourceLeaseArgs('resource-lease-acquire', owner, resourceId, resourceToken);
        const acquired = runLease(root, acquireArgs);
        expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
      }
      const registryPath = leaseRegistryPath(root);
      const before = readFileSync(registryPath, 'utf8');
      const commandArgs = kind === 'build'
        ? buildResourceLeaseArgs(command, owner, resourceId, resourceToken, [
          '--barrier-token', argvBearerToken,
        ])
        : readResourceLeaseArgs(command, owner, resourceId, resourceToken, [
          '--barrier-token', argvBearerToken,
        ]);

      const rejected = runLease(root, commandArgs);

      expect.soft(rejected.status).not.toBe(0);
      expect.soft(rejected.stdout).toBe('');
      expect.soft(rejected.stderr).toContain('--barrier-token is only supported for barrier commands');
      expect.soft(rejected.stderr).not.toContain(resourceToken);
      expect.soft(rejected.stderr).not.toContain(argvBearerToken);
      expect.soft(readFileSync(registryPath, 'utf8')).toBe(before);
    });

    it('continues rejecting --barrier-token-stdin on resource commands without reading or mutating capability state', () => {
      const root = makeRoot();
      const owner = 'builder-barrier-stdin-rejected';
      const barrierToken = readResourceToken('a');
      acquireHeldBarrier(root, owner, barrierToken);
      const registryPath = leaseRegistryPath(root);
      const before = readFileSync(registryPath, 'utf8');

      const rejected = runLease(root, buildResourceLeaseArgs(
        'resource-lease-acquire',
        owner,
        'generation-barrier-stdin-rejected',
        barrierToken,
        ['--barrier-token-stdin'],
      ));

      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).toContain('--barrier-token-stdin is only supported for barrier acquisition');
      expect(rejected.stderr).not.toContain(barrierToken);
      expect(readFileSync(registryPath, 'utf8')).toBe(before);
    });

    it('rejects wrong BUILD owner, token, argv bearer, and oversized stdin before mutation or disclosure', () => {
      const root = makeRoot();
      const barrierOwner = 'builder-auth';
      const barrierToken = readResourceToken('a');
      acquireHeldBarrier(root, barrierOwner, barrierToken);
      const registryPath = leaseRegistryPath(root);
      const heldBytes = readFileSync(registryPath, 'utf8');

      for (const args of [
        buildResourceLeaseArgs('resource-lease-acquire', 'builder-wrong', 'generation-auth', barrierToken),
        buildResourceLeaseArgs('resource-lease-acquire', barrierOwner, 'generation-auth', readResourceToken('b')),
      ]) {
        const rejected = runLease(root, args);
        expect.soft(rejected.status).toBe(1);
        expect.soft(JSON.parse(rejected.stdout).reason).toBe('build-resource-barrier-authentication-failed');
        expect.soft(rejected.stdout).not.toContain(barrierToken);
        expect.soft(readFileSync(registryPath, 'utf8')).toBe(heldBytes);
      }

      const argvRejected = runLease(root, [
        'resource-lease-acquire',
        '--owner', barrierOwner,
        '--resource-kind', 'build',
        '--resource-id', 'generation-auth',
        '--resource-token', barrierToken,
      ]);
      expect(argvRejected.status).not.toBe(0);
      expect(argvRejected.stdout).toBe('');
      expect(argvRejected.stderr).toContain('--resource-token');
      expect(argvRejected.stderr).not.toContain(barrierToken);
      expect(readFileSync(registryPath, 'utf8')).toBe(heldBytes);

      const oversized = runLease(root, [
        'resource-lease-acquire',
        '--owner', barrierOwner,
        '--resource-kind', 'build',
        '--resource-id', 'generation-auth',
        '--resource-token-stdin',
      ], { input: `${barrierToken}0\r\n` });
      expect(oversized.status).not.toBe(0);
      expect(oversized.stdout).toBe('');
      expect(oversized.stderr).toContain('resource token stdin');
      expect(oversized.stderr).not.toContain(barrierToken);
      expect(readFileSync(registryPath, 'utf8')).toBe(heldBytes);
    });

    it('keeps expired ACTIVE BUILD tombstones terminal and non-blocking', () => {
      const root = makeRoot();
      const barrierOwner = 'builder-expired';
      const barrierToken = readResourceToken('a');
      acquireHeldBarrier(root, barrierOwner, barrierToken);
      expect(runLease(root, buildResourceLeaseArgs(
        'resource-lease-acquire', barrierOwner, 'generation-expired', barrierToken,
      )).status).toBe(0);
      const registryPath = leaseRegistryPath(root);
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const record = registry.resourceLeases[readResourceTokenHash(barrierToken)];
      record.acquiredAt = '1970-01-01T00:00:00.000Z';
      record.heartbeatAt = '1970-01-01T00:00:00.001Z';
      record.heartbeatSequence = 1;
      record.expiresAt = '1970-01-01T00:00:00.002Z';
      record.expiresAtMs = 2;
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      const expiredBytes = readFileSync(registryPath, 'utf8');

      for (const command of [
        'resource-lease-acquire',
        'resource-lease-heartbeat',
        'resource-lease-release',
      ] as const) {
        const terminal = runLease(root, buildResourceLeaseArgs(
          command, barrierOwner, 'generation-expired', barrierToken,
        ));
        expect.soft(terminal.status).toBe(1);
        expect.soft(JSON.parse(terminal.stdout).reason).toBe('resource-lease-expired');
        expect.soft(readFileSync(registryPath, 'utf8')).toBe(expiredBytes);
      }

      const pruned = runLease(root, ['prune']);
      expect(pruned.status, pruned.stderr || pruned.stdout).toBe(0);
      expect(JSON.parse(pruned.stdout).resourcePruned).toBe(0);
      expect(JSON.parse(pruned.stdout).resourceLeases.expired).toEqual([
        expect.objectContaining({ kind: 'build', resourceId: 'generation-expired', state: 'ACTIVE' }),
      ]);
      const releasedBarrier = runLease(root, [
        'barrier-release', '--owner', barrierOwner, '--barrier-token', barrierToken,
      ]);
      expect(releasedBarrier.status, releasedBarrier.stderr || releasedBarrier.stdout).toBe(0);
      expect(JSON.parse(releasedBarrier.stdout).barrier.state).toBe('RELEASED');
    });

    it('rejects old BUILD capability reuse against a successor barrier without mutating successor state', () => {
      const root = makeRoot();
      const barrierOwner = 'builder-successor';
      const oldToken = readResourceToken('a');
      const successorToken = readResourceToken('b');
      const unknownToken = readResourceToken('c');
      const oldHeld = acquireHeldBarrier(root, barrierOwner, oldToken);
      expect(runLease(root, buildResourceLeaseArgs(
        'resource-lease-acquire', barrierOwner, 'generation-old', oldToken,
      )).status).toBe(0);
      expect(runLease(root, buildResourceLeaseArgs(
        'resource-lease-release', barrierOwner, 'generation-old', oldToken,
      )).status).toBe(0);
      expect(runLease(root, [
        'barrier-release', '--owner', barrierOwner, '--barrier-token', oldToken,
      ]).status).toBe(0);
      const successorHeld = acquireHeldBarrier(root, barrierOwner, successorToken);
      expect(successorHeld.barrier.fence).toBe(oldHeld.barrier.fence + 1);
      const registryPath = leaseRegistryPath(root);
      const successorBytes = readFileSync(registryPath, 'utf8');

      for (const command of [
        'resource-lease-acquire',
        'resource-lease-heartbeat',
        'resource-lease-release',
      ] as const) {
        const stale = runLease(root, buildResourceLeaseArgs(
          command, barrierOwner, 'generation-old', oldToken,
        ));
        expect.soft(stale.status).toBe(1);
        expect.soft(JSON.parse(stale.stdout).reason).toBe('build-resource-barrier-binding-stale');
        expect.soft(readFileSync(registryPath, 'utf8')).toBe(successorBytes);
      }

      for (const command of [
        'resource-lease-acquire',
        'resource-lease-heartbeat',
        'resource-lease-release',
      ] as const) {
        const wrong = runLease(root, buildResourceLeaseArgs(
          command, barrierOwner, 'generation-successor', unknownToken,
        ));
        expect.soft(wrong.status).toBe(1);
        expect.soft(JSON.parse(wrong.stdout).reason).toBe('build-resource-barrier-authentication-failed');
        expect.soft(readFileSync(registryPath, 'utf8')).toBe(successorBytes);
      }

      const status = JSON.parse(runLease(root, ['status']).stdout);
      expect(status.barrier).toEqual(successorHeld.barrier);
      expect(status.resourceLeases.released).toEqual([
        expect.objectContaining({
          kind: 'build',
          resourceId: 'generation-old',
          fence: oldHeld.barrier.fence,
          heldEpoch: oldHeld.barrier.heldEpoch,
        }),
      ]);
    }, 5_000);

    it.each([
      'resource-lease-acquire',
      'resource-lease-heartbeat',
      'resource-lease-release',
    ] as const)('rejects a persisted heldEpoch-only BUILD binding mismatch for %s without mutation', command => {
      const root = makeRoot();
      const barrierOwner = 'builder-held-epoch-mismatch';
      const barrierToken = readResourceToken('a');
      const held = acquireHeldBarrier(root, barrierOwner, barrierToken);
      expect(runLease(root, buildResourceLeaseArgs(
        'resource-lease-acquire',
        barrierOwner,
        'generation-held-epoch-mismatch',
        barrierToken,
      )).status).toBe(0);
      const registryPath = leaseRegistryPath(root);
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const barrierBeforeMismatch = structuredClone(registry.barrier);
      const resourceLease = registry.resourceLeases[readResourceTokenHash(barrierToken)];
      const resourceLeaseBeforeMismatch = structuredClone(resourceLease);
      expect(resourceLease).toEqual(expect.objectContaining({
        barrierOwner: held.barrier.owner,
        barrierTokenFingerprint: held.barrier.tokenFingerprint,
        fence: held.barrier.fence,
        heldEpoch: held.barrier.heldEpoch,
      }));

      resourceLease.heldEpoch += 1;
      expect({
        ...resourceLease,
        heldEpoch: resourceLeaseBeforeMismatch.heldEpoch,
      }).toEqual(resourceLeaseBeforeMismatch);
      expect(registry.barrier).toEqual(barrierBeforeMismatch);
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      const mismatchedBytes = readFileSync(registryPath, 'utf8');

      const rejected = runLease(root, buildResourceLeaseArgs(
        command,
        barrierOwner,
        'generation-held-epoch-mismatch',
        barrierToken,
      ));
      expect.soft(rejected.status).toBe(1);
      const report = JSON.parse(rejected.stdout);
      expect.soft(report.reason).toBe('build-resource-barrier-binding-stale');
      expect.soft(report.barrier).toEqual(held.barrier);
      expect.soft(report.resourceLease).toEqual(expect.objectContaining({
        barrierOwner: held.barrier.owner,
        barrierTokenFingerprint: held.barrier.tokenFingerprint,
        fence: held.barrier.fence,
        heldEpoch: held.barrier.heldEpoch + 1,
        state: 'ACTIVE',
      }));
      expect.soft(readFileSync(registryPath, 'utf8')).toBe(mismatchedBytes);
    });

    it.each(['fence', 'heldEpoch'] as const)(
      'fails closed on a HELD barrier missing %s before BUILD admission',
      field => {
        const root = makeRoot();
        const barrierOwner = 'builder-malformed-barrier';
        const barrierToken = readResourceToken('a');
        acquireHeldBarrier(root, barrierOwner, barrierToken);
        const registryPath = leaseRegistryPath(root);
        const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
        delete registry.barrier[field];
        writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
        const malformedBytes = readFileSync(registryPath, 'utf8');

        const rejected = runLease(root, buildResourceLeaseArgs(
          'resource-lease-acquire',
          barrierOwner,
          'generation-malformed-barrier',
          barrierToken,
        ));
        expect(rejected.status).not.toBe(0);
        expect(rejected.stdout).toBe('');
        expect(rejected.stderr).toContain(`lease registry barrier is missing ${field}`);
        expect(readFileSync(registryPath, 'utf8')).toBe(malformedBytes);
      },
    );

    it.each(['barrierOwner', 'barrierTokenFingerprint', 'fence', 'heldEpoch'] as const)(
      'rejects a persisted BUILD resource lease missing %s without rewriting it',
      field => {
        const root = makeRoot();
        const barrierOwner = 'builder-malformed-binding';
        const barrierToken = readResourceToken('a');
        acquireHeldBarrier(root, barrierOwner, barrierToken);
        expect(runLease(root, buildResourceLeaseArgs(
          'resource-lease-acquire',
          barrierOwner,
          'generation-malformed-binding',
          barrierToken,
        )).status).toBe(0);
        const registryPath = leaseRegistryPath(root);
        const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
        delete registry.resourceLeases[readResourceTokenHash(barrierToken)][field];
        writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
        const malformedBytes = readFileSync(registryPath, 'utf8');

        const status = runLease(root, ['status']);
        expect(status.status).not.toBe(0);
        expect(status.stdout).toBe('');
        expect(status.stderr).toContain(`lease registry BUILD resource lease is missing ${field}`);
        expect(readFileSync(registryPath, 'utf8')).toBe(malformedBytes);
      },
    );
  });

  it('accepts a caller-preheld 64-hex barrier acquisition token from stdin', () => {
    const root = makeRoot();
    const token = '1'.repeat(64);

    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'stdin-barrier', '--barrier-token-stdin',
    ], {
      input: `${token}\r\n`,
    });

    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    const report = JSON.parse(acquired.stdout);
    expect(report).not.toHaveProperty('barrierToken');
    expect(acquired.stdout).not.toContain(token);
    expect(report.barrier).toEqual(expect.objectContaining({
      state: 'HELD',
      owner: 'stdin-barrier',
      heldEpoch: 0,
      fence: 1,
    }));
    expect(readFileSync(path.join(root, 'tmp', 'agent-file-leases.json'), 'utf8')).not.toContain(token);
  });

  it('normalizes 64-hex barrier capabilities to lowercase across authentication commands', () => {
    const root = makeRoot();
    const uppercaseToken = 'A'.repeat(64);
    const normalizedToken = uppercaseToken.toLowerCase();

    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'normalized-barrier', '--barrier-token', uppercaseToken,
    ]);

    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    const acquiredReport = JSON.parse(acquired.stdout);
    expect(acquiredReport).not.toHaveProperty('barrierToken');
    expect(acquired.stdout).not.toContain(normalizedToken);
    expect(acquiredReport.barrier).toEqual(expect.objectContaining({ state: 'HELD', fence: 1 }));

    const retried = runLease(root, [
      'barrier-acquire', '--owner', 'normalized-barrier', '--barrier-token', normalizedToken,
    ]);
    expect(retried.status, retried.stderr || retried.stdout).toBe(0);
    expect(JSON.parse(retried.stdout)).toEqual(expect.objectContaining({
      fencingCounter: 1,
      workspaceEpoch: 0,
    }));

    const heartbeat = runLease(root, [
      'barrier-heartbeat', '--owner', 'normalized-barrier', '--barrier-token', uppercaseToken,
    ]);
    expect(heartbeat.status, heartbeat.stderr || heartbeat.stdout).toBe(0);
    const released = runLease(root, [
      'barrier-release', '--owner', 'normalized-barrier', '--barrier-token', normalizedToken,
    ]);
    expect(released.status, released.stderr || released.stdout).toBe(0);
  });

  it('authenticates a persisted legacy uppercase 64-hex raw token without weakening case rejection', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const legacyToken = 'A'.repeat(64);
    const wrongCaseToken = legacyToken.toLowerCase();
    const tokenHash = createHash('sha256').update(legacyToken, 'utf8').digest('hex');
    const acquiredAt = '2026-01-01T00:00:00.000Z';
    const persistedBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 0,
      fencingCounter: 1,
      barrier: {
        state: 'HELD',
        owner: 'legacy-uppercase-barrier',
        tokenHash,
        tokenFingerprint: tokenHash.slice(0, 12),
        acquiredAt,
        heartbeatAt: acquiredAt,
        heartbeatSequence: 1,
        heldEpoch: 0,
        fence: 1,
        releasedAt: null,
        transitions: [
          { state: 'CLOSING', at: acquiredAt, sequence: 1 },
          { state: 'WAITING', at: acquiredAt, sequence: 2 },
          { state: 'HELD', at: acquiredAt, sequence: 3 },
        ],
      },
      leases: {},
    }, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, persistedBytes);

    for (const rejectedToken of [wrongCaseToken, 'B'.repeat(64)]) {
      const rejected = runLease(root, [
        'barrier-heartbeat', '--owner', 'legacy-uppercase-barrier',
        '--barrier-token', rejectedToken,
      ]);
      expect.soft(rejected.status).toBe(1);
      expect.soft(rejected.stdout).not.toContain(legacyToken);
      expect.soft(rejected.stderr).not.toContain(legacyToken);
      expect.soft(readFileSync(leasePath, 'utf8')).toBe(persistedBytes);
    }

    const heartbeat = runLease(root, [
      'barrier-heartbeat', '--owner', 'legacy-uppercase-barrier',
      '--barrier-token', legacyToken,
    ]);
    expect(heartbeat.status, heartbeat.stderr || heartbeat.stdout).toBe(0);
    expect(heartbeat.stdout).not.toContain(legacyToken);
    expect(heartbeat.stderr).not.toContain(legacyToken);

    const released = runLease(root, [
      'barrier-release', '--owner', 'legacy-uppercase-barrier',
      '--barrier-token', legacyToken,
    ]);
    expect(released.status, released.stderr || released.stdout).toBe(0);
    expect(released.stdout).not.toContain(legacyToken);
    expect(released.stderr).not.toContain(legacyToken);
    expect(JSON.parse(released.stdout).barrier.state).toBe('RELEASED');
  });

  it.each([
    ['WAITING', false],
    ['HELD', true],
  ] as const)('retries a persisted legacy uppercase raw token through barrier-acquire in %s', (
    barrierState,
    isHeld,
  ) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const owner = `legacy-uppercase-${barrierState.toLowerCase()}`;
    const legacyToken = isHeld ? 'C'.repeat(64) : 'D'.repeat(64);
    const wrongCaseToken = legacyToken.toLowerCase();
    const tokenHash = createHash('sha256').update(legacyToken, 'utf8').digest('hex');
    const workspaceEpoch = 7;
    const fencingCounter = 11;
    const acquiredAt = new Date(Date.now() - 1_000).toISOString();
    const activeLeaseExpiresAtMs = Date.now() + 60 * 60 * 1_000;
    const transitions = [
      { state: 'CLOSING', at: acquiredAt, sequence: 1 },
      { state: 'WAITING', at: acquiredAt, sequence: 2 },
      ...(isHeld ? [{ state: 'HELD', at: acquiredAt, sequence: 3 }] : []),
    ];
    const leases = isHeld
      ? {}
      : {
          'active-writer.ts': {
            owner: 'active-writer',
            claimedAt: acquiredAt,
            expiresAt: new Date(activeLeaseExpiresAtMs).toISOString(),
            expiresAtMs: activeLeaseExpiresAtMs,
          },
        };
    const persistedBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch,
      fencingCounter,
      barrier: {
        state: barrierState,
        owner,
        tokenHash,
        tokenFingerprint: tokenHash.slice(0, 12),
        acquiredAt,
        heartbeatAt: acquiredAt,
        heartbeatSequence: 1,
        heldEpoch: isHeld ? workspaceEpoch : null,
        fence: isHeld ? fencingCounter : null,
        releasedAt: null,
        transitions,
      },
      leases,
    }, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, persistedBytes);

    for (const rejectedToken of [wrongCaseToken, 'E'.repeat(64)]) {
      const rejected = runLease(root, [
        'barrier-acquire', '--owner', owner, '--barrier-token', rejectedToken,
      ]);
      expect.soft(rejected.status).toBe(1);
      expect.soft(JSON.parse(rejected.stdout).reason).toBe('barrier-already-active');
      expect.soft(readFileSync(leasePath, 'utf8')).toBe(persistedBytes);
    }

    const retried = runLease(root, [
      'barrier-acquire', '--owner', owner, '--barrier-token', legacyToken,
    ]);
    expect(retried.status, retried.stderr || retried.stdout).toBe(0);
    expect(JSON.parse(retried.stdout)).toEqual(expect.objectContaining({
      workspaceEpoch,
      fencingCounter,
      barrier: expect.objectContaining({
        state: barrierState,
        heldEpoch: isHeld ? workspaceEpoch : null,
        fence: isHeld ? fencingCounter : null,
      }),
    }));
    expect(readFileSync(leasePath, 'utf8')).toBe(persistedBytes);

    const heartbeat = runLease(root, [
      'barrier-heartbeat', '--owner', owner, '--barrier-token', legacyToken,
    ]);
    expect(heartbeat.status, heartbeat.stderr || heartbeat.stdout).toBe(0);
    expect(JSON.parse(heartbeat.stdout)).toEqual(expect.objectContaining({
      workspaceEpoch,
      fencingCounter,
      barrier: expect.objectContaining({
        state: barrierState,
        heartbeatSequence: 2,
      }),
    }));

    const released = runLease(root, [
      'barrier-release', '--owner', owner, '--barrier-token', legacyToken,
    ]);
    expect(released.status, released.stderr || released.stdout).toBe(0);
    expect(JSON.parse(released.stdout)).toEqual(expect.objectContaining({
      workspaceEpoch,
      fencingCounter,
      barrier: expect.objectContaining({ state: 'RELEASED' }),
    }));
  });

  it.each([
    ['missing', ['barrier-acquire', '--owner', 'invalid-barrier'], undefined],
    ['duplicate argv', [
      'barrier-acquire', '--owner', 'invalid-barrier',
      '--barrier-token', '2'.repeat(64),
      '--barrier-token', '3'.repeat(64),
    ], undefined],
    ['duplicate stdin', [
      'barrier-acquire', '--owner', 'invalid-barrier',
      '--barrier-token-stdin', '--barrier-token-stdin',
    ], `${'4'.repeat(64)}\n`],
    ['ambiguous argv and stdin', [
      'barrier-acquire', '--owner', 'invalid-barrier',
      '--barrier-token', '5'.repeat(64), '--barrier-token-stdin',
    ], `${'6'.repeat(64)}\n`],
    ['malformed argv', [
      'barrier-acquire', '--owner', 'invalid-barrier', '--barrier-token', 'not-64-hex',
    ], undefined],
    ['malformed stdin', [
      'barrier-acquire', '--owner', 'invalid-barrier', '--barrier-token-stdin',
    ], 'not-64-hex\n'],
    ['bare LF stdin', [
      'barrier-acquire', '--owner', 'invalid-barrier', '--barrier-token-stdin',
    ], `${'a'.repeat(64)}\n`],
  ] as const)('rejects %s barrier acquisition token input before acquiring the registry lock', (
    _caseName,
    args,
    input,
  ) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const lockPath = `${leasePath}.lock`;
    const originalBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 3,
      leases: {},
    }, null, 2)}\n`;
    const lockBytes = 'input-validation-lock-sentinel\n';
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);
    writeFileSync(lockPath, lockBytes, { flag: 'wx' });

    const rejected = runLease(root, [...args], { input });

    expect.soft(rejected.status).not.toBe(0);
    expect.soft(rejected.stdout).toBe('');
    expect.soft(rejected.stderr).toContain('barrier acquisition token');
    expect.soft(rejected.stderr).not.toContain('lease state is locked');
    expect.soft(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
    expect(readFileSync(lockPath, 'utf8')).toBe(lockBytes);
  });

  it.each([
    ['WAITING', true, 1, 0, null],
    ['HELD', false, 0, 1, 1],
  ] as const)('recovers an authenticated %s barrier from an uppercase caller capability after a post-commit pre-output crash', async (
    expectedState,
    seedWriteLease,
    expectedWorkspaceEpoch,
    expectedFencingCounter,
    expectedFence,
  ) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const rawToken = expectedState === 'WAITING' ? 'A'.repeat(64) : 'B'.repeat(64);
    const canonicalToken = rawToken.toLowerCase();
    if (seedWriteLease) {
      const seeded = runLease(root, ['claim', '--owner', 'writer-before-crash', 'held-open.ts']);
      expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0);
    }

    const crashed = await crashCommandAfterCommit(root, [
      'barrier-acquire', '--owner', `barrier-${expectedState.toLowerCase()}`,
      '--barrier-token', rawToken,
    ], `barrier-${expectedState.toLowerCase()}-unknown-outcome`);

    expect(crashed.status === null || crashed.status !== 0).toBe(true);
    expect(crashed.stdout).toBe('');
    expect(existsSync(leasePath), 'barrier acquisition must have committed before output loss').toBe(true);
    const committed = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(committed.workspaceEpoch).toBe(expectedWorkspaceEpoch);
    expect(committed.fencingCounter).toBe(expectedFencingCounter);
    expect(committed.barrier.tokenHash).toBe(
      createHash('sha256').update(canonicalToken, 'utf8').digest('hex'),
    );
    expect(committed.barrier).toEqual(expect.objectContaining({
      state: expectedState,
      heldEpoch: expectedFence === null ? null : expectedWorkspaceEpoch,
      fence: expectedFence,
    }));
    const committedBytes = readFileSync(leasePath, 'utf8');

    await new Promise(resolve => setTimeout(resolve, 5));
    const staleReclaimer = spawnStaleWorker(root, 'contender', {
      NANOFLOW_LEASE_TEST_STALE_AFTER_MS: '1',
    });
    const reclaimed = await staleReclaimer.completion;
    expect(reclaimed.status, reclaimed.stderr || reclaimed.stdout).toBe(0);
    const retry = runLease(root, [
      'barrier-acquire', '--owner', `barrier-${expectedState.toLowerCase()}`,
      '--barrier-token', rawToken,
    ]);
    expect(retry.status, retry.stderr || retry.stdout).toBe(0);
    const retried = JSON.parse(retry.stdout);
    expect(retried).not.toHaveProperty('barrierToken');
    expect(retry.stdout).not.toContain(canonicalToken);
    expect(retried.workspaceEpoch).toBe(expectedWorkspaceEpoch);
    expect(retried.fencingCounter).toBe(expectedFencingCounter);
    expect(retried.barrier).toEqual(expect.objectContaining({
      state: expectedState,
      heldEpoch: expectedFence === null ? null : expectedWorkspaceEpoch,
      fence: expectedFence,
    }));
    expect(readFileSync(leasePath, 'utf8')).toBe(committedBytes);

    const heartbeat = runLease(root, [
      'barrier-heartbeat', '--owner', `barrier-${expectedState.toLowerCase()}`,
      '--barrier-token', canonicalToken,
    ]);
    expect(heartbeat.status, heartbeat.stderr || heartbeat.stdout).toBe(0);
    const released = runLease(root, [
      'barrier-release', '--owner', `barrier-${expectedState.toLowerCase()}`,
      '--barrier-token', canonicalToken,
    ]);
    expect(released.status, released.stderr || released.stdout).toBe(0);
    expect(JSON.parse(released.stdout).barrier.state).toBe('RELEASED');

    const reopened = runLease(root, [
      'claim', '--owner', 'writer-after-recovery', 'after-recovery.ts',
    ]);
    expect(reopened.status, reopened.stderr || reopened.stdout).toBe(0);
  });

  it('drains delayed stdout before the CLI exits', () => {
    const root = makeRoot();
    const delayedStdoutShimPath = path.join(root, 'delay-stdout-write.cjs');
    writeFileSync(delayedStdoutShimPath, [
      "'use strict';",
      'const originalWrite = process.stdout.write.bind(process.stdout);',
      'process.stdout.write = function delayedStdoutWrite(...args) {',
      '  setTimeout(() => originalWrite(...args), 25);',
      '  return false;',
      '};',
      '',
    ].join('\n'));
    const timeout = leaseSpawnSyncTimeout();

    const result = requireCompletedSpawnSync(spawnSync(process.execPath, [
      '--require', delayedStdoutShimPath,
      leaseScriptPath,
      '--root', root,
      'status',
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout,
    }), 'agent-file-lease delayed stdout CLI', timeout);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout, result.stderr).not.toBe('');
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: true,
      command: 'status',
      workspaceEpoch: 0,
    }));
  });

  it('settles a delayed stdout callback failure through the awaited CLI error path', () => {
    const root = makeRoot();
    const delayedFailureShimPath = path.join(root, 'fail-delayed-stdout-write.cjs');
    writeFileSync(delayedFailureShimPath, [
      "'use strict';",
      'process.stdout.write = function failDelayedStdoutWrite(...args) {',
      '  const callback = args[args.length - 1];',
      "  setTimeout(() => callback(new Error('delayed-stdout-callback-sentinel')), 25);",
      '  return false;',
      '};',
      '',
    ].join('\n'));
    const timeout = leaseSpawnSyncTimeout();

    const result = requireCompletedSpawnSync(spawnSync(process.execPath, [
      '--require', delayedFailureShimPath,
      leaseScriptPath,
      '--root', root,
      'status',
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '--unhandled-rejections=warn',
      },
      timeout,
    }), 'agent-file-lease delayed stdout callback CLI', timeout);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('delayed-stdout-callback-sentinel');
    expect(result.stderr).not.toContain('UnhandledPromiseRejection');
  });

  it('acquires an empty-workspace barrier through auditable transitions and keeps HELD polls idempotent', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');

    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);

    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    const report = JSON.parse(acquired.stdout);
    expect(report).not.toHaveProperty('barrierToken');
    expect(acquired.stdout).not.toContain('a'.repeat(64));
    expect(report.workspaceEpoch).toBe(0);
    expect(report.fencingCounter).toBe(1);
    expect(report.barrier).toEqual(expect.objectContaining({
      state: 'HELD',
      owner: 'barrier-a',
      heartbeatSequence: 1,
      heldEpoch: 0,
      fence: 1,
    }));
    expect(report.barrier.transitions.map((entry: { state: string }) => entry.state)).toEqual([
      'CLOSING',
      'WAITING',
      'HELD',
    ]);

    const registryBytes = readFileSync(leasePath, 'utf8');
    const registry = JSON.parse(registryBytes);
    expect(registry.barrier.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.barrier.tokenFingerprint).toBe(registry.barrier.tokenHash.slice(0, 12));
    expect(registryBytes).not.toContain('a'.repeat(64));

    const status = runLease(root, ['status']);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    expect(status.stdout).not.toContain('a'.repeat(64));
    expect(JSON.parse(status.stdout).barrier).not.toHaveProperty('tokenHash');

    const poll = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);
    expect(poll.status, poll.stderr || poll.stdout).toBe(0);
    const polled = JSON.parse(poll.stdout);
    expect(polled).not.toHaveProperty('barrierToken');
    expect(polled.barrier).toEqual(expect.objectContaining({ state: 'HELD', heldEpoch: 0, fence: 1 }));
    expect(polled.fencingCounter).toBe(1);
    expect(readFileSync(leasePath, 'utf8')).toBe(registryBytes);
  });

  it('enforces WAITING/HELD barrier write admission while allowing exact renewal and release', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const initial = runLease(root, ['claim', '--owner', 'writer-a', 'a.ts', 'b.ts']);
    expect(initial.status, initial.stderr || initial.stdout).toBe(0);
    expect(JSON.parse(initial.stdout).workspaceEpoch).toBe(1);

    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);
    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    const waiting = JSON.parse(acquired.stdout);
    expect(waiting).not.toHaveProperty('barrierToken');
    expect(acquired.stdout).not.toContain('a'.repeat(64));
    expect(waiting.barrier).toEqual(expect.objectContaining({
      state: 'WAITING',
      heldEpoch: null,
      fence: null,
    }));
    expect(waiting.fencingCounter).toBe(0);
    expect(waiting.workspaceEpoch).toBe(1);
    const beforeRejectedClaims = readFileSync(leasePath, 'utf8');

    for (const args of [
      ['claim', '--owner', 'writer-a', 'new.ts'],
      ['claim', '--owner', 'writer-a', 'a.ts', 'new.ts'],
      ['claim', '--owner', 'writer-b', 'a.ts'],
    ]) {
      const rejected = runLease(root, args);
      expect.soft(rejected.status, rejected.stderr || rejected.stdout).toBe(1);
      expect.soft(JSON.parse(rejected.stdout).reason).toBe('barrier-write-admission-closed');
      expect.soft(readFileSync(leasePath, 'utf8')).toBe(beforeRejectedClaims);
    }

    const renewed = runLease(root, ['claim', '--owner', 'writer-a', 'a.ts', 'b.ts']);
    expect(renewed.status, renewed.stderr || renewed.stdout).toBe(0);
    expect(JSON.parse(renewed.stdout).workspaceEpoch).toBe(2);
    expect(JSON.parse(readFileSync(leasePath, 'utf8')).workspaceEpoch).toBe(2);

    const releasedWrites = runLease(root, ['release', '--owner', 'writer-a', 'a.ts', 'b.ts']);
    expect(releasedWrites.status, releasedWrites.stderr || releasedWrites.stdout).toBe(0);
    const afterWriteRelease = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(afterWriteRelease.workspaceEpoch).toBe(2);
    expect(afterWriteRelease.leases).toEqual({});
    expect(afterWriteRelease.barrier.state).toBe('WAITING');

    const held = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);
    expect(held.status, held.stderr || held.stdout).toBe(0);
    const heldReport = JSON.parse(held.stdout);
    expect(heldReport.workspaceEpoch).toBe(2);
    expect(heldReport.fencingCounter).toBe(1);
    expect(heldReport.barrier).toEqual(expect.objectContaining({
      state: 'HELD',
      heldEpoch: 2,
      fence: 1,
    }));

    const rejectedWhileHeld = runLease(root, ['claim', '--owner', 'writer-a', 'a.ts']);
    expect(rejectedWhileHeld.status).toBe(1);
    expect(JSON.parse(rejectedWhileHeld.stdout).reason).toBe('barrier-held');

    const releasedBarrier = runLease(root, [
      'barrier-release', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);
    expect(releasedBarrier.status, releasedBarrier.stderr || releasedBarrier.stdout).toBe(0);
    expect(JSON.parse(releasedBarrier.stdout).barrier.state).toBe('RELEASED');
    const reopened = runLease(root, ['claim', '--owner', 'writer-a', 'a.ts']);
    expect(reopened.status, reopened.stderr || reopened.stdout).toBe(0);
    expect(JSON.parse(reopened.stdout).workspaceEpoch).toBe(3);
  });

  it('authenticates long-lived barrier heartbeats without takeover, token leakage, or counter drift', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);
    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    const acquiredReport = JSON.parse(acquired.stdout);
    const token = 'a'.repeat(64);
    const registry = JSON.parse(readFileSync(leasePath, 'utf8'));
    registry.barrier.acquiredAt = '2000-01-01T00:00:00.000Z';
    registry.barrier.heartbeatAt = '2000-01-01T00:00:00.000Z';
    registry.barrier.transitions = registry.barrier.transitions.map(
      (transition: Record<string, unknown>, index: number) => ({
        ...transition,
        at: new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString(),
      }),
    );
    writeFileSync(leasePath, `${JSON.stringify(registry, null, 2)}\n`);
    const longLivedBytes = readFileSync(leasePath, 'utf8');

    const takeover = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-b', '--barrier-token', 'b'.repeat(64),
    ]);
    expect(takeover.status).toBe(1);
    expect(takeover.stdout).not.toContain(token);
    expect(readFileSync(leasePath, 'utf8')).toBe(longLivedBytes);

    for (const args of [
      ['barrier-heartbeat', '--owner', 'barrier-b', '--barrier-token', token],
      ['barrier-heartbeat', '--owner', 'barrier-a', '--barrier-token', 'wrong-token'],
      ['barrier-heartbeat', '--owner', 'barrier-a'],
    ]) {
      const rejected = runLease(root, args);
      expect.soft(rejected.status).toBe(1);
      expect.soft(rejected.stdout).not.toContain(token);
      expect.soft(readFileSync(leasePath, 'utf8')).toBe(longLivedBytes);
    }

    const heartbeat = runLease(root, [
      'barrier-heartbeat', '--owner', 'barrier-a', '--barrier-token', token,
    ]);
    expect(heartbeat.status, heartbeat.stderr || heartbeat.stdout).toBe(0);
    expect(heartbeat.stdout).not.toContain(token);
    const heartbeatReport = JSON.parse(heartbeat.stdout);
    expect(heartbeatReport.workspaceEpoch).toBe(0);
    expect(heartbeatReport.fencingCounter).toBe(1);
    expect(heartbeatReport.barrier).toEqual(expect.objectContaining({
      state: 'HELD',
      heartbeatSequence: 2,
      heldEpoch: 0,
      fence: 1,
    }));
    const heartbeatRegistry = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(Date.parse(heartbeatRegistry.barrier.heartbeatAt)).toBeGreaterThan(
      Date.parse('2000-01-01T00:00:00.000Z'),
    );
    expect(heartbeatRegistry.barrier.transitions).toEqual(registry.barrier.transitions);
    expect(heartbeatRegistry.workspaceEpoch).toBe(0);
    expect(heartbeatRegistry.fencingCounter).toBe(1);
  });

  it('treats RELEASED acquisition replay as terminal and rejects an ABA predecessor token', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const rawFirstToken = 'A'.repeat(64);
    const first = JSON.parse(runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', rawFirstToken,
    ]).stdout);
    const firstToken = rawFirstToken.toLowerCase();
    expect(firstToken).toBe(rawFirstToken.toLowerCase());
    expect(first.barrier.fence).toBe(1);

    const released = runLease(root, [
      'barrier-release', '--owner', 'barrier-a', '--barrier-token', firstToken,
    ]);
    expect(released.status, released.stderr || released.stdout).toBe(0);
    expect(JSON.parse(released.stdout).barrier.state).toBe('RELEASED');
    const releasedBytes = readFileSync(leasePath, 'utf8');

    const releaseRetry = runLease(root, [
      'barrier-release', '--owner', 'barrier-a', '--barrier-token', firstToken,
    ]);
    expect(releaseRetry.status, releaseRetry.stderr || releaseRetry.stdout).toBe(0);
    expect(JSON.parse(releaseRetry.stdout).idempotent).toBe(true);
    expect(readFileSync(leasePath, 'utf8')).toBe(releasedBytes);

    for (const replayToken of [firstToken, rawFirstToken]) {
      const replay = runLease(root, [
        'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', replayToken,
      ]);
      expect.soft(replay.status, replay.stderr || replay.stdout).toBe(0);
      const replayReport = JSON.parse(replay.stdout);
      expect.soft(replayReport).toEqual(expect.objectContaining({
        acquired: false,
        fencingCounter: 1,
        idempotent: true,
        workspaceEpoch: 0,
      }));
      expect.soft(replayReport.barrier).toEqual(expect.objectContaining({
        state: 'RELEASED',
        fence: 1,
        heldEpoch: 0,
      }));
      expect.soft(readFileSync(leasePath, 'utf8')).toBe(releasedBytes);
    }

    const wrongOwnerReplay = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-b', '--barrier-token', firstToken,
    ]);
    expect(wrongOwnerReplay.status).toBe(1);
    expect(wrongOwnerReplay.stdout).not.toContain(firstToken);
    expect(readFileSync(leasePath, 'utf8')).toBe(releasedBytes);

    const releasedHeartbeat = runLease(root, [
      'barrier-heartbeat', '--owner', 'barrier-a', '--barrier-token', firstToken,
    ]);
    expect(releasedHeartbeat.status).toBe(1);
    expect(readFileSync(leasePath, 'utf8')).toBe(releasedBytes);

    const secondResult = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-b', '--barrier-token', 'b'.repeat(64),
    ]);
    expect(secondResult.status, secondResult.stderr || secondResult.stdout).toBe(0);
    const second = JSON.parse(secondResult.stdout);
    const secondToken = 'b'.repeat(64);
    expect(secondToken).not.toBe(firstToken);
    expect(second.barrier).toEqual(expect.objectContaining({ state: 'HELD', heldEpoch: 0, fence: 2 }));
    expect(second.fencingCounter).toBe(2);
    const successorBytes = readFileSync(leasePath, 'utf8');

    for (const command of ['barrier-acquire', 'barrier-heartbeat', 'barrier-release']) {
      const stale = runLease(root, [
        command, '--owner', 'barrier-a', '--barrier-token', firstToken,
      ]);
      expect.soft(stale.status).toBe(1);
      expect.soft(stale.stdout).not.toContain(secondToken);
      expect.soft(readFileSync(leasePath, 'utf8')).toBe(successorBytes);
    }
  });

  it('fails closed before a barrier fencing overflow and leaves complete bytes unchanged', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const originalBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 7,
      fencingCounter: Number.MAX_SAFE_INTEGER,
      leases: {},
    }, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);

    const result = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('fencing');
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
  });

  it('keeps a WAITING barrier complete when its authenticated HELD poll would overflow fencing', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const initial = runLease(root, ['claim', '--owner', 'writer-a', 'a.ts']);
    expect(initial.status, initial.stderr || initial.stdout).toBe(0);
    const registry = JSON.parse(readFileSync(leasePath, 'utf8'));
    registry.fencingCounter = Number.MAX_SAFE_INTEGER;
    writeFileSync(leasePath, `${JSON.stringify(registry, null, 2)}\n`);

    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);
    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    const waiting = JSON.parse(acquired.stdout);
    expect(waiting.barrier.state).toBe('WAITING');
    expect(waiting.fencingCounter).toBe(Number.MAX_SAFE_INTEGER);

    const releasedWrite = runLease(root, ['release', '--owner', 'writer-a', 'a.ts']);
    expect(releasedWrite.status, releasedWrite.stderr || releasedWrite.stdout).toBe(0);
    const beforePoll = readFileSync(leasePath, 'utf8');
    const poll = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);

    expect(poll.status).not.toBe(0);
    expect(poll.stdout).toBe('');
    expect(poll.stderr).toContain('fencing');
    expect(readFileSync(leasePath, 'utf8')).toBe(beforePoll);
  });

  it('supports authenticated CLOSING barrier renewal, heartbeat, and direct release', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    expect(runLease(root, ['claim', '--owner', 'writer-a', 'a.ts']).status).toBe(0);
    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);
    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    const token = 'a'.repeat(64);
    const registry = JSON.parse(readFileSync(leasePath, 'utf8'));
    registry.barrier.state = 'CLOSING';
    registry.barrier.transitions = registry.barrier.transitions.slice(0, 1);
    writeFileSync(leasePath, `${JSON.stringify(registry, null, 2)}\n`);

    const renewed = runLease(root, ['claim', '--owner', 'writer-a', 'a.ts']);
    expect(renewed.status, renewed.stderr || renewed.stdout).toBe(0);
    expect(JSON.parse(renewed.stdout).workspaceEpoch).toBe(2);
    const rejectedNew = runLease(root, ['claim', '--owner', 'writer-a', 'new.ts']);
    expect(rejectedNew.status).toBe(1);
    expect(JSON.parse(rejectedNew.stdout).reason).toBe('barrier-write-admission-closed');

    const heartbeat = runLease(root, [
      'barrier-heartbeat', '--owner', 'barrier-a', '--barrier-token', token,
    ]);
    expect(heartbeat.status, heartbeat.stderr || heartbeat.stdout).toBe(0);
    expect(JSON.parse(heartbeat.stdout).barrier).toEqual(expect.objectContaining({
      state: 'CLOSING',
      heartbeatSequence: 2,
    }));
    const released = runLease(root, [
      'barrier-release', '--owner', 'barrier-a', '--barrier-token', token,
    ]);
    expect(released.status, released.stderr || released.stdout).toBe(0);
    const releasedReport = JSON.parse(released.stdout);
    expect(releasedReport.workspaceEpoch).toBe(2);
    expect(releasedReport.fencingCounter).toBe(0);
    expect(releasedReport.barrier.state).toBe('RELEASED');
    expect(releasedReport.barrier.transitions.map((entry: { state: string }) => entry.state)).toEqual([
      'CLOSING',
      'RELEASED',
    ]);
  });

  const invalidBarrierCases: Array<[string, (registry: Record<string, any>) => void]> = [
    ['barrier array', registry => { registry.barrier = []; }],
    ['lowercase state', registry => { registry.barrier.state = 'held'; }],
    ['empty owner', registry => { registry.barrier.owner = ''; }],
    ['invalid token hash', registry => { registry.barrier.tokenHash = 'secret'; }],
    ['mismatched token fingerprint', registry => { registry.barrier.tokenFingerprint = '000000000000'; }],
    ['invalid acquired timestamp', registry => { registry.barrier.acquiredAt = 'not-a-date'; }],
    ['invalid heartbeat timestamp', registry => { registry.barrier.heartbeatAt = 7; }],
    ['unsafe heartbeat sequence', registry => { registry.barrier.heartbeatSequence = Number.MAX_SAFE_INTEGER + 1; }],
    ['missing held epoch', registry => { registry.barrier.heldEpoch = null; }],
    ['held epoch ahead of workspace epoch', registry => { registry.barrier.heldEpoch = 1; }],
    ['zero fence', registry => { registry.barrier.fence = 0; }],
    ['fence beyond counter', registry => { registry.barrier.fence = 2; }],
    ['non-array transitions', registry => { registry.barrier.transitions = {}; }],
    ['non-monotonic transition sequence', registry => { registry.barrier.transitions[1].sequence = 1; }],
    ['invalid transition path', registry => { registry.barrier.transitions[1].state = 'HELD'; }],
    ['released timestamp while held', registry => { registry.barrier.releasedAt = '2026-01-01T00:00:00.000Z'; }],
    ['unsafe fencing counter', registry => { registry.fencingCounter = Number.MAX_SAFE_INTEGER + 1; }],
    ['HELD with an active write lease', registry => {
      registry.leases['active.ts'] = validRegistryLease;
    }],
    ['direct RELEASED history carrying forged held fields', registry => {
      const releasedAt = new Date(Date.parse(registry.barrier.acquiredAt) + 1).toISOString();
      registry.barrier.state = 'RELEASED';
      registry.barrier.releasedAt = releasedAt;
      registry.barrier.transitions = [
        registry.barrier.transitions[0],
        { state: 'RELEASED', at: releasedAt, sequence: 2 },
      ];
    }],
    ['HELD RELEASED history erasing held fields', registry => {
      const releasedAt = new Date(Date.parse(registry.barrier.acquiredAt) + 1).toISOString();
      registry.barrier.state = 'RELEASED';
      registry.barrier.heldEpoch = null;
      registry.barrier.fence = null;
      registry.barrier.releasedAt = releasedAt;
      registry.barrier.transitions.push({ state: 'RELEASED', at: releasedAt, sequence: 4 });
    }],
  ];

  it.each(invalidBarrierCases)('fails closed for malformed persisted barrier %s', (_caseName, mutate) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'barrier-a', '--barrier-token', 'a'.repeat(64),
    ]);
    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    const registry = JSON.parse(readFileSync(leasePath, 'utf8'));
    mutate(registry);
    const malformedBytes = `${JSON.stringify(registry, null, 2)}\n`;
    writeFileSync(leasePath, malformedBytes);

    const status = runLease(root, ['status']);

    expect.soft(status.status, status.stderr || status.stdout).not.toBe(0);
    expect.soft(status.stdout).toBe('');
    expect(readFileSync(leasePath, 'utf8')).toBe(malformedBytes);
  });

  it.each([
    ['status', 'barier'],
    ['claim', 'fencingConter'],
  ] as const)('fails closed for an unknown v1 top-level registry field during %s', (command, unknownField) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const malformedBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 4,
      leases: {},
      [unknownField]: { state: 'HELD' },
    }, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, malformedBytes);

    const result = command === 'status'
      ? runLease(root, ['status'])
      : runLease(root, ['claim', '--owner', 'schema-writer', 'schema.ts']);

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(result.stdout).toBe('');
    expect.soft(result.stderr).toContain('top-level');
    expect(readFileSync(leasePath, 'utf8')).toBe(malformedBytes);
  });

  it.each([
    ['status'],
    ['claim'],
  ] as const)('fails closed without replacing a dangling registry symlink during %s', (command) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const danglingTarget = path.join(root, 'missing-registry-target.json');
    mkdirSync(path.dirname(leasePath), { recursive: true });
    symlinkSync(danglingTarget, leasePath, 'file');
    const before = lstatSync(leasePath, { bigint: true });

    const result = command === 'status'
      ? runLease(root, ['status'])
      : runLease(root, ['claim', '--owner', 'symlink-writer', 'symlink.ts']);

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(result.stdout).toBe('');
    expect.soft(result.stderr).toContain('regular file');
    expect(lstatSync(leasePath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(leasePath)).toBe(danglingTarget);
    const after = lstatSync(leasePath, { bigint: true });
    expect({ dev: after.dev, ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({
      dev: before.dev,
      ino: before.ino,
      mtimeNs: before.mtimeNs,
    });
  });

  it.each([
    ['a missing registry is replaced by a dangling symlink', false, 'dangling-symlink'],
    ['an existing registry is replaced by a dangling symlink', true, 'dangling-symlink'],
    ['an existing registry is replaced by a regular file', true, 'regular-file-replacement'],
    ['an existing registry is rewritten in place', true, 'in-place-rewrite'],
  ] as const)('fails the read-to-commit registry CAS when %s', async (
    _scenario,
    seedRegistry,
    mutation,
  ) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const initialBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 7,
      leases: {},
    }, null, 2)}\n`;
    if (seedRegistry) {
      mkdirSync(path.dirname(leasePath), { recursive: true });
      writeFileSync(leasePath, initialBytes);
    }
    const danglingTarget = path.join(root, 'missing-registry-cas-target.json');
    const successorBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 41,
      leases: {},
    }, null, 2)}\n`;
    let predecessorIdentity: { dev: bigint; ino: bigint } | undefined;
    let successorIdentity: { dev: bigint; ino: bigint; mtimeNs: bigint } | undefined;

    const result = await runOwnerLockScenario(root, {
      pausePoint: 'registry-cas-protocol',
      onCheckpoint: () => {
        if (mutation === 'in-place-rewrite') {
          const before = statSync(leasePath, { bigint: true });
          predecessorIdentity = { dev: before.dev, ino: before.ino };
          writeFileSync(leasePath, successorBytes);
          const after = statSync(leasePath, { bigint: true });
          successorIdentity = {
            dev: after.dev,
            ino: after.ino,
            mtimeNs: after.mtimeNs,
          };
          return;
        }
        if (seedRegistry) unlinkSync(leasePath);
        if (mutation === 'dangling-symlink') {
          symlinkSync(danglingTarget, leasePath, 'file');
        } else {
          writeFileSync(leasePath, successorBytes, { flag: 'wx' });
          const identity = statSync(leasePath, { bigint: true });
          successorIdentity = {
            dev: identity.dev,
            ino: identity.ino,
            mtimeNs: identity.mtimeNs,
          };
        }
      },
    });

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(result.stdout).toBe('');
    expect.soft(result.stderr).toContain('registry');
    if (mutation === 'dangling-symlink') {
      const after = lstatSync(leasePath);
      expect.soft(after.isSymbolicLink()).toBe(true);
      if (after.isSymbolicLink()) {
        expect(readlinkSync(leasePath)).toBe(danglingTarget);
      }
    } else {
      expect.soft(readFileSync(leasePath, 'utf8')).toBe(successorBytes);
      const after = statSync(leasePath, { bigint: true });
      if (mutation === 'in-place-rewrite') {
        expect.soft({ dev: successorIdentity!.dev, ino: successorIdentity!.ino }).toEqual(
          predecessorIdentity,
        );
      }
      expect({ dev: after.dev, ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({
        dev: successorIdentity!.dev,
        ino: successorIdentity!.ino,
        mtimeNs: successorIdentity!.mtimeNs,
      });
    }
    expect(readdirSync(path.dirname(leasePath))
      .filter(entry => entry.startsWith(`${path.basename(leasePath)}.`) && entry.endsWith('.tmp')))
      .toEqual([]);
  });

  it.each([
    ['__proto__'],
    ['constructor'],
    ['prototype'],
    ['toString'],
    ['hasOwnProperty'],
  ] as const)('round-trips the reserved lease key %s through claim/status/barrier/release', (reservedFile) => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const token = '9'.repeat(64);

    const claim = runLease(root, ['claim', '--owner', 'reserved-writer', reservedFile]);
    expect(claim.status, claim.stderr || claim.stdout).toBe(0);
    const claimed = JSON.parse(claim.stdout);
    expect(Object.prototype.hasOwnProperty.call(claimed.leases, reservedFile)).toBe(true);
    expect(claimed.leases[reservedFile]).toEqual(expect.objectContaining({ owner: 'reserved-writer' }));

    const status = runLease(root, ['status']);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    const statusReport = JSON.parse(status.stdout);
    expect(Object.prototype.hasOwnProperty.call(statusReport.leases, reservedFile)).toBe(true);
    expect(statusReport.leases[reservedFile]).toEqual(expect.objectContaining({ owner: 'reserved-writer' }));

    const acquired = runLease(root, [
      'barrier-acquire', '--owner', 'reserved-barrier', '--barrier-token', token,
    ]);
    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    expect(JSON.parse(acquired.stdout).barrier).toEqual(expect.objectContaining({
      state: 'WAITING',
      heldEpoch: null,
      fence: null,
    }));

    const releasedWrite = runLease(root, [
      'release', '--owner', 'reserved-writer', reservedFile,
    ]);
    expect(releasedWrite.status, releasedWrite.stderr || releasedWrite.stdout).toBe(0);
    expect(JSON.parse(releasedWrite.stdout).released).toEqual([reservedFile]);

    const held = runLease(root, [
      'barrier-acquire', '--owner', 'reserved-barrier', '--barrier-token', token,
    ]);
    expect(held.status, held.stderr || held.stdout).toBe(0);
    expect(JSON.parse(held.stdout).barrier).toEqual(expect.objectContaining({
      state: 'HELD',
      heldEpoch: 1,
      fence: 1,
    }));
    const releasedBarrier = runLease(root, [
      'barrier-release', '--owner', 'reserved-barrier', '--barrier-token', token,
    ]);
    expect(releasedBarrier.status, releasedBarrier.stderr || releasedBarrier.stdout).toBe(0);

    const serialized = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(serialized.leases).toEqual({});
    expect(serialized.barrier.state).toBe('RELEASED');
  });

  it('serializes two initial barrier acquirers to one token and one fence winner', async () => {
    const root = makeRoot();

    const results = await Promise.all([
      barrierAcquireWithLockRetry(root, 'barrier-a', 'a'.repeat(64)),
      barrierAcquireWithLockRetry(root, 'barrier-b', 'b'.repeat(64)),
    ]);

    expect(results.map(result => result.status).sort()).toEqual([0, 1]);
    const winner = results.find(result => result.status === 0);
    const loser = results.find(result => result.status === 1);
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    const winnerReport = JSON.parse(winner!.stdout);
    const loserReport = JSON.parse(loser!.stdout);
    expect(winnerReport).not.toHaveProperty('barrierToken');
    expect(winnerReport.fencingCounter).toBe(1);
    expect(loserReport.reason).toBe('barrier-already-active');
    expect(loser!.stdout).not.toContain('a'.repeat(64));
    expect(loser!.stdout).not.toContain('b'.repeat(64));
    const registry = JSON.parse(readFileSync(path.join(root, 'tmp', 'agent-file-leases.json'), 'utf8'));
    expect(registry.fencingCounter).toBe(1);
    expect(registry.barrier.fence).toBe(1);
  });

  it('serializes claim-before-barrier and barrier-before-claim without mixed partial state', async () => {
    const claimFirstRoot = makeRoot();
    const claimFirst = await runSerializationScenario(claimFirstRoot, {
      contenderArgs: [
        'barrier-acquire', '--owner', 'barrier-after-claim', '--barrier-token', 'a'.repeat(64),
      ],
      finalRetry: () => runLease(claimFirstRoot, [
        'barrier-acquire', '--owner', 'barrier-after-claim', '--barrier-token', 'a'.repeat(64),
      ]),
    });
    expect(claimFirst.a.status, claimFirst.a.stderr || claimFirst.a.stdout).toBe(0);
    expect(claimFirst.bBeforeCommit.status).not.toBe(0);
    expect(claimFirst.bBeforeRelease.status).not.toBe(0);
    const waiting = JSON.parse(claimFirst.bAfterRelease.stdout);
    expect(claimFirst.bAfterRelease.status).toBe(0);
    expect(waiting.workspaceEpoch).toBe(1);
    expect(waiting.fencingCounter).toBe(0);
    expect(waiting.barrier.state).toBe('WAITING');
    expect(waiting.leases['a.ts'].owner).toBe('agent-a');

    const barrierFirstRoot = makeRoot();
    const barrierFirst = await runSerializationScenario(barrierFirstRoot, {
      workerArgs: [
        'barrier-acquire', '--owner', 'barrier-before-claim', '--barrier-token', 'a'.repeat(64),
      ],
      contenderArgs: ['claim', '--owner', 'writer-after-barrier', 'new.ts'],
      finalRetry: () => runLease(barrierFirstRoot, [
        'claim', '--owner', 'writer-after-barrier', 'new.ts',
      ]),
    });
    expect(barrierFirst.a.status, barrierFirst.a.stderr || barrierFirst.a.stdout).toBe(0);
    expect(barrierFirst.bBeforeCommit.status).not.toBe(0);
    expect(barrierFirst.bBeforeRelease.status).not.toBe(0);
    expect(barrierFirst.bAfterRelease.status).toBe(1);
    expect(JSON.parse(barrierFirst.bAfterRelease.stdout).reason).toBe('barrier-held');
    const held = JSON.parse(readFileSync(
      path.join(barrierFirstRoot, 'tmp', 'agent-file-leases.json'),
      'utf8',
    ));
    expect(held.workspaceEpoch).toBe(0);
    expect(held.fencingCounter).toBe(1);
    expect(held.leases).toEqual({});
    expect(held.barrier).toEqual(expect.objectContaining({ state: 'HELD', heldEpoch: 0, fence: 1 }));
  });

  it('keeps barrier/fence/epoch state complete across pre-rename and post-commit crashes', async () => {
    const oldRoot = makeRoot();
    const oldRegistryPath = path.join(oldRoot, 'tmp', 'agent-file-leases.json');
    const oldBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 7,
      fencingCounter: 4,
      leases: {},
    }, null, 2)}\n`;
    mkdirSync(path.dirname(oldRegistryPath), { recursive: true });
    writeFileSync(oldRegistryPath, oldBytes);

    const preRenameCrash = await crashCommandBeforeCommit(
      oldRoot,
      [
        'barrier-acquire', '--owner', 'barrier-crash-old', '--barrier-token', 'a'.repeat(64),
      ],
      'barrier-pre-rename',
    );
    expect(preRenameCrash.status === null || preRenameCrash.status !== 0).toBe(true);
    expect(readFileSync(oldRegistryPath, 'utf8')).toBe(oldBytes);
    const preparedTemps = readdirSync(path.dirname(oldRegistryPath))
      .filter(entry => entry.endsWith('.tmp'));
    expect(preparedTemps).toHaveLength(1);
    const prepared = JSON.parse(readFileSync(
      path.join(path.dirname(oldRegistryPath), preparedTemps[0]),
      'utf8',
    ));
    expect(prepared).toEqual(expect.objectContaining({
      workspaceEpoch: 7,
      fencingCounter: 5,
      leases: {},
    }));
    expect(prepared.barrier).toEqual(expect.objectContaining({
      state: 'HELD',
      heldEpoch: 7,
      fence: 5,
    }));

    const newRoot = makeRoot();
    const newRegistryPath = path.join(newRoot, 'tmp', 'agent-file-leases.json');
    mkdirSync(path.dirname(newRegistryPath), { recursive: true });
    writeFileSync(newRegistryPath, oldBytes);
    const postCommitCrash = await crashCommandAfterCommit(
      newRoot,
      [
        'barrier-acquire', '--owner', 'barrier-crash-new', '--barrier-token', 'b'.repeat(64),
      ],
      'barrier-post-commit',
    );
    expect(postCommitCrash.status === null || postCommitCrash.status !== 0).toBe(true);
    const committed = JSON.parse(readFileSync(newRegistryPath, 'utf8'));
    expect(committed).toEqual(expect.objectContaining({
      workspaceEpoch: 7,
      fencingCounter: 5,
      leases: {},
    }));
    expect(committed.barrier).toEqual(expect.objectContaining({
      state: 'HELD',
      heldEpoch: 7,
      fence: 5,
    }));
  });

  it('publishes a fully written owner record through a real hard link', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');

    const result = await runOwnerLockScenario(root, {
      owner: 'agent-owner-token',
      onCheckpoint: () => {
        const lockBytes = readFileSync(lockPath);
        const metadata = JSON.parse(lockBytes.toString('utf8'));
        const createdAtMs = Date.parse(metadata.createdAt);
        expect(metadata).toEqual({
          schema: 3,
          token: expect.stringMatching(/^[a-f0-9]{64}$/),
          owner: 'agent-owner-token',
          pid: expect.any(Number),
          processStartIdentity: {
            kind: 'node-performance-time-origin',
            unit: 'unix-ms',
            value: expect.any(Number),
          },
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          initialHeartbeat: {
            schema: 1,
            token: metadata.token,
            pid: metadata.pid,
            processStartIdentity: metadata.processStartIdentity,
            sequence: 0,
            heartbeatAtMs: createdAtMs,
          },
        });
        expect(Number.isFinite(metadata.processStartIdentity.value)).toBe(true);
        expect(metadata.processStartIdentity.value).toBeGreaterThan(0);
        expect(Number.isSafeInteger(createdAtMs)).toBe(true);
        expect(new Date(createdAtMs).toISOString()).toBe(metadata.createdAt);

        const directory = path.dirname(lockPath);
        const ownerFiles = readdirSync(directory)
          .filter(name => name.startsWith(`${path.basename(lockPath)}.owner.`));
        expect(ownerFiles).toHaveLength(1);
        const ownerPath = path.join(directory, ownerFiles[0]);
        expect(readFileSync(ownerPath).equals(lockBytes)).toBe(true);

        const ownerIdentity = statSync(ownerPath, { bigint: true });
        const canonicalIdentity = statSync(lockPath, { bigint: true });
        expect(ownerIdentity.dev).not.toBe(0n);
        expect(ownerIdentity.ino).not.toBe(0n);
        expect(canonicalIdentity.dev).toBe(ownerIdentity.dev);
        expect(canonicalIdentity.ino).toBe(ownerIdentity.ino);
        expect(ownerIdentity.nlink).toBeGreaterThanOrEqual(2n);
        expect(readdirSync(directory).filter(name => name.includes('.heartbeat.'))).toEqual([]);
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(path.dirname(lockPath))).toEqual([]);
  });

  it('reclaims a dead schema-3 seq0 owner that crashes before its first heartbeat tick', async () => {
    const root = makeRoot();

    const crashed = await runHeartbeatScenario(root, 'crash-before-first-tick');
    const beforeFirstTick = crashed.checkpoints.find(checkpoint => checkpoint.stage === 'before-first-tick')?.evidence;

    expect(crashed.process.status).toBe(85);
    expect(beforeFirstTick).toBeDefined();
    expect(beforeFirstTick?.owner?.schema).toBe(3);
    expect(beforeFirstTick?.owner?.initialHeartbeat).toEqual({
      schema: 1,
      token: beforeFirstTick?.owner?.token,
      pid: beforeFirstTick?.owner?.pid,
      processStartIdentity: beforeFirstTick?.owner?.processStartIdentity,
      sequence: 0,
      heartbeatAtMs: Date.parse(beforeFirstTick?.owner?.createdAt ?? ''),
    });
    expect(beforeFirstTick?.heartbeatExists).toBe(false);

    const contender = spawnStaleWorker(root, 'contender', {
      NANOFLOW_LEASE_TEST_STALE_AFTER_MS: '1',
    });
    const acquired = await contender.completion;

    expect(acquired.status, acquired.stderr || acquired.stdout).toBe(0);
    expect(JSON.parse(acquired.stdout)).toEqual({ acquired: true });
    expect(readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it('completes a short status before the first heartbeat tick without heartbeat or lock residue', () => {
    const root = makeRoot();
    const canonicalRoot = realpathSync(root);

    const result = runLease(root, ['status'], {
      env: {
        ...process.env,
        NANOFLOW_LEASE_TEST_RUN_ID: `short-status-${process.pid}-${path.basename(root)}`,
        NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
        NANOFLOW_LEASE_TEST_PAUSE_POINT: 'heartbeat-protocol',
        NANOFLOW_LEASE_TEST_HEARTBEAT_FAULT: 'throw-before-temp-fsync',
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      ok: true,
      command: 'status',
      workspaceEpoch: 0,
      fencingCounter: 0,
      barrier: expect.objectContaining({ state: 'OPEN', heldEpoch: null, fence: null }),
      leases: {},
      expired: {},
    }));
    expect(readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it('renews a durable token heartbeat monotonically without mutating the canonical owner record', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runHeartbeatScenario(root, 'observe-renewal');
    const initial = result.checkpoints.find(checkpoint => checkpoint.stage === 'initial')?.evidence;
    const renewed = result.checkpoints.find(checkpoint => checkpoint.stage === 'renewed')?.evidence;

    expect(result.process.status, result.process.stderr || result.process.stdout).toBe(0);
    expect(initial).toBeDefined();
    expect(renewed).toBeDefined();
    expect(initial?.heartbeat).toEqual({
      schema: 1,
      token: expect.stringMatching(/^[a-f0-9]{64}$/),
      pid: expect.any(Number),
      processStartIdentity: {
        kind: 'node-performance-time-origin',
        unit: 'unix-ms',
        value: expect.any(Number),
      },
      sequence: expect.any(Number),
      updatedAtMs: expect.any(Number),
    });
    expect(renewed?.heartbeat.token).toBe(initial?.heartbeat.token);
    expect(renewed?.heartbeat.sequence).toBeGreaterThanOrEqual((initial?.heartbeat.sequence ?? 0) + 2);
    expect(renewed?.heartbeat.updatedAtMs).toBeGreaterThan(initial?.heartbeat.updatedAtMs ?? 0);
    expect(renewed?.canonical).toEqual(initial?.canonical);
    expect(renewed?.heartbeatName).toBe(`agent-file-leases.json.lock.heartbeat.${initial?.heartbeat.token}`);
    expect(JSON.parse(result.process.stdout)).toEqual({ directoryEntries: [] });
    expect(readdirSync(lockDirectory)).toEqual([]);
  });

  it('keeps the previous heartbeat complete when the renewer exits after temp fsync and before rename', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runHeartbeatScenario(root, 'crash-before-rename');
    const initial = result.checkpoints.find(checkpoint => checkpoint.stage === 'initial')?.evidence;
    const armed = result.checkpoints.find(checkpoint => checkpoint.stage === 'fault-armed')?.evidence;

    expect(result.process.status).toBe(86);
    expect(initial).toBeDefined();
    expect(armed?.heartbeatBytesBase64).toBe(initial?.heartbeatBytesBase64);
    expect(armed?.canonical).toEqual(initial?.canonical);
    const heartbeatPath = path.join(lockDirectory, initial!.heartbeatName);
    const persistedBytes = readFileSync(heartbeatPath);
    expect(persistedBytes.toString('base64')).toBe(initial?.heartbeatBytesBase64);
    expect(() => JSON.parse(persistedBytes.toString('utf8'))).not.toThrow();
  });

  it.each([
    ['temp fsync', 'failure-before-fsync'],
    ['atomic rename', 'failure-on-rename'],
  ] as const)('reports a heartbeat %s failure without publishing partial state or success', async (_case, mode) => {
    const root = makeRoot();

    const result = await runHeartbeatScenario(root, mode);
    const initial = result.checkpoints.find(checkpoint => checkpoint.stage === 'initial')?.evidence;
    const failed = result.checkpoints.find(checkpoint => checkpoint.stage === 'failed')?.evidence;

    expect(result.process.status).not.toBe(0);
    expect(result.process.stdout).toBe('');
    expect(result.process.stderr).toContain('heartbeat renewal failure observed');
    expect(initial).toBeDefined();
    expect(failed?.heartbeatBytesBase64).toBe(initial?.heartbeatBytesBase64);
    expect(failed?.canonical).toEqual(initial?.canonical);
    expect(readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it.each([
    ['normal exit', 'normal-exit'],
    ['crash exit', 'crash'],
  ] as const)('reclaims an expired heartbeat only after its real holder has a %s', async (_case, disposition) => {
    const root = makeRoot();

    const result = await runStaleScenario(root, {
      disposition,
      mutate: (scenarioRoot, evidence) => rewriteStaleHeartbeat(scenarioRoot, evidence),
    });

    expect(result.holder?.status).toBe(disposition === 'normal-exit' ? 0 : 85);
    expect(result.contender.status, result.contender.stderr || result.contender.stdout).toBe(0);
    expect(JSON.parse(result.contender.stdout)).toEqual({ acquired: true });
    expect(readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it('does not probe or reclaim a live holder whose heartbeat is below the stale age', async () => {
    const root = makeRoot();

    const result = await runStaleScenario(root, {
      disposition: 'live',
      staleAfterMs: 10_000,
    });

    expect(result.contender.status).not.toBe(0);
    expect(result.contender.stdout).toBe('');
    expect(result.contender.stderr).toContain('lease state is locked');
    expect(result.processProbeCount).toBe(0);
  });

  it.each([
    ['normal exit', 'normal-exit', 0],
    ['crash exit', 'crash', 85],
  ] as const)(
    'requires minimum age independently of a dead owner after %s (quality Important minimum age)',
    async (_case, disposition, expectedHolderStatus) => {
      const root = makeRoot();
      writePreservedLeaseRegistry(root, 'minimum-age-evidence.ts');
      let snapshot: StaleArtifactSnapshot | undefined;

      const result = await runStaleScenario(root, {
        disposition,
        staleAfterMs: 60_000,
        afterHolderExit: (scenarioRoot, evidence) => {
          snapshot = captureStaleArtifacts(scenarioRoot, evidence);
        },
      });

      expect.soft(result.holder?.status).toBe(expectedHolderStatus);
      expect.soft(result.contender.status).not.toBe(0);
      expect.soft(result.contender.stdout).toBe('');
      expect.soft(result.contender.stderr).toContain('lease state is locked');
      expect.soft(result.processProbeCount).toBe(0);
      expect(snapshot).toBeDefined();
      if (snapshot) expectStaleArtifactsUnchanged(snapshot);
    },
  );

  it.each([32, 64, 100])('elects exactly one q(token) reclaim and registry commit winner across %i contenders', async contenderCount => {
    const root = makeRoot();
    const registryPath = path.join(root, 'tmp', 'agent-file-leases.json');
    const now = Date.now();
    const expiresAtMs = now + 30 * 60 * 1000;
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, `${JSON.stringify({
      version: 1,
      leases: {
        'preserved-before-reclaim.ts': {
          owner: 'preserved-owner',
          claimedAt: new Date(now).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
          expiresAtMs,
        },
      },
    }, null, 2)}\n`);

    const result = await runConcurrentStaleReclaim(root, contenderCount);

    expect(result.winnerResult.status, result.winnerResult.stderr || result.winnerResult.stdout).toBe(0);
    expect(result.loserResults).toHaveLength(contenderCount - 1);
    expect(result.loserResults.every(entry => entry.status !== 0 && entry.stdout === '')).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(registry.leases['preserved-before-reclaim.ts'].owner).toBe('preserved-owner');
    expect(registry.leases['concurrent-reclaim.ts'].owner).toBe(result.winner.runId);
    expect(readdirSync(path.dirname(registryPath))).toEqual([path.basename(registryPath)]);
  }, 60_000);

  it('fails closed when fixed q(token) already points at a wrong token and inode', async () => {
    const root = makeRoot();
    const { evidence } = await prepareDeadStaleHolder(root);
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const originalBytes = readFileSync(lockPath);
    const qPath = `${lockPath}.reclaim.${evidence.heartbeat.token}`;
    const wrongQBytes = Buffer.from(JSON.stringify({
      schema: 2,
      token: 'f'.repeat(64),
      owner: 'wrong-q',
      pid: process.pid,
      processStartIdentity: evidence.heartbeat.processStartIdentity,
      createdAt: new Date().toISOString(),
    }));
    writeFileSync(qPath, wrongQBytes, { flag: 'wx' });

    const contender = spawnStaleWorker(root, 'contender');
    const result = await contender.completion;

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('lease state is locked');
    expect(readFileSync(lockPath).equals(originalBytes)).toBe(true);
    expect(readFileSync(qPath).equals(wrongQBytes)).toBe(true);
  });

  it.each([
    'advance-heartbeat-after-q-link',
    'replace-canonical-successor-before-q-link',
    'replace-canonical-successor-after-q-link',
    'replace-canonical-same-token-new-inode-after-q-link',
  ] as const)('cleans q(token) and permits an eligible retry after the deterministic %s abort race (quality Important post-q abort)', async reclaimFault => {
    const root = makeRoot();
    const { evidence } = await prepareDeadStaleHolder(root);
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const qPath = `${lockPath}.reclaim.${evidence.heartbeat.token}`;
    const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    const ownerPath = path.join(
      path.dirname(lockPath),
      `${path.basename(lockPath)}.owner.${owner.pid}.${owner.token}`,
    );
    const originalIdentity = statSync(lockPath, { bigint: true });

    const contender = spawnStaleWorker(root, 'contender', {
      NANOFLOW_LEASE_TEST_RECLAIM_FAULT: reclaimFault,
    });
    const result = await contender.completion;

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('lease state is locked');
    expect(existsSync(lockPath)).toBe(true);
    if (reclaimFault === 'advance-heartbeat-after-q-link') {
      const heartbeat = JSON.parse(readFileSync(path.join(root, 'tmp', evidence.heartbeatName), 'utf8'));
      expect(heartbeat.sequence).toBeGreaterThan(evidence.heartbeat.sequence);
      expect(heartbeat.updatedAtMs).toBeGreaterThan(Date.now() - 5_000);
    } else {
      const currentIdentity = statSync(lockPath, { bigint: true });
      expect(currentIdentity.ino).not.toBe(originalIdentity.ino);
      const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (reclaimFault === 'replace-canonical-successor-before-q-link'
        || reclaimFault === 'replace-canonical-successor-after-q-link') {
        expect(owner.token).toBe('e'.repeat(64));
      } else {
        expect(owner.token).toBe(evidence.heartbeat.token);
      }
    }
    expect(existsSync(qPath)).toBe(false);

    if (reclaimFault === 'advance-heartbeat-after-q-link') {
      rewriteStaleHeartbeat(root, evidence);
    } else {
      unlinkSync(lockPath);
      linkSync(ownerPath, lockPath);
    }

    const eligibleRetry = spawnStaleWorker(root, 'contender');
    const retried = await eligibleRetry.completion;
    expect(retried.status, retried.stderr || retried.stdout).toBe(0);
    expect(JSON.parse(retried.stdout)).toEqual({ acquired: true });
    expect(readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it.each([
    ['fail-mismatched-q-cleanup', 'successor-link'],
    ['replace-mismatched-q-before-cleanup', 'foreign-q'],
  ] as const)('fails closed and preserves evidence after %s', async (reclaimFault, qDisposition) => {
    const root = makeRoot();
    const { evidence } = await prepareDeadStaleHolder(root);
    const lockDirectory = path.join(root, 'tmp');
    const lockPath = path.join(lockDirectory, 'agent-file-leases.json.lock');
    const oldOwner = JSON.parse(readFileSync(lockPath, 'utf8'));
    const oldOwnerPath = path.join(
      lockDirectory,
      `${path.basename(lockPath)}.owner.${oldOwner.pid}.${oldOwner.token}`,
    );
    const heartbeatPath = path.join(lockDirectory, evidence.heartbeatName);
    const oldOwnerBytes = readFileSync(oldOwnerPath);
    const heartbeatBytes = readFileSync(heartbeatPath);
    const qPath = `${lockPath}.reclaim.${evidence.heartbeat.token}`;

    const contender = spawnStaleWorker(root, 'contender', {
      NANOFLOW_LEASE_TEST_RECLAIM_FAULT: reclaimFault,
    });
    const result = await contender.completion;

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('lease state is locked');
    const successorBytes = readFileSync(lockPath);
    const successor = JSON.parse(successorBytes.toString('utf8'));
    const successorIdentity = statSync(lockPath, { bigint: true });
    const qBytes = readFileSync(qPath);
    const qIdentity = statSync(qPath, { bigint: true });
    expect(successor.token).toBe('e'.repeat(64));
    if (qDisposition === 'successor-link') {
      expect({ dev: qIdentity.dev, ino: qIdentity.ino }).toEqual({
        dev: successorIdentity.dev,
        ino: successorIdentity.ino,
      });
      expect(qBytes.equals(successorBytes)).toBe(true);
    } else {
      expect({ dev: qIdentity.dev, ino: qIdentity.ino }).not.toEqual({
        dev: successorIdentity.dev,
        ino: successorIdentity.ino,
      });
      expect(qBytes.toString('utf8')).toBe('foreign-mismatched-q');
    }
    expect(readFileSync(oldOwnerPath).equals(oldOwnerBytes)).toBe(true);
    expect(readFileSync(heartbeatPath).equals(heartbeatBytes)).toBe(true);
  });

  it('reports repair-required after the q(token) winner crashes before canonical unlink (quality Important q crash)', async () => {
    const root = makeRoot();
    const registryPath = writePreservedLeaseRegistry(root, 'q-crash-evidence.ts');
    const { evidence } = await prepareDeadStaleHolder(root);
    const lockDirectory = path.join(root, 'tmp');
    const lockPath = path.join(lockDirectory, 'agent-file-leases.json.lock');
    const qPath = `${lockPath}.reclaim.${evidence.heartbeat.token}`;
    const canonicalBytes = readFileSync(lockPath);
    const owner = JSON.parse(canonicalBytes.toString('utf8'));
    const ownerPath = path.join(
      lockDirectory,
      `${path.basename(lockPath)}.owner.${owner.pid}.${owner.token}`,
    );
    const heartbeatPath = path.join(lockDirectory, evidence.heartbeatName);
    const ownerBytes = readFileSync(ownerPath);
    const heartbeatBytes = readFileSync(heartbeatPath);

    const crashing = spawnStaleWorker(root, 'contender', {
      NANOFLOW_LEASE_TEST_RECLAIM_FAULT: 'exit-after-q-link',
    });
    const crashed = await crashing.completion;

    expect(crashed.status).toBe(87);
    expect(crashed.stdout).toBe('');
    const canonicalAfterCrash = statSync(lockPath, { bigint: true });
    const qAfterCrash = statSync(qPath, { bigint: true });
    expect({ dev: qAfterCrash.dev, ino: qAfterCrash.ino }).toEqual({
      dev: canonicalAfterCrash.dev,
      ino: canonicalAfterCrash.ino,
    });
    expect(readFileSync(lockPath).equals(canonicalBytes)).toBe(true);
    expect(readFileSync(qPath).equals(canonicalBytes)).toBe(true);
    expect(readFileSync(ownerPath).equals(ownerBytes)).toBe(true);
    expect(readFileSync(heartbeatPath).equals(heartbeatBytes)).toBe(true);

    const preservedPaths = [registryPath, lockPath, qPath, ownerPath, heartbeatPath];
    const preserved = preservedPaths.map(filePath => {
      const identity = lstatSync(filePath, { bigint: true });
      return {
        filePath,
        bytes: readFileSync(filePath),
        identity: { dev: identity.dev, ino: identity.ino },
      };
    });
    const namespaceAfterCrash = readdirSync(lockDirectory).sort();

    const blocked = runLease(root, ['status']);

    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout).toBe('');
    expect(JSON.parse(blocked.stderr)).toEqual({
      ok: false,
      failure: 'repair-required',
      reason: 'existing-reclaim-anchor',
      qPath,
      canonicalToken: evidence.heartbeat.token,
      qToken: evidence.heartbeat.token,
    });
    const canonicalAfterBlocked = statSync(lockPath, { bigint: true });
    const qAfterBlocked = statSync(qPath, { bigint: true });
    expect({ dev: qAfterBlocked.dev, ino: qAfterBlocked.ino }).toEqual({
      dev: canonicalAfterBlocked.dev,
      ino: canonicalAfterBlocked.ino,
    });
    for (const artifact of preserved) {
      const identity = lstatSync(artifact.filePath, { bigint: true });
      expect.soft({ dev: identity.dev, ino: identity.ino }).toEqual(artifact.identity);
      expect.soft(readFileSync(artifact.filePath).equals(artifact.bytes)).toBe(true);
    }
    expect(readdirSync(lockDirectory).sort()).toEqual(namespaceAfterCrash);
  });

  it.each([
    ['exit-after-canonical-unlink', 88],
    ['exit-after-heartbeat-cleanup', 89],
  ] as const)('recovers idempotently after a reclaim winner %s crash', async (reclaimFault, exitCode) => {
    const root = makeRoot();
    await prepareDeadStaleHolder(root);

    const crashing = spawnStaleWorker(root, 'contender', {
      NANOFLOW_LEASE_TEST_RECLAIM_FAULT: reclaimFault,
    });
    const crashed = await crashing.completion;

    expect(crashed.status).toBe(exitCode);
    expect(crashed.stdout).toBe('');

    const helper = spawnStaleWorker(root, 'contender');
    const recovered = await helper.completion;

    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(JSON.parse(recovered.stdout)).toEqual({ acquired: true });
    expect(readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it.each([
    ['fail-q-link', 'old-lock-intact'],
    ['fail-canonical-unlink', 'old-lock-intact'],
    ['fail-post-unlink-fsync', 'token-isolated'],
    ['fail-heartbeat-unlink', 'token-isolated'],
    ['fail-owner-unlink', 'token-isolated'],
    ['fail-q-unlink', 'token-isolated'],
  ] as const)('reports %s without success and remains recoverable from %s', async (reclaimFault, expectedState) => {
    const root = makeRoot();
    await prepareDeadStaleHolder(root);
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const oldLockBytes = readFileSync(lockPath);

    const failing = spawnStaleWorker(root, 'contender', {
      NANOFLOW_LEASE_TEST_RECLAIM_FAULT: reclaimFault,
    });
    const failed = await failing.completion;

    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toBe('');
    if (expectedState === 'old-lock-intact') {
      expect(readFileSync(lockPath).equals(oldLockBytes)).toBe(true);
    } else {
      expect(existsSync(lockPath)).toBe(false);
      expect(readdirSync(path.dirname(lockPath)).some(name => name.includes('.reclaim.'))).toBe(true);
    }

    const helper = spawnStaleWorker(root, 'contender');
    const recovered = await helper.completion;

    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(JSON.parse(recovered.stdout)).toEqual({ acquired: true });
    expect(readdirSync(path.join(root, 'tmp'))).toEqual([]);
  });

  it('does not reclaim an expired heartbeat from a live matching process identity', async () => {
    const root = makeRoot();

    const result = await runStaleScenario(root, {
      disposition: 'live',
      mutate: (scenarioRoot, evidence) => rewriteStaleHeartbeat(scenarioRoot, evidence),
    });

    expect(result.contender.status).not.toBe(0);
    expect(result.contender.stdout).toBe('');
    expect(result.contender.stderr).toContain('lease state is locked');
    expect(result.processProbeCount).toBe(1);
  });

  it.runIf(process.platform === 'win32')('reclaims an expired heartbeat after a clear live-PID start-identity mismatch', async () => {
    const root = makeRoot();

    const result = await runStaleScenario(root, {
      disposition: 'live',
      mutate: (scenarioRoot, evidence) => {
        rewriteOwnerStartIdentity(
          scenarioRoot,
          evidence,
          evidence.heartbeat.processStartIdentity.value - 10 * 60 * 1000,
        );
      },
    });

    expect(result.contender.status, result.contender.stderr || result.contender.stdout).toBe(0);
    expect(JSON.parse(result.contender.stdout)).toEqual({ acquired: true });
  });

  for (const [identityCase, mismatch] of [
    ['matching start identity', false],
    ['mismatched start identity', true],
  ] as const) {
    it.runIf(process.platform === 'win32')(
      `uses the canonical system PowerShell for one real slow probe with ${identityCase}`,
      async () => {
        const root = makeRoot();
        const plants = preparePlantedPowerShellScenario(root);

        const result = await runStaleScenario(root, {
          contenderCwd: root,
          contenderEnv: plants.contenderEnv,
          disposition: 'live',
          mutate: (scenarioRoot, evidence) => {
            if (mismatch) {
              rewriteOwnerStartIdentity(
                scenarioRoot,
                evidence,
                evidence.heartbeat.processStartIdentity.value - 10 * 60 * 1000,
              );
            } else {
              rewriteStaleHeartbeat(scenarioRoot, evidence);
            }
          },
        });

        expect.soft(result.processProbeCount).toBe(1);
        if (mismatch) {
          expect.soft(result.contender.status, result.contender.stderr || result.contender.stdout).toBe(0);
          expect.soft(JSON.parse(result.contender.stdout)).toEqual({ acquired: true });
        } else {
          expect.soft(result.contender.status).not.toBe(0);
          expect.soft(result.contender.stdout).toBe('');
          expect.soft(result.contender.stderr).toContain('lease state is locked');
        }
        expectPlantedPowerShellScenarioUntouched(plants);
      },
      10_000,
    );
  }

  for (const systemLayout of ['invalid', 'missing'] as const) {
    it.runIf(process.platform === 'win32')(
      `fails closed for an expired live holder when the absolute system PowerShell layout is ${systemLayout}`,
      async () => {
        const root = makeRoot();
        const fakeSystemRoot = path.join(root, `fake-system-${systemLayout}`);
        const systemSentinelPath = path.join(fakeSystemRoot, 'system-root-sentinel.txt');
        const systemSentinelBytes = Buffer.from(`system-root-${systemLayout}-sentinel`, 'utf8');
        mkdirSync(fakeSystemRoot, { recursive: true });
        writeFileSync(systemSentinelPath, systemSentinelBytes, { flag: 'wx' });
        const systemSentinelIdentity = statSync(systemSentinelPath, { bigint: true });
        if (systemLayout === 'invalid') {
          mkdirSync(
            path.join(fakeSystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            { recursive: true },
          );
        }
        const plants = preparePlantedPowerShellScenario(root);
        plants.contenderEnv.NANOFLOW_LEASE_TEST_SYSTEM_ROOT_OVERRIDE = fakeSystemRoot;
        plants.contenderEnv.NANOFLOW_LEASE_TEST_WIN_DIR_OVERRIDE = fakeSystemRoot;

        const result = await runStaleScenario(root, {
          contenderCwd: root,
          contenderEnv: plants.contenderEnv,
          disposition: 'live',
          mutate: (scenarioRoot, evidence) => rewriteStaleHeartbeat(scenarioRoot, evidence),
        });

        expect.soft(result.contender.status).not.toBe(0);
        expect.soft(result.contender.stdout).toBe('');
        expect.soft(result.contender.stderr).toContain('lease state is locked');
        expect.soft(result.processProbeCount).toBe(0);
        expect.soft(readFileSync(systemSentinelPath).equals(systemSentinelBytes)).toBe(true);
        const systemSentinelAfter = statSync(systemSentinelPath, { bigint: true });
        expect.soft({ dev: systemSentinelAfter.dev, ino: systemSentinelAfter.ino }).toEqual({
          dev: systemSentinelIdentity.dev,
          ino: systemSentinelIdentity.ino,
        });
        expectPlantedPowerShellScenarioUntouched(plants);
      },
      10_000,
    );
  }

  it.each([
    ['EPERM liveness probe', 'eperm'],
    ['unobserved start identity', 'unobserved'],
  ] as const)('fails closed for an expired live holder with %s', async (_case, processProbeMode) => {
    const root = makeRoot();

    const result = await runStaleScenario(root, {
      disposition: 'live',
      processProbeMode,
      mutate: (scenarioRoot, evidence) => rewriteStaleHeartbeat(scenarioRoot, evidence),
    });

    expect(result.contender.status).not.toBe(0);
    expect(result.contender.stdout).toBe('');
    expect(result.contender.stderr).toContain('lease state is locked');
  });

  it.each([
    ['a legacy schema-2 owner with a complete stale heartbeat', (root: string) => {
      rewriteOwnerMetadata(root, owner => {
        owner.schema = 2;
        delete owner.initialHeartbeat;
      });
    }],
    ['a schema-3 heartbeat with an extra top-level key', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.unexpected = true;
      });
    }],
    ['a schema-3 heartbeat with an extra process-start key', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.processStartIdentity.unexpected = true;
      });
    }],
    ['a fractional heartbeat sequence', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.sequence = 1.5;
      });
    }],
    ['an unsafe heartbeat sequence', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.sequence = Number.MAX_SAFE_INTEGER + 1;
      });
    }],
    ['a negative heartbeat sequence', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.sequence = -1;
      });
    }],
    ['a nonmonotonic heartbeat sequence', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.sequence = 0;
      });
    }],
    ['a fractional heartbeat updatedAtMs', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.updatedAtMs += 0.5;
      });
    }],
    ['an unsafe heartbeat updatedAtMs', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.updatedAtMs = Number.MAX_SAFE_INTEGER + 1;
      });
    }],
    ['a negative heartbeat updatedAtMs', (root: string, evidence: HeartbeatEvidence) => {
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.updatedAtMs = -1;
      });
    }],
    ['a heartbeat updatedAtMs equal to the initial heartbeat', (root: string, evidence: HeartbeatEvidence) => {
      const owner = JSON.parse(readFileSync(
        path.join(root, 'tmp', 'agent-file-leases.json.lock'),
        'utf8',
      ));
      rewriteHeartbeatMetadata(root, evidence, heartbeat => {
        heartbeat.updatedAtMs = owner.initialHeartbeat.heartbeatAtMs;
      });
    }],
  ] as const)('fails closed without destructive reclaim for %s', async (_case, mutate) => {
    const root = makeRoot();
    const { evidence } = await prepareDeadStaleHolder(root);
    mutate(root, evidence);
    const snapshot = captureStaleArtifacts(root, evidence);

    const contender = spawnStaleWorker(root, 'contender');
    const result = await contender.completion;

    expect.soft(result.status).not.toBe(0);
    expect.soft(result.stdout).toBe('');
    expect.soft(result.stderr).toContain('lease state is locked');
    expect.soft(contender.processProbeCount).toBe(0);
    expectStaleArtifactsUnchanged(snapshot);
  });

  it.each([
    ['malformed heartbeat', (root: string, evidence: HeartbeatEvidence) => {
      writeFileSync(path.join(root, 'tmp', evidence.heartbeatName), 'not-json');
    }],
    ['missing heartbeat', (root: string, evidence: HeartbeatEvidence) => {
      unlinkSync(path.join(root, 'tmp', evidence.heartbeatName));
    }],
    ['legacy schema-2 owner with missing heartbeat', (root: string, evidence: HeartbeatEvidence) => {
      rewriteOwnerMetadata(root, owner => {
        owner.schema = 2;
        delete owner.initialHeartbeat;
      });
      unlinkSync(path.join(root, 'tmp', evidence.heartbeatName));
    }],
    ['schema-3 owner with incomplete seq0 and missing heartbeat', (root: string, evidence: HeartbeatEvidence) => {
      rewriteOwnerMetadata(root, owner => {
        const createdAtMs = Date.parse(owner.createdAt);
        owner.schema = 3;
        owner.initialHeartbeat = {
          schema: 1,
          token: owner.token,
          pid: owner.pid,
          processStartIdentity: owner.processStartIdentity,
          sequence: 0,
          heartbeatAtMs: createdAtMs,
        };
        delete owner.initialHeartbeat.pid;
      });
      unlinkSync(path.join(root, 'tmp', evidence.heartbeatName));
    }],
    ['age-only heartbeat', (root: string, evidence: HeartbeatEvidence) => {
      writeFileSync(path.join(root, 'tmp', evidence.heartbeatName), JSON.stringify({
        token: evidence.heartbeat.token,
        updatedAtMs: Date.now() - 10 * 60 * 1000,
      }));
    }],
    ['legacy canonical owner', (root: string, evidence: HeartbeatEvidence) => {
      const canonicalPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
      writeFileSync(canonicalPath, JSON.stringify({
        owner: 'legacy-holder',
        pid: evidence.heartbeat.pid,
        createdAtMs: Date.now() - 10 * 60 * 1000,
      }));
      rewriteStaleHeartbeat(root, evidence);
    }],
  ] as const)('fails closed without age-only reclaim for a %s', async (_case, mutate) => {
    const root = makeRoot();

    const result = await runStaleScenario(root, {
      disposition: 'live',
      mutate,
    });

    expect(result.contender.status).not.toBe(0);
    expect(result.contender.stdout).toBe('');
    expect(result.contender.stderr).toContain('lease state is locked');
  });

  it('rejects a provisional helper fault without IPC before any namespace mutation', () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');
    const registryPath = path.join(lockDirectory, 'agent-file-leases.json');
    const lockPath = `${registryPath}.lock`;
    const registryBytes = Buffer.from('{"version":1,"leases":{}}\n', 'utf8');
    const canonicalBytes = Buffer.from('provisional-no-ipc-canonical-sentinel', 'utf8');
    mkdirSync(lockDirectory, { recursive: true });
    writeFileSync(registryPath, registryBytes, { flag: 'wx' });
    writeFileSync(lockPath, canonicalBytes, { flag: 'wx' });
    const registryIdentity = statSync(registryPath, { bigint: true });
    const canonicalIdentity = statSync(lockPath, { bigint: true });
    const entriesBefore = readdirSync(lockDirectory).sort();

    const result = runProvisionalHelperFaultWithoutIpc(root);

    expect.soft(result.status).not.toBe(0);
    expect.soft(result.stderr).toContain('lease test seam requires IPC');
    expect.soft(result.stderr).not.toContain('provisional owner helper test fault');
    expect.soft(readFileSync(registryPath).equals(registryBytes)).toBe(true);
    expect.soft(readFileSync(lockPath).equals(canonicalBytes)).toBe(true);
    const registryAfter = statSync(registryPath, { bigint: true });
    const canonicalAfter = statSync(lockPath, { bigint: true });
    expect.soft({ dev: registryAfter.dev, ino: registryAfter.ino }).toEqual({
      dev: registryIdentity.dev,
      ino: registryIdentity.ino,
    });
    expect.soft({ dev: canonicalAfter.dev, ino: canonicalAfter.ino }).toEqual({
      dev: canonicalIdentity.dev,
      ino: canonicalIdentity.ino,
    });
    expect.soft(readdirSync(lockDirectory).sort()).toEqual(entriesBefore);
    expect.soft(entriesBefore.some(name => name.includes('.owner.') || name.endsWith('.tmp'))).toBe(false);
  });

  it.each([
    ['empty', '', 'agent-file-lease worker requires a complete test checkpoint'],
    ['malformed', 'malformed/run id', 'lease test seam requires IPC, runId'],
  ] as const)(
    'rejects an %s provisional helper runId over active IPC before namespace mutation',
    async (_case, testRunId, expectedError) => {
      const root = makeRoot();
      const lockDirectory = path.join(root, 'tmp');
      const registryPath = path.join(lockDirectory, 'agent-file-leases.json');
      const lockPath = `${registryPath}.lock`;
      const registryBytes = Buffer.from('{"version":1,"leases":{}}\n', 'utf8');
      const canonicalBytes = Buffer.from('provisional-invalid-run-id-canonical-sentinel', 'utf8');
      mkdirSync(lockDirectory, { recursive: true });
      writeFileSync(registryPath, registryBytes, { flag: 'wx' });
      writeFileSync(lockPath, canonicalBytes, { flag: 'wx' });
      const registryIdentity = statSync(registryPath, { bigint: true });
      const canonicalIdentity = statSync(lockPath, { bigint: true });
      const entriesBefore = readdirSync(lockDirectory).sort();

      const result = await runOwnerLockScenario(root, {
        allowMissingCheckpoint: true,
        onCheckpoint: () => undefined,
        pausePoint: 'after-owner-helper-created-before-publication',
        provisionalHelperFaultMode: 'throw',
        testRunId,
      });

      expect.soft(result.status).not.toBe(0);
      expect.soft(result.stderr).toContain(expectedError);
      expect.soft(result.stderr).not.toContain('provisional owner helper test fault');
      expect.soft(readFileSync(registryPath).equals(registryBytes)).toBe(true);
      expect.soft(readFileSync(lockPath).equals(canonicalBytes)).toBe(true);
      const registryAfter = statSync(registryPath, { bigint: true });
      const canonicalAfter = statSync(lockPath, { bigint: true });
      expect.soft({ dev: registryAfter.dev, ino: registryAfter.ino }).toEqual({
        dev: registryIdentity.dev,
        ino: registryIdentity.ino,
      });
      expect.soft({ dev: canonicalAfter.dev, ino: canonicalAfter.ino }).toEqual({
        dev: canonicalIdentity.dev,
        ino: canonicalIdentity.ino,
      });
      expect.soft(readdirSync(lockDirectory).sort()).toEqual(entriesBefore);
      expect.soft(entriesBefore.some(name => name.includes('.owner.') || name.endsWith('.tmp'))).toBe(false);
    },
  );

  it.each([
    {
      caseName: 'a disconnected active IPC channel',
      disconnectBeforeAcquire: true,
      pausePoint: 'after-owner-helper-created-before-publication',
    },
    {
      caseName: 'the wrong owner-lock stage',
      disconnectBeforeAcquire: false,
      pausePoint: 'after-owner-lock-acquired',
    },
  ] as const)(
    'rejects the provisional helper seam with $caseName before namespace mutation',
    async ({ disconnectBeforeAcquire, pausePoint }) => {
      const root = makeRoot();
      const lockDirectory = path.join(root, 'tmp');
      const registryPath = path.join(lockDirectory, 'agent-file-leases.json');
      const lockPath = `${registryPath}.lock`;
      const registryBytes = Buffer.from('{"version":1,"leases":{}}\n', 'utf8');
      const canonicalBytes = Buffer.from('provisional-strict-context-canonical-sentinel', 'utf8');
      mkdirSync(lockDirectory, { recursive: true });
      writeFileSync(registryPath, registryBytes, { flag: 'wx' });
      writeFileSync(lockPath, canonicalBytes, { flag: 'wx' });
      const registryIdentity = statSync(registryPath, { bigint: true });
      const canonicalIdentity = statSync(lockPath, { bigint: true });
      const entriesBefore = readdirSync(lockDirectory).sort();

      const result = await runOwnerLockScenario(root, {
        allowMissingCheckpoint: true,
        disconnectBeforeAcquire,
        onCheckpoint: () => undefined,
        pausePoint,
        provisionalHelperFaultMode: 'throw',
      });

      expect.soft(result.status).not.toBe(0);
      expect.soft(result.stderr).toContain('lease test seam requires IPC, runId, exact stage');
      expect.soft(result.stderr).not.toContain('provisional owner helper test fault');
      expect.soft(readFileSync(registryPath).equals(registryBytes)).toBe(true);
      expect.soft(readFileSync(lockPath).equals(canonicalBytes)).toBe(true);
      const registryAfter = statSync(registryPath, { bigint: true });
      const canonicalAfter = statSync(lockPath, { bigint: true });
      expect.soft({ dev: registryAfter.dev, ino: registryAfter.ino }).toEqual({
        dev: registryIdentity.dev,
        ino: registryIdentity.ino,
      });
      expect.soft({ dev: canonicalAfter.dev, ino: canonicalAfter.ino }).toEqual({
        dev: canonicalIdentity.dev,
        ino: canonicalIdentity.ino,
      });
      expect.soft(readdirSync(lockDirectory).sort()).toEqual(entriesBefore);
    },
  );

  it('removes a provisional helper when acquisition fails immediately after creation', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runProvisionalHelperFaultScenario(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('provisional owner helper test fault');
    expect(readdirSync(lockDirectory)).toEqual([]);
  });

  it('keeps provisional acquisition failure primary when helper cleanup detects a successor', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runProvisionalHelperFaultScenario(root, 'replace-helper');
    const observed = result.stdout ? JSON.parse(result.stdout) : {};

    expect.soft(result.status).not.toBe(0);
    expect.soft(observed.message).toBe('provisional owner helper test fault');
    expect.soft(observed.causeMessage).toContain('owner helper ownership changed before cleanup');
    expect.soft(result.stderr).toContain('provisional owner helper test fault');
    const residue = readdirSync(lockDirectory);
    expect.soft(residue).toHaveLength(1);
    if (residue.length === 1) {
      expect(readFileSync(path.join(lockDirectory, residue[0]), 'utf8')).toBe('provisional-helper-successor');
    }
  });

  it.runIf(process.platform === 'win32')('does not execute a planted powershell.exe from the child working directory', () => {
    const root = makeRoot();
    copyFileSync(process.execPath, path.join(root, 'powershell.exe'));

    const claim = runLease(root, ['claim', '--owner', 'agent-a', 'a.ts'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: root,
      },
    });

    expect(claim.status, claim.stderr || claim.stdout).toBe(0);
  });

  it.runIf(process.platform === 'win32')('claims when PATH contains no PowerShell provider', () => {
    const root = makeRoot();

    const claim = runLease(root, ['claim', '--owner', 'agent-a', 'a.ts'], {
      env: {
        ...process.env,
        PATH: root,
      },
    });

    expect(claim.status, claim.stderr || claim.stdout).toBe(0);
  });

  it('rejects a timed-out synchronous child without accepting partial JSON output', () => {
    const root = makeRoot();
    const blockingScriptPath = path.join(root, 'partial-json-blocker.cjs');
    writeFileSync(
      blockingScriptPath,
      "require('node:fs').writeSync(1, '{\"ok\":'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n",
    );
    let returned: ReturnType<typeof spawnSync> | undefined;
    let observedError: (Error & { code?: string; partialStdout?: string }) | undefined;

    try {
      returned = runLease(root, ['status'], {
        leaseScriptPath: blockingScriptPath,
        timeout: PARTIAL_JSON_BLOCKER_TIMEOUT_MS,
      });
    } catch (error) {
      observedError = error as Error & { code?: string; partialStdout?: string };
    }

    expect.soft(observedError?.message ?? '').toContain('timed out');
    expect.soft(observedError?.code).toBe('ETIMEDOUT');
    expect.soft(returned).toBeUndefined();
    const partialStdout = observedError?.partialStdout ?? String(returned?.stdout ?? '');
    expect(partialStdout).toBe('{"ok":');
    expect(() => JSON.parse(partialStdout)).toThrow();
  });

  it('caps explicit synchronous child timeouts and rejects signal or null-status results', () => {
    expect(leaseSpawnSyncTimeout()).toBe(LEASE_SPAWN_SYNC_TIMEOUT_MS);
    expect(leaseSpawnSyncTimeout(250)).toBe(250);
    expect(leaseSpawnSyncTimeout(60_000)).toBe(LEASE_SPAWN_SYNC_TIMEOUT_MS);
    expect(() => leaseSpawnSyncTimeout(0)).toThrow('positive finite number');

    const signaled = {
      error: undefined,
      signal: 'SIGTERM',
      status: null,
      stderr: '',
      stdout: '',
    } as unknown as SpawnSyncReturns<string>;
    const missingStatus = {
      error: undefined,
      signal: null,
      status: null,
      stderr: '',
      stdout: '',
    } as unknown as SpawnSyncReturns<string>;

    expect(() => requireCompletedSpawnSync(signaled, 'signal-case', 250)).toThrow(
      'signal-case terminated by signal SIGTERM',
    );
    expect(() => requireCompletedSpawnSync(missingStatus, 'null-status-case', 250)).toThrow(
      'null-status-case completed without an exit status',
    );
  });

  it('executes callbacks through the exported state-lock protocol', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      onCheckpoint: () => undefined,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readdirSync(lockDirectory)).toEqual([]);
  });

  it('holds the state lock through async callback and transaction settlement', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const registryPath = path.join(root, 'tmp', 'agent-file-leases.json');

    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      protocolMode: 'async-success',
      onCheckpoint: () => undefined,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      callbackResult: 'async-state-lock-callback-result',
      heldBeforeCallbackAwait: true,
      heldAfterCallbackAwait: true,
      heldAfterTransactionAwait: true,
      registryBeforeTransactionSettlement: false,
      registryAfterTransactionSettlement: true,
      heldBeforeCallbackSettlement: true,
      heldAfterCallbackSettlement: false,
      registryAfterCallbackSettlement: true,
    });
    expect(existsSync(lockPath)).toBe(false);
    expect(JSON.parse(readFileSync(registryPath, 'utf8')).leases['async.ts'].owner).toBe('state-lock-protocol-worker');
  });

  it('rejects a registry transaction whose root does not match the OwnerRef root', async () => {
    const ownerRoot = makeRoot();
    const transactionRoot = makeRoot();
    const transactionDirectory = path.join(transactionRoot, 'tmp');
    const transactionRegistry = path.join(transactionDirectory, 'agent-file-leases.json');
    const originalRegistryBytes = '{\n  "version": 1,\n  "leases": {\n    "preserved.ts": { "owner": "preserved-owner" }\n  }\n}\n';
    mkdirSync(transactionDirectory, { recursive: true });
    writeFileSync(transactionRegistry, originalRegistryBytes);
    const originalDirectoryEntries = readdirSync(transactionDirectory).sort();

    const result = await runOwnerLockScenario(ownerRoot, {
      onCheckpoint: () => undefined,
      runTransaction: true,
      transactionRoot,
    });

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(result.stderr).toContain('OwnerRef root does not match transaction root');
    expect.soft(readFileSync(transactionRegistry, 'utf8')).toBe(originalRegistryBytes);
    expect(readdirSync(transactionDirectory).sort()).toEqual(originalDirectoryEntries);
  });

  it('does not rename the registry after the canonical lock namespace is replaced at the pre-rename checkpoint', async () => {
    const root = makeRoot();
    const directory = path.join(root, 'tmp');
    const registryPath = path.join(directory, 'agent-file-leases.json');
    const lockPath = `${registryPath}.lock`;
    const successorBytes = Buffer.from('{"schema":2,"token":"pre-rename-successor"}', 'utf8');

    const result = await runOwnerLockScenario(root, {
      pausePoint: 'after-registry-temp-fsync-before-rename',
      runTransaction: true,
      onCheckpoint: () => {
        expect(readFileSync(lockPath).equals(successorBytes)).toBe(true);
      },
    });

    expect(result.status, result.stderr || result.stdout).not.toBe(0);
    expect(readFileSync(lockPath).equals(successorBytes)).toBe(true);
    expect(existsSync(registryPath)).toBe(false);
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects the pre-rename fault after IPC disconnect before mutating canonical or registry state', async () => {
    const root = makeRoot();
    const directory = path.join(root, 'tmp');
    const registryPath = path.join(directory, 'agent-file-leases.json');
    const registryBytes = Buffer.from('{"version":1,"leases":{}}\n', 'utf8');
    mkdirSync(directory, { recursive: true });
    writeFileSync(registryPath, registryBytes, { flag: 'wx' });

    const result = await runOwnerLockScenario(root, {
      allowMissingCheckpoint: true,
      disconnectBeforeTransaction: true,
      pausePoint: 'after-registry-temp-fsync-before-rename',
      probeTransactionFailureState: true,
      runTransaction: true,
      onCheckpoint: () => undefined,
    });
    const observed = result.stdout ? JSON.parse(result.stdout) : {};
    const evidence = observed.transactionFailureEvidence;

    expect.soft(result.status).not.toBe(0);
    expect.soft(result.stderr).toContain('lease test seam requires IPC');
    expect.soft(evidence).toBeDefined();
    expect.soft(evidence?.after?.canonical).toEqual(evidence?.before?.canonical);
    expect.soft(evidence?.after?.registry).toEqual(evidence?.before?.registry);
    expect.soft(evidence?.after?.entries).toEqual(evidence?.before?.entries);
    expect.soft(evidence?.after?.entries?.some((name: string) => name.endsWith('.tmp'))).toBe(false);
    expect.soft(Buffer.from(evidence?.before?.registry?.bytesBase64 ?? '', 'base64').equals(registryBytes))
      .toBe(true);
    expect.soft(readFileSync(registryPath).equals(registryBytes)).toBe(true);
  });

  it('preserves the callback error when release also loses canonical ownership', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const evidencePath = path.join(root, 'state-lock-double-error-evidence.json');
    const successorBytes = Buffer.from('{"schema":2,"token":"double-error-successor"}', 'utf8');

    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      protocolMode: 'double-error',
      onCheckpoint: () => undefined,
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(lockPath).equals(successorBytes)).toBe(true);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const successorStat = statSync(lockPath, { bigint: true });
    expect({
      dev: successorStat.dev.toString(),
      ino: successorStat.ino.toString(),
      mtimeNs: successorStat.mtimeNs.toString(),
    }).toEqual(evidence);
    expect(readdirSync(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
    const observed = JSON.parse(result.stdout);
    expect(observed.message).toBe('state-lock-callback-primary-sentinel');
    expect(observed.causeMessage).toContain('ownership changed before release');
    expect(result.stderr).toContain('state-lock-callback-primary-sentinel');
  });

  it('refuses to release a successor that replaced the acquired canonical lock', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const successorBytes = Buffer.from('{"schema":2,"token":"successor"}', 'utf8');
    let successorIdentity: { dev: bigint; ino: bigint; mtimeNs: bigint } | undefined;

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, successorBytes, { flag: 'wx' });
        const stat = statSync(lockPath, { bigint: true });
        successorIdentity = { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs };
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ownership changed before release');
    expect(readFileSync(lockPath).equals(successorBytes)).toBe(true);
    const afterRelease = statSync(lockPath, { bigint: true });
    expect({
      dev: afterRelease.dev,
      ino: afterRelease.ino,
      mtimeNs: afterRelease.mtimeNs,
    }).toEqual(successorIdentity);
    expect(readdirSync(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
  });

  it('fails closed and preserves evidence when the canonical lock is a symlink to its owner helper', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    let ownerPath: string | undefined;

    const result = await runOwnerLockScenario(root, {
      probeReleaseStateAfterFailure: true,
      onCheckpoint: () => {
        const ownerFiles = readdirSync(path.dirname(lockPath))
          .filter(name => name.startsWith(`${path.basename(lockPath)}.owner.`));
        expect(ownerFiles).toHaveLength(1);
        ownerPath = path.join(path.dirname(lockPath), ownerFiles[0]);
        unlinkSync(lockPath);
        symlinkSync(ownerPath, lockPath, 'file');
      },
    });

    expect(result.status, result.stderr || result.stdout).not.toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.releaseErrorFailure).toBe('non-regular-file');
    expect(observed.stateProbeError).toContain('already repair-required');
    expect(observed.retryReleaseError).toContain('already repair-required');
    expect(ownerPath).toBeDefined();
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(lockPath)).toBe(ownerPath);
    expect(existsSync(ownerPath!)).toBe(true);
    const residue = readdirSync(path.dirname(lockPath));
    const heartbeatFiles = residue.filter(name => name.startsWith(`${path.basename(lockPath)}.heartbeat.`));
    expect(heartbeatFiles).toHaveLength(0);
    expect(residue.sort()).toEqual([
      path.basename(lockPath),
      path.basename(ownerPath!),
    ].sort());
  });

  it('fails closed and preserves evidence when the canonical lock is a dangling symlink', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const danglingTarget = path.join(root, 'missing-owner-target');
    let ownerPath: string | undefined;

    const result = await runOwnerLockScenario(root, {
      probeReleaseStateAfterFailure: true,
      onCheckpoint: () => {
        const ownerFiles = readdirSync(path.dirname(lockPath))
          .filter(name => name.startsWith(`${path.basename(lockPath)}.owner.`));
        expect(ownerFiles).toHaveLength(1);
        ownerPath = path.join(path.dirname(lockPath), ownerFiles[0]);
        unlinkSync(lockPath);
        symlinkSync(danglingTarget, lockPath, 'file');
      },
    });

    expect(result.status, result.stderr || result.stdout).not.toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.releaseErrorFailure).toBe('non-regular-file');
    expect(observed.stateProbeError).toContain('already repair-required');
    expect(observed.retryReleaseError).toContain('already repair-required');
    expect(ownerPath).toBeDefined();
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(lockPath)).toBe(danglingTarget);
    expect(existsSync(ownerPath!)).toBe(true);
    const residue = readdirSync(path.dirname(lockPath));
    const heartbeatFiles = residue.filter(name => name.startsWith(`${path.basename(lockPath)}.heartbeat.`));
    expect(heartbeatFiles).toHaveLength(0);
    expect(residue.sort()).toEqual([
      path.basename(lockPath),
      path.basename(ownerPath!),
    ].sort());
  });

  it('cleans its helper after canonical absence is confirmed by ENOENT', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => {
        unlinkSync(lockPath);
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readdirSync(path.dirname(lockPath))).toEqual([]);
  });

  it('keeps canonical ownership failure primary when helper cleanup also fails', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const canonicalSuccessorBytes = Buffer.from('{"schema":2,"token":"canonical-successor"}', 'utf8');
    const helperSuccessorBytes = Buffer.from('helper-successor', 'utf8');
    let ownerPath: string | undefined;

    const result = await runOwnerLockScenario(root, {
      probeReleaseStateAfterFailure: true,
      onCheckpoint: () => {
        const ownerFiles = readdirSync(path.dirname(lockPath))
          .filter(name => name.startsWith(`${path.basename(lockPath)}.owner.`));
        expect(ownerFiles).toHaveLength(1);
        ownerPath = path.join(path.dirname(lockPath), ownerFiles[0]);
        unlinkSync(ownerPath);
        writeFileSync(ownerPath, helperSuccessorBytes, { flag: 'wx' });
        unlinkSync(lockPath);
        writeFileSync(lockPath, canonicalSuccessorBytes, { flag: 'wx' });
      },
    });

    const observed = JSON.parse(result.stdout);
    expect(result.status).not.toBe(0);
    expect(observed.releaseError).toContain('ownership changed before release');
    expect(observed.releaseErrorCause).toContain('owner helper ownership changed before cleanup');
    expect(observed.stateProbeError).toContain('already repair-required');
    expect(observed.retryReleaseError).toContain('already repair-required');
    expect(result.stderr).toContain('ownership changed before release');
    expect(readFileSync(lockPath).equals(canonicalSuccessorBytes)).toBe(true);
    expect(ownerPath).toBeDefined();
    expect(readFileSync(ownerPath!).equals(helperSuccessorBytes)).toBe(true);
  });

  it('does not clean an owner helper path that was replaced by a successor', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const successorBytes = Buffer.from('owner-helper-successor', 'utf8');
    let ownerPath: string | undefined;
    let successorIdentity: { dev: bigint; ino: bigint; mtimeNs: bigint } | undefined;

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => {
        const directory = path.dirname(lockPath);
        const ownerFiles = readdirSync(directory)
          .filter(name => name.startsWith(`${path.basename(lockPath)}.owner.`));
        expect(ownerFiles).toHaveLength(1);
        ownerPath = path.join(directory, ownerFiles[0]);
        unlinkSync(ownerPath);
        writeFileSync(ownerPath, successorBytes, { flag: 'wx' });
        const stat = statSync(ownerPath, { bigint: true });
        successorIdentity = { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs };
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('owner helper ownership changed before cleanup');
    expect(existsSync(lockPath)).toBe(false);
    expect(ownerPath).toBeDefined();
    expect(readFileSync(ownerPath!).equals(successorBytes)).toBe(true);
    const afterRelease = statSync(ownerPath!, { bigint: true });
    expect({
      dev: afterRelease.dev,
      ino: afterRelease.ino,
      mtimeNs: afterRelease.mtimeNs,
    }).toEqual(successorIdentity);
    expect(readdirSync(path.dirname(lockPath))).toEqual([path.basename(ownerPath!)]);
  });

  it('does not commit a registry transaction after the OwnerRef loses canonical ownership', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const registryPath = path.join(root, 'tmp', 'agent-file-leases.json');
    const successorBytes = Buffer.from('{"schema":2,"token":"transaction-successor"}', 'utf8');
    let successorIdentity: { dev: bigint; ino: bigint; mtimeNs: bigint } | undefined;

    const result = await runOwnerLockScenario(root, {
      runTransaction: true,
      onCheckpoint: () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, successorBytes, { flag: 'wx' });
        const stat = statSync(lockPath, { bigint: true });
        successorIdentity = { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs };
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ownership changed before release');
    expect(existsSync(registryPath)).toBe(false);
    expect(readFileSync(lockPath).equals(successorBytes)).toBe(true);
    const afterTransaction = statSync(lockPath, { bigint: true });
    expect({
      dev: afterTransaction.dev,
      ino: afterTransaction.ino,
      mtimeNs: afterTransaction.mtimeNs,
    }).toEqual(successorIdentity);
    expect(readdirSync(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
  });

  it('refuses to release when canonical metadata no longer matches the OwnerRef digest and token', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const tamperedBytes = Buffer.from('{"schema":2,"token":"tampered"}', 'utf8');
    let ownerPath: string | undefined;
    let tamperedIdentity: { dev: bigint; ino: bigint; mtimeNs: bigint } | undefined;

    const result = await runOwnerLockScenario(root, {
      probeReleaseStateAfterFailure: true,
      onCheckpoint: () => {
        const ownerFiles = readdirSync(path.dirname(lockPath))
          .filter(name => name.startsWith(`${path.basename(lockPath)}.owner.`));
        expect(ownerFiles).toHaveLength(1);
        ownerPath = path.join(path.dirname(lockPath), ownerFiles[0]);
        writeFileSync(lockPath, tamperedBytes);
        const stat = statSync(lockPath, { bigint: true });
        tamperedIdentity = { dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs };
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('metadata changed before release');
    const observed = JSON.parse(result.stdout);
    expect(observed.releaseError).toContain('metadata changed before release');
    expect.soft(observed.retryReleaseError).toContain('already repair-required');
    expect(readFileSync(lockPath).equals(tamperedBytes)).toBe(true);
    expect(ownerPath).toBeDefined();
    const helperExists = existsSync(ownerPath!);
    expect.soft(helperExists).toBe(true);
    const afterRelease = statSync(lockPath, { bigint: true });
    expect({
      dev: afterRelease.dev,
      ino: afterRelease.ino,
      mtimeNs: afterRelease.mtimeNs,
    }).toEqual(tamperedIdentity);
    if (helperExists) {
      expect(readFileSync(ownerPath!).equals(tamperedBytes)).toBe(true);
      const helperAfterRelease = statSync(ownerPath!, { bigint: true });
      expect(helperAfterRelease.dev).toBe(afterRelease.dev);
      expect(helperAfterRelease.ino).toBe(afterRelease.ino);
    }
    const residue = readdirSync(path.dirname(lockPath));
    const heartbeatFiles = residue.filter(name => name.startsWith(`${path.basename(lockPath)}.heartbeat.`));
    expect.soft(heartbeatFiles).toHaveLength(0);
    expect.soft(residue.sort()).toEqual([
      path.basename(lockPath),
      path.basename(ownerPath!),
    ].sort());
  });

  it('preserves helper evidence and exposes retryable state after a real unlink failure', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => undefined,
      probeReleaseStateAfterFailure: true,
      releaseFault: 'replace-canonical-with-directory-before-unlink',
    });
    const observed = result.stdout ? JSON.parse(result.stdout) : {};

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(observed.releaseErrorCode).toMatch(/^(?:EISDIR|EPERM)$/);
    expect.soft(observed.stateProbeError).toContain('already retryable');
    expect.soft(observed.evidenceAfterFirstFailure).toEqual(expect.objectContaining({
      canonicalIsDirectory: true,
      helperExists: true,
      heartbeatExistedBeforeRelease: false,
      heartbeatNames: [],
      heartbeatRestored: false,
    }));
    expect.soft(observed.releaseErrorCause).toContain('not a regular file');
    expect.soft(observed.retryReleaseError).toBeNull();
    expect(readdirSync(lockDirectory)).toEqual([]);
  });

  it('restores the canonical owner when quarantine unlink fails and leaves no quarantine residue', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => undefined,
      probeReleaseStateAfterFailure: true,
      releaseFault: 'throw-on-quarantine-unlink',
    });
    const observed = result.stdout ? JSON.parse(result.stdout) : {};

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(observed.releaseErrorCode).toBe('EIO');
    expect.soft(observed.releaseError).toContain('quarantine unlink failure');
    expect.soft(observed.stateProbeError).toContain('already retryable');
    expect.soft(observed.evidenceAfterFirstFailure).toEqual(expect.objectContaining({
      canonicalIsDirectory: false,
      canonicalIsSymbolicLink: false,
      helperExists: true,
      quarantineNames: [],
    }));
    expect.soft(observed.retryReleaseError).toBeNull();
    expect(readdirSync(lockDirectory)).toEqual([]);
  });

  it('restores a quarantined successor to canonical and never deletes it on retry', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');
    const lockPath = path.join(lockDirectory, 'agent-file-leases.json.lock');
    const successorBytes = '{"schema":2,"token":"release-quarantine-successor"}';

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => undefined,
      probeReleaseStateAfterFailure: true,
      releaseFault: 'replace-quarantine-with-successor-before-readback',
    });
    const observed = result.stdout ? JSON.parse(result.stdout) : {};

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(observed.releaseErrorFailure).toBe('ownership-changed');
    expect.soft(observed.releaseError).toContain('ownership changed during release');
    expect.soft(observed.stateProbeError).toContain('already retryable');
    expect.soft(observed.evidenceAfterFirstFailure.quarantineNames).toEqual([]);
    expect.soft(observed.retryReleaseError).toContain('ownership changed before release');
    expect.soft(readFileSync(lockPath, 'utf8')).toBe(successorBytes);
    expect(readdirSync(lockDirectory)).toEqual([path.basename(lockPath)]);
  });

  it('recovers a prior heartbeat failure and renews while canonical unlink is retryable', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => undefined,
      heartbeatFault: 'throw-before-temp-fsync',
      heartbeatIntervalMs: 10,
      probeReleaseStateAfterFailure: true,
      releaseFault: 'throw-on-canonical-unlink',
      waitForHeartbeatFailureBeforeRelease: true,
    });
    const observed = result.stdout ? JSON.parse(result.stdout) : {};

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(observed.releaseErrorCode).toBe('EIO');
    expect.soft(observed.releaseErrorCause).toContain('injected heartbeat syscall failure');
    expect.soft(observed.stateProbeError).toContain('already retryable');
    expect.soft(observed.evidenceAfterFirstFailure).toEqual(expect.objectContaining({
      canonicalIsDirectory: false,
      helperExists: true,
      heartbeatFailureBeforeRelease: expect.stringContaining('injected heartbeat syscall failure'),
      heartbeatExistedBeforeRelease: false,
      heartbeatRestored: true,
      heartbeatNames: [expect.stringMatching(/^agent-file-leases\.json\.lock\.heartbeat\.[a-f0-9]{64}$/)],
      retryableHeartbeatAdvance: expect.objectContaining({
        initialSequence: expect.any(Number),
        renewedSequence: expect.any(Number),
        initialUpdatedAtMs: expect.any(Number),
        renewedUpdatedAtMs: expect.any(Number),
      }),
    }));
    expect.soft(observed.evidenceAfterFirstFailure.retryableHeartbeatAdvance.renewedSequence)
      .toBeGreaterThanOrEqual(observed.evidenceAfterFirstFailure.retryableHeartbeatAdvance.initialSequence + 2);
    expect.soft(observed.evidenceAfterFirstFailure.retryableHeartbeatAdvance.renewedUpdatedAtMs)
      .toBeGreaterThan(observed.evidenceAfterFirstFailure.retryableHeartbeatAdvance.initialUpdatedAtMs);
    expect.soft(observed.retryReleaseError).toBeNull();
    expect(readdirSync(lockDirectory)).toEqual([]);
  });

  it('retains a prior heartbeat failure when release cannot reverify canonical ownership', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => undefined,
      heartbeatFault: 'throw-before-temp-fsync',
      heartbeatIntervalMs: 10,
      probeReleaseStateAfterFailure: true,
      releaseFault: 'replace-canonical-with-directory-before-unlink',
      waitForHeartbeatFailureBeforeRelease: true,
    });
    const observed = result.stdout ? JSON.parse(result.stdout) : {};

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(observed.releaseErrorCode).toMatch(/^(?:EISDIR|EPERM)$/);
    expect.soft(observed.releaseErrorCause).toContain('injected heartbeat syscall failure');
    expect.soft(observed.releaseErrorHeartbeatRestoreError).toContain('not a regular file');
    expect.soft(observed.evidenceAfterFirstFailure).toEqual(expect.objectContaining({
      canonicalIsDirectory: true,
      heartbeatFailureBeforeRelease: expect.stringContaining('injected heartbeat syscall failure'),
      heartbeatNames: [],
      heartbeatRestored: false,
      helperExists: true,
    }));
    expect.soft(observed.retryReleaseError).toContain('injected heartbeat syscall failure');
    expect(readdirSync(lockDirectory)).toEqual([]);
  });

  it.each([
    [
      'successor ownership',
      'replace-canonical-successor',
      'ownership-changed',
      'ownership changed before release',
      null,
    ],
    [
      'non-regular canonical',
      'replace-canonical-directory',
      'non-regular-file',
      'not a regular file',
      null,
    ],
    [
      'successor ownership plus helper cleanup',
      'replace-canonical-successor-and-helper',
      'ownership-changed',
      'ownership changed before release',
      'owner helper ownership changed before cleanup',
    ],
  ] as const)(
    'retains the stopped heartbeat error under %s release failure',
    async (_case, mutation, primaryFailure, primaryMessage, cleanupMessage) => {
      const root = makeRoot();
      const lockDirectory = path.join(root, 'tmp');
      const lockPath = path.join(lockDirectory, 'agent-file-leases.json.lock');
      try {
        const result = await runOwnerLockScenario(root, {
          onCheckpoint: () => undefined,
          heartbeatFault: 'throw-before-temp-fsync',
          heartbeatIntervalMs: 10,
          postHeartbeatFailureMutation: mutation,
          probeReleaseStateAfterFailure: true,
          waitForHeartbeatFailureBeforeRelease: true,
        });
        const observed = result.stdout ? JSON.parse(result.stdout) : {};

        expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
        expect.soft(observed.releaseErrorFailure).toBe(primaryFailure);
        expect.soft(observed.releaseError).toContain(primaryMessage);
        expect.soft(String(observed.releaseErrorCause ?? ''))
          .toContain('injected heartbeat syscall failure');
        expect.soft(observed.releaseErrorHeartbeatError).toBeNull();
        if (cleanupMessage) {
          expect.soft(String(observed.releaseErrorCleanupError ?? '')).toContain(cleanupMessage);
        } else {
          expect.soft(observed.releaseErrorCleanupError).toBeNull();
        }
        const expectedChain = [
          { slot: 'cause', message: expect.stringContaining('injected heartbeat syscall failure') },
          ...(cleanupMessage
            ? [{ slot: 'cleanupError', message: expect.stringContaining(cleanupMessage) }]
            : []),
        ];
        expect.soft(observed.releaseErrorSecondaryChain).toEqual(expectedChain);
        const secondaryMessages = observed.releaseErrorSecondaryChain
          .map((entry: { message: string }) => entry.message);
        expect.soft(new Set(secondaryMessages).size).toBe(secondaryMessages.length);
        expect.soft(secondaryMessages.filter((message: string) => (
          message.includes('injected heartbeat syscall failure')
        ))).toHaveLength(1);

        const residue = readdirSync(lockDirectory);
        expect.soft(residue.filter(name => name.includes('.heartbeat.'))).toEqual([]);
        const ownerFiles = residue.filter(name => name.includes('.owner.'));
        if (mutation === 'replace-canonical-directory') {
          expect.soft(lstatSync(lockPath).isDirectory()).toBe(true);
          expect.soft(ownerFiles).toHaveLength(1);
        } else {
          expect.soft(readFileSync(lockPath, 'utf8')).toBe(
            '{"schema":2,"token":"post-heartbeat-canonical-successor"}',
          );
          if (mutation === 'replace-canonical-successor-and-helper') {
            expect.soft(ownerFiles).toHaveLength(1);
            expect.soft(readFileSync(path.join(lockDirectory, ownerFiles[0]), 'utf8'))
              .toBe('post-heartbeat-helper-successor');
          } else {
            expect.soft(ownerFiles).toEqual([]);
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
        const trackedIndex = tempRoots.indexOf(root);
        if (trackedIndex >= 0) tempRoots.splice(trackedIndex, 1);
      }
    },
  );

  it('rejects the release unlink fault after its worker IPC channel disconnects', async () => {
    const root = makeRoot();
    const lockDirectory = path.join(root, 'tmp');

    const result = await runOwnerLockScenario(root, {
      disconnectBeforeRelease: true,
      onCheckpoint: () => undefined,
      probeReleaseStateAfterFailure: true,
      releaseFault: 'throw-on-canonical-unlink',
    });
    const observed = result.stdout ? JSON.parse(result.stdout) : {};

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(observed.releaseError).toContain('lease test seam requires IPC');
    expect.soft(observed.releaseErrorCode).toBeNull();
    expect.soft(observed.retryReleaseError).toBeNull();
    expect(readdirSync(lockDirectory)).toEqual([]);
  });

  it('rejects a duplicate release after the OwnerRef reaches released state', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => undefined,
      releaseCount: 2,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('already released');
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(path.dirname(lockPath))).toEqual([]);
  });

  it('keeps OwnerRef state private and rejects a forged reference', async () => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');

    const result = await runOwnerLockScenario(root, {
      onCheckpoint: () => undefined,
      probeOwnerRef: true,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(path.dirname(lockPath))).toEqual([]);
  });

  it.each([
    ['malformed', () => 'not-json\n'],
    ['legacy dead-PID', () => JSON.stringify({
      pid: 999999,
      owner: 'legacy-dead-agent',
      createdAtMs: Date.now() - 10 * 60 * 1000,
    })],
    ['live but older than five minutes', () => JSON.stringify({
      pid: process.pid,
      owner: 'live-old-agent',
      createdAtMs: Date.now() - 10 * 60 * 1000,
    })],
  ])('does not automatically reclaim a %s canonical lock', (_kind, makeLockBytes) => {
    const root = makeRoot();
    const lockPath = path.join(root, 'tmp', 'agent-file-leases.json.lock');
    const originalBytes = makeLockBytes();
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, originalBytes, { flag: 'wx' });
    const before = statSync(lockPath, { bigint: true });

    const status = runLease(root, ['status']);

    expect(status.status).not.toBe(0);
    expect(status.stdout).toBe('');
    expect(status.stderr).toContain('lease state is locked');
    expect(readFileSync(lockPath, 'utf8')).toBe(originalBytes);
    const after = statSync(lockPath, { bigint: true });
    expect({ dev: after.dev, ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({
      dev: before.dev,
      ino: before.ino,
      mtimeNs: before.mtimeNs,
    });
    expect(readdirSync(path.dirname(lockPath))).toEqual([path.basename(lockPath)]);
  });

  it('keeps status read-only and prunes only through an explicit command', () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');

    const missingStatus = runLease(root, ['status']);
    expect(missingStatus.status, missingStatus.stderr || missingStatus.stdout).toBe(0);
    expect(JSON.parse(missingStatus.stdout).workspaceEpoch).toBe(0);
    expect(existsSync(leasePath)).toBe(false);

    const emptyMutationRoot = makeRoot();
    const emptyMutationPath = path.join(emptyMutationRoot, 'tmp', 'agent-file-leases.json');
    const emptyPrune = runLease(emptyMutationRoot, ['prune']);
    expect(emptyPrune.status, emptyPrune.stderr || emptyPrune.stdout).toBe(0);
    expect(JSON.parse(emptyPrune.stdout).workspaceEpoch).toBe(0);
    expect(JSON.parse(readFileSync(emptyMutationPath, 'utf8'))).toEqual({
      version: 1,
      workspaceEpoch: 0,
      leases: {},
    });

    const expiredRegistryBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 9,
      leases: {
        'AGENTS.md': {
          owner: 'agent-a',
          claimedAt: '1970-01-01T00:00:00.000Z',
          expiresAt: '1970-01-01T00:00:00.001Z',
          expiresAtMs: 1,
        },
      },
    }, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, expiredRegistryBytes, { flag: 'wx' });
    const beforeStatus = statSync(leasePath, { bigint: true });

    const status = runLease(root, ['status']);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.workspaceEpoch).toBe(9);
    expect(report.leases).toEqual({});
    expect(report.expired).toEqual(expect.objectContaining({
      'AGENTS.md': expect.objectContaining({ owner: 'agent-a' }),
    }));
    expect(readFileSync(leasePath, 'utf8')).toBe(expiredRegistryBytes);
    const afterStatus = statSync(leasePath, { bigint: true });
    expect({ dev: afterStatus.dev, ino: afterStatus.ino, mtimeNs: afterStatus.mtimeNs }).toEqual({
      dev: beforeStatus.dev,
      ino: beforeStatus.ino,
      mtimeNs: beforeStatus.mtimeNs,
    });

    const prune = runLease(root, ['prune']);
    expect(prune.status, prune.stderr || prune.stdout).toBe(0);
    expect(JSON.parse(prune.stdout).workspaceEpoch).toBe(9);
    const prunedRegistry = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(prunedRegistry.workspaceEpoch).toBe(9);
    expect(prunedRegistry.leases).toEqual({});
  });

  it('serializes claims while the first transaction owns the canonical lock', async () => {
    const root = makeRoot();
    const result = await runSerializationScenario(root);

    expect(result.a.status, result.a.stderr || result.a.stdout).toBe(0);
    expect(result.wrongRunIdIgnoredBeforeCommit).toBe(true);
    expect(result.wrongStageIgnoredBeforeCommit).toBe(true);
    expect(result.bBeforeCommit.status, result.bBeforeCommit.stderr || result.bBeforeCommit.stdout).not.toBe(0);
    expect(result.bBeforeCommit.stderr).toContain('lease state is locked');
    expect(result.registryExistedBeforeCommit).toBe(false);
    expect(result.lockExistedBeforeRelease).toBe(true);
    const beforeRelease = JSON.parse(result.registryBeforeRelease);
    expect(beforeRelease.workspaceEpoch).toBe(1);
    expect(beforeRelease.leases).toEqual({
      'a.ts': expect.objectContaining({ owner: 'agent-a' }),
    });
    expect(result.bBeforeRelease.status, result.bBeforeRelease.stderr || result.bBeforeRelease.stdout).not.toBe(0);
    expect(result.bBeforeRelease.stderr).toContain('lease state is locked');
    expect(result.registryAfterRejectedClaim).toBe(result.registryBeforeRelease);
    expect(result.bAfterRelease.status, result.bAfterRelease.stderr || result.bAfterRelease.stdout).toBe(0);

    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const leaseFile = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(leaseFile.workspaceEpoch).toBe(2);
    expect(leaseFile.leases).toEqual({
      'a.ts': expect.objectContaining({ owner: 'agent-a' }),
      'b.ts': expect.objectContaining({ owner: 'agent-b' }),
    });
    expect(readdirSync(path.dirname(leasePath)).sort()).toEqual(['agent-file-leases.json']);
  });

  it('serializes concurrent successful claims with one workspace epoch per process', async () => {
    const root = makeRoot();

    const results = await Promise.all(Array.from(
      { length: CONCURRENT_WORKSPACE_EPOCH_CLAIM_COUNT },
      (_, index) => claimWithLockRetry(root, index),
    ));

    expect(results).toHaveLength(CONCURRENT_WORKSPACE_EPOCH_CLAIM_COUNT);
    for (const result of results) {
      expect(result.status, result.stderr || result.stdout).toBe(0);
    }
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const registry = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(registry.workspaceEpoch).toBe(CONCURRENT_WORKSPACE_EPOCH_CLAIM_COUNT);
    expect(Object.keys(registry.leases)).toHaveLength(CONCURRENT_WORKSPACE_EPOCH_CLAIM_COUNT);
  });

  it('keeps the old complete registry when a claim process exits before commit', async () => {
    const root = makeRoot();
    const leasePath = path.join(root, 'tmp', 'agent-file-leases.json');
    const originalBytes = `${JSON.stringify({
      version: 1,
      workspaceEpoch: 7,
      leases: { 'held.ts': validRegistryLease },
    }, null, 2)}\n`;
    mkdirSync(path.dirname(leasePath), { recursive: true });
    writeFileSync(leasePath, originalBytes);

    const crashed = await crashClaimBeforeCommit(root);

    expect(crashed.status === null || crashed.status !== 0).toBe(true);
    expect(crashed.stdout).toBe('');
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
    const preparedTemps = readdirSync(path.dirname(leasePath))
      .filter(entry => entry.endsWith('.tmp'));
    expect(preparedTemps).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(path.dirname(leasePath), preparedTemps[0]), 'utf8'))).toEqual({
      version: 1,
      workspaceEpoch: 8,
      leases: {
        'after-crash.ts': expect.objectContaining({ owner: 'crashing-agent' }),
        'held.ts': validRegistryLease,
      },
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const staleReclaimer = spawnStaleWorker(root, 'contender', {
      NANOFLOW_LEASE_TEST_STALE_AFTER_MS: '1',
    });
    const reclaimResult = await staleReclaimer.completion;
    expect(reclaimResult.status, reclaimResult.stderr || reclaimResult.stdout).toBe(0);
    expect(readFileSync(leasePath, 'utf8')).toBe(originalBytes);
    const status = runLease(root, ['status']);
    expect(status.status, status.stderr || status.stdout).toBe(0);
    expect(JSON.parse(status.stdout).workspaceEpoch).toBe(7);

    const retry = runLease(root, ['claim', '--owner', 'retry-agent', 'after-crash.ts']);
    expect(retry.status, retry.stderr || retry.stdout).toBe(0);
    const committed = JSON.parse(readFileSync(leasePath, 'utf8'));
    expect(committed.workspaceEpoch).toBe(8);
    expect(committed.leases).toEqual({
      'after-crash.ts': expect.objectContaining({ owner: 'retry-agent' }),
      'held.ts': validRegistryLease,
    });
  });

  it('rejects a checked final retry failure through scenario cleanup', async () => {
    const root = makeRoot();
    const blockingScriptPath = path.join(root, 'final-retry-blocker.cjs');
    writeFileSync(
      blockingScriptPath,
      "require('node:fs').writeSync(1, '{\"ok\":'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n",
    );
    let observeFinalRetryFailure: ((error: CheckedSpawnSyncError) => void) | undefined;
    const finalRetryFailure = new Promise<CheckedSpawnSyncError>(resolve => {
      observeFinalRetryFailure = resolve;
    });
    let scenarioSettled = false;
    let scenarioRejection: unknown;

    const scenario = runSerializationScenario(root, {
      finalRetry: () => {
        try {
          return runLease(root, ['claim', '--owner', 'agent-b', 'b.ts'], {
            leaseScriptPath: blockingScriptPath,
            timeout: 100,
          });
        } catch (error) {
          observeFinalRetryFailure?.(error as CheckedSpawnSyncError);
          throw error;
        }
      },
    });
    const [worker] = [...activeLeaseWorkers.keys()];
    void scenario.then(
      () => {
        scenarioSettled = true;
      },
      error => {
        scenarioSettled = true;
        scenarioRejection = error;
      },
    );

    const checkedFailure = await finalRetryFailure;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect.soft(checkedFailure.code).toBe('ETIMEDOUT');
    expect.soft(checkedFailure.partialStdout).toBe('{"ok":');
    expect.soft(scenarioSettled).toBe(true);
    expect.soft(scenarioRejection).toBe(checkedFailure);
    expect.soft(worker).toBeDefined();
    expect.soft(worker && activeLeaseWorkers.has(worker)).toBe(false);
    expect.soft(worker?.listenerCount('message')).toBe(0);
    expect.soft(worker?.listenerCount('close')).toBe(0);
    expect.soft(worker?.listenerCount('error')).toBe(0);
    expect.soft(worker?.stdout?.listenerCount('data')).toBe(0);
    expect.soft(worker?.stderr?.listenerCount('data')).toBe(0);
    const transactionDirectory = path.join(root, 'tmp');
    expect.soft(existsSync(path.join(transactionDirectory, 'agent-file-leases.json.lock'))).toBe(false);
    expect.soft(readdirSync(transactionDirectory).sort()).toEqual(['agent-file-leases.json']);
  });

  it('requires IPC before enabling the real CLI transaction checkpoint', () => {
    const root = makeRoot();
    const canonicalRoot = realpathSync(root);
    const result = runLease(root, ['claim', '--owner', 'agent-a', 'a.ts'], {
      env: {
        ...process.env,
        NANOFLOW_LEASE_TEST_RUN_ID: `missing-ipc-${process.pid}`,
        NANOFLOW_LEASE_TEST_ROOT: canonicalRoot,
        NANOFLOW_LEASE_TEST_PAUSE_POINT: 'cli-transaction',
      },
    });

    expect.soft(result.status, result.stderr || result.stdout).not.toBe(0);
    expect.soft(result.stdout).toBe('');
    expect(existsSync(path.join(root, 'tmp', 'agent-file-leases.json'))).toBe(false);
  });

  it('rejects the real CLI transaction checkpoint outside a canonical NanoFlow test root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'outside-agent-file-lease-test-'));
    tempRoots.push(root);

    await expect(runSerializationScenario(root)).rejects.toThrow('canonical NanoFlow temp root');
    expect(existsSync(path.join(root, 'tmp', 'agent-file-leases.json'))).toBe(false);
  });

  it('settles collected process output only after close drains stdout and stderr', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const worker = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
    }) as unknown as ReturnType<typeof fork>;
    const resultPromise = new Promise<WorkerCommandResult>((resolve, reject) => {
      observeScenarioProcessOutput(worker, resolve, reject);
    });

    stdout.write('stdout-prefix:');
    stderr.write('stderr-prefix:');
    worker.emit('exit', 0, null);
    stdout.write('stdout-close-sentinel');
    stderr.write('stderr-close-sentinel');
    worker.emit('close', 0, null);

    const result = await resultPromise;
    expect(result).toEqual({
      status: 0,
      signal: null,
      stdout: 'stdout-prefix:stdout-close-sentinel',
      stderr: 'stderr-prefix:stderr-close-sentinel',
    });
    expect(worker.listenerCount('exit')).toBe(0);
    expect(worker.listenerCount('close')).toBe(0);
    expect(worker.listenerCount('error')).toBe(0);
    expect(stdout.listenerCount('data')).toBe(0);
    expect(stderr.listenerCount('data')).toBe(0);
  });

  it('routes completion callback failures through collector error handling', () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const worker = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
    }) as unknown as ReturnType<typeof fork>;
    const primaryError = new Error('collector-completion-primary-sentinel');
    let escapedError: unknown;
    let observedError: Error | undefined;
    observeScenarioProcessOutput(worker, () => {
      throw primaryError;
    }, error => {
      observedError = error;
    });

    try {
      worker.emit('close', 0, null);
    } catch (error) {
      escapedError = error;
    }

    expect.soft(escapedError).toBeUndefined();
    expect.soft(observedError).toBe(primaryError);
    expect.soft(worker.listenerCount('close')).toBe(0);
    expect.soft(worker.listenerCount('error')).toBe(0);
    expect.soft(stdout.listenerCount('data')).toBe(0);
    expect.soft(stderr.listenerCount('data')).toBe(0);
  });

  it('waits for worker exit before settling a checkpoint failure', async () => {
    const root = makeRoot();
    const events: string[] = [];
    let worker: ReturnType<typeof fork> | undefined;
    let resolveExited: (() => void) | undefined;
    const exited = new Promise<void>(resolve => {
      resolveExited = resolve;
    });

    const scenario = runOwnerLockScenario(root, {
      deadlineMs: 500,
      onCheckpoint: () => {
        const workers = [...activeLeaseWorkers.keys()];
        expect(workers).toHaveLength(1);
        [worker] = workers;
        worker!.stdout?.resume();
        worker!.stderr?.resume();
        worker!.once('exit', () => {
          events.push('exit');
          resolveExited?.();
        });
        worker!.once('close', () => {
          events.push('close');
        });
        throw new Error('owner-lock-checkpoint-primary-sentinel');
      },
    });

    let rejection: Error | undefined;
    let liveWhenSettled: boolean | undefined;
    try {
      await scenario;
    } catch (error) {
      rejection = error instanceof Error ? error : new Error(String(error));
      liveWhenSettled = worker?.exitCode === null && worker?.signalCode === null;
      events.push('settled');
    }
    expect(rejection?.message).toBe('owner-lock-checkpoint-primary-sentinel');
    expect(worker).toBeDefined();
    await exited;

    expect(liveWhenSettled).toBe(false);
    expect(events.indexOf('exit')).toBeLessThan(events.indexOf('settled'));
    expect(worker && activeLeaseWorkers.has(worker)).toBe(false);
  });

  it('bounds a worker exit wait that receives no exit or close event', async () => {
    const handle = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
    }) as LeaseWorkerProcessHandle;

    await expect(waitForLeaseWorkerExitOrClose(handle, 25)).rejects.toThrow(
      'lease worker teardown exceeded 25ms',
    );
  }, 500);

  it('keeps a timed-out worker tracked until a later exit event', async () => {
    const handle = Object.assign(new EventEmitter(), {
      connected: false,
      exitCode: null,
      signalCode: null,
      disconnect: () => undefined,
      kill: () => true,
    }) as unknown as ReturnType<typeof fork>;
    activeLeaseWorkers.set(handle, () => terminateLeaseWorker(handle));

    try {
      await expect(terminateLeaseWorker(handle)).rejects.toThrow(
        `lease worker teardown exceeded ${LEASE_WORKER_TEARDOWN_DEADLINE_MS}ms`,
      );
      expect(activeLeaseWorkers.has(handle)).toBe(true);

      Object.assign(handle, { signalCode: 'SIGTERM' as NodeJS.Signals });
      handle.emit('exit', null, 'SIGTERM');
      await Promise.resolve();

      expect(activeLeaseWorkers.has(handle)).toBe(false);
    } finally {
      activeLeaseWorkers.delete(handle);
    }
  }, LEASE_WORKER_TEARDOWN_DEADLINE_MS + 500);

  it('keeps a scenario error primary when bounded teardown also fails', () => {
    const primaryError = new Error('scenario-primary-sentinel');
    const teardownError = new Error('teardown-secondary-sentinel');

    const observed = leaseWorkerSettlementError(primaryError, teardownError);

    expect(observed).toBe(primaryError);
    expect(observed.cause).toBe(teardownError);
  });

  it('rejects an early worker failure without retaining a tracked child', async () => {
    const root = makeRoot();

    await expect(runSerializationScenario(root, {
      leaseScriptPath: path.join(root, 'missing-agent-file-lease.cjs'),
    })).rejects.toThrow();

    expect(activeLeaseWorkers.size).toBe(0);
  });

  it('fails closed when a transaction callback returns an invalid candidate shape', async () => {
    const root = makeRoot();
    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      protocolMode: 'invalid-candidate',
      onCheckpoint: () => undefined,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('transaction candidate');
    expect(existsSync(leaseRegistryPath(root))).toBe(false);
  });

  it('rejects a changed transaction candidate that is not the callback state', async () => {
    const root = makeRoot();
    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      protocolMode: 'foreign-state-candidate',
      onCheckpoint: () => undefined,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('transaction candidate');
    expect(existsSync(leaseRegistryPath(root))).toBe(false);
  });

  it('validates the complete changed transaction candidate before publication', async () => {
    const root = makeRoot();
    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      protocolMode: 'invalid-registry-candidate',
      onCheckpoint: () => undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lease registry leases must be a plain object');
    expect(existsSync(leaseRegistryPath(root))).toBe(false);
  });

  it.each([
    ['workspaceEpoch', 'workspace-epoch-rollback'],
    ['fencingCounter', 'fencing-counter-rollback'],
  ] as const)('rejects a transaction candidate that rolls back %s', async (field, protocolMode) => {
    const root = makeRoot();
    const registryPath = writeLeaseRegistry(root, {
      version: 1,
      workspaceEpoch: 7,
      fencingCounter: 5,
      leases: {},
    });
    const originalBytes = readFileSync(registryPath, 'utf8');

    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      protocolMode,
      onCheckpoint: () => undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`lease registry ${field} must not decrease`);
    expect(readFileSync(registryPath, 'utf8')).toBe(originalBytes);
  });

  it('rejects a schema-valid rewrite of an existing barrier transition prefix', async () => {
    const root = makeRoot();
    const acquiredAt = new Date(Date.now() - 1_000).toISOString();
    const tokenHash = 'a'.repeat(64);
    const registryPath = writeLeaseRegistry(root, {
      version: 1,
      workspaceEpoch: 7,
      fencingCounter: 5,
      barrier: {
        state: 'CLOSING',
        owner: 'barrier-owner',
        tokenHash,
        tokenFingerprint: tokenHash.slice(0, 12),
        acquiredAt,
        heartbeatAt: acquiredAt,
        heartbeatSequence: 1,
        heldEpoch: null,
        fence: null,
        releasedAt: null,
        transitions: [{ state: 'CLOSING', at: acquiredAt, sequence: 1 }],
      },
      leases: {},
    });
    const originalBytes = readFileSync(registryPath, 'utf8');

    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      protocolMode: 'transition-prefix-rewrite',
      onCheckpoint: () => undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('barrier transition prefix must be immutable');
    expect(readFileSync(registryPath, 'utf8')).toBe(originalBytes);
  });

  it.each([
    ['owner helper', 'owner-helper-replaced-before-commit'],
    ['heartbeat', 'heartbeat-replaced-before-commit'],
  ] as const)('rechecks the %s immediately before publishing a changed registry', async (
    evidenceKind,
    protocolMode,
  ) => {
    const root = makeRoot();
    const result = await runOwnerLockScenario(root, {
      pausePoint: 'before-state-lock-protocol',
      protocolMode,
      onCheckpoint: () => undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(evidenceKind);
    expect(result.stderr).not.toContain('was unavailable for replacement');
    if (evidenceKind === 'heartbeat') {
      expect(result.stderr).toMatch(/heartbeat (?:ownership|metadata) changed/);
    }
    expect(existsSync(leaseRegistryPath(root))).toBe(false);
  });
});

describe('agent-file-lease reconcile-expired-exact fault boundary', function () {
  afterEach(function () { while (tempRoots.length > 0) { const root = tempRoots.pop(); if (root) rmSync(root, { recursive: true, force: true }); } });
  function registryWithExpiredTarget(root: string, owner: string) {
    const now = Date.now();
    const expired = new Date(now - 60000).toISOString();
    const barrier = { state: 'RELEASED', owner, tokenHash: 'a'.repeat(64), tokenFingerprint: 'a'.repeat(12), acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatSequence: 1, heldEpoch: 3, fence: 2, releasedAt: '2026-01-01T00:01:00.000Z', transitions: [{ state: 'CLOSING', at: '2026-01-01T00:00:00.000Z', sequence: 1 }, { state: 'WAITING', at: '2026-01-01T00:00:00.000Z', sequence: 2 }, { state: 'HELD', at: '2026-01-01T00:00:00.000Z', sequence: 3 }, { state: 'RELEASED', at: '2026-01-01T00:01:00.000Z', sequence: 4 }] };
    return writeLeaseRegistry(root, { version: 1, workspaceEpoch: 3, fencingCounter: 2, barrier, leases: {
      'a.ts': { owner, claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
    } });
  }
  function runReconcileFaultScenario(
    root: string,
    owner: string,
    action: 'cas-after-read' | 'callback-rollback' | 'postwrite-mismatch',
  ): Promise<WorkerCommandResult> {
    const runId = `reconcile-${process.pid}-${path.basename(root)}`;
    const canonicalRoot = realpathSync(root);
    return new Promise<WorkerCommandResult>((resolve, reject) => {
      const worker = fork(leaseWorkerPath, [leaseScriptPath, '--root', canonicalRoot, 'a.ts'], {
        cwd: projectRoot,
        env: { ...process.env, NANOFLOW_LEASE_TEST_RUN_ID: runId, NANOFLOW_LEASE_TEST_ROOT: canonicalRoot, NANOFLOW_LEASE_TEST_PAUSE_POINT: 'reconcile-command-protocol', NANOFLOW_LEASE_TEST_OWNER: owner },
        silent: true,
      });
      let stdout = '';
      let stderr = '';
      worker.stdout?.setEncoding('utf8');
      worker.stderr?.setEncoding('utf8');
      worker.stdout?.on('data', chunk => { stdout += chunk; });
      worker.stderr?.on('data', chunk => { stderr += chunk; });
      const cleanup = () => terminateLeaseWorker(worker);
      activeLeaseWorkers.set(worker, cleanup);
      worker.once('error', reject);
      worker.once('close', (status, signal) => {
        activeLeaseWorkers.delete(worker);
        resolve({ status, signal, stdout, stderr });
      });
      worker.once('spawn', () => {
        worker.send({ type: 'NANOFLOW_LEASE_TEST_RECONCILE_SCENARIO', runId, root: canonicalRoot, pausePoint: 'reconcile-command-protocol', action });
      });
    });
  }
  function reconcileFaultResult(result: WorkerCommandResult): { reconcileExitCode: number | null; signal: NodeJS.Signals | null; cliStdout: string; cliStderr: string; mutatedRegistrySha?: string | null; mutatedRegistryIdentity?: Record<string, unknown> | null } {
    const lines = result.stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1] ?? '{}');
  }
  it('rejects CAS drift after read before commit without promotion', async function () {
    const root = makeRoot();
    const owner = 'owner';
    const registry = registryWithExpiredTarget(root, owner);
    const original = readFileSync(registry, 'utf8');
    const result = await runReconcileFaultScenario(root, owner, 'cas-after-read');
    const parsed = reconcileFaultResult(result);
    expect(parsed.reconcileExitCode).not.toBe(0);
    expect(parsed.cliStdout).not.toContain('"ok": true');
    expect(parsed.mutatedRegistrySha).toMatch(/^[0-9a-f]{64}$/);
    const finalSha = createHash('sha256').update(readFileSync(registry)).digest('hex');
    expect(finalSha).toBe(parsed.mutatedRegistrySha);
  });
  it('rolls back injected reconcile callback failure and clears residue', async function () {
    const root = makeRoot();
    const owner = 'owner';
    const registry = registryWithExpiredTarget(root, owner);
    const original = readFileSync(registry, 'utf8');
    const result = await runReconcileFaultScenario(root, owner, 'callback-rollback');
    const parsed = reconcileFaultResult(result);
    expect(parsed.reconcileExitCode).not.toBe(0);
    expect(parsed.cliStdout).not.toContain('"ok": true');
    expect(readFileSync(registry, 'utf8')).toBe(original);
    expect(existsSync(registry + '.lock')).toBe(false);
  });
  it('fails closed on postwrite A/B mismatch without success receipt', async function () {
    const root = makeRoot();
    const owner = 'owner';
    const registry = registryWithExpiredTarget(root, owner);
    const original = readFileSync(registry, 'utf8');
    const result = await runReconcileFaultScenario(root, owner, 'postwrite-mismatch');
    const parsed = reconcileFaultResult(result);
    expect(parsed.reconcileExitCode).not.toBe(0);
    expect(parsed.cliStdout).not.toContain('"ok": true');
    expect(parsed.mutatedRegistrySha).toMatch(/^[0-9a-f]{64}$/);
    const finalBytes = readFileSync(registry);
    const finalSha = createHash('sha256').update(finalBytes).digest('hex');
    expect(finalSha).toBe(parsed.mutatedRegistrySha);
    const initialSha = createHash('sha256').update(Buffer.from(original, 'utf8')).digest('hex');
    expect(finalSha).not.toBe(initialSha);
  });
});

describe('agent-file-lease reconcile-expired-exact', function () {
  afterEach(function () { while (tempRoots.length > 0) { const root = tempRoots.pop(); if (root) rmSync(root, { recursive: true, force: true }); } });
  it('rejects empty and duplicate exact paths before any mutation', function () {
    const root = makeRoot();
    const registry = writeLeaseRegistry(root, {
      version: 1,
      workspaceEpoch: 3,
      fencingCounter: 2,
      barrier: { state: 'RELEASED', owner: 'owner', tokenHash: 'a'.repeat(64), tokenFingerprint: 'a'.repeat(12), acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatSequence: 1, heldEpoch: 3, fence: 2, releasedAt: '2026-01-01T00:01:00.000Z', transitions: [{ state: 'CLOSING', at: '2026-01-01T00:00:00.000Z', sequence: 1 }, { state: 'WAITING', at: '2026-01-01T00:00:00.000Z', sequence: 2 }, { state: 'HELD', at: '2026-01-01T00:00:00.000Z', sequence: 3 }, { state: 'RELEASED', at: '2026-01-01T00:01:00.000Z', sequence: 4 }] },
      leases: {},
    });
    const original = readFileSync(registry, 'utf8');

    const empty = runLease(root, ['reconcile-expired-exact', '--owner', 'owner']);
    expect(empty.status).not.toBe(0);
    const duplicate = runLease(root, [
      'reconcile-expired-exact', '--owner', 'owner', 'a.ts', 'a.ts',
    ]);
    expect(duplicate.status).not.toBe(0);
    expect(readFileSync(registry, 'utf8')).toBe(original);
  });
});

describe('agent-file-lease reconcile-expired-exact', function () {
  afterEach(function () { while (tempRoots.length > 0) { const root = tempRoots.pop(); if (root) rmSync(root, { recursive: true, force: true }); } });
  it('rejects traversal and absolute paths before any mutation', function () {
    const root = makeRoot();
    const registry = writeLeaseRegistry(root, {
      version: 1,
      workspaceEpoch: 3,
      fencingCounter: 2,
      barrier: { state: 'RELEASED', owner: 'owner', tokenHash: 'a'.repeat(64), tokenFingerprint: 'a'.repeat(12), acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatSequence: 1, heldEpoch: 3, fence: 2, releasedAt: '2026-01-01T00:01:00.000Z', transitions: [{ state: 'CLOSING', at: '2026-01-01T00:00:00.000Z', sequence: 1 }, { state: 'WAITING', at: '2026-01-01T00:00:00.000Z', sequence: 2 }, { state: 'HELD', at: '2026-01-01T00:00:00.000Z', sequence: 3 }, { state: 'RELEASED', at: '2026-01-01T00:01:00.000Z', sequence: 4 }] },
      leases: {},
    });
    const original = readFileSync(registry, 'utf8');

    const traversal = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', '../escape.ts']);
    expect(traversal.status).not.toBe(0);
    const absolute = runLease(root, [
      'reconcile-expired-exact', '--owner', 'owner', 'C:/escape.ts',
    ]);
    expect(absolute.status).not.toBe(0);
    expect(readFileSync(registry, 'utf8')).toBe(original);
  });

  it('preserves foreign expired, active, and same-owner non-target rows', function () {
    const root = makeRoot();
    const now = Date.now();
    const expired = new Date(now - 60000).toISOString();
    const active = new Date(now + 60000).toISOString();
    const registry = writeLeaseRegistry(root, {
      version: 1,
      workspaceEpoch: 3,
      fencingCounter: 2,
      barrier: { state: 'RELEASED', owner: 'owner', tokenHash: 'a'.repeat(64), tokenFingerprint: 'a'.repeat(12), acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatSequence: 1, heldEpoch: 3, fence: 2, releasedAt: '2026-01-01T00:01:00.000Z', transitions: [{ state: 'CLOSING', at: '2026-01-01T00:00:00.000Z', sequence: 1 }, { state: 'WAITING', at: '2026-01-01T00:00:00.000Z', sequence: 2 }, { state: 'HELD', at: '2026-01-01T00:00:00.000Z', sequence: 3 }, { state: 'RELEASED', at: '2026-01-01T00:01:00.000Z', sequence: 4 }] },
      leases: {
        'a.ts': { owner: 'owner', claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
        'b.ts': { owner: 'owner', claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
        'foreign.ts': { owner: 'foreign', claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
        'active.ts': { owner: 'owner', claimedAt: active, expiresAt: active, expiresAtMs: now + 60000 },
      },
    });

    const result = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', 'a.ts']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.removed).toEqual(['a.ts']);
    const state = JSON.parse(readFileSync(registry, 'utf8'));
    expect(state.leases['b.ts']).toBeDefined();
    expect(state.leases['foreign.ts']).toBeDefined();
    expect(state.leases['active.ts']).toBeDefined();
  });

  it('rejects HELD barrier without mutation', function () {
    const root = makeRoot();
    const now = Date.now();
    const expired = new Date(now - 60000).toISOString();
    const registry = writeLeaseRegistry(root, {
      version: 1,
      workspaceEpoch: 3,
      fencingCounter: 2,
      barrier: { state: 'HELD', owner: 'held-owner', tokenHash: 'b'.repeat(64), tokenFingerprint: 'b'.repeat(12), acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatSequence: 1, heldEpoch: 3, fence: 2, releasedAt: null, transitions: [{ state: 'CLOSING', at: '2026-01-01T00:00:00.000Z', sequence: 1 }, { state: 'WAITING', at: '2026-01-01T00:00:00.000Z', sequence: 2 }, { state: 'HELD', at: '2026-01-01T00:00:00.000Z', sequence: 3 }] },
      leases: {
        'a.ts': { owner: 'owner', claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
      },
    });
    const original = readFileSync(registry, 'utf8');

    const result = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', 'a.ts']);
    expect(result.status).not.toBe(0);
    expect(readFileSync(registry, 'utf8')).toBe(original);
  });
});

describe('agent-file-lease reconcile-expired-exact transaction', function () {
  afterEach(function () { while (tempRoots.length > 0) { const root = tempRoots.pop(); if (root) rmSync(root, { recursive: true, force: true }); } });
  it('allows CLOSING exact-owner renewal and rejects missing/wrong-owner/active mismatch', function () {
    const root = makeRoot();
    const now = Date.now();
    const expired = new Date(now - 60000).toISOString();
    const active = new Date(now + 60000).toISOString();
    const barrier = { state: 'CLOSING', owner: 'owner', tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tokenFingerprint: 'aaaaaaaaaaaa', acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatSequence: 1, heldEpoch: null, fence: null, releasedAt: null, transitions: [{ state: 'CLOSING', at: '2026-01-01T00:00:00.000Z', sequence: 1 }] };
    const registry = writeLeaseRegistry(root, { version: 1, workspaceEpoch: 3, fencingCounter: 2, barrier, leases: {
      'a.ts': { owner: 'owner', claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
      'foreign.ts': { owner: 'foreign', claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
      'active.ts': { owner: 'owner', claimedAt: active, expiresAt: active, expiresAtMs: now + 60000 },
    } });
    const ok = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', 'a.ts']);
    expect(ok.status).toBe(0);
    const missing = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', 'missing.ts']);
    expect(missing.status).not.toBe(0);
    const wrong = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', 'foreign.ts']);
    expect(wrong.status).not.toBe(0);
    const activeBad = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', 'active.ts']);
    expect(activeBad.status).not.toBe(0);
  });
  it('increments epoch once, leaves fence/barrier unchanged, and is deterministic', function () {
    const root = makeRoot();
    const now = Date.now();
    const expired = new Date(now - 60000).toISOString();
    const barrier = { state: 'RELEASED', owner: 'owner', tokenHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', tokenFingerprint: 'aaaaaaaaaaaa', acquiredAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2026-01-01T00:00:00.000Z', heartbeatSequence: 1, heldEpoch: 3, fence: 2, releasedAt: '2026-01-01T00:01:00.000Z', transitions: [{ state: 'CLOSING', at: '2026-01-01T00:00:00.000Z', sequence: 1 }, { state: 'WAITING', at: '2026-01-01T00:00:00.000Z', sequence: 2 }, { state: 'HELD', at: '2026-01-01T00:00:00.000Z', sequence: 3 }, { state: 'RELEASED', at: '2026-01-01T00:01:00.000Z', sequence: 4 }] };
    const registry = writeLeaseRegistry(root, { version: 1, workspaceEpoch: 3, fencingCounter: 2, barrier, leases: {
      'a.ts': { owner: 'owner', claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
      'b.ts': { owner: 'owner', claimedAt: expired, expiresAt: expired, expiresAtMs: now - 60000 },
    } });
    const first = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', 'b.ts', 'a.ts']);
    expect(first.status).toBe(0);
    const parsed = JSON.parse(first.stdout);
    expect(parsed.removed).toEqual(['a.ts', 'b.ts']);
    const state = JSON.parse(readFileSync(registry, 'utf8'));
    expect(state.workspaceEpoch).toBe(4);
    expect(state.fencingCounter).toBe(2);
    expect(state.barrier.state).toBe('RELEASED');
    const second = runLease(root, ['reconcile-expired-exact', '--owner', 'owner', 'a.ts']);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).removed).toEqual([]);
    expect(JSON.parse(readFileSync(registry, 'utf8')).workspaceEpoch).toBe(4);
  });
});

describe('agent-file-lease reconcile-expired-exact usage hygiene', function () {
  it('exposes reconcile-expired-exact in CLI usage and removes probe residue', function () {
    const cli = readFileSync(leaseScriptPath, 'utf8');
    expect(cli).toContain('reconcile-expired-exact');
    expect(cli).toContain('<claim|release|status|prune|reconcile-expired-exact|barrier-acquire');
    expect(cli).not.toContain('const __probe = true;');
  });
});
