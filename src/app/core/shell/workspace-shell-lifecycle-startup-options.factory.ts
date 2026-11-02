import { effect, type EffectRef, type Injector } from '@angular/core';

import type {
  WorkspaceShellLifecycleDelegatesOptions,
} from './workspace-shell-lifecycle-delegates.factory';

export interface WorkspaceShellLifecycleStartupOptionsFactoryOptions {
  injector?: Injector;
  destroyed: () => boolean;
  startupTier?: {
    isTierReady(tier: 'p1'): boolean;
  };
  warn: (message: string, error: unknown) => void;
}

export type WorkspaceShellLifecycleStartupOptions = Pick<
  WorkspaceShellLifecycleDelegatesOptions,
  'flowPrewarm' | 'lazyLifecycles' | 'startupLazyServices'
>;

export function createWorkspaceShellLifecycleStartupOptions(
  options: WorkspaceShellLifecycleStartupOptionsFactoryOptions,
): WorkspaceShellLifecycleStartupOptions {
  const gateScheduledPrewarm = createStartupTierP1Gate(options);

  return {
    flowPrewarm: {
      isDestroyed: options.destroyed,
      ...(gateScheduledPrewarm ? { gateScheduledPrewarm } : {}),
      warn: options.warn,
    },
    lazyLifecycles: {
      injector: options.injector,
      runtime: { destroyed: options.destroyed },
      warn: options.warn,
    },
    startupLazyServices: {
      injector: options.injector,
      warn: options.warn,
    },
  };
}

function createStartupTierP1Gate(
  options: WorkspaceShellLifecycleStartupOptionsFactoryOptions,
): WorkspaceShellLifecycleStartupOptions['flowPrewarm']['gateScheduledPrewarm'] | undefined {
  if (!options.startupTier || !options.injector) {
    return undefined;
  }

  return resume => {
    if (options.startupTier?.isTierReady('p1')) {
      resume();
      return undefined;
    }

    let effectRef: EffectRef | null = effect(() => {
      if (!options.startupTier?.isTierReady('p1')) {
        return;
      }

      effectRef?.destroy();
      effectRef = null;
      resume();
    }, {
      injector: options.injector,
      manualCleanup: true,
    });

    return () => {
      effectRef?.destroy();
      effectRef = null;
    };
  };
}
