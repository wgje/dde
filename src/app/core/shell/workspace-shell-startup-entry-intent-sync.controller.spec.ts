import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { StartupEntryIntent } from '../../../utils/startup-entry-intent';
import type { WorkspaceShellStartupEntryDeferredClearOwner } from './workspace-shell-startup-entry-action.controller';
import {
  focusToolsIntent,
  markGateReadIntent,
  startupIntent,
} from './workspace-shell-startup-entry-intent.controller.spec-helpers';

interface MutationContext {
  clearDeferredAfterSuccess: boolean;
  onFailure: () => void;
}

interface StartupEntryActionDelegate {
  apply(
    startupEntryIntent: StartupEntryIntent,
    mutationContext: MutationContext | null,
  ): WorkspaceShellStartupEntryDeferredClearOwner;
}

interface StartupQueryCleanupDelegate {
  consume(startupEntryIntentKey: string): void;
  isPending(startupEntryIntentKey: string): boolean;
}

interface WidgetWorkspaceGateDelegate {
  prime(startupEntryIntent: StartupEntryIntent): void;
  resetPrimeState(): void;
}

interface StartupEntryIntentSyncControllerOptions {
  clearDeferredStartupEntryIntent: () => void;
  currentStartupEntryIntent: () => StartupEntryIntent | null;
  deferredStartupEntryIntent: () => StartupEntryIntent | null;
  isApplicationReady: () => boolean;
  routeUrl: () => string;
  startupEntryAction: StartupEntryActionDelegate;
  startupQueryCleanup: StartupQueryCleanupDelegate;
  widgetWorkspaceGate: WidgetWorkspaceGateDelegate;
}

interface StartupEntryIntentSyncController {
  isTornDown(): boolean;
  sync(): void;
  teardown(): void;
}

type StartupEntryIntentSyncControllerConstructor = new (
  options: StartupEntryIntentSyncControllerOptions,
) => StartupEntryIntentSyncController;

async function loadController(): Promise<StartupEntryIntentSyncControllerConstructor> {
  const modulePath = './workspace-shell-startup-entry-intent-sync.controller';
  const controllerModule = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));
  const Controller = Reflect.get(
    controllerModule,
    'WorkspaceShellStartupEntryIntentSyncController',
  ) as StartupEntryIntentSyncControllerConstructor | undefined;

  expect(Controller).toEqual(expect.any(Function));
  return Controller!;
}

function createContext(): {
  action: StartupEntryActionDelegate;
  clearDeferredStartupEntryIntent: ReturnType<typeof vi.fn>;
  cleanup: StartupQueryCleanupDelegate;
  options: StartupEntryIntentSyncControllerOptions;
  setApplicationReady: (ready: boolean) => void;
  setCurrentIntent: (intent: StartupEntryIntent | null) => void;
  setDeferredIntent: (intent: StartupEntryIntent | null) => void;
  setRouteUrl: (url: string) => void;
  widgetGate: WidgetWorkspaceGateDelegate;
} {
  let applicationReady = false;
  let currentIntent: StartupEntryIntent | null = null;
  let deferredIntent: StartupEntryIntent | null = null;
  let routeUrl = '/projects';
  const clearDeferredStartupEntryIntent = vi.fn();
  const action: StartupEntryActionDelegate = {
    apply: vi.fn<StartupEntryActionDelegate['apply']>(() => 'caller'),
  };
  const cleanup: StartupQueryCleanupDelegate = {
    consume: vi.fn(),
    isPending: vi.fn(() => false),
  };
  const widgetGate: WidgetWorkspaceGateDelegate = {
    prime: vi.fn(),
    resetPrimeState: vi.fn(),
  };

  return {
    action,
    cleanup,
    widgetGate,
    clearDeferredStartupEntryIntent,
    options: {
      routeUrl: () => routeUrl,
      currentStartupEntryIntent: () => currentIntent,
      deferredStartupEntryIntent: () => deferredIntent,
      isApplicationReady: () => applicationReady,
      clearDeferredStartupEntryIntent,
      startupEntryAction: action,
      startupQueryCleanup: cleanup,
      widgetWorkspaceGate: widgetGate,
    },
    setApplicationReady: ready => {
      applicationReady = ready;
    },
    setCurrentIntent: intent => {
      currentIntent = intent;
    },
    setDeferredIntent: intent => {
      deferredIntent = intent;
    },
    setRouteUrl: url => {
      routeUrl = url;
    },
  };
}

