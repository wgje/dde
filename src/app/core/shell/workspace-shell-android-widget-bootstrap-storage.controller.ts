import type { WritableSignal } from '@angular/core';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  readDeferredStartupEntryIntentStorage,
  readPendingAndroidWidgetBootstrapStorage,
  writeDeferredStartupEntryIntentStorage,
  writePendingAndroidWidgetBootstrapStorage,
} from './workspace-shell-android-widget-bootstrap.helpers';

interface WorkspaceShellAndroidWidgetBootstrapStorageOptions {
  getStorage: () => Storage | null;
  pendingAndroidWidgetBootstrap: WritableSignal<AndroidWidgetBootstrapRequest | null>;
  deferredStartupEntryIntent: WritableSignal<StartupEntryIntent | null>;
}

/** Handles persisted Android widget bootstrap state for WorkspaceShellComponent. */
export class WorkspaceShellAndroidWidgetBootstrapStorageController {
  constructor(private readonly options: WorkspaceShellAndroidWidgetBootstrapStorageOptions) {}

  restoreAll(): void {
    const storage = this.options.getStorage();
    if (!storage) return;

    this.restoreDeferredStartupEntryIntent(storage);
    this.restorePendingBootstrap(storage);
  }

  persistPendingBootstrap(request: AndroidWidgetBootstrapRequest | null): void {
    const storage = this.options.getStorage();
    if (!storage) return;

    writePendingAndroidWidgetBootstrapStorage(storage, request);
  }

  persistDeferredStartupEntryIntent(startupEntryIntent: StartupEntryIntent | null): void {
    const storage = this.options.getStorage();
    if (!storage) return;

    writeDeferredStartupEntryIntentStorage(storage, startupEntryIntent);
  }

  private restorePendingBootstrap(storage: Storage): void {
    const pendingBootstrap = readPendingAndroidWidgetBootstrapStorage(storage);
    if (pendingBootstrap.shouldClear) {
      writePendingAndroidWidgetBootstrapStorage(storage, null);
    }

    if (pendingBootstrap.value) {
      this.options.pendingAndroidWidgetBootstrap.set(pendingBootstrap.value);
    }
  }

  private restoreDeferredStartupEntryIntent(storage: Storage): void {
    const startupEntryIntent = readDeferredStartupEntryIntentStorage(storage);
    if (startupEntryIntent.shouldClear) {
      writeDeferredStartupEntryIntentStorage(storage, null);
    }

    if (startupEntryIntent.value) {
      this.options.deferredStartupEntryIntent.set(startupEntryIntent.value);
    }
  }
}
