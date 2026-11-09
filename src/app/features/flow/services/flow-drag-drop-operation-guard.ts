import type { Task } from '../../../../models';

export interface FlowDropInsertInfoLike {
  parentId?: string;
  beforeTaskId?: string;
  afterTaskId?: string;
  insertOnLink?: {
    sourceId: string;
    targetId: string;
  };
}

export interface FlowDropPointLike {
  x: number;
  y: number;
}

export interface FlowDropClaim {
  claimed: boolean;
  key: string;
}

type FlowDropPositionUpdateResult = void | boolean | Promise<void | boolean>;
type FlowDropPositionUpdater = (taskId: string, x: number, y: number) => FlowDropPositionUpdateResult;

export class FlowDropOperationGuard {
  private readonly activeDropKeys = new Set<string>();
  private readonly positionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly POSITION_RETRY_DELAY_MS = 1000;

  claim(taskId: string, insertInfo: FlowDropInsertInfoLike, docPoint: FlowDropPointLike): FlowDropClaim {
    const key = this.createDropKey(taskId, insertInfo, docPoint);
    if (this.activeDropKeys.has(key)) {
      return { claimed: false, key };
    }

    this.activeDropKeys.add(key);
    return { claimed: true, key };
  }

  release(dropKey: string): void {
    this.activeDropKeys.delete(dropKey);
    this.clearPositionRetry(dropKey);
  }

  schedulePositionUpdate(
    updateTaskPosition: FlowDropPositionUpdater,
    taskId: string,
    docPoint: FlowDropPointLike,
    delayMs: number,
    dropKey?: string,
  ): void {
    setTimeout(() => {
      this.runPositionUpdate(updateTaskPosition, taskId, docPoint, dropKey);
    }, delayMs);
  }

  private runPositionUpdate(
    updateTaskPosition: FlowDropPositionUpdater,
    taskId: string,
    docPoint: FlowDropPointLike,
    dropKey?: string,
  ): void {
    try {
      const updateResult = updateTaskPosition(taskId, docPoint.x, docPoint.y);
      if (isFlowDropPositionUpdatePromise(updateResult)) {
        void updateResult
          .then(result => this.handlePositionUpdateResult(result, updateTaskPosition, taskId, docPoint, dropKey))
          .catch(() => this.schedulePositionRetry(updateTaskPosition, taskId, docPoint, dropKey));
        return;
      }

      this.handlePositionUpdateResult(updateResult, updateTaskPosition, taskId, docPoint, dropKey);
    } catch {
      this.schedulePositionRetry(updateTaskPosition, taskId, docPoint, dropKey);
    }
  }

  private handlePositionUpdateResult(
    result: void | boolean,
    updateTaskPosition: FlowDropPositionUpdater,
    taskId: string,
    docPoint: FlowDropPointLike,
    dropKey?: string,
  ): void {
    if (result === false) {
      this.schedulePositionRetry(updateTaskPosition, taskId, docPoint, dropKey);
      return;
    }

    if (dropKey) {
      this.release(dropKey);
    }
  }

  private schedulePositionRetry(
    updateTaskPosition: FlowDropPositionUpdater,
    taskId: string,
    docPoint: FlowDropPointLike,
    dropKey?: string,
  ): void {
    if (!dropKey || this.positionRetryTimers.has(dropKey) || !this.activeDropKeys.has(dropKey)) {
      return;
    }

    const retryTimer = setTimeout(() => {
      this.positionRetryTimers.delete(dropKey);
      if (!this.activeDropKeys.has(dropKey)) {
        return;
      }

      this.runPositionUpdate(updateTaskPosition, taskId, docPoint, dropKey);
    }, this.POSITION_RETRY_DELAY_MS);
    this.positionRetryTimers.set(dropKey, retryTimer);
  }

  private clearPositionRetry(dropKey: string): void {
    const timer = this.positionRetryTimers.get(dropKey);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.positionRetryTimers.delete(dropKey);
  }

  private createDropKey(taskId: string, insertInfo: FlowDropInsertInfoLike, docPoint: FlowDropPointLike): string {
    const target = insertInfo.insertOnLink
      ? `link:${insertInfo.insertOnLink.sourceId}:${insertInfo.insertOnLink.targetId}`
      : insertInfo.parentId
        ? `parent:${insertInfo.parentId}:${insertInfo.beforeTaskId ?? ''}`
        : insertInfo.beforeTaskId
          ? `before:${insertInfo.beforeTaskId}`
          : insertInfo.afterTaskId
            ? `after:${insertInfo.afterTaskId}`
            : 'position';
    return `${taskId}|${target}|${docPoint.x}:${docPoint.y}`;
  }
}

function isFlowDropPositionUpdatePromise(
  value: FlowDropPositionUpdateResult,
): value is Promise<void | boolean> {
  return typeof value === 'object' && value !== null && typeof value.then === 'function';
}

export function findNextFlowDropSiblingId(tasks: Task[], refTask: Task): string | null {
  const siblings = tasks
    .filter(t => t.stage === refTask.stage && t.parentId === refTask.parentId)
    .sort((a, b) => a.rank - b.rank);
  const afterIndex = siblings.findIndex(t => t.id === refTask.id);
  return siblings[afterIndex + 1]?.id ?? null;
}
