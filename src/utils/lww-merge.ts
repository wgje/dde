/**
 * LWW (Last-Write-Wins) 通用合并工具。
 *
 * 设计原则：
 * - 纯函数，无副作用，无依赖注入。
 * - 以 `updatedAt` 毫秒时间戳作为唯一冲突仲裁权威。
 * - 可选 Tombstone Wins：一旦软删除确立，不应被本地未删除版本逆转。
 *
 * 历史：从 `UserSessionService` 抽离（原 `mergeTasksWithLWW` / `mergeConnectionsWithLWW`）。
 * AGENTS.md §5.2 LWW 约束与 §4 核心哲学「不造轮子」同时要求这类合并必须复用唯一实现。
 */

/** 任意带 `id` + `updatedAt` 的实体；unknown 强类型由调用方约束。 */
export interface LwwEntity {
  readonly id: string;
  readonly updatedAt?: string | null;
}

/** 支持软删除的 LWW 实体（如 Connection）。 */
export interface TombstonableLwwEntity extends LwwEntity {
  readonly deletedAt?: string | null;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 单实体 LWW 判定：`incoming` 是否应当覆盖 `current`。
 *
 * 规则：
 * 1. `current` 为 null / undefined → true（没有本地版本）；
 * 2. `incoming.updatedAt` 毫秒严格大于 `current.updatedAt` → true；
 * 3. 时间戳严格相等时：
 *    - 若未提供 `tiebreaker`，返回 false（保守维持 current）；
 *    - 若提供 `tiebreaker`，返回 `tiebreaker(incoming, current) > 0`。
 *
 * 典型用法（增强版 LWW，确定性）：
 *   `shouldPreferIncoming(remote, local, (a, b) => a.id.localeCompare(b.id))`
 */
export function shouldPreferIncoming<T extends LwwEntity>(
  incoming: T,
  current: T | null | undefined,
  tiebreaker?: (incoming: T, current: T) => number,
): boolean {
  if (!current) {
    return true;
  }
  const incomingMs = parseTimestamp(incoming.updatedAt);
  const currentMs = parseTimestamp(current.updatedAt);
  if (incomingMs > currentMs) {
    return true;
  }
  if (incomingMs === currentMs && tiebreaker) {
    return tiebreaker(incoming, current) > 0;
  }
  return false;
}

/**
 * LWW 合并两个实体数组（不处理 tombstone）。
 *
 * 规则：
 * 1. 以 id 为主键去重；
 * 2. 两侧同 id 时，`updatedAt` 更晚者胜；
 * 3. `updatedAt` 缺省或无法解析时按 0 处理（等同远端优先）；
 * 4. 云端优先作为默认 base（符合既有 `mergeTasksWithLWW` 行为）。
 */
export function mergeByLww<T extends LwwEntity>(local: readonly T[], cloud: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of cloud) {
    merged.set(item.id, item);
  }
  for (const item of local) {
    const current = merged.get(item.id);
    if (!current) {
      merged.set(item.id, item);
      continue;
    }
    if (parseTimestamp(item.updatedAt) > parseTimestamp(current.updatedAt)) {
      merged.set(item.id, item);
    }
  }
  return Array.from(merged.values());
}

/**
 * LWW 合并 + Tombstone Wins：
 * - 任一侧标记 `deletedAt` 则保留已删除版本；
 * - 两侧都删除取 `deletedAt` 更早者（删除意图不可逆转）；
 * - 两侧都未删除回退到标准 LWW。
 *
 * 对应历史 `mergeConnectionsWithLWW` 语义。
 */
export function mergeByLwwWithTombstone<T extends TombstonableLwwEntity>(
  local: readonly T[],
  cloud: readonly T[],
): T[] {
  const merged = new Map<string, T>();
  for (const item of cloud) {
    merged.set(item.id, item);
  }
  for (const item of local) {
    const current = merged.get(item.id);
    if (!current) {
      merged.set(item.id, item);
      continue;
    }
    const cloudDeleted = Boolean(current.deletedAt);
    const localDeleted = Boolean(item.deletedAt);
    if (cloudDeleted && !localDeleted) {
      // 云端删除，保留云端（已是 base，不动）
      continue;
    }
    if (!cloudDeleted && localDeleted) {
      merged.set(item.id, item);
      continue;
    }
    if (cloudDeleted && localDeleted) {
      const cloudTime = parseTimestamp(current.deletedAt);
      const localTime = parseTimestamp(item.deletedAt);
      merged.set(item.id, cloudTime <= localTime ? current : item);
      continue;
    }
    // 两侧都未删除 → 标准 LWW
    if (parseTimestamp(item.updatedAt) > parseTimestamp(current.updatedAt)) {
      merged.set(item.id, item);
    }
  }
  return Array.from(merged.values());
}
