import { TestBed } from "@angular/core/testing";
import { expect, it, vi } from "vitest";

import { AUTH_CONFIG } from "../config/auth.config";
import type { BlackBoxEntry } from "../models/focus";
import { blackBoxEntriesMap, setBlackBoxEntries } from "../state/focus-stores";
import { SupabaseClientService } from "./supabase-client.service";
import { BlackBoxSyncService } from "./black-box-sync.service";
import {
  createEntry,
  createIdbReadOnlyTransaction,
  createIdbReadWriteTransaction,
  createPreflightQuery,
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
