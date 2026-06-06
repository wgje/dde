/**
 * ProjectDataService 的「ID / 快照 / RPC 错误」纯函数模块。
 *
 * 从 ProjectDataService「下切」出的无状态工具：ID 规整与分块、批量 RPC 缺失错误识别、
 * 离线快照字节计量与项目形态归一。全部纯函数（无 `this`、无副作用）。
 *
 * - isBatchRpcMissingError：识别「批量 RPC 函数未部署 / schema cache 未刷新」类错误（驱动降级）
 * - chunkIds：把 id 列表按 size 切片（≤size 时单片返回副本）
 * - normalizeIds：去空白 + 去重，保持插入序
 * - getSnapshotByteSize：快照 JSON 的 UTF-8 字节数（TextEncoder，降级到 length）
 * - normalizeOfflineSnapshotProject：离线快照项目归一（保留软删任务、仅恢复活跃任务间连接）
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；ProjectDataService 长期越界，
 * 这些纯工具自洽且零依赖服务态，适合先行下切。
 */
import { Project } from '../../../../models';

export function isBatchRpcMissingError(error: {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}): boolean {
  const normalized = [error.message, error.details, error.hint]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();

  return (
    error.code === '42883' ||
    error.code === 'PGRST202' ||
    normalized.includes('does not exist') ||
    normalized.includes('could not find the function') ||
    normalized.includes('schema cache')
  );
}

export function chunkIds(ids: readonly string[], size: number): string[][] {
  if (ids.length <= size) return [Array.from(ids)];
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

export function normalizeIds(ids: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const id of ids) {
    const value = id.trim();
    if (value.length > 0) {
      normalized.add(value);
    }
  }
  return Array.from(normalized);
}

export function getSnapshotByteSize(raw: string): number {
  try {
    return new TextEncoder().encode(raw).byteLength;
  } catch {
    return raw.length;
  }
}

export function normalizeOfflineSnapshotProject(project: Project): Project {
  const allTasks = project.tasks || [];
  const activeTaskIds = new Set(
    allTasks
      .filter(task => !task.deletedAt)
      .map(task => task.id)
  );

  return {
    ...project,
    // 软删除任务仍属于回收站保留窗口，离线快照恢复不能把它们误当作已永久销毁。
    tasks: allTasks,
    // 主视图只恢复活跃任务之间的连接，避免 deleted task 在图上重新挂回可见边。
    connections: (project.connections || []).filter(connection =>
      activeTaskIds.has(connection.source) && activeTaskIds.has(connection.target)
    ),
  };
}
