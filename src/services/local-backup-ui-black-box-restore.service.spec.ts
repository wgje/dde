import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';

import {
  applyLocalBackupUiBlackBoxRestore,
  decodeLocalBackupUiBlackBoxRestoreSnapshot,
  prepareLocalBackupUiBlackBoxRestore,
  readLocalBackupUiBlackBoxRestoreOwnerState,
  rollbackLocalBackupUiBlackBoxRestore,
} from './local-backup-ui-black-box-restore.service';
import {
  createBlackBoxRestoreDependencies,
  makeBackup,
  makeBlackBoxEntry,
  OWNER_A,
  OWNER_B,
  readBlackBoxRows,
  resetBlackBoxRestoreSpecDatabase,
  seedBlackBoxRows,
  SOURCE_DIGEST,
  toBackupEntry,
} from './local-backup-ui-black-box-restore.spec-helpers';

describe('LocalBackupUiBlackBoxRestoreService', () => {
  beforeEach(resetBlackBoxRestoreSpecDatabase);
  afterEach(resetBlackBoxRestoreSpecDatabase);

  it('prepares an exact owner-scoped before/target snapshot and preserves unrelated rows', async () => {
    const current = makeBlackBoxEntry('current');
    const foreign = makeBlackBoxEntry('foreign', { userId: OWNER_B });
    const restored = makeBlackBoxEntry('restored');
    await seedBlackBoxRows([current, foreign]);
    const dependencies = createBlackBoxRestoreDependencies([]);

    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry(restored)]),
    }, dependencies);

    expect(snapshot.before).toEqual([current]);
    expect(snapshot.target.map(entry => entry.id).sort()).toEqual([current.id, restored.id].sort());
    expect(await readBlackBoxRows()).toEqual(expect.arrayContaining([current, foreign]));
  });

  it('accepts the live UUID generation and replaces it with a fresh opaque generation', async () => {
    const oldGeneration = crypto.randomUUID();
    const newGeneration = crypto.randomUUID();
    const current = makeBlackBoxEntry('current', { _localVersion: oldGeneration });
    await seedBlackBoxRows([current]);
    const dependencies = createBlackBoxRestoreDependencies([], [], () => newGeneration);

    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry({ ...current, content: 'restored' })]),
    }, dependencies);

    expect(snapshot.before).toEqual([current]);
    expect(snapshot.target).toEqual([{ ...current, content: 'restored', _localVersion: newGeneration }]);
  });

  it('accepts a legacy numeric generation but never increments it arithmetically', async () => {
    const newGeneration = crypto.randomUUID();
    const current = makeBlackBoxEntry('legacy', { _localVersion: 2 });
    await seedBlackBoxRows([current]);

    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry({ ...current, content: 'restored' })]),
    }, createBlackBoxRestoreDependencies([], [], () => newGeneration));

    expect(snapshot.before).toEqual([current]);
    expect(snapshot.target[0]._localVersion).toBe(newGeneration);
  });

  it.each(['', 'generation', Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, {}, []])(
    'rejects malformed persisted generation %j', generation => {
      const row = makeBlackBoxEntry('malformed', { _localVersion: generation as never });
      expect(() => decodeLocalBackupUiBlackBoxRestoreSnapshot({
        schemaVersion: 1,
        ownerUserId: OWNER_A,
        sourceDigest: SOURCE_DIGEST,
        before: [row],
        target: [],
      }, OWNER_A, SOURCE_DIGEST)).toThrow(/invalid/);
    },
  );

  it.each([
    ['count mismatch', (backup: BackupData) => { backup.tableCounts.blackBoxEntries = 2; }],
    ['owner mismatch', (backup: BackupData) => { backup.blackBoxEntries[0].userId = OWNER_B; }],
    ['duplicate id', (backup: BackupData) => {
      backup.blackBoxEntries.push({ ...backup.blackBoxEntries[0] });
    }],
    ['malformed entry', (backup: BackupData) => { backup.blackBoxEntries[0].updatedAt = 'invalid'; }],
  ])('rejects %s before mutation', async (_name, mutate) => {
    const entry = makeBlackBoxEntry('restored');
    const backup = makeBackup([toBackupEntry(entry)]);
    mutate(backup);
    await expect(prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup,
    }, createBlackBoxRestoreDependencies([]))).rejects.toThrow();
    expect(await readBlackBoxRows()).toEqual([]);
  });

  it('commits the owner merge, independently reads it back, then publishes', async () => {
    const current = makeBlackBoxEntry('current');
    const restored = makeBlackBoxEntry('restored');
    await seedBlackBoxRows([current]);
    const published: Parameters<typeof createBlackBoxRestoreDependencies>[0] = [];
    const events: string[] = [];
    const dependencies = createBlackBoxRestoreDependencies(published, events);
    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry(restored)]),
    }, dependencies);

    const restoredCount = await applyLocalBackupUiBlackBoxRestore(
      snapshot,
      dependencies,
      async () => { events.push('checkpoint'); },
    );

    expect(restoredCount).toBe(1);
    expect(await readLocalBackupUiBlackBoxRestoreOwnerState(OWNER_A, dependencies))
      .toEqual(snapshot.target);
    expect(published).toHaveLength(1);
    expect(published[0].map(entry => entry.id).sort()).toEqual(
      snapshot.target.map(entry => entry.id).sort(),
    );
    expect(events.at(-1)).toBe('publish');
  });

  it('does zero writes when the prepared preimage is stale', async () => {
    const current = makeBlackBoxEntry('current');
    const restored = makeBlackBoxEntry('restored');
    await seedBlackBoxRows([current]);
    const dependencies = createBlackBoxRestoreDependencies([]);
    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry(restored)]),
    }, dependencies);
    const successor = makeBlackBoxEntry('successor');
    await seedBlackBoxRows([current, successor]);

    await expect(applyLocalBackupUiBlackBoxRestore(
      snapshot,
      dependencies,
      async () => undefined,
    )).rejects.toThrow(/preimage/i);
    expect(await readBlackBoxRows()).toEqual(expect.arrayContaining([current, successor]));
  });

  it('rolls back only the exact applied target and is idempotent on the original preimage', async () => {
    const current = makeBlackBoxEntry('current');
    const restored = makeBlackBoxEntry('restored');
    await seedBlackBoxRows([current]);
    const published: Parameters<typeof createBlackBoxRestoreDependencies>[0] = [];
    const dependencies = createBlackBoxRestoreDependencies(published);
    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry(restored)]),
    }, dependencies);
    await applyLocalBackupUiBlackBoxRestore(snapshot, dependencies, async () => undefined);

    await rollbackLocalBackupUiBlackBoxRestore(snapshot, dependencies, async () => undefined);
    await rollbackLocalBackupUiBlackBoxRestore(snapshot, dependencies, async () => undefined);

    expect(await readLocalBackupUiBlackBoxRestoreOwnerState(OWNER_A, dependencies))
      .toEqual(snapshot.before);
    const { _localVersion: _ignored, ...publishedCurrent } = current;
    expect(published.at(-1)).toEqual([publishedCurrent]);
  });

  it('retains a concurrent successor instead of overwriting it during rollback', async () => {
    const current = makeBlackBoxEntry('current');
    const restored = makeBlackBoxEntry('restored');
    await seedBlackBoxRows([current]);
    const dependencies = createBlackBoxRestoreDependencies([]);
    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry(restored)]),
    }, dependencies);
    await applyLocalBackupUiBlackBoxRestore(snapshot, dependencies, async () => undefined);
    const successor = makeBlackBoxEntry('successor');
    await seedBlackBoxRows([...snapshot.target, successor]);

    await expect(rollbackLocalBackupUiBlackBoxRestore(
      snapshot,
      dependencies,
      async () => undefined,
    )).rejects.toThrow(/successor/i);
    expect(await readBlackBoxRows()).toEqual(expect.arrayContaining([...snapshot.target, successor]));
  });

  it('rejects same-business-bytes rollback after an opaque generation ABA', async () => {
    const generationA = crypto.randomUUID();
    const generationB = crypto.randomUUID();
    const current = makeBlackBoxEntry('current', { _localVersion: generationA });
    await seedBlackBoxRows([current]);
    const dependencies = createBlackBoxRestoreDependencies([], [], () => generationB);
    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry({ ...current, content: 'restored' })]),
    }, dependencies);
    await applyLocalBackupUiBlackBoxRestore(snapshot, dependencies, async () => undefined);
    const generationC = crypto.randomUUID();
    await seedBlackBoxRows(snapshot.target.map(row => ({ ...row, _localVersion: generationC })));

    await expect(rollbackLocalBackupUiBlackBoxRestore(
      snapshot, dependencies, async () => undefined,
    )).rejects.toThrow(/successor/i);
    expect((await readBlackBoxRows())[0]._localVersion).toBe(generationC);
  });

  it('does not publish when the owner generation checkpoint fails after durable commit', async () => {
    const restored = makeBlackBoxEntry('restored');
    const published: Parameters<typeof createBlackBoxRestoreDependencies>[0] = [];
    const dependencies = createBlackBoxRestoreDependencies(published);
    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: OWNER_A,
      sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry(restored)]),
    }, dependencies);
    let checkpoints = 0;

    await expect(applyLocalBackupUiBlackBoxRestore(snapshot, dependencies, async () => {
      checkpoints += 1;
      if (checkpoints >= 2) throw new Error('owner generation changed');
    })).rejects.toThrow(/owner generation changed/);

    expect(await readLocalBackupUiBlackBoxRestoreOwnerState(OWNER_A, dependencies))
      .toEqual(snapshot.target);
    expect(published).toEqual([]);
  });
});
