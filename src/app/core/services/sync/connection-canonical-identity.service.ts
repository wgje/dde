import { Injectable, inject } from '@angular/core';

import { Connection, Project } from '../../../../models';
import { ProjectStateService } from '../../../../services/project-state.service';
import { getConnectionFreshnessTimestamp } from './connection-sync-freshness.helpers';

export interface EndpointConnectionMatch {
  id: string;
  deleted_at: string | null;
  updated_at?: string | null;
  title?: string | null;
  description?: string | null;
}

type ConnectionIdentityRebindResult = {
  connection: Connection | null;
  previousFound: boolean;
};

@Injectable({ providedIn: 'root' })
export class ConnectionCanonicalIdentityService {
  private readonly projectState = inject(ProjectStateService);

  updateProjectsFromCurrentData(mutator: (projects: Project[]) => Project[]): void {
    const projectState = this.projectState as ProjectStateService & {
      getProjectsWithCurrentData?: () => Project[];
      setProjects?: (projects: Project[]) => void;
    };

    if (typeof projectState.getProjectsWithCurrentData === 'function' && typeof projectState.setProjects === 'function') {
      projectState.setProjects(mutator(projectState.getProjectsWithCurrentData()));
      return;
    }

    this.projectState.updateProjects(mutator);
  }

  normalizeLocalConnectionUpdatedAt(
    projectId: string,
    connection: Connection,
    serverUpdatedAt?: string | null,
  ): void {
    if (!serverUpdatedAt) {
      return;
    }

    connection.updatedAt = serverUpdatedAt;
    const connectionId = connection.id;

    this.updateProjectsFromCurrentData(projects => projects.map(project => {
      if (project.id !== projectId) {
        return project;
      }

      let changed = false;
      const connections = (project.connections || []).map(connection => {
        if (connection.id !== connectionId || connection.updatedAt === serverUpdatedAt) {
          return connection;
        }

        changed = true;
        return {
          ...connection,
          updatedAt: serverUpdatedAt,
        };
      });

      return changed
        ? {
            ...project,
            connections,
          }
        : project;
    }));
  }

  applyCanonicalConnectionIdentity(
    projectId: string,
    connection: Connection,
    canonicalMatch: EndpointConnectionMatch,
  ): void {
    if (!canonicalMatch.id || canonicalMatch.id === connection.id) {
      return;
    }

    const previousConnectionId = connection.id;
    const reboundResult = this.rebindLocalConnectionIdentity(projectId, previousConnectionId, canonicalMatch.id);
    connection.id = canonicalMatch.id;
    if (reboundResult.connection) {
      connection.source = reboundResult.connection.source;
      connection.target = reboundResult.connection.target;

      if (this.isCanonicalMatchAtLeastAsFresh(canonicalMatch, reboundResult.connection)) {
        this.hydrateConnectionFromCanonicalMatch(connection, canonicalMatch, reboundResult.connection);
        this.applyCanonicalConnectionPatchToLocalStore(projectId, canonicalMatch.id, canonicalMatch);
        return;
      }

      this.applyReboundConnectionState(connection, reboundResult.connection);
      return;
    }

    if (this.isCanonicalMatchAtLeastAsFresh(canonicalMatch, connection)) {
      this.hydrateConnectionFromCanonicalMatch(connection, canonicalMatch);
      this.applyCanonicalConnectionPatchToLocalStore(projectId, canonicalMatch.id, canonicalMatch);
    }
  }

  applyCanonicalConnectionState(
    projectId: string,
    connection: Connection,
    canonicalMatch: EndpointConnectionMatch,
  ): void {
    this.hydrateConnectionFromCanonicalMatch(connection, canonicalMatch);
    this.applyCanonicalConnectionPatchToLocalStore(projectId, canonicalMatch.id, canonicalMatch);
  }

  isCanonicalMatchAtLeastAsFresh(
    canonicalMatch: EndpointConnectionMatch,
    localConnection: Connection,
  ): boolean {
    const localFreshness = getConnectionFreshnessTimestamp(
      localConnection.updatedAt,
      localConnection.deletedAt,
    );
    const canonicalFreshness = getConnectionFreshnessTimestamp(
      canonicalMatch.updated_at,
      canonicalMatch.deleted_at,
    );

    return canonicalFreshness >= localFreshness && canonicalFreshness > 0;
  }

