import type {
  DataSafetyEntityRecord,
  DataSafetyRestoreOperation,
  DataSafetyRestoreStore,
  DataSafetySyncCursorRecord,
} from './data-safety-package';

type RestoreRecord = DataSafetyEntityRecord | DataSafetySyncCursorRecord;
type StableStringify = (value: unknown) => string;

export function buildStoreRestoreOperations(
  store: DataSafetyRestoreStore,
  incoming: RestoreRecord[],
  current: RestoreRecord[],
  stableStringify: StableStringify,
): DataSafetyRestoreOperation[] {
  const currentById = new Map(current.map(item => [getRestoreId(item), item]));

  return incoming.map((item) => {
    const id = getRestoreId(item);
    const existing = currentById.get(id);
    return {
      store,
      action: existing && stableStringify(existing) === stableStringify(item) ? 'skip' : 'put',
      id,
    };
  });
}

function getRestoreId(item: RestoreRecord): string {
  if ('key' in item && typeof item.key === 'string') {
    return item.key;
  }
  if ('id' in item && typeof item.id === 'string') {
    return item.id;
  }
  throw new Error('restore item is missing id/key');
}
