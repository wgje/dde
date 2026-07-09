/**
 * BlackBoxSyncService 的「条目等价判定」纯函数模块。
 *
 * 从 BlackBoxSyncService「下切」出的无状态等价比较助手：把任意来源的黑匣子条目
 * 归一化后做业务字段级等价判定，用于 pending 对账 / 合并时避免"仅同步元数据漂移"
 * 导致的伪不等价循环。
 *
 * 职责单一、纯函数（无 `this`、无副作用）：
 * - normalizeEntryForEquivalence：把 focusMeta 的 null/undefined 漂移、snooze/projectId/deletedAt
 *   等可空字段统一成默认值，仅用于等价判定（不回写 IDB / signal store）
 * - hasEquivalentEntryState：归一后逐字段比较；时间戳比较通过注入的 `sameInstant` 比较器完成
 *   （由调用方提供，从而把"无效时间戳 debug 日志"等副作用留在服务侧）
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；BlackBoxSyncService 长期越界，
 * 这些纯归一/比较助手自洽且零依赖服务态，最适合先行下切。
 */
import { BlackBoxEntry } from '../models/focus';

/** 时间戳「同一时刻」比较器（由服务侧注入，承载无效时间戳的 debug 日志副作用）。 */
export type SameInstantComparator = (
  left: string | null | undefined,
  right: string | null | undefined,
) => boolean;

type EquivalentEntry = ReturnType<typeof normalizeEntryForEquivalence>;

/**
 * 把任意来源的 entry 归一化成等价比较友好的形态：
 * - focusMeta 的 `null` 与 `undefined` 统一成 `null`，并对内部可空字段递归归一；
 * - `snoozeUntil` / `snoozeCount` / `projectId` / `deletedAt` 的 `undefined` 统一成默认值；
 *
 * 仅用于等价判定，不会回写到 IDB 或 signal store。
 *
 * 【2026-05-18 根因修复·阶段 1】黑匣子条目在多个写入路径（BlackBoxService.create / update、
 * mapRowToEntry、saveToLocal 等）可能出现 focusMeta=undefined vs null、snoozeCount=undefined
 * vs 0 等"形态漂移"。hasEquivalentEntryState 未归一时，会把"业务字段实际相等、仅同步元数据
 * 不同"的快照判定为不等价，使 upgradeEquivalentLatestLocalToSynced / mergeWithLocal 进入
 * "保留 pending + 重新入队"的循环，UI 表现为黑匣子条目长期 ⏳ 待同步。
 */
export function normalizeEntryForEquivalence(entry: BlackBoxEntry): BlackBoxEntry {
  const rawFocusMeta = entry.focusMeta ?? null;
  const focusMeta = rawFocusMeta
    ? {
        source: rawFocusMeta.source,
        sessionId: rawFocusMeta.sessionId,
        title: rawFocusMeta.title,
        detail: rawFocusMeta.detail ?? null,
        lane: rawFocusMeta.lane,
        expectedMinutes: rawFocusMeta.expectedMinutes ?? null,
        waitMinutes: rawFocusMeta.waitMinutes ?? null,
        cognitiveLoad: rawFocusMeta.cognitiveLoad,
        dockEntryId: rawFocusMeta.dockEntryId,
      }
    : null;

  return {
    ...entry,
    projectId: entry.projectId ?? null,
    completedAt: entry.completedAt ?? null,
    snoozeUntil: entry.snoozeUntil ?? undefined,
    snoozeCount: entry.snoozeCount ?? 0,
    deletedAt: entry.deletedAt ?? null,
    focusMeta,
  };
}

function haveEquivalentFocusMeta(
  localFocusMeta: BlackBoxEntry['focusMeta'],
  remoteFocusMeta: BlackBoxEntry['focusMeta'],
): boolean {
  if (!localFocusMeta || !remoteFocusMeta) {
    return localFocusMeta === remoteFocusMeta;
  }

  return localFocusMeta.source === remoteFocusMeta.source
    && localFocusMeta.sessionId === remoteFocusMeta.sessionId
    && localFocusMeta.title === remoteFocusMeta.title
    && localFocusMeta.detail === remoteFocusMeta.detail
    && localFocusMeta.lane === remoteFocusMeta.lane
    && localFocusMeta.expectedMinutes === remoteFocusMeta.expectedMinutes
    && localFocusMeta.waitMinutes === remoteFocusMeta.waitMinutes
    && localFocusMeta.cognitiveLoad === remoteFocusMeta.cognitiveLoad
    && localFocusMeta.dockEntryId === remoteFocusMeta.dockEntryId;
}

function haveEquivalentIdentityFields(
  local: EquivalentEntry,
  remote: EquivalentEntry,
  sameInstant: SameInstantComparator,
): boolean {
  return local.id === remote.id
    && local.projectId === remote.projectId
    && local.userId === remote.userId
    && local.content === remote.content
    && local.date === remote.date
    && sameInstant(local.createdAt, remote.createdAt)
    && sameInstant(local.completedAt, remote.completedAt);
}

function haveEquivalentStateFields(local: EquivalentEntry, remote: EquivalentEntry): boolean {
  return local.isRead === remote.isRead
    && local.isCompleted === remote.isCompleted
    && local.isArchived === remote.isArchived
    && (local.snoozeUntil ?? null) === (remote.snoozeUntil ?? null)
    && local.snoozeCount === remote.snoozeCount;
}

export function hasEquivalentEntryState(
  local: BlackBoxEntry,
  remote: BlackBoxEntry,
  sameInstant: SameInstantComparator,
): boolean {
  const normalizedLocal = normalizeEntryForEquivalence(local);
  const normalizedRemote = normalizeEntryForEquivalence(remote);

  return haveEquivalentIdentityFields(normalizedLocal, normalizedRemote, sameInstant)
    && haveEquivalentStateFields(normalizedLocal, normalizedRemote)
    && sameInstant(normalizedLocal.deletedAt, normalizedRemote.deletedAt)
    && haveEquivalentFocusMeta(normalizedLocal.focusMeta, normalizedRemote.focusMeta);
}
