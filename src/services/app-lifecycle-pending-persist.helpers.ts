import type { AppResumeReason } from './app-lifecycle-orchestrator.types';

interface PendingPersistLogger {
  warn(message: string, data: unknown): void;
}

export interface PendingPersistRecoveryDeps {
  hasPendingLocalChanges: () => boolean;
  addBreadcrumb: (breadcrumb: {
    category: string;
    message: string;
    level: 'info';
    data: { step: string; reason: AppResumeReason };
  }) => void;
  flushPendingPersistToCloud: (reason: string) => Promise<unknown>;
  captureException: (error: unknown, context: {
    operation: string;
    reason: AppResumeReason;
  }) => void;
  logger: PendingPersistLogger;
}

let pendingPersistRecoveryScheduled = false;
let queuedPendingPersistRecoveryReason: AppResumeReason | null = null;

const PENDING_PERSIST_RECOVERY_RETRY_DELAY_MS = 1500;

export function schedulePendingPersistRecovery(
  reason: AppResumeReason,
  deps: PendingPersistRecoveryDeps,
): void {
  if (!deps.hasPendingLocalChanges()) {
    return;
  }
  if (pendingPersistRecoveryScheduled) {
    queuedPendingPersistRecoveryReason = reason;
    return;
  }

  pendingPersistRecoveryScheduled = true;
  addPendingPersistRecoveryBreadcrumb(reason, deps);
  schedulePendingPersistRecoveryRun(reason, deps);
}

function addPendingPersistRecoveryBreadcrumb(
  reason: AppResumeReason,
  deps: PendingPersistRecoveryDeps,
): void {
  try {
    deps.addBreadcrumb({
      category: 'lifecycle',
      message: 'recovery.step',
      level: 'info',
      data: {
        step: 'resume-pending-persist-recovery',
        reason,
      },
    });
  } catch (error) {
    deps.logger.warn('Resume pending persist recovery breadcrumb failed', { reason, error });
  }
}

function runPendingPersistRecovery(
  reason: AppResumeReason,
  deps: PendingPersistRecoveryDeps,
): void {
  let shouldRetryAfterFalseResult = false;
  void createPendingPersistFlush(reason, deps)
    .then((result) => {
      shouldRetryAfterFalseResult = result === false;
    })
    .catch((error) => {
      deps.logger.warn('Resume pending persist recovery failed', { reason, error });
      capturePendingPersistRecoveryError(error, reason, deps);
    })
    .finally(() => {
      pendingPersistRecoveryScheduled = false;
      const queuedReason = queuedPendingPersistRecoveryReason;
      queuedPendingPersistRecoveryReason = null;
      if (queuedReason && deps.hasPendingLocalChanges()) {
        schedulePendingPersistRecovery(queuedReason, deps);
        return;
      }
      if (shouldRetryAfterFalseResult && deps.hasPendingLocalChanges()) {
        schedulePendingPersistRecoveryRetry(reason, deps);
      }
    });
}

function createPendingPersistFlush(
  reason: AppResumeReason,
  deps: PendingPersistRecoveryDeps,
): Promise<unknown> {
  try {
    return Promise.resolve(deps.flushPendingPersistToCloud(`resume:${reason}`));
  } catch (error) {
    return Promise.reject(error);
  }
}

function capturePendingPersistRecoveryError(
  error: unknown,
  reason: AppResumeReason,
  deps: PendingPersistRecoveryDeps,
): void {
  try {
    deps.captureException(error, {
      operation: 'lifecycle.resume.pending-persist',
      reason,
    });
  } catch (captureError) {
    deps.logger.warn('Resume pending persist recovery telemetry failed', {
      reason,
      error: captureError,
    });
  }
}

function schedulePendingPersistRecoveryRun(
  reason: AppResumeReason,
  deps: PendingPersistRecoveryDeps,
): void {
  const runRecovery = () => runPendingPersistRecovery(reason, deps);
  try {
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(runRecovery);
      return;
    }
  } catch (error) {
    deps.logger.warn('Resume pending persist recovery scheduling failed', { reason, error });
  }

  void Promise.resolve().then(runRecovery);
}

function schedulePendingPersistRecoveryRetry(
  reason: AppResumeReason,
  deps: PendingPersistRecoveryDeps,
): void {
  try {
    setTimeout(() => {
      schedulePendingPersistRecovery(reason, deps);
    }, PENDING_PERSIST_RECOVERY_RETRY_DELAY_MS);
  } catch (error) {
    deps.logger.warn('Resume pending persist recovery retry scheduling failed', { reason, error });
  }
}
