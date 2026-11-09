/**
 * BlackBoxSyncService 的「同步游标」纯函数模块。
 *
 * 从 BlackBoxSyncService「下切」出的无状态游标助手：解析/比较/推进 BlackBox 同步游标，
 * 以及游标有效性校验与 keyset 分页过滤构造。
 *
 * 职责单一、纯函数（无 `this`、无副作用）：
 * - parseStoredSyncCursor：把 IndexedDB 里存的 legacy 字符串 / 对象解析为游标
 * - compareBlackBoxCursor：updatedAt 时间优先、id 次之的全序比较
 * - computeBlackBoxCursorFromRows：从远端行集取最大游标
 * - isValidBlackBoxCursor：updatedAt 可解析 + id 为空或合法 UUID
 * - createSafeBlackBoxKeysetFilter：构造 (updated_at,id) keyset 分页 PostgREST 过滤
 * - isBlackBoxCursorRow：远端行的游标字段类型守卫
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；BlackBoxSyncService 长期越界，
 * 这些纯游标助手自洽且零依赖服务态，最适合先行下切。
 */
import { isValidUUID } from '../utils/validation';

export interface BlackBoxSyncCursor {
  updatedAt: string;
  id: string;
}

export function parseStoredSyncCursor(value: unknown): BlackBoxSyncCursor | null {
  if (typeof value === 'string' && value) {
    return { updatedAt: value, id: '' };
  }
  if (value && typeof value === 'object') {
    const record = value as { updatedAt?: unknown; id?: unknown };
    if (typeof record.updatedAt === 'string' && typeof record.id === 'string') {
      return { updatedAt: record.updatedAt, id: record.id };
    }
  }
  return null;
}

export function compareBlackBoxCursor(left: BlackBoxSyncCursor, right: BlackBoxSyncCursor): number {
  const leftTime = new Date(left.updatedAt).getTime();
  const rightTime = new Date(right.updatedAt).getTime();
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.id.localeCompare(right.id);
}

export function computeBlackBoxCursorFromRows(rows: Array<Record<string, unknown>>): BlackBoxSyncCursor | null {
  let nextCursor: BlackBoxSyncCursor | null = null;
  for (const row of rows) {
    if (typeof row['updated_at'] !== 'string' || typeof row['id'] !== 'string') {
      continue;
    }
    const candidate = { updatedAt: row['updated_at'], id: row['id'] };
    if (!nextCursor || compareBlackBoxCursor(candidate, nextCursor) > 0) {
      nextCursor = candidate;
    }
  }

  return nextCursor;
}

export function isValidBlackBoxCursor(cursor: BlackBoxSyncCursor): boolean {
  const updatedAtMs = Date.parse(cursor.updatedAt);
  return Number.isFinite(updatedAtMs) && (!cursor.id || isValidUUID(cursor.id));
}

export function createSafeBlackBoxKeysetFilter(cursor: BlackBoxSyncCursor): string | null {
  if (!cursor.id || !isValidBlackBoxCursor(cursor)) return null;
  return `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`;
}

export function isBlackBoxCursorRow(row: Record<string, unknown> | undefined): row is Record<string, unknown> & {
  id: string;
  updated_at: string;
} {
  return typeof row?.['id'] === 'string'
    && isValidUUID(row['id'])
    && typeof row['updated_at'] === 'string'
    && Number.isFinite(Date.parse(row['updated_at']));
}
