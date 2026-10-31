import type { LocalBackupResult } from '../config/local-backup.config';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import { isStaleDirectoryHandleError } from './local-backup-directory-handle.helpers';

const DEFERRED_RETRY_ERROR_MESSAGE = '浏览器恢复连接中，自动备份稍后重试';

type LocalBackupFailureKind = 'stale-directory-handle' | 'deferred-retry' | 'failed';

interface LocalBackupFailureClassification {
  kind: LocalBackupFailureKind;
  result: LocalBackupResult;
}

export function buildDeferredRetryResult(): LocalBackupResult {
  return {
    success: false,
    error: DEFERRED_RETRY_ERROR_MESSAGE,
    deferred: true,
  };
}

export function classifyLocalBackupFailure(
  error: unknown,
  staleDirectoryHandleMessage: string,
): LocalBackupFailureClassification {
  if (isStaleDirectoryHandleError(error)) {
    return {
      kind: 'stale-directory-handle',
      result: { success: false, error: staleDirectoryHandleMessage },
    };
  }

  if (isBrowserNetworkSuspendedError(error)) {
    return {
      kind: 'deferred-retry',
      result: buildDeferredRetryResult(),
    };
  }

  const backupError = error as Error;
  return {
    kind: 'failed',
    result: { success: false, error: backupError.message },
  };
}

export function getAutoBackupDeferredRetryWindowState(): { resumeDelayMs: number } | null {
  if (!isBrowserNetworkSuspendedWindow()) {
    return null;
  }

  return {
    resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
  };
}
