import { Injectable, inject } from '@angular/core';
import type { Connection, Task } from '../../../../models';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import { isPermanentFailureError } from '../../../../utils/permanent-failure-error';

@Injectable({ providedIn: 'root' })
export class ProjectSaveEntityStateService {
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly logger = inject(LoggerService).category('BatchSync');

  private readonly suppressedTaskIds = new Map<string, Map<string, string>>();
  private readonly suppressedConnectionIds = new Map<string, Map<string, string>>();

  getBatchChangeRevision(): number {
    const tracker = this.changeTracker as unknown as {
      getCurrentChangeRevision?: () => number;
    };

    if (typeof tracker.getCurrentChangeRevision === 'function') {
      return tracker.getCurrentChangeRevision();
    }

    this.logger.warn('ChangeTracker revision API unavailable; falling back to conservative dirty cleanup');
    return Number.POSITIVE_INFINITY;
  }

  clearTaskChangeAfterSuccessfulPush(projectId: string, taskId: string, batchChangeRevision: number): void {
    const tracker = this.changeTracker as unknown as {
      clearTaskChangeIfFresh?: (projectId: string, taskId: string, notNewerThanRevision: number) => boolean;
      clearTaskChange?: (projectId: string, taskId: string) => void;
    };

    if (typeof tracker.clearTaskChangeIfFresh === 'function') {
      tracker.clearTaskChangeIfFresh(projectId, taskId, batchChangeRevision);
      return;
    }

    tracker.clearTaskChange?.(projectId, taskId);
  }

  clearConnectionChangeAfterSuccessfulPush(projectId: string, connectionId: string, batchChangeRevision: number): void {
    const tracker = this.changeTracker as unknown as {
      clearConnectionChangeIfFresh?: (projectId: string, connectionId: string, notNewerThanRevision: number) => boolean;
    };

    tracker.clearConnectionChangeIfFresh?.(projectId, connectionId, batchChangeRevision);
  }

  createTaskConflictFingerprint(task: Task): string {
    return `${task.updatedAt ?? ''}|${task.deletedAt ?? ''}`;
  }

  createConnectionConflictFingerprint(connection: Connection): string {
    return `${connection.updatedAt ?? ''}|${connection.deletedAt ?? ''}`;
  }

  suppressTaskUntilFingerprintChanges(projectId: string, taskId: string, fingerprint: string): void {
    this.suppressEntityUntilFingerprintChanges(this.suppressedTaskIds, projectId, taskId, fingerprint);
  }

  suppressConnectionUntilFingerprintChanges(projectId: string, connectionId: string, fingerprint: string): void {
    this.suppressEntityUntilFingerprintChanges(this.suppressedConnectionIds, projectId, connectionId, fingerprint);
  }

  isTaskSuppressedUntilFreshEdit(projectId: string, taskId: string, changedTaskIds: Set<string>): boolean {
    return this.isEntitySuppressedUntilFreshEdit(this.suppressedTaskIds, projectId, taskId, changedTaskIds);
  }

  isConnectionSuppressedUntilFreshEdit(
    projectId: string,
    connectionId: string,
    changedConnectionIds: Set<string>,
  ): boolean {
    return this.isEntitySuppressedUntilFreshEdit(
      this.suppressedConnectionIds,
      projectId,
      connectionId,
      changedConnectionIds,
    );
  }

  reconcileSuppressedTasks(
    projectId: string,
    shouldKeepSuppressed: (entityId: string, fingerprint: string) => boolean,
  ): string[] {
    return this.reconcileSuppressedEntities(this.suppressedTaskIds, projectId, shouldKeepSuppressed);
  }

  reconcileSuppressedConnections(
    projectId: string,
    shouldKeepSuppressed: (entityId: string, fingerprint: string) => boolean,
  ): string[] {
    return this.reconcileSuppressedEntities(this.suppressedConnectionIds, projectId, shouldKeepSuppressed);
  }

  getTerminalTaskIds(projectId: string): string[] {
    return Array.from((this.suppressedTaskIds.get(projectId) ?? new Map<string, string>()).keys());
  }

  getTerminalConnectionIds(projectId: string): string[] {
    return Array.from((this.suppressedConnectionIds.get(projectId) ?? new Map<string, string>()).keys());
  }

  shouldClearDirtyMarkerAfterPermanentFailure(error: unknown): boolean {
    if (!isPermanentFailureError(error)) {
      return false;
    }

    const permanentError = error as {
      originalError?: { code?: unknown; errorType?: unknown; name?: unknown };
      context?: Record<string, unknown>;
    };
    const originalError = permanentError.originalError;
    const code = typeof originalError?.code === 'string' ? originalError.code : null;
    const errorType = typeof originalError?.errorType === 'string' ? originalError.errorType : null;
    const name = typeof originalError?.name === 'string' ? originalError.name : null;
    const operation = typeof permanentError.context?.['operation'] === 'string'
      ? permanentError.context['operation']
      : null;

    if (errorType === 'VersionConflictError' || name === 'VersionConflictError') {
      return true;
    }

    if (code?.endsWith('_REMOTE_NEWER') || code?.endsWith('_REMOTE_TOMBSTONE_NEWER')) {
      return true;
    }

    return operation === 'pushTaskTombstone' || operation === 'pushConnection.remoteTombstone';
  }

  private suppressEntityUntilFingerprintChanges(
    registry: Map<string, Map<string, string>>,
    projectId: string,
    entityId: string,
    fingerprint: string,
  ): void {
    const suppressedIds = registry.get(projectId) ?? new Map<string, string>();
    suppressedIds.set(entityId, fingerprint);
    registry.set(projectId, suppressedIds);
  }

  private isEntitySuppressedUntilFreshEdit(
    registry: Map<string, Map<string, string>>,
    projectId: string,
    entityId: string,
    changedEntityIds: Set<string>,
  ): boolean {
    const suppressedIds = registry.get(projectId);
    if (!suppressedIds?.has(entityId)) {
      return false;
    }

    if (changedEntityIds.has(entityId)) {
      suppressedIds.delete(entityId);
      if (suppressedIds.size === 0) {
        registry.delete(projectId);
      }
      return false;
    }

    return true;
  }

  private reconcileSuppressedEntities(
    registry: Map<string, Map<string, string>>,
    projectId: string,
    shouldKeepSuppressed: (entityId: string, fingerprint: string) => boolean,
  ): string[] {
    const suppressedIds = registry.get(projectId);
    if (!suppressedIds) {
      return [];
    }

    for (const [entityId, fingerprint] of Array.from(suppressedIds.entries())) {
      if (!shouldKeepSuppressed(entityId, fingerprint)) {
        suppressedIds.delete(entityId);
      }
    }

    if (suppressedIds.size === 0) {
      registry.delete(projectId);
      return [];
    }

    return Array.from(suppressedIds.keys());
  }
}
