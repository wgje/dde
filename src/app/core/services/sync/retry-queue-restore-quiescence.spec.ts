import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deleteDataSafetyRestoreMarkerJournalDatabaseForTests } from '../../../../services/data-safety-restore-marker-journal';
import {
  LocalBackupUiRestoreWriterPausedError,
  localBackupUiRestoreWriterQuiescence,
} from '../../../../services/local-backup-ui-restore-writer-quiescence.service';
import {
  createRetryQueueServiceSpecHarness,
  type RetryQueueServiceSpecHarness,
} from './retry-queue-service.spec-fixture';
import { createTask } from './retry-queue-test-data.spec-helpers';

describe('RetryQueue restore writer quiescence', () => {
  let harness: RetryQueueServiceSpecHarness;

  beforeEach(async () => {
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
    harness = createRetryQueueServiceSpecHarness({ clearLocalStorage: false });
  });

  afterEach(async () => {
    await harness.teardown();
    localStorage.clear();
    await deleteDataSafetyRestoreMarkerJournalDatabaseForTests();
  });

  it('rejects clear without persisting or changing queue state while the owner is frozen', async () => {
    const handle = await localBackupUiRestoreWriterQuiescence.prepare('test-user');

    expect(() => harness.service.clear()).toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(harness.service.getItems()).toEqual([]);
    expect(harness.saveToStorageSpy).not.toHaveBeenCalled();
    await handle.abortBeforeMutation();
  });

  it('drains the complete replay lifetime and blocks every item mutation family while frozen', async () => {
    harness.saveToStorageSpy.mockRestore();
    const task = createTask('restore-quiescence-replay');
    expect(harness.service.add(
      'task', 'upsert', task, 'project-1', 'test-user', undefined, 'task_full_upsert',
    )).toBe(true);
    await harness.service.persistNow();
    harness.setOnline(true);
    harness.syncWriterLeaseMock.isFeatureEnabled.mockReturnValue(true);
    harness.syncWriterLeaseMock.requestLease.mockResolvedValueOnce({
      tabId: 'tab-restore-quiescence',
      lockName: 'nanoflow-sync:test:test-user:__global__',
      mode: 'idb-lease',
      signal: new AbortController().signal,
      release: harness.releaseLeaseMock,
    });
    let releaseReplay!: (value: boolean) => void;
    vi.mocked(harness.handler.pushTask).mockImplementationOnce(async () => (
      await new Promise<boolean>(resolve => { releaseReplay = resolve; })
    ));

    const replay = harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });
    await vi.waitFor(() => expect(releaseReplay).toBeTypeOf('function'));
    let prepared = false;
    const preparing = localBackupUiRestoreWriterQuiescence.prepare('test-user').then(handle => {
      prepared = true;
      return handle;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(prepared).toBe(false);

    releaseReplay(true);
    await replay;
    const handle = await preparing;
    expect(() => harness.service.add('task', 'upsert', createTask('blocked-add'), 'project-1', 'test-user'))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    await expect(harness.service.addDurably(
      'task', 'upsert', createTask('blocked-durable-add'), 'project-1', 'test-user',
    )).rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    expect(() => harness.service.removeByEntity('task', task.id))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => harness.service.removeByProjectId('project-1'))
      .toThrow(LocalBackupUiRestoreWriterPausedError);
    expect(() => harness.service.cleanExpired()).toThrow(LocalBackupUiRestoreWriterPausedError);
    await expect(harness.service.reloadFromStorageForCurrentOwner())
      .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    await expect(harness.service.processQueueSlice())
      .rejects.toBeInstanceOf(LocalBackupUiRestoreWriterPausedError);
    await handle.abortBeforeMutation();
  });
});