  applyCanonicalConnectionPatchToLocalStore(
    projectId: string,
    connectionId: string,
    canonicalMatch: EndpointConnectionMatch,
  ): void {
    this.updateProjectsFromCurrentData(projects => projects.map(project => {
      if (project.id !== projectId) {
        return project;
      }

      let changed = false;
      const connections = (project.connections || []).map(connection => {
        if (connection.id !== connectionId) {
          return connection;
        }

        changed = true;
        return {
          ...connection,
          title: Object.prototype.hasOwnProperty.call(canonicalMatch, 'title')
            ? canonicalMatch.title ?? undefined
            : connection.title,
          description: Object.prototype.hasOwnProperty.call(canonicalMatch, 'description')
            ? canonicalMatch.description ?? undefined
            : connection.description,
          deletedAt: canonicalMatch.deleted_at ?? undefined,
          updatedAt: canonicalMatch.updated_at ?? connection.updatedAt,
        };
      });

      return changed
        ? {
            ...project,
            connections,
          }
        : project;
    }));
  }

  private rebindLocalConnectionIdentity(
    projectId: string,
    previousId: string,
    nextId: string,
  ): ConnectionIdentityRebindResult {
    if (!previousId || !nextId || previousId === nextId) {
      return { connection: null, previousFound: false };
    }

    let reboundConnection: Connection | null = null;
    let previousFound = false;

    this.updateProjectsFromCurrentData(projects => projects.map(project => {
      const result = this.rebindProjectConnectionIdentity(project, projectId, previousId, nextId);
      if (!result.touched) {
        return project;
      }

      reboundConnection = result.connection;
      previousFound = result.previousFound;
      return result.project;
    }));

    return {
      connection: reboundConnection,
      previousFound,
    };
  }

  private rebindProjectConnectionIdentity(
    project: Project,
    projectId: string,
    previousId: string,
    nextId: string,
  ): {
    touched: boolean;
    project: Project;
    connection: Connection | null;
    previousFound: boolean;
  } {
    if (project.id !== projectId) {
      return { touched: false, project, connection: null, previousFound: false };
    }

    const previousConnection = (project.connections || []).find(connection => connection.id === previousId);
    const nextConnection = (project.connections || []).find(connection => connection.id === nextId);
    if (!previousConnection) {
      return { touched: true, project, connection: nextConnection ?? null, previousFound: false };
    }

    const mergedConnection = this.mergeReboundConnection(previousConnection, nextConnection, nextId);
    const connections = (project.connections || []).filter(connection => (
      connection.id !== previousId && connection.id !== nextId
    ));
    connections.push(mergedConnection);

    return {
      touched: true,
      project: {
        ...project,
        connections,
      },
      connection: mergedConnection,
      previousFound: true,
    };
  }

  private mergeReboundConnection(
    previousConnection: Connection,
    nextConnection: Connection | undefined,
    nextId: string,
  ): Connection {
    if (!nextConnection) {
      return {
        ...previousConnection,
        id: nextId,
      };
    }

    const previousFreshness = getConnectionFreshnessTimestamp(
      previousConnection.updatedAt,
      previousConnection.deletedAt,
    );
    const nextFreshness = getConnectionFreshnessTimestamp(
      nextConnection.updatedAt,
      nextConnection.deletedAt,
    );
    const preferredLocalConnection = nextFreshness >= previousFreshness
      ? nextConnection
      : previousConnection;
    const fallbackLocalConnection = preferredLocalConnection === previousConnection
      ? nextConnection
      : previousConnection;

    return {
      ...nextConnection,
      ...previousConnection,
      id: nextId,
      source: previousConnection.source,
      target: previousConnection.target,
      title: preferredLocalConnection.title ?? fallbackLocalConnection.title,
      description: preferredLocalConnection.description ?? fallbackLocalConnection.description,
      deletedAt: preferredLocalConnection.deletedAt,
      updatedAt: preferredLocalConnection.updatedAt ?? fallbackLocalConnection.updatedAt,
    };
  }

  private hydrateConnectionFromCanonicalMatch(
    connection: Connection,
    canonicalMatch: EndpointConnectionMatch,
    fallbackConnection?: Connection | null,
  ): void {
    connection.title = Object.prototype.hasOwnProperty.call(canonicalMatch, 'title')
      ? canonicalMatch.title ?? undefined
      : fallbackConnection?.title ?? connection.title;
    connection.description = Object.prototype.hasOwnProperty.call(canonicalMatch, 'description')
      ? canonicalMatch.description ?? undefined
      : fallbackConnection?.description ?? connection.description;
    connection.deletedAt = canonicalMatch.deleted_at ?? undefined;
    connection.updatedAt = canonicalMatch.updated_at ?? fallbackConnection?.updatedAt ?? connection.updatedAt;
  }

  private applyReboundConnectionState(connection: Connection, reboundConnection: Connection): void {
    connection.title = reboundConnection.title;
    connection.description = reboundConnection.description;
    connection.deletedAt = reboundConnection.deletedAt;
    connection.updatedAt = reboundConnection.updatedAt;
  }
}
