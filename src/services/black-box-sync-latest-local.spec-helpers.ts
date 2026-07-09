import { TestBed } from "@angular/core/testing";
import { expect, it, vi } from "vitest";

import type { BlackBoxEntry } from "../models/focus";
import { blackBoxEntriesMap, setBlackBoxEntries } from "../state/focus-stores";
import { SupabaseClientService } from "./supabase-client.service";
import { BlackBoxSyncService } from "./black-box-sync.service";
import {
  createEntry,
  createPreflightQuery,
  flushMicrotasks,
} from "./black-box-sync.spec-helpers";

interface BlackBoxSyncLatestLocalSpecContext {
  getService: () => BlackBoxSyncService;
}

type BlackBoxSyncLatestLocalSpecTools = {
  service: () => BlackBoxSyncService;
};

type BlackBoxSyncLatestLocalSpec = readonly [
  name: string,
  run: (tools: BlackBoxSyncLatestLocalSpecTools) => Promise<void>,
];

const blackBoxSyncLatestLocalSpecs: readonly BlackBoxSyncLatestLocalSpec[] = [
  [
    "mergeWithLocal 把远端单调真值合并进本地 pending 后，retryQueueHandler 应被 merged entry 调用一次",
    runBlackBoxSyncLatestLocalSpec1,
  ],
  [
    "pushToServer 直接 upsert 完成、latestLocalAfterPush 业务字段等价但 updatedAt 更晚时，应升级为 synced 而不是长期 pending",
    runBlackBoxSyncLatestLocalSpec2,
  ],
  [
    "pushToServer 直接写入在 preflight 后被并发更新抢先时应返回 false 而不是覆盖远端",
    runBlackBoxSyncLatestLocalSpec3,
  ],
  [
    "pushToServer 直接 upsert 完成、latestLocalAfterPush 业务字段不等价时，应主动入队 latestLocal 避免孤儿 pending",
    runBlackBoxSyncLatestLocalSpec4,
  ],
  [
    "upgradeEquivalentLatestLocalToSynced 非等价分支在缺少 retryQueueHandler 时应降级为内联 pushToServer",
    runBlackBoxSyncLatestLocalSpec5,
  ],
  [
    "upgradeEquivalentLatestLocalToSynced 内联 push 返回 false 时应保留 latestLocal 到 pending 队列等待恢复",
    runBlackBoxSyncLatestLocalSpec6,
  ],
];

export function registerBlackBoxSyncLatestLocalSpecs(
  context: BlackBoxSyncLatestLocalSpecContext,
): void {
  const tools: BlackBoxSyncLatestLocalSpecTools = {
    service: () => context.getService(),
  };

  for (const [name, run] of blackBoxSyncLatestLocalSpecs) {
    it(name, () => run(tools));
  }
}

async function runBlackBoxSyncLatestLocalSpec1(
  tools: BlackBoxSyncLatestLocalSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const localPending = createEntry({
    id: entryId,
    isCompleted: false,
    isRead: false,
    updatedAt: "2026-03-04T00:00:10.000Z", // 比 remote 新 → LWW 本地胜
    syncStatus: "pending",
  });
  const remote = createEntry({
    id: entryId,
    isCompleted: true,
    isRead: true,
    updatedAt: "2026-03-04T00:00:05.000Z",
    syncStatus: "synced",
  });

  const saveToLocalSpy = vi
    .spyOn(service(), "saveToLocal")
    .mockResolvedValue(undefined);
  const enqueue = vi.fn();
  setBlackBoxEntries([localPending]);
  (
    service() as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }
  ).retryQueueHandler = enqueue;

  await (
    service() as unknown as {
      mergeWithLocal: (
        remoteEntry: BlackBoxEntry,
        preferRemoteForSyncedLocalDuringPull: boolean,
        repairingFutureCursor: boolean,
      ) => Promise<void>;
    }
  ).mergeWithLocal(remote, false, false);

  // 单调真值被合并到 local，但 syncStatus 仍是 pending
  const mergedSaveCall = saveToLocalSpy.mock.calls.find((args) => {
    const arg = args[0] as BlackBoxEntry;
    return (
      arg.id === entryId &&
      arg.isCompleted === true &&
      arg.isRead === true &&
      arg.syncStatus === "pending"
    );
  });
  expect(mergedSaveCall).toBeDefined();

  // 合并后必须重新入队，否则没有任何机制再次触发这条 pending 的 push
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      isCompleted: true,
      isRead: true,
      syncStatus: "pending",
    }),
  );
}

