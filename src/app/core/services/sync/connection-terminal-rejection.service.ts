import { Injectable, inject } from '@angular/core';

import type { Connection } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { ConnectionCanonicalIdentityService } from './connection-canonical-identity.service';

@Injectable({ providedIn: 'root' })
export class ConnectionTerminalRejectionService {
  private readonly logger = inject(LoggerService).category('ConnectionSyncOps');
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly canonicalIdentity = inject(ConnectionCanonicalIdentityService);

  discardInvalidConnectionLocally(
    connection: Connection,
    projectId: string,
    reason: string,
  ): void {
    const now = new Date().toISOString();
    const connectionId = connection.id;

    this.logger.info('connection 终态拒绝，就地软删避免 RetryQueue 循环', {
      connectionId,
      projectId,
      reason,
      source: connection.source,
      target: connection.target,
    });

    this.canonicalIdentity.updateProjectsFromCurrentData(projects => projects.map(project => {
      if (project.id !== projectId) return project;

      let changed = false;
      const connections = (project.connections || []).map(currentConnection => {
        if (currentConnection.id !== connectionId) return currentConnection;
        if (currentConnection.deletedAt) return currentConnection;
        changed = true;
        return { ...currentConnection, deletedAt: now, updatedAt: now };
      });

      return changed ? { ...project, connections } : project;
    }));

    this.sentryLazyLoader.captureMessage('connection_discarded_terminal_rejection', {
      level: 'info',
      tags: {
        operation: 'pushConnection',
        entityType: 'connection',
        reason,
      },
      extra: {
        connectionId,
        projectId,
        source: connection.source,
        target: connection.target,
      },
    });
  }
}
