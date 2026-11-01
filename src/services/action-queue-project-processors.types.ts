import type { Project } from '../models';
import type { ProjectPayload } from './action-queue.types';

export type ProjectMutationActionType = 'project:create' | 'project:update';
export type ProjectMutationKind = 'create' | 'update';
export type ProjectMutationStaleness = 'current' | 'queue-view-stale' | 'project-view-stale';

export type ProjectMutationContext = {
  actionType: ProjectMutationActionType;
  ownerUserId: string;
  projectId: string;
  queueViewGeneration: number;
  projectMutationViewGeneration: number;
  sessionGeneration: number;
  authFence: string;
};

export type ProjectConflictHandler = (
  localProject: Project,
  remoteProject: Project,
  ownerUserId?: string | null,
  taskIdsToDelete?: string[],
  taskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'],
) => void;
