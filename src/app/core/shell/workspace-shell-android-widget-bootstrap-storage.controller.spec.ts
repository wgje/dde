import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY,
  ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY,
} from './workspace-shell-android-widget-bootstrap.helpers';
import { WorkspaceShellAndroidWidgetBootstrapStorageController } from './workspace-shell-android-widget-bootstrap-storage.controller';
import type { AndroidWidgetBootstrapRequest, StartupEntryIntent } from '../../../utils/startup-entry-intent';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class ThrowingRemoveStorage extends MemoryStorage {
  override removeItem(_key: string): void {
    throw new Error('remove denied');
  }
}

const bootstrapRequest: AndroidWidgetBootstrapRequest = {
  callbackUri: 'nanoflow-widget://bootstrap',
  clientVersion: null,
  installationId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  deviceSecret: 'super-secret-device-key',
  instanceId: '33333333-3333-4333-8333-333333333333',
  hostInstanceId: '42',
  sizeBucket: '4x2',
  bootstrapNonce: '44444444-4444-4444-8444-444444444444',
  pendingPushToken: 'fcm-token',
};

const startupEntryIntent: StartupEntryIntent = {
  entry: 'twa',
  intent: 'open-focus-tools',
  rawIntent: 'open-focus-tools',
  widgetGateEntryId: null,
};

function createController(storage: Storage | null = new MemoryStorage()) {
  const pendingAndroidWidgetBootstrap = signal<AndroidWidgetBootstrapRequest | null>(null);
  const deferredStartupEntryIntent = signal<StartupEntryIntent | null>(null);

  return {
    controller: new WorkspaceShellAndroidWidgetBootstrapStorageController({
      getStorage: () => storage,
      pendingAndroidWidgetBootstrap,
      deferredStartupEntryIntent,
    }),
    deferredStartupEntryIntent,
    pendingAndroidWidgetBootstrap,
    storage,
  };
}

describe('WorkspaceShellAndroidWidgetBootstrapStorageController', () => {
  it('restoreAll 应恢复 pending bootstrap 和 deferred startup intent', () => {
    const { controller, deferredStartupEntryIntent, pendingAndroidWidgetBootstrap, storage } = createController();
    storage!.setItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY, JSON.stringify(bootstrapRequest));
    storage!.setItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY, JSON.stringify(startupEntryIntent));

    controller.restoreAll();

    expect(pendingAndroidWidgetBootstrap()).toEqual(bootstrapRequest);
    expect(deferredStartupEntryIntent()).toEqual(startupEntryIntent);
  });

  it('restoreAll 应清理损坏的 storage payload', () => {
    const { controller, storage } = createController();
    storage!.setItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY, '{bad');
    storage!.setItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY, '{bad');

    controller.restoreAll();

    expect(storage!.getItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY)).toBeNull();
    expect(storage!.getItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('restoreAll 清理损坏 payload 时应隔离 removeItem 异常', () => {
    const storage = new ThrowingRemoveStorage();
    const { controller, deferredStartupEntryIntent, pendingAndroidWidgetBootstrap } = createController(storage);
    storage.setItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY, '{bad');
    storage.setItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY, '{bad');

    expect(() => controller.restoreAll()).not.toThrow();

    expect(pendingAndroidWidgetBootstrap()).toBeNull();
    expect(deferredStartupEntryIntent()).toBeNull();
  });

  it('persistPendingBootstrap 和 persistDeferredStartupEntryIntent 应写入和删除 storage', () => {
    const { controller, storage } = createController();

    controller.persistPendingBootstrap(bootstrapRequest);
    controller.persistDeferredStartupEntryIntent(startupEntryIntent);

    expect(JSON.parse(storage!.getItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY)!)).toEqual(bootstrapRequest);
    expect(JSON.parse(storage!.getItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY)!)).toEqual(startupEntryIntent);

    controller.persistPendingBootstrap(null);
    controller.persistDeferredStartupEntryIntent(null);

    expect(storage!.getItem(ANDROID_WIDGET_BOOTSTRAP_STORAGE_KEY)).toBeNull();
    expect(storage!.getItem(ANDROID_WIDGET_STARTUP_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('storage 不可用时应静默跳过', () => {
    const { controller } = createController(null);

    expect(() => {
      controller.restoreAll();
      controller.persistPendingBootstrap(bootstrapRequest);
      controller.persistDeferredStartupEntryIntent(startupEntryIntent);
    }).not.toThrow();
  });
});
