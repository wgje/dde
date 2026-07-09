import type { SupabaseClient } from '@supabase/supabase-js';

import type { Project } from '../../../../models';
import type { ClockSyncService } from '../../../../services/clock-sync.service';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import {
  createProjectClockUncertainError,
  createProjectDirectConflictError,
} from './sync-project-errors';
import type {
  ProjectPushPayloads,
  ProjectPushPersistenceResult,
  RemoteProjectFreshness,
} from './project-push.types';

type ProjectPushDirectPersistenceOptions = {
  clockSync: Pick<ClockSyncService, 'compareTimestamps' | 'ensureSynced'>;
  normalizeLocalProjectUpdatedAt: (
    project: Project,
    serverUpdatedAt?: string | null,
  ) => void;
};

export class ProjectPushDirectPersistenceController {
  constructor(private readonly options: ProjectPushDirectPersistenceOptions) {}

  async pushProject(client: SupabaseClient, project: Project, userId: string): Promise<boolean> {
    const remoteProject = await this.loadRemoteProjectFreshness(client, project.id, userId);
    await this.assertRemoteProjectNotNewer(project, remoteProject);
    const result = await this.persistProjectDirect(client, project, userId, remoteProject);

    if (result.error) throw supabaseErrorToError(result.error);
    this.options.normalizeLocalProjectUpdatedAt(
      project,
      typeof result.data?.updated_at === 'string' ? result.data.updated_at : null,
    );
    return true;
  }

  private async loadRemoteProjectFreshness(
    client: SupabaseClient,
    projectId: string,
    userId: string,
  ): Promise<RemoteProjectFreshness | null> {
    const { data, error } = await client
      .from('projects')
      .select('id,updated_at,deleted_at')
      .eq('id', projectId)
      .eq('owner_id', userId)
      .maybeSingle();

    if (error) {
      throw supabaseErrorToError(error);
    }

    if (!data) {
      return null;
    }

    const row = data as { updated_at?: string | null; deleted_at?: string | null };
    return {
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
      deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    };
  }

  private async assertRemoteProjectNotNewer(
    project: Project,
    remoteProject: RemoteProjectFreshness | null,
  ): Promise<void> {
    const remoteHasTombstone = !!(remoteProject?.deletedAt && !project.deletedAt);
    if (remoteHasTombstone) {
      throw createProjectDirectConflictError(
        project.id,
        remoteProject?.updatedAt ?? remoteProject?.deletedAt ?? null,
        'remote-tombstone',
      );
    }

    if (await this.isRemoteProjectUpdatedAtNewer(project, remoteProject)) {
      throw createProjectDirectConflictError(project.id, remoteProject?.updatedAt ?? null, 'remote-newer');
    }
  }

  private async isRemoteProjectUpdatedAtNewer(
    project: Project,
    remoteProject: RemoteProjectFreshness | null,
  ): Promise<boolean> {
    const remoteUpdatedAt = remoteProject?.updatedAt ?? null;
    const localUpdatedAt = project.updatedAt ?? null;
    if (!remoteUpdatedAt || !localUpdatedAt) {
      return false;
    }

    const rawRemoteMs = new Date(remoteUpdatedAt).getTime();
    const rawLocalMs = new Date(localUpdatedAt).getTime();
    const timestampsDiffer = Number.isFinite(rawRemoteMs)
      && Number.isFinite(rawLocalMs)
      && rawLocalMs !== rawRemoteMs;
    const clockSyncResult = timestampsDiffer
      ? await this.options.clockSync.ensureSynced().catch(() => null)
      : null;

    if (timestampsDiffer && !clockSyncResult?.reliable) {
      throw createProjectClockUncertainError(project.id, localUpdatedAt, remoteUpdatedAt);
    }

    return clockSyncResult?.reliable
      ? this.options.clockSync.compareTimestamps(localUpdatedAt, remoteUpdatedAt) < 0
      : rawRemoteMs > rawLocalMs;
  }

  private buildProjectPushPayloads(project: Project, userId: string): ProjectPushPayloads {
    return {
      insert: {
        id: project.id,
        owner_id: userId,
        title: project.name,
        description: project.description,
        version: project.version || 1,
        migrated_to_v2: true,
        deleted_at: project.deletedAt ?? null,
      },
      update: {
        title: project.name,
        description: project.description,
        version: project.version || 1,
        migrated_to_v2: true,
        deleted_at: project.deletedAt ?? null,
      },
    };
  }

  private async persistProjectDirect(
    client: SupabaseClient,
    project: Project,
    userId: string,
    remoteProject: RemoteProjectFreshness | null,
  ): Promise<ProjectPushPersistenceResult> {
    const payloads = this.buildProjectPushPayloads(project, userId);

    if (remoteProject?.updatedAt) {
      const result = await client
        .from('projects')
        .update(payloads.update)
        .eq('id', project.id)
        .eq('owner_id', userId)
        .eq('updated_at', remoteProject.updatedAt)
        .select('updated_at')
        .maybeSingle();

      if (!result.error && !result.data) {
        throw createProjectDirectConflictError(
          project.id,
          remoteProject.updatedAt,
          'remote-newer',
        );
      }
      return result as ProjectPushPersistenceResult;
    } else if (remoteProject) {
      throw createProjectDirectConflictError(
        project.id,
        remoteProject.updatedAt ?? remoteProject.deletedAt ?? null,
        'remote-newer',
      );
    }

    const result = await client
      .from('projects')
      .insert(payloads.insert)
      .select('updated_at')
      .maybeSingle();

    const code = (result.error as { code?: string | number } | null)?.code;
    if (result.error && (code === '23505' || code === 23505)) {
      throw createProjectDirectConflictError(project.id, project.updatedAt ?? null, 'remote-newer');
    }

    if (!result.error && !result.data) {
      throw createProjectDirectConflictError(project.id, project.updatedAt ?? null, 'remote-newer');
    }

    return result as ProjectPushPersistenceResult;
  }
}
