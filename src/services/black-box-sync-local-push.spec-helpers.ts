import { TestBed } from "@angular/core/testing";
import { expect, it, vi } from "vitest";

import { AUTH_CONFIG } from "../config/auth.config";
import type { BlackBoxEntry } from "../models/focus";
import { blackBoxEntriesMap, setBlackBoxEntries } from "../state/focus-stores";
import { SupabaseClientService } from "./supabase-client.service";
import { BlackBoxSyncService } from "./black-box-sync.service";
import { readActiveLocalBackupUiRestoreWriters } from "./local-backup-ui-restore-writer-quiescence-tracker";
import { prepareLocalBackupUiBlackBoxRestore } from './local-backup-ui-black-box-restore.service';
import { createBlackBoxRestoreDependencies, makeBackup, resetBlackBoxRestoreSpecDatabase, seedBlackBoxRows, SOURCE_DIGEST, toBackupEntry } from './local-backup-ui-black-box-restore.spec-helpers';
import {
  createEntry,
  createIdbReadOnlyTransaction,
  createIdbReadWriteTransaction,
  createPreflightQuery,
  createSuccessfulIdbRequest,
  flushMicrotasks,
} from "./black-box-sync.spec-helpers";

interface BlackBoxSyncLocalPushSpecContext {
  getService: () => BlackBoxSyncService;
  getAuthSignals: () => {
    currentUserId: { set(value: string | null): void };
    runtimeState: { set(value: "idle" | "pending" | "ready" | "failed"): void };
  };
}

type BlackBoxSyncLocalPushSpecTools = {
  service: () => BlackBoxSyncService;
  authSignals: () => ReturnType<
    BlackBoxSyncLocalPushSpecContext["getAuthSignals"]
  >;
};

type BlackBoxSyncLocalPushSpec = readonly [
  name: string,
  run: (tools: BlackBoxSyncLocalPushSpecTools) => Promise<void>,
];

const blackBoxSyncLocalPushSpecs: readonly BlackBoxSyncLocalPushSpec[] = [
  ["loadFromLocal 应只恢复当前用户的黑匣子条目", runBlackBoxSyncLocalPushSpec1],
  [
    "loadFromLocal 不应让空 IDB 覆盖当前用户刚写入的内存条目",
    runBlackBoxSyncLocalPushSpec2,
  ],
  [
    "loadFromLocal 在 expectedUserId 要求 current user 时不应提交 auth settling 期间的持久化 hint 快照",
    runBlackBoxSyncLocalPushSpec3,
  ],
  [
    "loadFromLocal 应把历史本地模式 pending 条目归一为本地已保存",
    runBlackBoxSyncLocalPushSpec4,
  ],
  [
    "loadFromLocal 不应让 IDB 中更旧的 pending 回退内存里已收敛的 synced 条目",
    runBlackBoxSyncLocalPushSpec5,
  ],
  [
    "loadFromLocal 不应让业务等价但本地时间更晚的 pending 回退已收敛 synced 条目",
    runBlackBoxSyncLocalPushSpec6,
  ],
  [
    "markEntrySyncConflict 应把可见条目回写为 conflict 并持久化到本地",
    runBlackBoxSyncLocalPushSpec7,
  ],
  [
    "markEntrySyncConflict 遇到更新且已同步的本地快照时不应回退为 conflict",
    runBlackBoxSyncLocalPushSpec8,
  ],
  [
    "pushToServer owner-mismatch (local-user owner) → 改写 owner 后通过 retryQueueHandler 续推，且 pending 已落到合法 owner",
    runBlackBoxSyncLocalPushSpec9,
  ],
  [
    "pushToServer owner-mismatch (非法 UUID owner) → 物理删除脏数据，UI Map 同步移除",
    runBlackBoxSyncLocalPushSpec10,
  ],
  [
    "pushToServer owner-mismatch (合法跨账号 UUID) → markEntrySyncConflict 让 syncStatus 收敛为 conflict",
    runBlackBoxSyncLocalPushSpec11,
  ],
  [
    "recoverPendingEntries 检测到 owner-mismatch pending 时不再灌入 RetryQueue，而是走 selfHeal 路径",
    runBlackBoxSyncLocalPushSpec12,
  ],
  ["saveToLocal 只应在 IDB transaction complete 后完成", runBlackBoxSyncLocalPushSpec13],
  ["saveToLocal request error 应只拒绝一次", tools => runBlackBoxSyncLocalPushFailureSpec(tools, "request")],
  ["saveToLocal transaction error 应只拒绝一次", tools => runBlackBoxSyncLocalPushFailureSpec(tools, "transaction")],
  ["saveToLocal transaction abort 应只拒绝一次", tools => runBlackBoxSyncLocalPushFailureSpec(tools, "abort")],
  ["saveToLocal 应在事务完成前保持 black-box writer fence", runBlackBoxSyncLocalPushWriterFenceSpec],
  ['restore preparation accepts the exact persisted output of saveToLocal', runBlackBoxWriterRestoreGenerationSpec],
  ["deleteFromLocal 应按持久化 owner 跟踪事务并拒绝未知 owner", runBlackBoxSyncLocalDeleteFenceSpec],
  ["scheduleSync 应先提交 pending 事务再 detached push，重启仍可恢复", runBlackBoxSyncLocalPushSpec14],
];

