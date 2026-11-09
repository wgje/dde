type BrowserStorageKey = 'localStorage' | 'sessionStorage';
type StorageMethodName = 'getItem' | 'setItem' | 'removeItem' | 'clear' | 'key';
type StorageMethodBaseline = {
  owner: object;
  method: StorageMethodName;
  descriptor: PropertyDescriptor;
};

export interface BrowserStorageResetController {
  restoreBrowserStorageForTests(): void;
  clearBrowserStorageForTests(): void;
}

const STORAGE_METHOD_NAMES: StorageMethodName[] = ['getItem', 'setItem', 'removeItem', 'clear', 'key'];

export function createBrowserStorageResetController(): BrowserStorageResetController {
  const initialGlobalStorageRefs: Partial<Record<BrowserStorageKey, Storage>> = {
    localStorage: globalThis.localStorage,
    sessionStorage: globalThis.sessionStorage,
  };
  const initialWindowStorageRefs: Partial<Record<BrowserStorageKey, Storage>> = typeof window === 'undefined'
    ? {}
    : {
        localStorage: window.localStorage,
        sessionStorage: window.sessionStorage,
      };
  const browserStorageMethodBaselines = Array.from(new Set([
    ...Object.values(initialGlobalStorageRefs),
    ...Object.values(initialWindowStorageRefs),
  ])).flatMap(storage => captureStorageMethodBaselines(storage));

  function restoreBrowserStorageForTests(): void {
    restoreStorageReference(globalThis, 'localStorage', initialGlobalStorageRefs.localStorage);
    restoreStorageReference(globalThis, 'sessionStorage', initialGlobalStorageRefs.sessionStorage);
    if (typeof window !== 'undefined') {
      restoreStorageReference(window, 'localStorage', initialWindowStorageRefs.localStorage);
      restoreStorageReference(window, 'sessionStorage', initialWindowStorageRefs.sessionStorage);
    }

    for (const { owner, method, descriptor } of browserStorageMethodBaselines) {
      try {
        Object.defineProperty(owner, method, descriptor);
      } catch {
        // 只影响测试隔离；无法恢复时交给具体用例暴露失败。
      }
    }
  }

  function clearBrowserStorageForTests(): void {
    const storages = new Set<Storage>();
    if (typeof globalThis.localStorage !== 'undefined') storages.add(globalThis.localStorage);
    if (typeof globalThis.sessionStorage !== 'undefined') storages.add(globalThis.sessionStorage);
    if (typeof window !== 'undefined') {
      if (typeof window.localStorage !== 'undefined') storages.add(window.localStorage);
      if (typeof window.sessionStorage !== 'undefined') storages.add(window.sessionStorage);
    }

    for (const storage of storages) {
      try {
        storage.clear();
      } catch {
        // storage 不可写/不可访问时保持测试继续，由目标断言暴露具体问题。
      }
    }
  }

  return {
    restoreBrowserStorageForTests,
    clearBrowserStorageForTests,
  };
}

function findStorageMethodOwner(storage: Storage | undefined, method: StorageMethodName): object | null {
  let owner: object | null = storage ?? null;
  while (owner) {
    if (Object.prototype.hasOwnProperty.call(owner, method)) {
      return owner;
    }
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function captureStorageMethodBaselines(storage: Storage | undefined): StorageMethodBaseline[] {
  return STORAGE_METHOD_NAMES.flatMap((method) => {
    const owner = findStorageMethodOwner(storage, method);
    if (!owner) return [];

    const descriptor = owner ? Object.getOwnPropertyDescriptor(owner, method) : undefined;
    return descriptor ? [{ owner, method, descriptor }] : [];
  });
}

function restoreStorageReference(target: object, key: BrowserStorageKey, storage: Storage | undefined): void {
  if (!storage) return;
  try {
    Object.defineProperty(target, key, {
      value: storage,
      configurable: true,
      writable: true,
    });
  } catch {
    // 某些 DOM shim 会把 storage 暴露成只读 accessor；恢复失败时继续清理可访问实例。
  }
}
