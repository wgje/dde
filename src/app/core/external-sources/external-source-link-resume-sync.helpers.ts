interface ExternalSourceLinkResumeSyncWarningSink {
  warn(message: string, data?: unknown): void;
}

export function scheduleExternalSourceLinkResumeSyncTimer(
  schedule: (callback: () => void, delayMs: number) => number,
  callback: () => void,
  delayMs: number,
  logger: ExternalSourceLinkResumeSyncWarningSink,
): number | null {
  let timer: number | null = null;
  try {
    timer = schedule(callback, delayMs);
  } catch (error) {
    warnResumeSyncTimerFailure(
      logger,
      "思源锚点恢复 timer 注册失败，等待下一次恢复事件重试",
      error,
    );
  }
  return timer;
}

export function clearExternalSourceLinkResumeSyncTimer(
  timer: number | null,
  clear: (timer: number) => void,
  logger: ExternalSourceLinkResumeSyncWarningSink,
): void {
  if (timer == null) return;
  try {
    clear(timer);
  } catch (error) {
    warnResumeSyncTimerFailure(
      logger,
      "思源锚点恢复 timer 清理失败，继续清理其他资源",
      error,
    );
  }
}

function warnResumeSyncTimerFailure(
  logger: ExternalSourceLinkResumeSyncWarningSink,
  message: string,
  error: unknown,
): void {
  try {
    logger.warn(message, {
      message: error instanceof Error ? error.message : "unknown",
    });
  } catch {
    // Warning sinks must not interrupt resume scheduling or teardown.
  }
}