export function registerBlackBoxSyncLocalPushSpecs(
  context: BlackBoxSyncLocalPushSpecContext,
): void {
  const tools: BlackBoxSyncLocalPushSpecTools = {
    service: () => context.getService(),
    authSignals: () => context.getAuthSignals(),
  };

  for (const [name, run] of blackBoxSyncLocalPushSpecs) {
    it(name, () => run(tools));
  }
}

async function runBlackBoxSyncLocalPushSpec1(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const foreignEntry = {
    id: "entry-foreign",
    projectId: null,
    userId: "user-2",
    content: "foreign",
    date: "2026-03-04",
    createdAt: "2026-03-04T00:00:00.000Z",
    updatedAt: "2026-03-04T00:00:00.000Z",
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
  };
  const ownEntry = {
    ...foreignEntry,
    id: "entry-own",
    userId: "user-1",
    content: "own",
  };
  const getAll = vi.fn();
  const transaction = createIdbReadOnlyTransaction([ownEntry, foreignEntry], {
    onGetAll: getAll,
  });
  (service() as unknown as { db: unknown }).db = { transaction };

  const entries = await service().loadFromLocal();

  expect(getAll).toHaveBeenCalledTimes(1);
  expect(entries).toEqual([
    expect.objectContaining({ id: "entry-own", userId: "user-1" }),
  ]);
}

async function runBlackBoxSyncLocalPushSpec2(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const optimisticEntry = createEntry({
    id: "entry-optimistic",
    content: "刚创建的黑匣子条目",
  });
  setBlackBoxEntries([optimisticEntry]);

  const transaction = createIdbReadOnlyTransaction([]);
  (service() as unknown as { db: unknown }).db = { transaction };

  const entries = await service().loadFromLocal();

  expect(entries).toEqual([
    expect.objectContaining({ id: "entry-optimistic", userId: "user-1" }),
  ]);
  expect(blackBoxEntriesMap().get("entry-optimistic")).toEqual(
    expect.objectContaining({
      content: "刚创建的黑匣子条目",
    }),
  );
}

async function runBlackBoxSyncLocalPushSpec3(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service, authSignals } = tools;

  const ownEntry = createEntry({ id: "entry-own", content: "own" });
  const transaction = createIdbReadOnlyTransaction([ownEntry], {
    beforeGetAllSuccess: () => {
      authSignals().currentUserId.set(null);
      authSignals().runtimeState.set("pending");
    },
  });
  (service() as unknown as { db: unknown }).db = { transaction };

  const entries = await service().loadFromLocal({
    expectedUserId: "user-1",
    requireCurrentUser: true,
  });

  expect(entries).toEqual([]);
  expect(blackBoxEntriesMap().has("entry-own")).toBe(false);
}