describe('WorkspaceShellStartupEntryIntentSyncController', () => {
  it('owns startup intent sync state outside the public controller facade', async () => {
    await loadController();
    const source = readFileSync(
      join(__dirname, 'workspace-shell-startup-entry-intent.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellStartupEntryIntentSyncController');
    expect(source).toContain('this.syncController.sync()');
    expect(source).not.toContain('handledStartupEntryIntentKey');
    expect(source).not.toContain('private applyStartupEntryIntentForSync(');
    expect(source).not.toContain('areSameStartupEntryIntent(');
  });

  it('primes a deferred intent before readiness without applying it', async () => {
    const Controller = await loadController();
    const context = createContext();
    const intent = focusToolsIntent();
    context.setDeferredIntent(intent);
    const controller = new Controller(context.options);

    controller.sync();

    expect(context.widgetGate.prime).toHaveBeenCalledWith(intent);
    expect(context.action.apply).not.toHaveBeenCalled();
    expect(context.cleanup.consume).not.toHaveBeenCalled();
  });

  it('leaves current Android bootstrap intents for the capture path', async () => {
    const Controller = await loadController();
    const context = createContext();
    const intent = startupIntent({ androidWidgetBootstrap: true });
    context.setApplicationReady(true);
    context.setCurrentIntent(intent);
    const controller = new Controller(context.options);

    controller.sync();

    expect(context.widgetGate.prime).toHaveBeenCalledWith(intent);
    expect(context.action.apply).not.toHaveBeenCalled();
    expect(context.cleanup.consume).not.toHaveBeenCalled();
  });

  it('applies once per route key while allowing pending cleanup to retry', async () => {
    const Controller = await loadController();
    const context = createContext();
    const intent = focusToolsIntent();
    context.setApplicationReady(true);
    context.setCurrentIntent(intent);
    context.setRouteUrl('/projects?entry=shortcut&intent=open-focus-tools');
    const controller = new Controller(context.options);

    controller.sync();
    vi.mocked(context.cleanup.isPending).mockReturnValue(true);
    controller.sync();

    expect(context.action.apply).toHaveBeenCalledTimes(1);
    expect(context.cleanup.consume).toHaveBeenCalledTimes(2);
  });

  it('releases the handled route key after an action failure', async () => {
    const Controller = await loadController();
    const context = createContext();
    const currentIntent = focusToolsIntent();
    const deferredIntent = markGateReadIntent('gate-1');
    let mutationContext: MutationContext | null = null;
    vi.mocked(context.action.apply).mockImplementation((_intent, value) => {
      mutationContext = value;
      return 'caller';
    });
    context.setApplicationReady(true);
    context.setCurrentIntent(currentIntent);
    context.setDeferredIntent(deferredIntent);
    const controller = new Controller(context.options);

    controller.sync();
    mutationContext!.onFailure();
    controller.sync();

    expect(context.action.apply).toHaveBeenCalledTimes(2);
    expect(context.clearDeferredStartupEntryIntent).not.toHaveBeenCalled();
  });

  it('clears a matching deferred intent only when the action leaves ownership to the caller', async () => {
    const Controller = await loadController();
    const context = createContext();
    const intent = focusToolsIntent();
    context.setApplicationReady(true);
    context.setCurrentIntent(intent);
    context.setDeferredIntent({ ...intent });
    const controller = new Controller(context.options);

    controller.sync();

    expect(context.action.apply).toHaveBeenCalledWith(
      intent,
      expect.objectContaining({ clearDeferredAfterSuccess: true }),
    );
    expect(context.clearDeferredStartupEntryIntent).toHaveBeenCalledTimes(1);
  });

  it('resets handled state when intents clear and ignores sync after teardown', async () => {
    const Controller = await loadController();
    const context = createContext();
    const intent = focusToolsIntent();
    context.setApplicationReady(true);
    context.setCurrentIntent(intent);
    const controller = new Controller(context.options);

    controller.sync();
    context.setCurrentIntent(null);
    controller.sync();
    context.setCurrentIntent(intent);
    controller.sync();
    controller.teardown();
    controller.sync();

    expect(context.action.apply).toHaveBeenCalledTimes(2);
    expect(context.widgetGate.resetPrimeState).toHaveBeenCalledTimes(1);
    expect(controller.isTornDown()).toBe(true);
  });

  it('reapplies the same explicit startup intent after cleanup clears handled state', async () => {
    const Controller = await loadController();
    const context = createContext();
    const intent = focusToolsIntent();
    context.setApplicationReady(true);
    context.setCurrentIntent(intent);
    context.setRouteUrl('/projects?entry=shortcut&intent=open-focus-tools');
    const controller = new Controller(context.options);

    controller.sync();
    expect(context.action.apply).toHaveBeenCalledTimes(1);

    context.setCurrentIntent(null);
    controller.sync();
    expect(context.action.apply).toHaveBeenCalledTimes(1);

    context.setCurrentIntent(intent);
    controller.sync();

    expect(context.action.apply).toHaveBeenCalledTimes(2);
  });
});
