import type { WritableSignal } from '@angular/core';
import { expect, it, vi } from 'vitest';

import type { SessionRuntimeResetRegistry } from '../../../services/session-runtime-reset.service';
import type { SettingsModalComponent } from './settings-modal.component';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

type MockSiyuanConfig = {
  runtimeMode: 'extension-relay' | 'direct' | 'cache-only';
  baseUrl: string;
  token?: string;
};

interface SettingsModalSiyuanOwnerGenerationSpecContext {
  component: () => SettingsModalComponent;
  currentUserId: WritableSignal<string | null>;
  destroyFixture: () => void;
  mockSiyuanCache: {
    loadConfig: ReturnType<typeof vi.fn>;
    saveConfig: ReturnType<typeof vi.fn>;
  };
  sessionRuntimeReset: () => SessionRuntimeResetRegistry;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve: resolve! };
}

export function registerSettingsModalSiyuanOwnerGenerationSpecs(
  context: SettingsModalSiyuanOwnerGenerationSpecContext,
): void {
  it('should ignore a stale SiYuan config load after owner A→B→A session resets', async () => {
    const staleLoad = createDeferred<MockSiyuanConfig>();
    context.mockSiyuanCache.loadConfig.mockReturnValueOnce(staleLoad.promise);
    const load = context.component().loadSiyuanConfig();

    context.currentUserId.set('user-b');
    context.sessionRuntimeReset().resetAll('owner-change');
    context.currentUserId.set('user-1');
    context.sessionRuntimeReset().resetAll('owner-change');
    context.component().siyuanRuntimeMode.set('cache-only');
    context.component().siyuanBaseUrl.set('http://localhost:6806');
    context.component().siyuanTokenMask.set('newer-owner-state');
    staleLoad.resolve({
      runtimeMode: 'direct',
      baseUrl: 'http://127.0.0.1:6806',
      token: 'stale-owner-token',
    });

    await load;

    expect(context.component().siyuanRuntimeMode()).toBe('cache-only');
    expect(context.component().siyuanBaseUrl()).toBe('http://localhost:6806');
    expect(context.component().siyuanTokenMask()).toBe('newer-owner-state');
  });

  it('should let a newer same-owner SiYuan load supersede an older request', async () => {
    const staleLoad = createDeferred<MockSiyuanConfig>();
    context.mockSiyuanCache.loadConfig
      .mockReturnValueOnce(staleLoad.promise)
      .mockResolvedValueOnce({
        runtimeMode: 'cache-only',
        baseUrl: 'http://localhost:6806',
      });

    const firstLoad = context.component().loadSiyuanConfig();
    await context.component().loadSiyuanConfig();
    staleLoad.resolve({
      runtimeMode: 'direct',
      baseUrl: 'http://127.0.0.1:6806',
      token: 'stale-same-owner-token',
    });
    await firstLoad;

    expect(context.component().siyuanRuntimeMode()).toBe('cache-only');
    expect(context.component().siyuanBaseUrl()).toBe('http://localhost:6806');
    expect(context.component().siyuanTokenMask()).toBe('');
  });

  it('should not save an A-owned direct token after the owner changes during config read', async () => {
    const staleLoad = createDeferred<MockSiyuanConfig>();
    context.component().siyuanRuntimeMode.set('direct');
    context.mockSiyuanCache.loadConfig.mockReturnValueOnce(staleLoad.promise);
    context.mockSiyuanCache.saveConfig.mockClear();

    const update = context.component().updateSiyuanToken({
      target: { value: 'owner-a-token' },
    } as unknown as Event);
    context.currentUserId.set('user-b');
    context.sessionRuntimeReset().resetAll('owner-change');
    staleLoad.resolve({
      runtimeMode: 'direct',
      baseUrl: 'http://127.0.0.1:6806',
    });

    await update;

    expect(context.mockSiyuanCache.saveConfig).not.toHaveBeenCalled();
    expect(context.component().siyuanTokenMask()).toBe('');
  });

  it('should ignore a SiYuan config completion after the modal is destroyed', async () => {
    const staleLoad = createDeferred<MockSiyuanConfig>();
    context.mockSiyuanCache.loadConfig.mockReturnValueOnce(staleLoad.promise);
    const load = context.component().loadSiyuanConfig();

    context.destroyFixture();
    staleLoad.resolve({
      runtimeMode: 'direct',
      baseUrl: 'http://localhost:6806',
      token: 'destroyed-token',
    });
    await load;

    expect(context.component().siyuanRuntimeMode()).toBe('extension-relay');
    expect(context.component().siyuanTokenMask()).toBe('');
  });
}