async function runBlackBoxSyncLocalPushSpec4(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service, authSignals } = tools;

  authSignals().currentUserId.set(null);
  localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, "true");
  const localEntry = {
    id: "entry-local-only",
    projectId: null,
    userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    content: "local",
    date: "2026-03-04",
    createdAt: "2026-03-04T00:00:00.000Z",
    updatedAt: "2026-03-04T00:00:00.000Z",
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    syncStatus: "pending",
  };
  const { transaction, put } = createIdbReadWriteTransaction({
    getAllResult: [localEntry],
    getResult: mode => mode === "readwrite" ? localEntry : null,
  });
  (service() as unknown as { db: unknown }).db = { transaction };

  const entries = await service().loadFromLocal();
  await flushMicrotasks();

  expect(entries).toEqual([
    expect.objectContaining({
      id: "entry-local-only",
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      syncStatus: "synced",
    }),
  ]);
  expect(blackBoxEntriesMap().get("entry-local-only")?.syncStatus).toBe(
    "synced",
  );
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "entry-local-only",
      userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      syncStatus: "synced",
    }),
  );
}

async function runBlackBoxSyncLocalPushSpec5(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = "entry-stale-pending";
  const idbPendingEntry = {
    id: entryId,
    projectId: null,
    userId: "user-1",
    content: "entry",
    date: "2026-03-04",
    createdAt: "2026-03-04T00:00:00.000Z",
    updatedAt: "2026-03-04T00:00:00.000Z",
    isRead: false,
    isCompleted: false,
    isArchived: false,
    deletedAt: null,
    syncStatus: "pending",
  };
  const inMemorySyncedEntry = createEntry({
    id: entryId,
    updatedAt: "2026-03-04T00:00:05.000Z",
    syncStatus: "synced",
  });
  const { transaction, put } = createIdbReadWriteTransaction({
    getAllResult: [idbPendingEntry],
    getResult: mode => mode === "readwrite" ? idbPendingEntry : null,
  });
  (service() as unknown as { db: unknown }).db = { transaction };
  setBlackBoxEntries([inMemorySyncedEntry]);

  const entries = await service().loadFromLocal();
  await flushMicrotasks();

  expect(entries).toEqual([
    expect.objectContaining({
      id: entryId,
      syncStatus: "synced",
      updatedAt: "2026-03-04T00:00:05.000Z",
    }),
  ]);
  expect(blackBoxEntriesMap().get(entryId)).toEqual(
    expect.objectContaining({
      id: entryId,
      syncStatus: "synced",
      updatedAt: "2026-03-04T00:00:05.000Z",
    }),
  );
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      syncStatus: "synced",
      updatedAt: "2026-03-04T00:00:05.000Z",
    }),
  );
}

async function runBlackBoxSyncLocalPushSpec6(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = "entry-fast-clock-pending";
  const idbPendingEntry = createEntry({
    id: entryId,
    updatedAt: "2026-03-04T00:00:10.000Z",
    syncStatus: "pending",
  });
  const inMemorySyncedEntry = createEntry({
    id: entryId,
    updatedAt: "2026-03-04T00:00:05.000Z",
    syncStatus: "synced",
  });
  const { transaction, put } = createIdbReadWriteTransaction({
    getAllResult: [idbPendingEntry],
    getResult: mode => mode === "readwrite" ? idbPendingEntry : null,
  });
  (service() as unknown as { db: unknown }).db = { transaction };
  setBlackBoxEntries([inMemorySyncedEntry]);

  const entries = await service().loadFromLocal();
  await flushMicrotasks();

  expect(entries).toEqual([
    expect.objectContaining({
      id: entryId,
      syncStatus: "synced",
      updatedAt: "2026-03-04T00:00:05.000Z",
    }),
  ]);
  expect(blackBoxEntriesMap().get(entryId)).toEqual(
    expect.objectContaining({
      id: entryId,
      syncStatus: "synced",
      updatedAt: "2026-03-04T00:00:05.000Z",
    }),
  );
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      syncStatus: "synced",
      updatedAt: "2026-03-04T00:00:05.000Z",
    }),
  );
}

