/**
 * SyncCoordinatorService 的「签名 / 水位」纯函数模块。
 *
 * 从 SyncCoordinatorService「下切」出的无状态工具：项目本地水位计算、作用域水位键拼装、
 * 冲突快照签名、持久化去重签名。全部纯函数（无 `this`、无副作用）。
 *
 * - computeLocalProjectWatermark：取项目自身 + 全部 task/connection 的 updatedAt/deletedAt 最大毫秒
 * - resolveScopedWatermarkKey：把 prefix + userId 拼成 owner 作用域水位键（userId 空则 null）
 * - buildConflictSnapshotSignature：本地/远端项目 + 待删 task ids 的稳定 JSON 签名（去重判定）
 * - buildPersistTaskSignature / buildPersistConnectionSignature：实体持久化去重签名（仅取相关字段）
 * - buildPersistDataSignature：项目级签名（task/connection 按 id 排序后聚合）
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；SyncCoordinatorService 长期越界，
 * 这些纯工具自洽且零依赖服务态，适合先行下切。
 */
import { Project, Task, Connection } from '../models';

export function computeLocalProjectWatermark(project: Project | undefined): number {
  if (!project) return 0;

  let maxUpdatedAtMs = 0;
  const track = (value?: string | null) => {
    if (!value) return;
    const ts = new Date(value).getTime();
    if (Number.isFinite(ts)) {
      maxUpdatedAtMs = Math.max(maxUpdatedAtMs, ts);
    }
  };

  track(project.updatedAt);
  for (const task of project.tasks ?? []) {
    track(task.updatedAt);
    track(task.deletedAt);
  }
  for (const connection of project.connections ?? []) {
    track(connection.updatedAt);
    track(connection.deletedAt);
  }

  return maxUpdatedAtMs;
}

export function resolveScopedWatermarkKey(prefix: string, userId: string | null | undefined): string | null {
  const normalizedUserId = userId?.trim();
  if (!normalizedUserId) {
    return null;
  }
  return `${prefix}.${normalizedUserId}`;
}

export function buildConflictSnapshotSignature(
  localProject: Project | undefined,
  remoteProject: Project | undefined,
  pendingTaskDeleteIds?: string[],
): string {
  return JSON.stringify({
    localProject: localProject ?? null,
    remoteProject: remoteProject ?? null,
    pendingTaskDeleteIds: [...(pendingTaskDeleteIds ?? [])].sort(),
  });
}

export function buildPersistTaskSignature(task: Task): string {
  return JSON.stringify([
    task.id,
    task.updatedAt ?? '',
    task.parentId ?? '',
    task.stage ?? '',
    task.order,
    task.rank,
    task.displayId,
    task.x,
    task.y,
    task.status,
    task.deletedAt ?? '',
    task.shortId ?? '',
  ]);
}

export function buildPersistConnectionSignature(connection: Connection): string {
  return JSON.stringify([
    connection.id,
    connection.source,
    connection.target,
    connection.title ?? '',
    connection.description ?? '',
    connection.updatedAt ?? '',
    connection.deletedAt ?? '',
  ]);
}

export function buildPersistDataSignature(project: Project): string {
  const taskSignature = [...project.tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(task => buildPersistTaskSignature(task));
  const connectionSignature = [...project.connections]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(connection => buildPersistConnectionSignature(connection));

  return JSON.stringify({ taskSignature, connectionSignature });
}
