/**
 * RetryQueueService 的「指纹 / 等价 / 分类」纯函数模块。
 *
 * 从 RetryQueueService「下切」出的无状态工具：用于重试项去重、刷新检测、错误分类与
 * 持久化前裁剪。全部纯函数（无 `this`、无副作用）。
 *
 * - areStringArraysEqual：顺序敏感的字符串数组相等
 * - buildRefreshFingerprint：重试项刷新指纹（幂等键 + 数据快照 + taskIdsToDelete/CAS map 排序签名），
 *   用于识别"新快照覆盖旧 in-flight 项"而不被 loadFromStorage 浅复制误判
 * - buildBlackBoxRetryDataFingerprint：黑匣子条目数据指纹（含 focusMeta 归一），用于重试 noop 判定
 * - classifyErrorType：把 Error 归类成网络/超时/网关/未知等类型标签（驱动退避策略）
 * - minifyItem：持久化前裁剪 task 项的 displayId（仅本地展示字段，不入库）
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；RetryQueueService 长期越界，
 * 这些纯工具自洽且零依赖服务态，适合先行下切。
 */
import { Task, BlackBoxEntry } from '../../../../models';
import { isBrowserNetworkSuspendedError } from '../../../../utils/browser-network-suspension';
import type { RetryQueueItem } from './retry-queue.service';

export function areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftValues = left ?? [];
  const rightValues = right ?? [];
  if (leftValues.length !== rightValues.length) {
    return false;
  }

  return leftValues.every((value, index) => value === rightValues[index]);
}

export function buildRefreshFingerprint(item: RetryQueueItem): string {
  const dataWithTimestamps = item.data as { updatedAt?: unknown; deletedAt?: unknown };
  const updatedAt = typeof dataWithTimestamps.updatedAt === 'string' ? dataWithTimestamps.updatedAt : '';
  const deletedAt = typeof dataWithTimestamps.deletedAt === 'string' ? dataWithTimestamps.deletedAt : '';
  const taskDeleteSignature = Array.isArray(item.taskIdsToDelete)
    ? [...item.taskIdsToDelete].sort().join(',')
    : '';
  const taskDeleteBaseSignature = buildTaskDeleteBaseUpdatedAtMapSignature(item.taskDeleteBaseUpdatedAtMap);

  return [
    String(item.createdAt),
    item.operationId,
    item.operation,
    item.projectId ?? '',
    item.sourceUserId ?? '',
    item.writeIntent ?? '',
    buildStableJsonSignature(item.data),
    updatedAt,
    deletedAt,
    taskDeleteSignature,
    taskDeleteBaseSignature,
  ].join('|');
}

function buildStableJsonSignature(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => buildStableJsonSignature(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${buildStableJsonSignature(record[key])}`)
    .join(',')}}`;
}

function buildTaskDeleteBaseUpdatedAtMapSignature(
  map: RetryQueueItem['taskDeleteBaseUpdatedAtMap'],
): string {
  if (!map) {
    return '';
  }

  return Object.keys(map)
    .sort()
    .map(taskId => `${taskId}:${map[taskId] ?? null}`)
    .join(',');
}

export function buildBlackBoxRetryDataFingerprint(entry: BlackBoxEntry): string {
  const focusMeta = entry.focusMeta
    ? {
        source: entry.focusMeta.source,
        sessionId: entry.focusMeta.sessionId,
        title: entry.focusMeta.title,
        detail: entry.focusMeta.detail ?? null,
        lane: entry.focusMeta.lane,
        expectedMinutes: entry.focusMeta.expectedMinutes ?? null,
        waitMinutes: entry.focusMeta.waitMinutes ?? null,
        cognitiveLoad: entry.focusMeta.cognitiveLoad,
        dockEntryId: entry.focusMeta.dockEntryId,
      }
    : null;

  return JSON.stringify({
    id: entry.id,
    projectId: entry.projectId ?? null,
    userId: entry.userId,
    content: entry.content,
    date: entry.date,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    completedAt: entry.completedAt ?? null,
    isRead: entry.isRead,
    isCompleted: entry.isCompleted,
    isArchived: entry.isArchived,
    snoozeUntil: entry.snoozeUntil ?? null,
    snoozeCount: entry.snoozeCount ?? 0,
    deletedAt: entry.deletedAt ?? null,
    syncStatus: entry.syncStatus ?? null,
    localCreatedAt: entry.localCreatedAt ?? null,
    originalAudioDuration: entry.originalAudioDuration ?? null,
    focusMeta,
  });
}

export function classifyErrorType(error: Error): string {
  if (isBrowserNetworkSuspendedError(error)) {
    return 'BrowserNetworkSuspendedError';
  }

  const msg = (error.message || '').toLowerCase();
  if (msg.includes('failed to fetch') || msg.includes('network')) return 'NetworkError';
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('超时')) return 'NetworkTimeoutError';
  if (msg.includes('504')) return 'GatewayError';
  if (msg.includes('503')) return 'ServiceUnavailableError';
  if (msg.includes('offline') || msg.includes('no connection')) return 'NetworkError';
  return 'UnknownError';
}

export function minifyItem(item: RetryQueueItem): RetryQueueItem {
  if (item.type !== 'task') {
    return item;
  }

  const task = item.data as Task;
  const { displayId: _drop, ...taskWithoutDisplayId } = task;
  return {
    ...item,
    data: taskWithoutDisplayId as Task
  };
}