async function runBlackBoxSyncLocalPushSpec7(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const entry = createEntry({
    id: "entry-conflict",
    syncStatus: "pending",
  });
  const saveSpy = vi
    .spyOn(service(), "saveToLocal")
    .mockResolvedValue(undefined);
  setBlackBoxEntries([entry]);

  await service().markEntrySyncConflict(entry);

  expect(saveSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "entry-conflict",
      syncStatus: "conflict",
    }),
  );
  expect(blackBoxEntriesMap().get("entry-conflict")?.syncStatus).toBe(
    "conflict",
  );
}

async function runBlackBoxSyncLocalPushSpec8(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const stalePending = createEntry({
    id: "entry-conflict-stale",
    syncStatus: "pending",
    updatedAt: "2026-03-04T00:00:00.000Z",
  });
  const latestSynced = createEntry({
    id: "entry-conflict-stale",
    syncStatus: "synced",
    updatedAt: "2026-03-04T00:00:10.000Z",
  });
  const saveSpy = vi
    .spyOn(service(), "saveToLocal")
    .mockResolvedValue(undefined);
  setBlackBoxEntries([latestSynced]);

  await service().markEntrySyncConflict(stalePending);

  expect(saveSpy).not.toHaveBeenCalled();
  expect(blackBoxEntriesMap().get("entry-conflict-stale")?.syncStatus).toBe(
    "synced",
  );
}

async function runBlackBoxSyncLocalPushSpec9(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const legacyLocalEntry = createEntry({
    id: entryId,
    userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    updatedAt: "2026-03-04T00:00:00.000Z",
    syncStatus: "pending",
  });
  const enqueue = vi.fn();
  const saveToLocalSpy = vi
    .spyOn(service(), "saveToLocal")
    .mockResolvedValue(undefined);
  setBlackBoxEntries([legacyLocalEntry]);
  (
    service() as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }
  ).retryQueueHandler = enqueue;

  await expect(service().pushToServer(legacyLocalEntry)).resolves.toBe(true);

  // 持久化前后的 syncStatus 仍是 pending，但 owner 已经改写到 sessionUserId
  expect(saveToLocalSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      userId: "user-1",
      syncStatus: "pending",
    }),
  );
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      userId: "user-1",
      syncStatus: "pending",
    }),
  );
  // 内存 Map 也已被同步成新 owner，不会继续被当作 owner-mismatch 反复触发
  expect(blackBoxEntriesMap().get(entryId)).toEqual(
    expect.objectContaining({
      id: entryId,
      userId: "user-1",
    }),
  );
}

async function runBlackBoxSyncLocalPushSpec10(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const dirtyEntry = createEntry({
    id: entryId,
    userId: "not-a-uuid-owner",
    updatedAt: "2026-03-04T00:00:00.000Z",
    syncStatus: "pending",
  });
  const enqueue = vi.fn();
  const deleteSpy = vi
    .spyOn(service(), "deleteFromLocal")
    .mockResolvedValue(undefined);
  setBlackBoxEntries([dirtyEntry]);
  (
    service() as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }
  ).retryQueueHandler = enqueue;

  await expect(service().pushToServer(dirtyEntry)).resolves.toBe(true);

  expect(deleteSpy).toHaveBeenCalledWith(entryId);
  expect(blackBoxEntriesMap().has(entryId)).toBe(false);
  expect(enqueue).not.toHaveBeenCalled();
}

async function runBlackBoxSyncLocalPushSpec11(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const foreignUserId = crypto.randomUUID();
  const foreignEntry = createEntry({
    id: entryId,
    userId: foreignUserId,
    updatedAt: "2026-03-04T00:00:00.000Z",
    syncStatus: "pending",
  });
  const enqueue = vi.fn();
  const saveToLocalSpy = vi
    .spyOn(service(), "saveToLocal")
    .mockResolvedValue(undefined);
  setBlackBoxEntries([foreignEntry]);
  (
    service() as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }
  ).retryQueueHandler = enqueue;

  await expect(service().pushToServer(foreignEntry)).resolves.toBe(true);

  // markEntrySyncConflict 路径会把 entry 改写为 conflict 并持久化
  expect(saveToLocalSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      userId: foreignUserId,
      syncStatus: "conflict",
    }),
  );
  expect(blackBoxEntriesMap().get(entryId)?.syncStatus).toBe("conflict");
  // 跨账号条目不应被重新入队
  expect(enqueue).not.toHaveBeenCalled();
}

