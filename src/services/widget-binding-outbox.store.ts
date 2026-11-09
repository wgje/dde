import { Inject, Injectable, InjectionToken, Optional } from '@angular/core';
import { openIndexedDBAdaptive } from '../utils/indexeddb-open';

const WIDGET_BINDING_OUTBOX_DB_NAME = 'nanoflow-widget-binding-outbox';
const WIDGET_BINDING_OUTBOX_DB_VERSION = 1;
const WIDGET_BINDING_OUTBOX_STORE_NAME = 'operations';

export type WidgetBindingOutboxOperationType = 'revoke-all';

export interface WidgetBindingOutboxOperation {
  operationId: string;
  type: WidgetBindingOutboxOperationType;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
}

export interface WidgetBindingOutboxStoreOptions {
  dbProvider?: () => Promise<IDBDatabase | null>;
  storeName?: string;
}

export const WIDGET_BINDING_OUTBOX_STORE_OPTIONS =
  new InjectionToken<WidgetBindingOutboxStoreOptions>('WidgetBindingOutboxStoreOptions');

@Injectable({ providedIn: 'root' })
export class WidgetBindingOutboxStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbProvider: () => Promise<IDBDatabase | null>;
  private readonly storeName: string;

  constructor(
    @Optional() @Inject(WIDGET_BINDING_OUTBOX_STORE_OPTIONS) options: WidgetBindingOutboxStoreOptions | null = null,
  ) {
    this.storeName = options?.storeName ?? WIDGET_BINDING_OUTBOX_STORE_NAME;
    this.dbProvider = options?.dbProvider ?? (() => this.openDefaultDb());
  }

  async enqueueRevokeAll(): Promise<WidgetBindingOutboxOperation> {
    const db = await this.requireDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const getAllRequest = store.getAll();
      let operation: WidgetBindingOutboxOperation | null = null;

      getAllRequest.onsuccess = () => {
        const existing = (getAllRequest.result as WidgetBindingOutboxOperation[])
          .find(item => item.type === 'revoke-all');
        if (existing) {
          operation = existing;
          return;
        }

        const now = new Date().toISOString();
        operation = {
          operationId: crypto.randomUUID(),
          type: 'revoke-all',
          createdAt: now,
          updatedAt: now,
          attemptCount: 0,
        };
        const addRequest = store.add(operation);
        addRequest.onerror = () => reject(addRequest.error);
      };
      getAllRequest.onerror = () => reject(getAllRequest.error);
      tx.oncomplete = () => {
        if (!operation) {
          reject(new Error('Widget binding outbox enqueue did not complete'));
          return;
        }
        resolve(operation);
      };
      tx.onerror = () => reject(tx.error ?? getAllRequest.error);
      tx.onabort = () => reject(tx.error ?? getAllRequest.error);
    });
  }

  async readPending(): Promise<WidgetBindingOutboxOperation[]> {
    const db = await this.dbProvider();
    if (!db) {
      return [];
    }

    return new Promise((resolve, reject) => {
      const request = db.transaction(this.storeName, 'readonly')
        .objectStore(this.storeName)
        .getAll();

      request.onsuccess = () => {
        resolve((request.result as WidgetBindingOutboxOperation[])
          .slice()
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
      };
      request.onerror = () => reject(request.error);
    });
  }

  /** 记录一次失败尝试：递增 attemptCount 并刷新 updatedAt，供永久失败封顶判断使用 */
  async markAttempt(operationId: string): Promise<void> {
    const db = await this.dbProvider();
    if (!db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.get(operationId);

      request.onsuccess = () => {
        const operation = request.result as WidgetBindingOutboxOperation | undefined;
        if (!operation) {
          return;
        }

        store.put({
          ...operation,
          attemptCount: operation.attemptCount + 1,
          updatedAt: new Date().toISOString(),
        });
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? request.error);
    });
  }

  async delete(operationId: string): Promise<void> {
    const db = await this.dbProvider();
    if (!db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const request = tx.objectStore(this.storeName).delete(operationId);
      let requestCompleted = false;

      request.onsuccess = () => {
        requestCompleted = true;
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        if (requestCompleted) {
          resolve();
          return;
        }
        reject(new Error('Widget binding outbox delete did not complete'));
      };
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? request.error);
    });
  }

  private openDefaultDb(): Promise<IDBDatabase> {
    this.dbPromise ??= openIndexedDBAdaptive({
      dbName: WIDGET_BINDING_OUTBOX_DB_NAME,
      targetVersion: WIDGET_BINDING_OUTBOX_DB_VERSION,
      requiredStores: [this.storeName],
      ensureStores: db => {
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'operationId' });
        }
      },
    });
    return this.dbPromise;
  }

  private async requireDb(): Promise<IDBDatabase> {
    const db = await this.dbProvider();
    if (!db) {
      throw new Error('Widget binding outbox IndexedDB not initialized');
    }
    return db;
  }
}
