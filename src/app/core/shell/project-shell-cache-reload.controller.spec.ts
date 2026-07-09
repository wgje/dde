import { describe, expect, it, vi } from 'vitest';

import { ProjectShellCacheReloadController } from './project-shell-cache-reload.controller';

function createLocation(): Location {
  return { reload: vi.fn() } as unknown as Location;
}

function createWindow(overrides: Partial<Window> = {}): Window {
  return {
    location: createLocation(),
    ...overrides,
  } as unknown as Window;
}

function createController(overrides: {
  windowRef?: Window;
  navigatorRef?: Navigator;
  cachesRef?: CacheStorage;
} = {}): ProjectShellCacheReloadController {
  return new ProjectShellCacheReloadController({
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    windowRef: overrides.windowRef ?? createWindow(),
    navigatorRef: overrides.navigatorRef ?? ({} as Navigator),
    cachesRef: overrides.cachesRef,
  });
}

async function flushProjectShellCacheReloadMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe('ProjectShellCacheReloadController', () => {
  it('uses the global force-clear hook before falling back to manual cleanup', async () => {
    const forceClear = vi.fn();
    const windowRef = createWindow({
      __NANOFLOW_FORCE_CLEAR_CACHE__: forceClear,
    } as Partial<Window>);
    const controller = createController({ windowRef });

    controller.reloadPage();
    await flushProjectShellCacheReloadMicrotasks();

    expect(forceClear).toHaveBeenCalledTimes(1);
    expect(windowRef.location.reload).not.toHaveBeenCalled();
  });

  it('reloads when the global force-clear hook rejects', async () => {
    const windowRef = createWindow({
      __NANOFLOW_FORCE_CLEAR_CACHE__: vi.fn().mockRejectedValue(new Error('clear failed')),
    } as Partial<Window>);
    const controller = createController({ windowRef });

    controller.reloadPage();
    await flushProjectShellCacheReloadMicrotasks();

    expect(windowRef.location.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when the global force-clear hook throws synchronously', async () => {
    const clearError = new Error('clear failed synchronously');
    const windowRef = createWindow({
      __NANOFLOW_FORCE_CLEAR_CACHE__: vi.fn(() => {
        throw clearError;
      }),
    } as Partial<Window>);
    const controller = createController({ windowRef });

    expect(() => controller.reloadPage()).not.toThrow();
    await flushProjectShellCacheReloadMicrotasks();

    expect(windowRef.location.reload).toHaveBeenCalledTimes(1);
  });

  it('clears browser caches and unregisters service workers before fallback reload', async () => {
    const windowRef = createWindow();
    const cachesRef = {
      keys: vi.fn().mockResolvedValue(['ngsw', 'chunks']),
      delete: vi.fn().mockResolvedValue(true),
    } as unknown as CacheStorage;
    const registration = { unregister: vi.fn().mockResolvedValue(true) };
    const navigatorRef = {
      serviceWorker: {
        getRegistrations: vi.fn().mockResolvedValue([registration]),
      },
    } as unknown as Navigator;
    const controller = createController({ cachesRef, navigatorRef, windowRef });

    controller.reloadPage();
    await flushProjectShellCacheReloadMicrotasks();

    expect(cachesRef.keys).toHaveBeenCalledTimes(1);
    expect(cachesRef.delete).toHaveBeenCalledWith('ngsw');
    expect(cachesRef.delete).toHaveBeenCalledWith('chunks');
    expect(registration.unregister).toHaveBeenCalledTimes(1);
    expect(windowRef.location.reload).toHaveBeenCalledTimes(1);
  });
});