async function runBlackBoxSyncLocalPushSpec12(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const { service } = tools;

  const foreignOwnerId = crypto.randomUUID();
  const foreignPending = createEntry({
    id: crypto.randomUUID(),
    userId: foreignOwnerId,
    updatedAt: "2026-03-04T00:00:00.000Z",
    syncStatus: "pending",
  });
  const enqueue = vi.fn();
  const saveToLocalSpy = vi
    .spyOn(service(), "saveToLocal")
    .mockResolvedValue(undefined);
  vi.spyOn(service(), "loadFromLocal").mockResolvedValue([foreignPending]);
  // 让前置远端对账分支短路（不依赖 supabase 请求），直接拿原始 validPending
  vi.spyOn(
    service() as unknown as {
      resolvePendingEntriesForRecovery: (
        entries: BlackBoxEntry[],
      ) => Promise<BlackBoxEntry[]>;
    },
    "resolvePendingEntriesForRecovery",
  ).mockResolvedValue([foreignPending]);

  setBlackBoxEntries([foreignPending]);
  (
    service() as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }
  ).retryQueueHandler = enqueue;

  await (
    service() as unknown as { recoverPendingEntries: () => Promise<void> }
  ).recoverPendingEntries();

  expect(enqueue).not.toHaveBeenCalled();
  expect(saveToLocalSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      id: foreignPending.id,
      syncStatus: "conflict",
    }),
  );
}

async function runBlackBoxSyncLocalPushSpec13(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const entry = createEntry({ id: crypto.randomUUID(), syncStatus: "pending" });
  const controls = createIdbReadWriteTransaction({
    getAllResult: [],
    getResult: () => null,
    requestOutcome: "manual",
    autoComplete: false,
  });
  (tools.service() as unknown as { db: unknown }).db = { transaction: controls.transaction };
  let settled = false;
  const pending = tools.service().saveToLocal(entry).then(() => { settled = true; });

  await flushMicrotasks();
  controls.succeedRequest();
  await flushMicrotasks();
  expect(controls.put).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);

  controls.complete();
  await pending;
  expect(settled).toBe(true);
}

async function runBlackBoxSyncLocalPushFailureSpec(
  tools: BlackBoxSyncLocalPushSpecTools,
  failureKind: "request" | "transaction" | "abort",
): Promise<void> {
  const controls = createIdbReadWriteTransaction({
    getAllResult: [],
    getResult: () => null,
    requestOutcome: "manual",
    autoComplete: false,
  });
  (tools.service() as unknown as { db: unknown }).db = { transaction: controls.transaction };
  let rejectionCount = 0;
  const settlement = tools.service().saveToLocal(createEntry({ id: crypto.randomUUID() })).then(
    () => "resolved" as const,
    () => { rejectionCount += 1; return "rejected" as const; },
  );
  await flushMicrotasks();
  const error = new DOMException(`${failureKind} failed`, "UnknownError");
  if (failureKind === "request") controls.failRequest(error);
  if (failureKind === "transaction") controls.failTransaction(error);
  if (failureKind === "abort") controls.abort(error);
  await flushMicrotasks();

  expect(await Promise.race([settlement, Promise.resolve("pending" as const)])).toBe("rejected");
  controls.failRequest(error);
  controls.failTransaction(error);
  controls.abort(error);
  await flushMicrotasks();
  expect(rejectionCount).toBe(1);
}

async function runBlackBoxSyncLocalPushWriterFenceSpec(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const entry = createEntry({ id: crypto.randomUUID() });
  const controls = createIdbReadWriteTransaction({
    getAllResult: [], getResult: () => null, requestOutcome: "manual", autoComplete: false,
  });
  (tools.service() as unknown as { db: unknown }).db = { transaction: controls.transaction };
  const pending = tools.service().saveToLocal(entry);
  await flushMicrotasks();
  expect(readActiveLocalBackupUiRestoreWriters(entry.userId))
    .toEqual([expect.objectContaining({ ownerUserId: entry.userId, source: "black-box" })]);
  controls.succeedRequest();
  controls.complete();
  await pending;
  expect(readActiveLocalBackupUiRestoreWriters(entry.userId)).toEqual([]);
}

