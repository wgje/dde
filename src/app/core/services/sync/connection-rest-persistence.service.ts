import { Injectable } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Connection } from '../../../../models';
import { supabaseErrorToError, type EnhancedError } from '../../../../utils/supabase-error';
import type { EndpointConnectionMatch } from './connection-canonical-identity.service';

export type RemoteConnectionFreshness = Pick<EndpointConnectionMatch, 'id' | 'updated_at' | 'deleted_at'>;

export type RemoteNewerConflictFactory = (
  connectionId: string,
  projectId: string,
  remoteUpdatedAt: string | null,
  reason: 'remote-newer' | 'remote-tombstone',
) => EnhancedError;

@Injectable({ providedIn: 'root' })
export class ConnectionRestPersistenceService {
  async loadRemoteConnectionFreshness(
    client: SupabaseClient,
    connectionId: string,
    projectId: string,
  ): Promise<RemoteConnectionFreshness | null> {
    const { data, error } = await client
      .from('connections')
      .select('id,updated_at,deleted_at')
      .eq('id', connectionId)
      .eq('project_id', projectId)
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      return null;
    }

    const row = data as { id: string; updated_at?: string | null; deleted_at?: string | null };
    return {
      id: row.id,
      updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
      deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    };
  }

  async upsertConnectionReturningUpdatedAt(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
    remoteConnection: RemoteConnectionFreshness | null,
    createRemoteNewerConflictError: RemoteNewerConflictFactory,
  ): Promise<string | null> {
    if (remoteConnection?.updated_at) {
      return await this.updateConnectionReturningUpdatedAt(
        client,
        connection,
        projectId,
        remoteConnection.updated_at,
        createRemoteNewerConflictError,
      );
    }

    if (remoteConnection) {
      throw createRemoteNewerConflictError(
        connection.id,
        projectId,
        remoteConnection.deleted_at ?? null,
        'remote-newer',
      );
    }

    return await this.insertConnectionReturningUpdatedAt(
      client,
      connection,
      projectId,
      createRemoteNewerConflictError,
    );
  }

  private buildConnectionUpsertPayload(connection: Connection, projectId: string): {
    id: string;
    project_id: string;
    source_id: string;
    target_id: string;
    title: string | null;
    description: string | null;
    deleted_at: string | null;
  } {
    return {
      id: connection.id,
      project_id: projectId,
      source_id: connection.source,
      target_id: connection.target,
      title: connection.title || null,
      description: connection.description || null,
      deleted_at: connection.deletedAt || null,
    };
  }

  private async updateConnectionReturningUpdatedAt(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
    expectedRemoteUpdatedAt: string,
    createRemoteNewerConflictError: RemoteNewerConflictFactory,
  ): Promise<string | null> {
    const { data, error } = await client
      .from('connections')
      .update(this.buildConnectionUpsertPayload(connection, projectId))
      .eq('id', connection.id)
      .eq('project_id', projectId)
      .eq('updated_at', expectedRemoteUpdatedAt)
      .select('updated_at')
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      throw createRemoteNewerConflictError(
        connection.id,
        projectId,
        expectedRemoteUpdatedAt,
        'remote-newer',
      );
    }

    const updatedAt = (data as { updated_at?: string | null } | null)?.updated_at;
    return typeof updatedAt === 'string' ? updatedAt : null;
  }

  private async insertConnectionReturningUpdatedAt(
    client: SupabaseClient,
    connection: Connection,
    projectId: string,
    createRemoteNewerConflictError: RemoteNewerConflictFactory,
  ): Promise<string | null> {
    const { data, error } = await client
      .from('connections')
      .insert(this.buildConnectionUpsertPayload(connection, projectId))
      .select('updated_at')
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      throw createRemoteNewerConflictError(
        connection.id,
        projectId,
        connection.updatedAt ?? null,
        'remote-newer',
      );
    }

    const updatedAt = (data as { updated_at?: string | null } | null)?.updated_at;
    return typeof updatedAt === 'string' ? updatedAt : null;
  }
}
