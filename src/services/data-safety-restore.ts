import {
  buildRestorePlan,
  validateDataSafetyExportPackage,
  type DataSafetyCurrentLocalData,
  type DataSafetyExportPackage,
  type DataSafetyRestorePlan,
  type DataSafetyRestoreStore,
} from './data-safety-package';

export interface DataSafetyRestoreAdapter {
  current: DataSafetyCurrentLocalData;
  put(store: DataSafetyRestoreStore, id: string, value: unknown): Promise<void>;
  saveState(key: DataSafetyRestoreStateKey, value: unknown): Promise<void>;
}

export type DataSafetyRestoreStateKey =
  | 'meta'
  | 'retryQueue'
  | 'actionQueue'
  | 'deadLetters'
  | 'conflicts'
  | 'taskTombstones'
  | 'connectionTombstones'
  | 'syncSnapshot'
  | 'replayLog'
  | 'replayPlan'
  | 'lastWriteExplain';

export interface DataSafetyRestoreResult {
  success: boolean;
  plan: DataSafetyRestorePlan;
  errors: string[];
}

export async function restoreDataSafetyPackage(
  pkg: DataSafetyExportPackage,
  adapter: DataSafetyRestoreAdapter,
): Promise<DataSafetyRestoreResult> {
  const validation = validateDataSafetyExportPackage(pkg);
  const plan = buildRestorePlan(pkg, adapter.current);
  if (!validation.valid) {
    return { success: false, plan, errors: validation.errors };
  }

  for (const operation of plan.operations) {
    if (operation.action !== 'put') {
      continue;
    }
    await adapter.put(operation.store, operation.id, getIncomingValue(pkg, operation.store, operation.id));
  }

  await persistRestoreState(pkg, adapter);

  return { success: true, plan, errors: [] };
}

async function persistRestoreState(
  pkg: DataSafetyExportPackage,
  adapter: DataSafetyRestoreAdapter,
): Promise<void> {
  await adapter.saveState('meta', pkg.localData.meta ?? null);
  await adapter.saveState('retryQueue', pkg.localState.retryQueue);
  await adapter.saveState('actionQueue', pkg.localState.actionQueue);
  await adapter.saveState('deadLetters', pkg.localState.deadLetters);
  await adapter.saveState('conflicts', pkg.localState.conflicts);
  await adapter.saveState('taskTombstones', pkg.localState.taskTombstones);
  await adapter.saveState('connectionTombstones', pkg.localState.connectionTombstones);
  await adapter.saveState('syncSnapshot', pkg.syncSnapshot);
  await adapter.saveState('replayLog', pkg.replayLog);
  await adapter.saveState('replayPlan', pkg.replayPlan);
  await adapter.saveState('lastWriteExplain', pkg.lastWriteExplain);
}

function getIncomingValue(
  pkg: DataSafetyExportPackage,
  store: DataSafetyRestoreStore,
  id: string,
): unknown {
  const source = store === 'projects'
    ? pkg.localData.projects
    : store === 'tasks'
      ? pkg.localData.tasks
      : store === 'connections'
        ? pkg.localData.connections
        : pkg.localData.syncCursors;

  const value = source.find(item => ('key' in item ? item.key : item.id) === id);
  if (value === undefined) {
    throw new Error(`Restore value not found for ${store}:${id}`);
  }
  return value;
}
