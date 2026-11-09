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

export type AndroidWidgetBootstrapPreparation =
  | { kind: 'ready'; request: AndroidWidgetBootstrapRequest }
  | { kind: 'retry-unconfirmed' }
  | { kind: 'rejected-stale' };

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
    const persistedRequest = request?.originOwnerUserId ? request : null;
    writePendingAndroidWidgetBootstrapStorage(storage, persistedRequest);
    if (request && !persistedRequest) writeDeferredStartupEntryIntentStorage(storage, null);
  }

  persistDeferredStartupEntryIntent(startupEntryIntent: StartupEntryIntent | null): void {
    if (startupEntryIntent && !this.options.pendingAndroidWidgetBootstrap()?.originOwnerUserId) return;
    const storage = this.options.getStorage();
    if (!storage) return;

    writeDeferredStartupEntryIntentStorage(storage, startupEntryIntent);
  }

  preparePendingBootstrap(
    request: AndroidWidgetBootstrapRequest,
    ownerUserId: string,
    isCurrent: () => boolean,
  ): AndroidWidgetBootstrapPreparation {
    if (!isCurrent() || !this.sameRequest(this.options.pendingAndroidWidgetBootstrap(), request)) {
      return { kind: 'rejected-stale' };
    }
    if (request.originOwnerUserId && request.originOwnerUserId !== ownerUserId) {
      this.clearIfCurrent(request);
      return { kind: 'rejected-stale' };
    }

    const candidate = request.originOwnerUserId
      ? request
      : { ...request, originOwnerUserId: ownerUserId };
    this.options.pendingAndroidWidgetBootstrap.set(candidate);
    const storage = this.options.getStorage();
    if (!storage) return { kind: 'retry-unconfirmed' };

    const previous = readPendingAndroidWidgetBootstrapStorage(storage).value;
    writePendingAndroidWidgetBootstrapStorage(storage, candidate);
    const persisted = readPendingAndroidWidgetBootstrapStorage(storage).value;
    if (!isCurrent() || !this.sameRequest(this.options.pendingAndroidWidgetBootstrap(), candidate)) {
      writePendingAndroidWidgetBootstrapStorage(storage, previous);
      return { kind: 'rejected-stale' };
    }
    if (!this.sameRequest(persisted, candidate)) return { kind: 'retry-unconfirmed' };

    this.persistDeferredStartupEntryIntent(this.options.deferredStartupEntryIntent());
    return { kind: 'ready', request: candidate };
  }

  private restorePendingBootstrap(storage: Storage): void {
    const pendingBootstrap = readPendingAndroidWidgetBootstrapStorage(storage);
    if (pendingBootstrap.shouldClear || (pendingBootstrap.value && !pendingBootstrap.value.originOwnerUserId)) {
      writePendingAndroidWidgetBootstrapStorage(storage, null);
      writeDeferredStartupEntryIntentStorage(storage, null);
      this.options.pendingAndroidWidgetBootstrap.set(null);
      this.options.deferredStartupEntryIntent.set(null);
      return;
    }

    if (pendingBootstrap.value) {
      this.options.pendingAndroidWidgetBootstrap.set(pendingBootstrap.value);
    }
  }

  private clearIfCurrent(request: AndroidWidgetBootstrapRequest): void {
    if (!this.sameRequest(this.options.pendingAndroidWidgetBootstrap(), request)) return;
    this.options.pendingAndroidWidgetBootstrap.set(null);
    this.options.deferredStartupEntryIntent.set(null);
    const storage = this.options.getStorage();
    if (!storage) return;
    writePendingAndroidWidgetBootstrapStorage(storage, null);
    writeDeferredStartupEntryIntentStorage(storage, null);
  }

  private sameRequest(
    left: AndroidWidgetBootstrapRequest | null,
    right: AndroidWidgetBootstrapRequest | null,
  ): boolean {
    return !!left && !!right && Object.keys({ ...left, ...right }).every(
      key => left[key as keyof AndroidWidgetBootstrapRequest] === right[key as keyof AndroidWidgetBootstrapRequest],
    );
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
