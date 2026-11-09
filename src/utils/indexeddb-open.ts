export type IndexedDBUpgradeHandler = (db: IDBDatabase, transaction: IDBTransaction | null) => void;

export interface OpenIndexedDBAdaptiveOptions {
  dbName: string;
  targetVersion: number;
  ensureStores?: IndexedDBUpgradeHandler;
  requiredStores?: readonly string[];
  schemaNeedsUpgrade?: (db: IDBDatabase) => boolean;
}

interface IndexedDBOpenState {
  blockedTimer: ReturnType<typeof setTimeout> | null;
  upgradeFailed: boolean;
  settled: boolean;
}

interface IndexedDBOpenCallbacks {
  rejectOpen(error: unknown): void;
  resolveOpen(db: IDBDatabase): void;
}

/**
 * Open IndexedDB with adaptive version negotiation:
 * 1. Open without explicit version to avoid downgrade VersionError.
 * 2. Upgrade only when schema version or required stores are behind.
 */
export async function openIndexedDBAdaptive(options: OpenIndexedDBAdaptiveOptions): Promise<IDBDatabase> {
  const { dbName, targetVersion, ensureStores, requiredStores = [], schemaNeedsUpgrade } = options;

  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new Error(`Invalid IndexedDB targetVersion for ${dbName}: ${targetVersion}`);
  }

  const existingDb = await openIndexedDB(dbName);
  const missingStores = requiredStores.filter(store => !existingDb.objectStoreNames.contains(store));
  let missingSchema = false;
  try {
    missingSchema = schemaNeedsUpgrade?.(existingDb) === true;
  } catch (error) {
    existingDb.close();
    throw error;
  }
  const needsVersionUpgrade = existingDb.version < targetVersion;
  const needsSchemaRepair = missingStores.length > 0 || missingSchema;

  if (!needsVersionUpgrade && !needsSchemaRepair) {
    return existingDb;
  }

  if (needsSchemaRepair && !ensureStores) {
    existingDb.close();
    throw new Error(
      `IndexedDB ${dbName} is missing stores [${missingStores.join(', ')}] but no ensureStores handler was provided`
    );
  }

  const nextVersion = needsVersionUpgrade ? targetVersion : existingDb.version + 1;
  existingDb.close();
  return openIndexedDB(dbName, nextVersion, ensureStores);
}

function openIndexedDB(
  dbName: string,
  version?: number,
  ensureStores?: IndexedDBUpgradeHandler
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = createIndexedDBOpenRequest(dbName, version, reject);
    if (!request) return;

    const state: IndexedDBOpenState = {
      blockedTimer: null,
      upgradeFailed: false,
      settled: false,
    };
    attachIndexedDBOpenHandlers({
      request,
      dbName,
      ensureStores,
      state,
      callbacks: createIndexedDBOpenCallbacks(state, resolve, reject),
    });
  });
}

function createIndexedDBOpenRequest(
  dbName: string,
  version: number | undefined,
  reject: (reason?: unknown) => void,
): IDBOpenDBRequest | undefined {
  try {
    return version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version);
  } catch (error) {
    reject(error);
    return undefined;
  }
}

function createIndexedDBOpenCallbacks(
  state: IndexedDBOpenState,
  resolve: (value: IDBDatabase) => void,
  reject: (reason?: unknown) => void,
): IndexedDBOpenCallbacks {
  return {
    rejectOpen: (error: unknown) => {
      if (state.settled) return;
      state.settled = true;
      state.blockedTimer = clearIndexedDBOpenTimer(state.blockedTimer);
      reject(error);
    },
    resolveOpen: (db: IDBDatabase) => {
      if (state.settled) {
        db.close();
        return;
      }
      state.settled = true;
      state.blockedTimer = clearIndexedDBOpenTimer(state.blockedTimer);
      resolve(db);
    },
  };
}

function attachIndexedDBOpenHandlers(options: {
  request: IDBOpenDBRequest;
  dbName: string;
  ensureStores?: IndexedDBUpgradeHandler;
  state: IndexedDBOpenState;
  callbacks: IndexedDBOpenCallbacks;
}): void {
  const { request, dbName, ensureStores, state, callbacks } = options;
  request.onupgradeneeded = () => handleIndexedDBUpgrade(request, ensureStores, state, callbacks);
  request.onsuccess = () => handleIndexedDBOpenSuccess(request, state, callbacks);
  request.onerror = () => {
    callbacks.rejectOpen(request.error ?? new Error(`Unknown IndexedDB error while opening ${dbName}`));
  };
  request.onblocked = () => handleIndexedDBOpenBlocked(dbName, state, callbacks);
}

function handleIndexedDBUpgrade(
  request: IDBOpenDBRequest,
  ensureStores: IndexedDBUpgradeHandler | undefined,
  state: IndexedDBOpenState,
  callbacks: IndexedDBOpenCallbacks,
): void {
  if (!ensureStores) return;
  try {
    ensureStores(request.result, request.transaction ?? null);
  } catch (error) {
    state.upgradeFailed = true;
    request.transaction?.abort();
    callbacks.rejectOpen(error);
  }
}

function handleIndexedDBOpenSuccess(
  request: IDBOpenDBRequest,
  state: IndexedDBOpenState,
  callbacks: IndexedDBOpenCallbacks,
): void {
  if (state.upgradeFailed) {
    state.blockedTimer = clearIndexedDBOpenTimer(state.blockedTimer);
    request.result.close();
    return;
  }
  callbacks.resolveOpen(request.result);
}

function handleIndexedDBOpenBlocked(
  dbName: string,
  state: IndexedDBOpenState,
  callbacks: IndexedDBOpenCallbacks,
): void {
  if (state.settled) return;
  state.blockedTimer = clearIndexedDBOpenTimer(state.blockedTimer);
  state.blockedTimer = setTimeout(() => {
    callbacks.rejectOpen(new Error(`IndexedDB open blocked for ${dbName}`));
  }, 5000);
}

function clearIndexedDBOpenTimer(
  timer: ReturnType<typeof setTimeout> | null,
): null {
  if (timer !== null) {
    clearTimeout(timer);
  }
  return null;
}
