import { describe, expect, it, vi } from 'vitest';

import {
  startWidgetBootstrapAttempt,
  WorkspaceShellAndroidWidgetBootstrapProcessingController,
  type WorkspaceShellAndroidWidgetBootstrapProcessingControllerOptions,
} from './workspace-shell-android-widget-bootstrap-processing.controller';
import { AUTH_CONFIG } from '../../../config/auth.config';
import type { AndroidWidgetBootstrapRequest } from '../../../utils/startup-entry-intent';

const BOOTSTRAP_REQUEST: AndroidWidgetBootstrapRequest = {
  callbackUri: 'nanoflow-widget://bootstrap',
  clientVersion: null,
  installationId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  deviceSecret: 'super-secret-device-key',
  instanceId: '33333333-3333-4333-8333-333333333333',
  hostInstanceId: '42',
  sizeBucket: '4x2',
  bootstrapNonce: '44444444-4444-4444-8444-444444444444',
  pendingPushToken: null,
};

const STAMPED_BOOTSTRAP_REQUEST: AndroidWidgetBootstrapRequest = {
  ...BOOTSTRAP_REQUEST,
  originOwnerUserId: 'user-1',
};

function createController(overrides: Partial<WorkspaceShellAndroidWidgetBootstrapProcessingControllerOptions> = {}) {
  const completeAndroidWidgetBootstrap = vi.fn();
  let pendingBootstrap: AndroidWidgetBootstrapRequest | null = BOOTSTRAP_REQUEST;
  let currentUserId: string | null = 'user-1';
  let sessionInitialized = true;
  let inFlight = false;

  const controller = new WorkspaceShellAndroidWidgetBootstrapProcessingController({
    pendingBootstrap: () => pendingBootstrap,
    currentUserId: () => currentUserId,
    isSessionInitialized: () => sessionInitialized,
    isInFlight: () => inFlight,
    preparePendingBootstrap: vi.fn(() => ({
      kind: 'ready' as const,
      request: STAMPED_BOOTSTRAP_REQUEST,
    })),
    completeAndroidWidgetBootstrap,
    ...overrides,
  });

  return {
    completeAndroidWidgetBootstrap,
    controller,
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setInFlight: (nextInFlight: boolean) => {
      inFlight = nextInFlight;
    },
    setPendingBootstrap: (request: AndroidWidgetBootstrapRequest | null) => {
      pendingBootstrap = request;
    },
    setSessionInitialized: (initialized: boolean) => {
      sessionInitialized = initialized;
    },
  };
}

describe('WorkspaceShellAndroidWidgetBootstrapProcessingController', () => {
  it('does not complete when there is no pending bootstrap request', () => {
    const { completeAndroidWidgetBootstrap, controller, setPendingBootstrap } = createController();
    setPendingBootstrap(null);

    controller.sync();

    expect(completeAndroidWidgetBootstrap).not.toHaveBeenCalled();
  });

  it('does not complete before the auth session is initialized', () => {
    const { completeAndroidWidgetBootstrap, controller, setSessionInitialized } = createController();
    setSessionInitialized(false);

    controller.sync();

    expect(completeAndroidWidgetBootstrap).not.toHaveBeenCalled();
  });

  it('does not complete before a user is restored', () => {
    const { completeAndroidWidgetBootstrap, controller, setCurrentUserId } = createController();
    setCurrentUserId(null);

    controller.sync();

    expect(completeAndroidWidgetBootstrap).not.toHaveBeenCalled();
  });

  it('does not complete for the local-mode owner during auth settle', () => {
    const { completeAndroidWidgetBootstrap, controller, setCurrentUserId } = createController();
    setCurrentUserId(AUTH_CONFIG.LOCAL_MODE_USER_ID);

    controller.sync();

    expect(completeAndroidWidgetBootstrap).not.toHaveBeenCalled();
  });

  it('does not complete while bootstrap completion is already in flight', () => {
    const { completeAndroidWidgetBootstrap, controller, setInFlight } = createController();
    setInFlight(true);

    controller.sync();

    expect(completeAndroidWidgetBootstrap).not.toHaveBeenCalled();
  });

  it('completes the pending bootstrap once all gates are ready', () => {
    const { completeAndroidWidgetBootstrap, controller } = createController();

    controller.sync();

    expect(completeAndroidWidgetBootstrap).toHaveBeenCalledWith(
      STAMPED_BOOTSTRAP_REQUEST,
      expect.any(Number),
    );
  });

  it('rejects deferred A attempts superseded by A to B to A before preparation', () => {
    const preparePendingBootstrap = vi.fn(() => ({
      kind: 'ready' as const,
      request: STAMPED_BOOTSTRAP_REQUEST,
    }));
    const { completeAndroidWidgetBootstrap, controller } = createController({
      preparePendingBootstrap,
    });
    const deferred: Array<() => void> = [];

    startWidgetBootstrapAttempt(() => deferred.push(() => controller.sync()));
    startWidgetBootstrapAttempt(() => deferred.push(() => controller.sync()));
    startWidgetBootstrapAttempt(() => deferred.push(() => controller.sync()));

    deferred[0]();
    deferred[1]();
    expect(preparePendingBootstrap).not.toHaveBeenCalled();
    expect(completeAndroidWidgetBootstrap).not.toHaveBeenCalled();

    deferred[2]();
    expect(preparePendingBootstrap).toHaveBeenCalledTimes(1);
    expect(completeAndroidWidgetBootstrap).toHaveBeenCalledTimes(1);
  });

  it.each(['retry-unconfirmed', 'rejected-stale'] as const)(
    'publishes nothing when preparation is %s',
    kind => {
      const { completeAndroidWidgetBootstrap, controller } = createController({
        preparePendingBootstrap: vi.fn(() => ({ kind })),
      });

      controller.sync();

      expect(completeAndroidWidgetBootstrap).not.toHaveBeenCalled();
    },
  );

  it('isolates rejected bootstrap completion and remains retryable', () => {
    const { completeAndroidWidgetBootstrap, controller } = createController();
    const rejectHandlers: Array<(error: unknown) => unknown> = [];
    const completion = {
      catch: vi.fn((handler: (error: unknown) => unknown) => {
        rejectHandlers.push(handler);
        return Promise.resolve();
      }),
    } as unknown as Promise<void>;
    completeAndroidWidgetBootstrap.mockReturnValueOnce(completion);

    controller.sync();
    expect(completion.catch).toHaveBeenCalledWith(expect.any(Function));
    expect(rejectHandlers).toHaveLength(1);
    rejectHandlers[0](new Error('bootstrap completion failed'));

    controller.sync();

    expect(completeAndroidWidgetBootstrap).toHaveBeenCalledTimes(2);
    expect(completeAndroidWidgetBootstrap)
      .toHaveBeenNthCalledWith(2, STAMPED_BOOTSTRAP_REQUEST, expect.any(Number));
  });
});
