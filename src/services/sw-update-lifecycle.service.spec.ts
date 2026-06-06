import { vi, describe, it, expect } from 'vitest';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import { SwUpdateLifecycleService, type SwUpdateCheckReason } from './sw-update-lifecycle.service';

type SwUpdateLifecyclePrivate = {
  setupSwUpdateChecks: () => void;
  teardownSwUpdateChecks: () => void;
  checkForSwUpdate: (reason: SwUpdateCheckReason, force?: boolean) => Promise<void>;
  swUpdateInitialCheckTimer: ReturnType<typeof setTimeout> | null;
  swUpdatePollTimer: ReturnType<typeof setInterval> | null;
  swUpdateCheckInFlight: boolean;
  lastSwUpdateCheckAt: number;
  stopped: boolean;
  swUpdate: { isEnabled: boolean; checkForUpdate: ReturnType<typeof vi.fn> };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
};

function createSwUpdateCheckContext(checkForUpdate = vi.fn().mockResolvedValue(false)): SwUpdateLifecyclePrivate {
  const context = Object.create(SwUpdateLifecycleService.prototype) as SwUpdateLifecyclePrivate;
  context.swUpdateInitialCheckTimer = null;
  context.swUpdatePollTimer = null;
  context.swUpdateCheckInFlight = false;
  context.lastSwUpdateCheckAt = 0;
  context.stopped = false;
  context.swUpdate = { isEnabled: true, checkForUpdate };
  context.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return context;
}

function setDocumentVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('SwUpdateLifecycleService 版本更新检查', () => {
  it('应在启动延迟后主动检查 Service Worker 更新', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn().mockResolvedValue(false);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      context.setupSwUpdateChecks();

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS);

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      expect(context.logger.debug).toHaveBeenCalledWith(
        'SwUpdate checkForUpdate completed without new version',
        { reason: 'startup' },
      );
    } finally {
      context.teardownSwUpdateChecks();
      vi.useRealTimers();
    }
  });

  it('应对 focus/visibility/online 触发的版本检查做冷却去重', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn().mockResolvedValue(true);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      await context.checkForSwUpdate('focus');
      await context.checkForSwUpdate('online');
      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_RESUME_CHECK_COOLDOWN_MS);
      await context.checkForSwUpdate('visibility');

      expect(checkForUpdate).toHaveBeenCalledTimes(2);
      expect(context.logger.info).toHaveBeenCalledWith(
        'SwUpdate checkForUpdate detected a deploy version',
        { reason: 'focus' },
      );
    } finally {
      context.teardownSwUpdateChecks();
      vi.useRealTimers();
    }
  });
});
