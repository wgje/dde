import { describe, expect, it, vi } from 'vitest';

import type {
  ConsumedStartupEntryNavigationCommands,
} from './workspace-shell-startup-route.helpers';

interface StartupEntryIntentDelegate {
  flushWidgetWorkspaceGateRecheck(): void;
  resetPrimeState(): void;
  sync(): void;
}

interface StartupEntryIntentLazyHost {
  loadedDelegate: StartupEntryIntentDelegate | null;
  run(
    action: (delegate: StartupEntryIntentDelegate) => void,
    failureMessage?: string,
  ): void;
  teardown(): void;
}

interface PendingActionsController {
  clear(): void;
  flush(delegate: StartupEntryIntentDelegate): void;
  markFlushPending(): void;
  markSyncPending(): void;
}

interface LifecycleControllerOptions {
  captureGateDependencies(): void;
  captureSyncDependencies(): void;
  lazyHost: StartupEntryIntentLazyHost;
  pendingActions: PendingActionsController;
  resolveConsumedStartupEntryNavigation(): ConsumedStartupEntryNavigationCommands;
}

interface LifecycleController {
  flushWidgetWorkspaceGateRecheck(): void;
  resetPrimeState(): void;
  resolveConsumedStartupEntryNavigation(): ConsumedStartupEntryNavigationCommands;
  sync(): void;
  teardown(): void;
}

type LifecycleControllerConstructor = new (
  options: LifecycleControllerOptions,
) => LifecycleController;

async function loadController(): Promise<LifecycleControllerConstructor> {
  const modulePath = './workspace-shell-startup-entry-intent-lifecycle.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellStartupEntryIntentLifecycleController',
  ) as LifecycleControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createContext(): {
  controllerOptions: LifecycleControllerOptions;
  delegate: StartupEntryIntentDelegate;
  events: string[];
  host: StartupEntryIntentLazyHost;
  navigation: ConsumedStartupEntryNavigationCommands;
  pendingActions: PendingActionsController;
} {
  const events: string[] = [];
  const navigation = ['/projects', 'project-root'] as unknown as
    ConsumedStartupEntryNavigationCommands;
  const delegate: StartupEntryIntentDelegate = {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
    resetPrimeState: vi.fn(),
    sync: vi.fn(),
  };
  const pendingActions: PendingActionsController = {
    clear: vi.fn(() => events.push('clear')),
    flush: vi.fn(() => events.push('flush')),
    markFlushPending: vi.fn(() => events.push('mark-flush')),
    markSyncPending: vi.fn(() => events.push('mark-sync')),
  };
  const host: StartupEntryIntentLazyHost = {
    loadedDelegate: delegate,
    run: vi.fn(action => {
      events.push('run');
      action(delegate);
    }),
    teardown: vi.fn(() => events.push('host-teardown')),
  };

  return {
    controllerOptions: {
      captureGateDependencies: () => events.push('capture-gate'),
      captureSyncDependencies: () => events.push('capture-sync'),
      lazyHost: host,
      pendingActions,
      resolveConsumedStartupEntryNavigation: () => navigation,
    },
    delegate,
    events,
    host,
    navigation,
    pendingActions,
  };
}

describe('WorkspaceShellStartupEntryIntentLifecycleController', () => {
  it('captures sync and gate dependencies before flushing their pending actions', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.controllerOptions);

    controller.sync();

    expect(context.events).toEqual([
      'capture-sync',
      'mark-sync',
      'run',
      'flush',
    ]);
    expect(context.pendingActions.flush).toHaveBeenCalledWith(context.delegate);
    expect(context.host.run).toHaveBeenLastCalledWith(
      expect.any(Function),
      'Startup entry intent lazy-load host 加载失败，已保留待处理动作',
    );

    context.events.length = 0;
    controller.flushWidgetWorkspaceGateRecheck();

    expect(context.events).toEqual([
      'capture-gate',
      'mark-flush',
      'run',
      'flush',
    ]);
  });

  it('resets the loaded delegate and exposes consumed navigation resolution', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.controllerOptions);

    controller.resetPrimeState();

    expect(context.delegate.resetPrimeState).toHaveBeenCalledTimes(1);
    expect(controller.resolveConsumedStartupEntryNavigation()).toBe(context.navigation);
  });

  it('clears pending work and blocks lifecycle actions after teardown', async () => {
    const Controller = await loadController();
    const context = createContext();
    const controller = new Controller(context.controllerOptions);

    controller.teardown();
    context.events.length = 0;
    controller.sync();
    controller.flushWidgetWorkspaceGateRecheck();
    controller.resetPrimeState();

    expect(context.pendingActions.clear).toHaveBeenCalledTimes(1);
    expect(context.host.teardown).toHaveBeenCalledTimes(1);
    expect(context.events).toEqual([]);
    expect(context.delegate.resetPrimeState).not.toHaveBeenCalled();
    expect(controller.resolveConsumedStartupEntryNavigation()).toBe(context.navigation);
  });
});