async function runBlackBoxWriterRestoreGenerationSpec(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const entry = createEntry({ id: crypto.randomUUID(), userId: 'owner-a' });
  const controls = createIdbReadWriteTransaction({ getAllResult: [], getResult: () => null });
  (tools.service() as unknown as { db: unknown }).db = { transaction: controls.transaction };
  await tools.service().saveToLocal(entry);
  const persisted = controls.put.mock.calls[0][0] as BlackBoxEntry & { _localVersion: unknown };
  expect(persisted._localVersion).toMatch(/^[0-9a-f-]{36}$/i);

  await resetBlackBoxRestoreSpecDatabase();
  try {
    await seedBlackBoxRows([persisted as never]);
    const freshGeneration = crypto.randomUUID();
    const snapshot = await prepareLocalBackupUiBlackBoxRestore({
      ownerUserId: entry.userId, sourceDigest: SOURCE_DIGEST,
      backup: makeBackup([toBackupEntry({ ...entry, content: 'restored' })]),
    }, createBlackBoxRestoreDependencies([], [], () => freshGeneration));
    expect(snapshot.before[0]._localVersion).toBe(persisted._localVersion);
    expect(snapshot.target[0]._localVersion).toBe(freshGeneration);
  } finally {
    await resetBlackBoxRestoreSpecDatabase();
  }
}

async function runBlackBoxSyncLocalDeleteFenceSpec(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const entry = createEntry({ id: crypto.randomUUID() });
  const persistedEntry = { ...entry, _localVersion: 'generation-a' };
  const deleteRequest = {
    error: null, onerror: null,
  } as unknown as IDBRequest<undefined>;
  const deleteEntry = vi.fn(() => deleteRequest);
  let currentWriteEntry = persistedEntry;
  let readFails = false;
  const failedRead = {
    result: undefined, error: null, onsuccess: null, onerror: null,
  } as unknown as IDBRequest<unknown>;
  const readCurrent = vi.fn(() => readFails
    ? failedRead
    : createSuccessfulIdbRequest(currentWriteEntry));
  let transactionError: DOMException | null = null;
  const abortTransaction = vi.fn();
  const writeTransaction = {
    get error() { return transactionError; }, oncomplete: null, onerror: null, onabort: null,
    abort: abortTransaction,
    objectStore: vi.fn(() => ({ get: readCurrent, delete: deleteEntry })),
  } as unknown as IDBTransaction;
  const transaction = vi.fn((_store: string, mode?: IDBTransactionMode) => mode === "readonly"
    ? { objectStore: () => ({ get: () => createSuccessfulIdbRequest(persistedEntry) }) }
    : writeTransaction);
  (tools.service() as unknown as { db: unknown }).db = { transaction };
  const latest = await (tools.service() as unknown as {
    resolveLatestLocalEntry: (id: string) => Promise<BlackBoxEntry | null>;
  }).resolveLatestLocalEntry(entry.id);
  expect(latest).toEqual(entry);
  const pending = tools.service().deleteFromLocal(entry.id);
  await flushMicrotasks();
  expect(readActiveLocalBackupUiRestoreWriters(entry.userId)).toHaveLength(1);
  writeTransaction.oncomplete?.call(writeTransaction, new Event("complete"));
  await pending;
  expect(deleteEntry).toHaveBeenCalledWith(entry.id);
  expect(readActiveLocalBackupUiRestoreWriters(entry.userId)).toEqual([]);

  deleteEntry.mockClear();
  const replacement = { ...persistedEntry, _localVersion: 'generation-b' };
  currentWriteEntry = replacement;
  const staleDelete = tools.service().deleteFromLocal(entry.id);
  await flushMicrotasks();
  expect(abortTransaction).toHaveBeenCalledTimes(1);
  writeTransaction.onabort?.call(writeTransaction, new Event('abort'));
  await expect(staleDelete).rejects.toThrow(/changed/i);
  expect(readCurrent).toHaveBeenLastCalledWith(entry.id);
  expect(deleteEntry).not.toHaveBeenCalled();
  expect(readActiveLocalBackupUiRestoreWriters(entry.userId)).toEqual([]);

  abortTransaction.mockClear();
  currentWriteEntry = persistedEntry;
  readFails = true;
  const readFailure = tools.service().deleteFromLocal(entry.id);
  await flushMicrotasks();
  (failedRead as { error: DOMException | null }).error = new DOMException('read failed');
  failedRead.onerror?.call(failedRead, new Event('error'));
  expect(abortTransaction).toHaveBeenCalledTimes(1);
  expect(readActiveLocalBackupUiRestoreWriters(entry.userId)).toHaveLength(1);
  writeTransaction.onabort?.call(writeTransaction, new Event('abort'));
  await expect(readFailure).rejects.toThrow(/read failed/i);
  expect(deleteEntry).not.toHaveBeenCalled();

  readFails = false;
  abortTransaction.mockClear();
  const deleteFailure = tools.service().deleteFromLocal(entry.id);
  await flushMicrotasks();
  (deleteRequest as { error: DOMException | null }).error = new DOMException('delete failed');
  deleteRequest.onerror?.call(deleteRequest, new Event('error'));
  expect(abortTransaction).toHaveBeenCalledTimes(1);
  writeTransaction.onabort?.call(writeTransaction, new Event('abort'));
  await expect(deleteFailure).rejects.toThrow(/delete failed/i);

  abortTransaction.mockClear();
  const aborted = tools.service().deleteFromLocal(entry.id);
  await flushMicrotasks();
  transactionError = new DOMException('transaction aborted');
  writeTransaction.onabort?.call(writeTransaction, new Event('abort'));
  await expect(aborted).rejects.toThrow(/transaction aborted/i);
  expect(readActiveLocalBackupUiRestoreWriters(entry.userId)).toEqual([]);

  const missing = createIdbReadWriteTransaction({ getAllResult: [], getResult: () => null });
  (tools.service() as unknown as { db: unknown }).db = { transaction: missing.transaction };
  await expect(tools.service().deleteFromLocal("missing-owner")).rejects.toThrow(/owner/i);
  expect(missing.transaction).toHaveBeenCalledTimes(1);
}