async function runBlackBoxSyncLatestLocalSpec2(
  tools: BlackBoxSyncLatestLocalSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const entry = createEntry({
    id: entryId,
    updatedAt: "2026-03-04T00:00:00.000Z",
    isCompleted: false,
    syncStatus: "pending",
  });
  // 并发路径在 upsert 期间又把 pending 写了一遍（业务字段完全等价、只 bump updatedAt）
  const concurrentlyBumped: BlackBoxEntry = {
    ...entry,
    updatedAt: "2026-03-04T00:00:02.000Z",
    syncStatus: "pending",
  };
  const serverUpdatedAt = "2026-03-04T00:00:03.000Z";

  const preflightQuery = createPreflightQuery(
    vi.fn(async () => ({ data: null, error: null })),
  );
  const from = vi.fn(() => ({
    select: vi.fn(() => preflightQuery),
    insert: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => {
          // 在 upsert 返回前，把内存 Map 升到等价但更晚的快照
          setBlackBoxEntries([concurrentlyBumped]);
          return {
            data: { updated_at: serverUpdatedAt },
            error: null,
          };
        }),
      })),
    })),
    update: vi.fn(),
  }));
  const supabase = TestBed.inject(SupabaseClientService) as unknown as {
    clientAsync: ReturnType<typeof vi.fn>;
  };
  const saveToLocalSpy = vi
    .spyOn(service(), "saveToLocal")
    .mockResolvedValue(undefined);

  setBlackBoxEntries([entry]);
  supabase.clientAsync.mockResolvedValue({ from });

  await expect(service().pushToServer(entry)).resolves.toBe(true);

  // 关键断言：等价的更晚本地快照应被升级为 synced，并采纳服务端 updatedAt。
  // UI 因此立刻从"待同步"收敛。
  const syncedCall = saveToLocalSpy.mock.calls.find((args) => {
    const arg = args[0] as BlackBoxEntry;
    return (
      arg.id === entryId &&
      arg.syncStatus === "synced" &&
      arg.updatedAt === serverUpdatedAt
    );
  });
  expect(syncedCall).toBeDefined();
  expect(blackBoxEntriesMap().get(entryId)).toEqual(
    expect.objectContaining({
      id: entryId,
      syncStatus: "synced",
      updatedAt: serverUpdatedAt,
    }),
  );
}

async function runBlackBoxSyncLatestLocalSpec3(
  tools: BlackBoxSyncLatestLocalSpecTools,
): Promise<void> {
  const { service } = tools;

  const entry = createEntry({
    id: crypto.randomUUID(),
    updatedAt: "2026-03-04T00:00:00.000Z",
    syncStatus: "pending",
  });
  const preflightQuery = createPreflightQuery(
    vi.fn(async () => ({
      data: {
        id: entry.id,
        project_id: entry.projectId,
        user_id: entry.userId,
        content: entry.content,
        focus_meta: null,
        date: entry.date,
        created_at: entry.createdAt,
        updated_at: entry.updatedAt,
        is_read: entry.isRead,
        is_completed: entry.isCompleted,
        is_archived: entry.isArchived,
        snooze_until: null,
        snooze_count: 0,
        deleted_at: null,
      },
      error: null,
    })),
  );
  const update = vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          })),
        })),
      })),
    })),
  }));
  const from = vi.fn(() => ({
    select: vi.fn(() => preflightQuery),
    update,
    insert: vi.fn(),
  }));
  const supabase = TestBed.inject(SupabaseClientService) as unknown as {
    clientAsync: ReturnType<typeof vi.fn>;
  };

  setBlackBoxEntries([entry]);
  supabase.clientAsync.mockResolvedValue({ from });

  await expect(service().pushToServer(entry)).resolves.toBe(false);
  expect(update).toHaveBeenCalled();
}

async function runBlackBoxSyncLatestLocalSpec4(
  tools: BlackBoxSyncLatestLocalSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const entry = createEntry({
    id: entryId,
    content: "初稿",
    updatedAt: "2026-03-04T00:00:00.000Z",
    isCompleted: false,
    syncStatus: "pending",
  });
  // 并发路径在 upsert 期间把 content 改了——业务字段不等价
  const concurrentlyEditedNotEquivalent: BlackBoxEntry = {
    ...entry,
    content: "增补内容",
    updatedAt: "2026-03-04T00:00:02.000Z",
    syncStatus: "pending",
  };
  const serverUpdatedAt = "2026-03-04T00:00:03.000Z";

  const preflightQuery = createPreflightQuery(
    vi.fn(async () => ({ data: null, error: null })),
  );
  const from = vi.fn(() => ({
    select: vi.fn(() => preflightQuery),
    insert: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => {
          // 在 upsert 返回前把内存 Map 升到不等价的更晚快照
          setBlackBoxEntries([concurrentlyEditedNotEquivalent]);
          return {
            data: { updated_at: serverUpdatedAt },
            error: null,
          };
        }),
      })),
    })),
    update: vi.fn(),
  }));
  const supabase = TestBed.inject(SupabaseClientService) as unknown as {
    clientAsync: ReturnType<typeof vi.fn>;
  };
  vi.spyOn(service(), "saveToLocal").mockResolvedValue(undefined);
  const enqueue = vi.fn();
  (
    service() as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }
  ).retryQueueHandler = enqueue;

  setBlackBoxEntries([entry]);
  supabase.clientAsync.mockResolvedValue({ from });

  await expect(service().pushToServer(entry)).resolves.toBe(true);

  // 关键断言：业务字段不等价的更晚本地快照必须被显式重新入队，
  // 否则会成为孤儿 pending（UI 永远显示 待同步）。
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      content: "增补内容",
      syncStatus: "pending",
    }),
  );
  // 内存里不应被回写成 synced（业务字段不等价时仅保留 pending）
  const inMemory = blackBoxEntriesMap().get(entryId);
  expect(inMemory?.syncStatus).toBe("pending");
  expect(inMemory?.content).toBe("增补内容");
}

