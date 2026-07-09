/**
 * Tombstone 缓存项
 */
export interface TombstoneCache {
  /** 已删除的任务 ID 集合 */
  ids: Set<string>;
  /** 缓存时间戳 */
  timestamp: number;
  /** 任务 tombstone 的真实删除时间水位 */
  taskDeletedAt?: Map<string, number>;
}

export interface BatchTombstoneTaskRow {
  project_id: string;
  task_id: string;
  deleted_at?: string | null;
}

export interface BatchTombstoneConnectionRow {
  project_id: string;
  connection_id: string;
}

/** batch_get_tombstones RPC 返回结构 */
export interface BatchTombstoneResult {
  task_tombstones?: BatchTombstoneTaskRow[] | null;
  connection_tombstones?: BatchTombstoneConnectionRow[] | null;
}

export interface BatchTombstoneCacheData {
  taskRows: BatchTombstoneTaskRow[];
  connRows: BatchTombstoneConnectionRow[];
  taskMap: Map<string, Set<string>>;
  taskDeletedAtMap: Map<string, Map<string, number>>;
  taskProjectsMissingDeletedAt: Set<string>;
  connMap: Map<string, Set<string>>;
}

export function parseTombstoneTimestamp(value?: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseLocalTombstoneProjectRecord(
  value: unknown,
  fallbackTimestamp = Date.now(),
): Map<string, number> {
  if (Array.isArray(value)) {
    return parseLegacyLocalTombstoneIds(value, fallbackTimestamp);
  }

  if (value && typeof value === 'object') {
    return parseTimestampedLocalTombstoneRecord(value as Record<string, unknown>, fallbackTimestamp);
  }

  return new Map();
}

export function rowsFromTaskTombstoneCache(cached: TombstoneCache): { task_id: string; deleted_at?: string | null }[] {
  return Array.from(cached.ids).map(id => ({
    task_id: id,
    deleted_at: cached.taskDeletedAt?.has(id)
      ? new Date(cached.taskDeletedAt.get(id)!).toISOString()
      : undefined,
  }));
}

export function buildBatchTombstoneCacheData(data: BatchTombstoneResult): BatchTombstoneCacheData {
  const taskRows = data.task_tombstones ?? [];
  const connRows = data.connection_tombstones ?? [];
  const taskMap = new Map<string, Set<string>>();
  const taskDeletedAtMap = new Map<string, Map<string, number>>();
  const taskProjectsMissingDeletedAt = new Set<string>();
  const connMap = new Map<string, Set<string>>();

  groupBatchTaskTombstones(taskRows, taskMap, taskDeletedAtMap, taskProjectsMissingDeletedAt);
  groupBatchConnectionTombstones(connRows, connMap);

  return { taskRows, connRows, taskMap, taskDeletedAtMap, taskProjectsMissingDeletedAt, connMap };
}

function parseLegacyLocalTombstoneIds(value: unknown[], fallbackTimestamp: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const taskId of value) {
    if (typeof taskId === 'string') {
      map.set(taskId, fallbackTimestamp);
    }
  }
  return map;
}

function parseTimestampedLocalTombstoneRecord(
  value: Record<string, unknown>,
  fallbackTimestamp: number,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [taskId, timestamp] of Object.entries(value)) {
    const ts = typeof timestamp === 'number' ? timestamp : fallbackTimestamp;
    map.set(taskId, ts);
  }
  return map;
}

function groupBatchTaskTombstones(
  taskRows: BatchTombstoneTaskRow[],
  taskMap: Map<string, Set<string>>,
  taskDeletedAtMap: Map<string, Map<string, number>>,
  taskProjectsMissingDeletedAt: Set<string>,
): void {
  for (const row of taskRows) {
    if (!taskMap.has(row.project_id)) taskMap.set(row.project_id, new Set());
    taskMap.get(row.project_id)!.add(row.task_id);
    const deletedAt = parseTombstoneTimestamp(row.deleted_at);
    if (deletedAt !== undefined) {
      if (!taskDeletedAtMap.has(row.project_id)) {
        taskDeletedAtMap.set(row.project_id, new Map());
      }
      taskDeletedAtMap.get(row.project_id)!.set(row.task_id, deletedAt);
    } else {
      taskProjectsMissingDeletedAt.add(row.project_id);
    }
  }
}

function groupBatchConnectionTombstones(
  connRows: BatchTombstoneConnectionRow[],
  connMap: Map<string, Set<string>>,
): void {
  for (const row of connRows) {
    if (!connMap.has(row.project_id)) connMap.set(row.project_id, new Set());
    connMap.get(row.project_id)!.add(row.connection_id);
  }
}
