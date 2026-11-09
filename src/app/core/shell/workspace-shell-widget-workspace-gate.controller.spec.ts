import { describe, expect, it, vi } from 'vitest';

import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import { WorkspaceShellWidgetWorkspaceGateController } from './workspace-shell-widget-workspace-gate.controller';

function widgetWorkspaceIntent(): StartupEntryIntent {
  return {
    entry: 'widget',
    intent: 'open-workspace',
    rawIntent: 'open-workspace',
    widgetGateEntryId: null,
  };
}

function createController() {
  let applicationReady = false;
  let currentUserId: string | null = 'user-1';
  let routeUrl = '/projects/project-1?entry=widget&intent=open-workspace';
  const primeWidgetWorkspaceGateSync = vi.fn();
  const recheckGate = vi.fn();
  const refreshFocusSessionFromCloud = vi.fn();
  const warn = vi.fn();
  const controller = new WorkspaceShellWidgetWorkspaceGateController({
    routeUrl: () => routeUrl,
    currentUserId: () => currentUserId,
    isApplicationReady: () => applicationReady,
    primeWidgetWorkspaceGateSync,
    refreshFocusSessionFromCloud,
    recheckGate,
    warn,
  });

  return {
    controller,
    primeWidgetWorkspaceGateSync,
    recheckGate,
    refreshFocusSessionFromCloud,
    setApplicationReady: (ready: boolean) => {
      applicationReady = ready;
    },
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setRouteUrl: (url: string) => {
      routeUrl = url;
    },
    warn,
  };
}

describe('WorkspaceShellWidgetWorkspaceGateController', () => {
  it('primes and refreshes only once for the same startup route', () => {
    const {
      controller,
      primeWidgetWorkspaceGateSync,
      refreshFocusSessionFromCloud,
    } = createController();
    const intent = widgetWorkspaceIntent();

    controller.prime(intent);
    controller.prime(intent);

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
  });

  it('defers priming until a user is restored', () => {
    const {
      controller,
      primeWidgetWorkspaceGateSync,
      refreshFocusSessionFromCloud,
      setCurrentUserId,
    } = createController();
    setCurrentUserId(null);

    controller.prime(widgetWorkspaceIntent());

    expect(primeWidgetWorkspaceGateSync).not.toHaveBeenCalled();
    expect(refreshFocusSessionFromCloud).not.toHaveBeenCalled();

    setCurrentUserId('user-1');
    controller.prime(widgetWorkspaceIntent());

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
  });

  it('keeps the pending recheck until the application is ready', () => {
    const { controller, recheckGate, setApplicationReady } = createController();

    controller.prime(widgetWorkspaceIntent());
    expect(recheckGate).not.toHaveBeenCalled();

    setApplicationReady(true);
    controller.flush();

    expect(recheckGate).toHaveBeenCalledWith({
      source: 'widget-open-workspace',
      reloadLocal: false,
    });
  });

  it('does not consume an in-flight recheck when the owner changes', async () => {
    const {
      controller,
      recheckGate,
      setApplicationReady,
      setCurrentUserId,
    } = createController();
    let resolveRecheck!: () => void;
    recheckGate.mockImplementation(() => new Promise<void>(resolve => {
      resolveRecheck = resolve;
    }));
    setApplicationReady(true);

    controller.prime(widgetWorkspaceIntent());
    setCurrentUserId('user-2');
    resolveRecheck();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    controller.flush();

    expect(recheckGate).toHaveBeenCalledTimes(2);
  });

  it('serializes a new route recheck behind the in-flight recheck', async () => {
    const {
      controller,
      recheckGate,
      setApplicationReady,
      setRouteUrl,
    } = createController();
    let resolveFirstRecheck!: () => void;
    recheckGate.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolveFirstRecheck = resolve;
    }));
    setApplicationReady(true);

    controller.prime(widgetWorkspaceIntent());
    setRouteUrl('/projects/project-2?entry=widget&intent=open-workspace');
    controller.prime(widgetWorkspaceIntent());

    expect(recheckGate).toHaveBeenCalledTimes(1);

    resolveFirstRecheck();

    await vi.waitFor(() => expect(recheckGate).toHaveBeenCalledTimes(2));
  });

  it('keeps a failed pending recheck retryable', async () => {
    const {
      controller,
      recheckGate,
      setApplicationReady,
      warn,
    } = createController();
    const error = new Error('gate recheck failed');
    recheckGate.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    setApplicationReady(true);

    controller.prime(widgetWorkspaceIntent());

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry widget workspace gate recheck failed',
      error,
    ));

    controller.flush();

    await vi.waitFor(() => expect(recheckGate).toHaveBeenCalledTimes(2));
  });

  it('suppresses late recheck failures after teardown', async () => {
    const {
      controller,
      recheckGate,
      setApplicationReady,
      warn,
    } = createController();
    const error = new Error('late gate recheck failure');
    let rejectRecheck!: (reason?: unknown) => void;
    recheckGate.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectRecheck = reject;
    }));
    setApplicationReady(true);

    controller.prime(widgetWorkspaceIntent());
    controller.teardown();
    rejectRecheck(error);
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalledWith(
      'Startup entry widget workspace gate recheck failed',
      error,
    );
  });

  it('allows an identical route to prime again after reset', () => {
    const { controller, primeWidgetWorkspaceGateSync } = createController();
    const intent = widgetWorkspaceIntent();

    controller.prime(intent);
    controller.resetPrimeState();
    controller.prime(intent);

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(2);
  });
});
