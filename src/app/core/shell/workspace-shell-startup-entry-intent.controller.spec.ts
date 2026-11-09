import { describe, expect, it, vi } from 'vitest';

import {
  blackBoxRecorderIntent,
  createStartupEntryIntentController as createController,
  expectGateReadApplied,
  focusToolsIntent,
  markGateReadIntent,
  startupIntent,
  twaWorkspaceIntent,
  widgetWorkspaceIntent,
} from './workspace-shell-startup-entry-intent.controller.spec-helpers';

describe('WorkspaceShellStartupEntryIntentController', () => {
  it('opens sidebar tools and loads the black box recorder for enabled blackbox shortcuts', () => {
    const activateSidebarTools = vi.fn();
    const {
      controller,
      loadBlackBoxRecorder,
      preloadSidebarTools,
      setSidebarOpen,
    } = createController({ activateSidebarTools });

    controller.apply(blackBoxRecorderIntent());

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    expect(activateSidebarTools).toHaveBeenCalledTimes(1);
    expect(preloadSidebarTools).toHaveBeenCalledWith('intent');
    expect(loadBlackBoxRecorder).toHaveBeenCalledTimes(1);
  });

  it('isolates black box recorder lazy-load failures from startup intent handling', async () => {
    const {
      controller,
      loadBlackBoxRecorder,
      preloadSidebarTools,
      setSidebarOpen,
      warn,
    } = createController();
    const loadError = new Error('recorder import failed');
    loadBlackBoxRecorder.mockRejectedValue(loadError);

    controller.apply(blackBoxRecorderIntent());
    await Promise.resolve();

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    expect(preloadSidebarTools).toHaveBeenCalledWith('intent');
    expect(warn).toHaveBeenCalledWith(
      'Startup entry black box recorder preload failed',
      loadError,
    );
  });

  it('does not load the black box recorder when blackbox tools are disabled', () => {
    const { controller, loadBlackBoxRecorder, preloadSidebarTools, setSidebarOpen } = createController({
      isBlackBoxEnabled: () => false,
    });

    controller.apply(blackBoxRecorderIntent());

    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    expect(preloadSidebarTools).toHaveBeenCalledWith('intent');
    expect(loadBlackBoxRecorder).not.toHaveBeenCalled();
  });

  it('routes widget gate mutations through the mutation controller callback', () => {
    const { applyWidgetGateMutation, controller } = createController();

    controller.apply(markGateReadIntent('entry-1'));

    expectGateReadApplied(applyWidgetGateMutation, 'entry-1');
  });

  it('isolates widget gate mutation rejections from direct apply calls', async () => {
    const { applyWidgetGateMutation, controller, warn } = createController();
    const mutationError = new Error('gate mutation chunk load failed');
    applyWidgetGateMutation.mockRejectedValue(mutationError);

    controller.apply(markGateReadIntent('entry-9'));
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith('Startup entry widget gate mutation failed', mutationError);
  });

  it('clears the deferred widget gate mutation intent only after the async mutation succeeds', async () => {
    const {
      applyWidgetGateMutation,
      clearDeferredStartupEntryIntent,
      controller,
      setApplicationReady,
      setDeferredStartupEntryIntent,
    } = createController();
    let resolveMutation!: () => void;
    applyWidgetGateMutation.mockImplementation(() => new Promise<void>(resolve => {
      resolveMutation = resolve;
    }));
    setApplicationReady(true);
    setDeferredStartupEntryIntent(markGateReadIntent('gate-entry-1'));

    controller.sync();

    expectGateReadApplied(applyWidgetGateMutation, 'gate-entry-1');
    expect(clearDeferredStartupEntryIntent).not.toHaveBeenCalled();

    resolveMutation();
    await Promise.resolve();
    await Promise.resolve();

    expect(clearDeferredStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('keeps the deferred widget gate mutation intent replayable when the async mutation fails', async () => {
    const {
      applyWidgetGateMutation,
      clearDeferredStartupEntryIntent,
      controller,
      setApplicationReady,
      setDeferredStartupEntryIntent,
      warn,
    } = createController();
    const mutationError = new Error('gate mutation persist failed');
    applyWidgetGateMutation
      .mockRejectedValueOnce(mutationError)
      .mockResolvedValueOnce(undefined);
    setApplicationReady(true);
    setDeferredStartupEntryIntent(markGateReadIntent('gate-entry-2'));

    controller.sync();
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith('Startup entry widget gate mutation failed', mutationError);
    expect(clearDeferredStartupEntryIntent).not.toHaveBeenCalled();

    controller.sync();
    await Promise.resolve();
    await Promise.resolve();

    expect(applyWidgetGateMutation).toHaveBeenCalledTimes(2);
    expect(clearDeferredStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('primes widget open-workspace remote-first gate sync only once for the same route', () => {
    const {
      controller,
      primeWidgetWorkspaceGateSync,
      refreshFocusSessionFromCloud,
    } = createController();
    const intent = widgetWorkspaceIntent();

    controller.primeWidgetWorkspaceGateSync(intent);
    controller.primeWidgetWorkspaceGateSync(intent);

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledOnce();
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
  });

  it('isolates widget workspace gate cloud refresh failures during priming', async () => {
    const {
      controller,
      refreshFocusSessionFromCloud,
      warn,
    } = createController();
    const refreshError = new Error('focus cloud refresh failed');
    refreshFocusSessionFromCloud.mockRejectedValue(refreshError);

    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());
    await Promise.resolve();

    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
    expect(warn).toHaveBeenCalledWith(
      'Startup entry widget workspace gate cloud refresh failed',
      refreshError,
    );
  });

  it('does not consume the pending gate recheck when the owner changed while the recheck was in flight', async () => {
    const { controller, recheckGate, setApplicationReady, setCurrentUserId } = createController({
      isApplicationReady: () => true,
    });
    setApplicationReady(true);
    let resolveRecheck!: () => void;
    recheckGate.mockImplementation(() => new Promise<void>(resolve => {
      resolveRecheck = resolve;
    }));

    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());
    expect(recheckGate).toHaveBeenCalledTimes(1);

    // recheck 在途时账号发生切换：旧 owner 的完成结果不得消费 pending 复查
    setCurrentUserId('user-2');
    resolveRecheck();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    controller.flushWidgetWorkspaceGateRecheck();
    expect(recheckGate).toHaveBeenCalledTimes(2);
  });

  it('leaves android widget bootstrap query cleanup to the bootstrap capture path', () => {
    const {
      applyWidgetGateMutation,
      controller,
      navigate,
      primeWidgetWorkspaceGateSync,
      setApplicationReady,
      setCurrentStartupEntryIntent,
      setRouteUrl,
    } = createController({
      isApplicationReady: () => true,
    });
    setApplicationReady(true);
    setRouteUrl('/projects?entry=twa&intent=open-workspace&widgetBootstrap=1');
    setCurrentStartupEntryIntent(twaWorkspaceIntent({ androidWidgetBootstrap: true }));

    controller.sync();

    // bootstrap capture 独占 query 清理：sync 不应重复发起 replaceUrl 导航
    expect(navigate).not.toHaveBeenCalled();
    expect(applyWidgetGateMutation).not.toHaveBeenCalled();
    // 但仍应照常 prime 远端优先的 gate sync
    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
  });

  it('supports TWA bootstrap open-workspace as the same remote-first gate sync path', () => {
    const { controller, primeWidgetWorkspaceGateSync, refreshFocusSessionFromCloud, setRouteUrl } = createController();
    setRouteUrl('/projects?entry=twa&intent=open-workspace&widgetBootstrap=1');

    controller.primeWidgetWorkspaceGateSync(twaWorkspaceIntent({
      androidWidgetBootstrap: true,
    }));

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
  });

  it('keeps the pending gate recheck until the application is ready', () => {
    const { controller, recheckGate, setApplicationReady } = createController();

    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());
    expect(recheckGate).not.toHaveBeenCalled();

    setApplicationReady(true);
    controller.flushWidgetWorkspaceGateRecheck();

    expect(recheckGate).toHaveBeenCalledWith({
      source: 'widget-open-workspace',
      reloadLocal: false,
    });
  });

  it('keeps the pending gate recheck until a user is restored', () => {
    const { controller, recheckGate, setCurrentUserId } = createController({
      isApplicationReady: () => true,
    });

    setCurrentUserId(null);
    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());
    expect(recheckGate).not.toHaveBeenCalled();

    setCurrentUserId('user-1');
    controller.flushWidgetWorkspaceGateRecheck();

    expect(recheckGate).toHaveBeenCalledWith({
      source: 'widget-open-workspace',
      reloadLocal: false,
    });
  });

  it('keeps a failed pending gate recheck retryable for a later flush', async () => {
    const {
      controller,
      recheckGate,
      setApplicationReady,
      warn,
    } = createController();
    const recheckError = new Error('gate recheck failed');
    recheckGate
      .mockRejectedValueOnce(recheckError)
      .mockResolvedValueOnce(undefined);

    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());
    setApplicationReady(true);
    controller.flushWidgetWorkspaceGateRecheck();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry widget workspace gate recheck failed',
      recheckError,
    ));
    expect(recheckGate).toHaveBeenCalledTimes(1);

    controller.flushWidgetWorkspaceGateRecheck();

    await vi.waitFor(() => expect(recheckGate).toHaveBeenCalledTimes(2));
  });

  it('serializes widget workspace gate rechecks when the startup route changes while one is in flight', async () => {
    const {
      controller,
      recheckGate,
      setApplicationReady,
      setRouteUrl,
    } = createController();
    let resolveFirstRecheck!: () => void;
    recheckGate.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveFirstRecheck = resolve;
    }));
    setApplicationReady(true);

    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());
    expect(recheckGate).toHaveBeenCalledTimes(1);

    setRouteUrl('/projects/project-2?entry=widget&intent=open-workspace');
    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());

    expect(recheckGate).toHaveBeenCalledTimes(1);

    resolveFirstRecheck();

    await vi.waitFor(() => expect(recheckGate).toHaveBeenCalledTimes(2));
  });

  it('does not warn when an in-flight widget workspace gate recheck fails after teardown', async () => {
    const {
      controller,
      recheckGate,
      setApplicationReady,
      warn,
    } = createController();
    const recheckError = new Error('gate recheck failed after teardown');
    let rejectRecheck!: (reason?: unknown) => void;
    recheckGate.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectRecheck = reject;
    }));
    setApplicationReady(true);

    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());
    expect(recheckGate).toHaveBeenCalledTimes(1);

    (controller as { teardown?: () => void }).teardown?.();
    rejectRecheck(recheckError);
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalledWith(
      'Startup entry widget workspace gate recheck failed',
      recheckError,
    );
  });

  it('defers widget workspace gate priming until a user is restored', () => {
    const {
      controller,
      primeWidgetWorkspaceGateSync,
      refreshFocusSessionFromCloud,
      setCurrentUserId,
    } = createController({
      isApplicationReady: () => true,
    });

    setCurrentUserId(null);
    controller.primeWidgetWorkspaceGateSync(widgetWorkspaceIntent());

    expect(primeWidgetWorkspaceGateSync).not.toHaveBeenCalled();
    expect(refreshFocusSessionFromCloud).not.toHaveBeenCalled();

    setCurrentUserId('user-1');
    controller.primeWidgetWorkspaceGateSync(startupIntent({}));

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
    expect(refreshFocusSessionFromCloud).toHaveBeenCalledWith('user-1');
  });

  it('resetPrimeState allows a later identical startup intent to prime again', () => {
    const { controller, primeWidgetWorkspaceGateSync } = createController();
    const intent = widgetWorkspaceIntent();

    controller.primeWidgetWorkspaceGateSync(intent);
    controller.resetPrimeState();
    controller.primeWidgetWorkspaceGateSync(intent);

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(2);
  });

  it('sync resets prime state when no startup entry intent is active', () => {
    const { controller, primeWidgetWorkspaceGateSync } = createController();
    const intent = widgetWorkspaceIntent();
    controller.primeWidgetWorkspaceGateSync(intent);

    controller.sync();
    controller.primeWidgetWorkspaceGateSync(intent);

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(2);
  });

  it('sync primes a deferred startup intent before the application is ready', () => {
    const {
      controller,
      primeWidgetWorkspaceGateSync,
      setDeferredStartupEntryIntent,
    } = createController();
    setDeferredStartupEntryIntent(widgetWorkspaceIntent());

    controller.sync();

    expect(primeWidgetWorkspaceGateSync).toHaveBeenCalledTimes(1);
  });

  it('sync applies a startup intent only once per route key after the application is ready', () => {
    const {
      clearDeferredStartupEntryIntent,
      controller,
      preloadSidebarTools,
      setApplicationReady,
      setCurrentStartupEntryIntent,
    } = createController();
    setApplicationReady(true);
    setCurrentStartupEntryIntent(focusToolsIntent());

    controller.sync();
    controller.sync();

    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);
    expect(clearDeferredStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('sync consumes startup query only when the current route still carries the startup intent', () => {
    const {
      controller,
      navigate,
      setApplicationReady,
      setCurrentStartupEntryIntent,
      setDeferredStartupEntryIntent,
      setRouteUrl,
    } = createController();
    setApplicationReady(true);
    setDeferredStartupEntryIntent(twaWorkspaceIntent());
    controller.sync();
    expect(navigate).not.toHaveBeenCalled();

    setCurrentStartupEntryIntent(twaWorkspaceIntent());
    setRouteUrl('/projects?entry=twa&intent=open-workspace');
    controller.sync();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      ['/projects', 'project-root', 'text'],
      { replaceUrl: true },
    );
  });

  it('sync consumes a startup query by navigating to the preserved deep link without shell wrapper code', () => {
    const {
      controller,
      navigate,
      setApplicationReady,
      setCurrentStartupEntryIntent,
      setRouteUrl,
    } = createController();
    setApplicationReady(true);
    setRouteUrl('/projects/project-1/task/task-1?entry=widget&intent=open-workspace');
    setCurrentStartupEntryIntent(widgetWorkspaceIntent());

    controller.sync();

    expect(navigate).toHaveBeenCalledWith(
      ['/projects', 'project-1', 'task', 'task-1'],
      { replaceUrl: true },
    );
  });

  it('isolates startup query cleanup navigation failures', async () => {
    const {
      controller,
      navigate,
      setApplicationReady,
      setCurrentStartupEntryIntent,
      warn,
    } = createController();
    const navigationError = new Error('router rejected cleanup');
    setApplicationReady(true);
    setCurrentStartupEntryIntent(widgetWorkspaceIntent());
    navigate.mockRejectedValue(navigationError);

    controller.sync();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry query cleanup navigation failed',
      navigationError,
    ));
  });

  it('retries failed startup query cleanup without reapplying the startup action', async () => {
    const {
      controller,
      navigate,
      preloadSidebarTools,
      setApplicationReady,
      setCurrentStartupEntryIntent,
      setRouteUrl,
      warn,
    } = createController();
    const navigationError = new Error('router rejected cleanup');
    setApplicationReady(true);
    setRouteUrl('/projects?entry=shortcut&intent=open-focus-tools');
    setCurrentStartupEntryIntent(focusToolsIntent());
    navigate
      .mockRejectedValueOnce(navigationError)
      .mockResolvedValueOnce(undefined);

    controller.sync();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry query cleanup navigation failed',
      navigationError,
    ));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);

    controller.sync();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter cleanup failure handling when warning an unsuccessful navigation also fails', async () => {
    const {
      controller,
      navigate,
      preloadSidebarTools,
      setApplicationReady,
      setCurrentStartupEntryIntent,
      setRouteUrl,
      warn,
    } = createController();
    const warningError = new Error('warning sink failed');
    setApplicationReady(true);
    setRouteUrl('/projects?entry=shortcut&intent=open-focus-tools');
    setCurrentStartupEntryIntent(focusToolsIntent());
    navigate
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    warn.mockImplementation(() => {
      throw warningError;
    });

    controller.sync();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry query cleanup navigation failed',
      expect.any(Error),
    ));
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);

    controller.sync();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);
  });

  it('retries startup query cleanup when router resolves navigation as unsuccessful', async () => {
    const {
      controller,
      navigate,
      preloadSidebarTools,
      setApplicationReady,
      setCurrentStartupEntryIntent,
      setRouteUrl,
      warn,
    } = createController();
    setApplicationReady(true);
    setRouteUrl('/projects?entry=shortcut&intent=open-focus-tools');
    setCurrentStartupEntryIntent(focusToolsIntent());
    navigate
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    controller.sync();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry query cleanup navigation failed',
      expect.any(Error),
    ));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);

    controller.sync();

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);
  });

  it('keeps a different deferred startup intent while retrying failed current query cleanup', async () => {
    const {
      applyWidgetGateMutation,
      clearDeferredStartupEntryIntent,
      controller,
      navigate,
      preloadSidebarTools,
      setApplicationReady,
      setCurrentStartupEntryIntent,
      setDeferredStartupEntryIntent,
      setRouteUrl,
      warn,
    } = createController();
    setApplicationReady(true);
    setRouteUrl('/projects?entry=shortcut&intent=open-focus-tools');
    setCurrentStartupEntryIntent(focusToolsIntent());
    setDeferredStartupEntryIntent(markGateReadIntent('gate-1'));
    navigate.mockResolvedValueOnce(false);

    controller.sync();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry query cleanup navigation failed',
      expect.any(Error),
    ));
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);
    expect(applyWidgetGateMutation).not.toHaveBeenCalled();
    expect(clearDeferredStartupEntryIntent).not.toHaveBeenCalled();

    setCurrentStartupEntryIntent(null);
    setRouteUrl('/projects/project-root/text');
    controller.sync();

    expectGateReadApplied(applyWidgetGateMutation, 'gate-1');
    // deferred 网关变更改为成功后再清除（异步 settle），避免失败时静默丢失重放
    await vi.waitFor(() => expect(clearDeferredStartupEntryIntent).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
