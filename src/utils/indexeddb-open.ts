export type IndexedDBUpgradeHandler = (db: IDBDatabase, transaction: IDBTransaction | null) => void;

export interface OpenIndexedDBAdaptiveOptions {
  dbName: string;
  targetVersion: number;
  ensureStores?: IndexedDBUpgradeHandler;
  requiredStores?: readonly string[];
  schemaNeedsUpgrade?: (db: IDBDatabase) => boolean;
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
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    let request: IDBOpenDBRequest;
    try {
      request = version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version);
    } catch (error) {
      reject(error);
      return;
    }

    let upgradeFailed = false;

    request.onupgradeneeded = () => {
      if (!ensureStores) return;
      try {
        ensureStores(request.result, request.transaction ?? null);
      } catch (error) {
        upgradeFailed = true;
        request.transaction?.abort();
        reject(error);
      }
    };

    request.onsuccess = () => {
      if (blockedTimer !== null) {
        clearTimeout(blockedTimer);
      }
      if (upgradeFailed) {
        request.result.close();
        return;
      }
      resolve(request.result);
    };

    request.onerror = () => {
      if (blockedTimer !== null) {
        clearTimeout(blockedTimer);
      }
      reject(request.error ?? new Error(`Unknown IndexedDB error while opening ${dbName}`));
    };

    request.onblocked = () => {
      if (blockedTimer !== null) {
        clearTimeout(blockedTimer);
      }
      blockedTimer = setTimeout(() => {
        reject(new Error(`IndexedDB open blocked for ${dbName}`));
      }, 5000);
    };
  });
}
