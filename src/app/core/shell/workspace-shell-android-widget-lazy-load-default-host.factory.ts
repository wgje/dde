import { readRuntimePlatformSnapshot } from '../../../utils/runtime-platform';
import type {
  WorkspaceShellAndroidWidgetLazyLoadDelegate,
} from './workspace-shell-android-widget-lazy-load-delegate.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadHostOptions,
} from './workspace-shell-android-widget-lazy-load-host.controller';
import {
  createWorkspaceShellAndroidWidgetLazyLoadHostLoader,
} from './workspace-shell-android-widget-lazy-load-host-loader.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadControllerOptions,
} from './workspace-shell-android-widget-lazy-load.controller';
import type {
  WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
} from './workspace-shell-android-widget-lazy-load.factory';

export function createWorkspaceShellAndroidWidgetDefaultLazyLoadHost(
  options: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
): Promise<WorkspaceShellAndroidWidgetLazyLoadDelegate> {
  return createWorkspaceShellAndroidWidgetLazyLoadHostLoader({
    createAndroidWidgetLazyLoadHost: options.createAndroidWidgetLazyLoadHost,
    hostOptions: createWorkspaceShellAndroidWidgetLazyLoadHostOptions(options),
  })();
}

export function createWorkspaceShellAndroidWidgetLazyLoadHostOptions(
  options: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
): WorkspaceShellAndroidWidgetLazyLoadHostOptions {
  const platformOptions = createPlatformOptions(options);

  return {
    ...options,
    ...platformOptions,
    completeAndroidBootstrap: request => options.completeAndroidBootstrap(request),
    consumeStartupEntryIntent: onCleanupFailed =>
      consumeStartupEntryIntent(options, onCleanupFailed),
    warningToast: (title, message) => options.warningToast(title, message),
  };
}

function consumeStartupEntryIntent(
  options: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
  onCleanupFailed?: () => void,
): void {
  try {
    const commands = options.resolveConsumedStartupEntryNavigation();
    void Promise.resolve(options.navigate(commands, { replaceUrl: true }))
      .then((navigationResult) => {
        if (navigationResult === false || navigationResult === null) {
          options.warn(
            'Android widget startup query cleanup navigation failed',
            new Error('Router did not confirm Android widget startup query cleanup navigation'),
          );
          onCleanupFailed?.();
        }
      })
      .catch((error: unknown) => {
        options.warn('Android widget startup query cleanup navigation failed', error);
        onCleanupFailed?.();
      });
  } catch (error) {
    options.warn('Android widget startup query cleanup navigation failed', error);
    onCleanupFailed?.();
  }
}

function createPlatformOptions(
  options: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
): Pick<
  WorkspaceShellAndroidWidgetLazyLoadControllerOptions,
  'getDocument' | 'getStorage' | 'getWindow' | 'readRuntimePlatform'
> {
  return {
    getDocument: options.getDocument ?? readAndroidWidgetDocument,
    getStorage: options.getStorage ?? readAndroidWidgetSessionStorage,
    getWindow: options.getWindow ?? readAndroidWidgetWindow,
    readRuntimePlatform: options.readRuntimePlatform ?? readRuntimePlatformSnapshot,
  };
}

function readAndroidWidgetDocument(): Document | object | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

function readAndroidWidgetSessionStorage(): Storage | null {
  if (
    typeof window === 'undefined' ||
    typeof window.sessionStorage === 'undefined'
  ) {
    return null;
  }

  return window.sessionStorage;
}

function readAndroidWidgetWindow(): WorkspaceShellAndroidWidgetLazyLoadControllerOptions['getWindow'] extends () => infer T
  ? T
  : never {
  return typeof window === 'undefined' ? undefined : window;
}
