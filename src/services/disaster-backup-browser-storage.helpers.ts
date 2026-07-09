export async function openExistingDb(name: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;

  return new Promise((resolve) => {
    let createdDuringOpen = false;
    const request = indexedDB.open(name);

    request.onupgradeneeded = () => {
      createdDuringOpen = true;
      request.transaction?.abort();
    };

    request.onsuccess = () => {
      if (createdDuringOpen) {
        request.result.close();
        resolve(null);
        return;
      }
      resolve(request.result);
    };

    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export async function getAllFromStore<T = unknown>(
  db: IDBDatabase,
  storeName: string,
): Promise<T[]> {
  if (!db.objectStoreNames.contains(storeName)) {
    return [];
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve((request.result ?? []) as T[]);
    request.onerror = () => reject(request.error);
  });
}

export async function getByKey<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | null> {
  if (!db.objectStoreNames.contains(storeName)) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve((request.result ?? null) as T | null);
    request.onerror = () => reject(request.error);
  });
}

export function safeGetLocalStorage(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // eslint-disable-line no-restricted-syntax -- localStorage 访问异常时"无数据"语义正确，null 触发调用方降级
  }
}

export function safeParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null; // eslint-disable-line no-restricted-syntax -- JSON 解析失败时"无数据"语义正确，null 触发调用方降级
  }
}

export function readOwnerScopedLocalStorage(baseKey: string, ownerUserId: string): string | null {
  return safeGetLocalStorage(`${baseKey}.${ownerUserId}`);
}

export function resolveRetryQueueItemOwner(item: unknown): string {
  if (!item || typeof item !== 'object') {
    return '__legacy_unknown__';
  }

  const sourceUserId = (item as { sourceUserId?: unknown }).sourceUserId;
  return typeof sourceUserId === 'string' && sourceUserId.length > 0
    ? sourceUserId
    : '__legacy_unknown__';
}