async function runBlackBoxSyncLatestLocalSpec5(
  tools: BlackBoxSyncLatestLocalSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const pushedEntry = createEntry({
    id: entryId,
    content: "旧",
    updatedAt: "2026-03-04T00:00:00.000Z",
    syncStatus: "pending",
  });
  const latestLocal = createEntry({
    id: entryId,
    content: "新内容",
    updatedAt: "2026-03-04T00:00:02.000Z",
    syncStatus: "pending",
  });

  (
    service() as unknown as {
      retryQueueHandler: ((entry: BlackBoxEntry) => void) | null;
    }
  ).retryQueueHandler = null;
  vi.spyOn(service(), "saveToLocal").mockResolvedValue(undefined);
  const pushSpy = vi.spyOn(service(), "pushToServer").mockResolvedValue(true);

  await (
    service() as unknown as {
      upgradeEquivalentLatestLocalToSynced: (
        latestLocal: BlackBoxEntry,
        pushedEntry: BlackBoxEntry,
        serverUpdatedAt: string,
        pushPath: "rpc" | "upsert",
      ) => Promise<void>;
    }
  ).upgradeEquivalentLatestLocalToSynced(
    latestLocal,
    pushedEntry,
    "2026-03-04T00:00:03.000Z",
    "upsert",
  );

  // 微任务结算（ensureLatestLocalEnqueued 走 void this.pushToServer().catch(...)）
  await flushMicrotasks();

  expect(pushSpy).toHaveBeenCalledTimes(1);
  expect(pushSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      content: "新内容",
    }),
  );
}

async function runBlackBoxSyncLatestLocalSpec6(
  tools: BlackBoxSyncLatestLocalSpecTools,
): Promise<void> {
  const { service } = tools;

  const entryId = crypto.randomUUID();
  const pushedEntry = createEntry({
    id: entryId,
    content: "旧",
    updatedAt: "2026-03-04T00:00:00.000Z",
    syncStatus: "pending",
  });
  const latestLocal = createEntry({
    id: entryId,
    content: "弱网期间继续编辑",
    updatedAt: "2026-03-04T00:00:02.000Z",
    syncStatus: "pending",
  });
  const internals = service() as unknown as {
    pendingPushEntries: Map<string, BlackBoxEntry>;
    retryQueueHandler: ((entry: BlackBoxEntry) => Promise<boolean>) | null;
    schedulePendingPushFlush: () => void;
    upgradeEquivalentLatestLocalToSynced: (
      latestLocal: BlackBoxEntry,
      pushedEntry: BlackBoxEntry,
      serverUpdatedAt: string,
      pushPath: "rpc" | "upsert",
    ) => Promise<void>;
  };

  internals.retryQueueHandler = null;
  vi.spyOn(service(), "saveToLocal").mockResolvedValue(undefined);
  const pushSpy = vi.spyOn(service(), "pushToServer").mockResolvedValue(false);
  const scheduleFlushSpy = vi
    .spyOn(internals, "schedulePendingPushFlush")
    .mockImplementation(() => undefined);

  await internals.upgradeEquivalentLatestLocalToSynced(
    latestLocal,
    pushedEntry,
    "2026-03-04T00:00:03.000Z",
    "upsert",
  );
  await flushMicrotasks();

  expect(pushSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      id: entryId,
      content: "弱网期间继续编辑",
    }),
  );
  expect(internals.pendingPushEntries.get(entryId)).toEqual(
    expect.objectContaining({
      id: entryId,
      content: "弱网期间继续编辑",
      syncStatus: "pending",
    }),
  );
  expect(scheduleFlushSpy).toHaveBeenCalledTimes(1);
}