async function runBlackBoxSyncLocalPushSpec14(
  tools: BlackBoxSyncLocalPushSpecTools,
): Promise<void> {
  const entry = createEntry({ id: crypto.randomUUID(), syncStatus: "pending" });
  const controls = createIdbReadWriteTransaction({
    getAllResult: [],
    getResult: () => null,
    requestOutcome: "manual",
    autoComplete: false,
  });
  const service = tools.service();
  (service as unknown as { db: unknown }).db = { transaction: controls.transaction };
  const push = vi.spyOn(service, "pushToServer").mockImplementation(() => new Promise<boolean>(() => {}));
  let scheduleSettled = false;
  const scheduled = service.scheduleSync(entry, { immediate: true }).then(() => { scheduleSettled = true; });

  await flushMicrotasks();
  controls.succeedRequest();
  await flushMicrotasks();
  expect(scheduleSettled).toBe(false);
  expect(push).not.toHaveBeenCalled();

  controls.complete();
  await scheduled;
  const committed = controls.put.mock.calls[0]?.[0] as BlackBoxEntry;
  expect(committed).toEqual(expect.objectContaining({ id: entry.id, syncStatus: "pending" }));
  expect(push).toHaveBeenCalledWith(expect.objectContaining({ id: entry.id, syncStatus: "pending" }), "user-1");

  const enqueue = vi.fn().mockResolvedValue(true);
  setBlackBoxEntries([]);
  vi.spyOn(service, "loadFromLocal").mockResolvedValue([committed]);
  vi.spyOn(service as unknown as {
    resolvePendingEntriesForRecovery: (entries: BlackBoxEntry[]) => Promise<BlackBoxEntry[]>;
  }, "resolvePendingEntriesForRecovery").mockResolvedValue([committed]);
  (service as unknown as { retryQueueHandler: typeof enqueue }).retryQueueHandler = enqueue;
  await (service as unknown as { recoverPendingEntries: () => Promise<void> }).recoverPendingEntries();
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: entry.id, syncStatus: "pending" }));
}
