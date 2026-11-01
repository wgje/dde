import type { Project } from '../models';
import type { Result, OperationError } from '../utils/result';
import type { TaskDeleteBaseUpdatedAtMap } from './action-queue.types';
import type { ConflictRecord, OperationConflictRecord } from './conflict-storage.helpers';

export type ProjectSessionContext = {
  ownerUserId: string | null;
  sessionGeneration: number;
  authFence?: string;
};

export type ProjectConflictSnapshot = {
  projectId?: string;
  conflictedAt?: string;
  local?: Project;
  remote?: Project;
  localProject?: Project;
  remoteProject?: Project;
  pendingTaskDeleteIds?: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  operationConflicts?: OperationConflictRecord[];
} | null;

export type ProjectConflictFingerprint = {
  projectId: string;
  ownerUserId: string | null;
  conflictedAt?: string;
  localVersion?: number;
  remoteVersion?: number;
  pendingTaskDeleteIds?: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  operationConflictFingerprints?: string[];
};

export type ConflictSaveFlowOutcome = 'continue-cleanup' | 'stop-success' | 'stop-failure';

export interface ResolveConflictInternalOptions {
  projectId: string;
  preservePendingTaskDeletes: boolean;
  requiresRemoteProject: boolean;
  finalizeAsRemote: boolean;
  backgroundPersist: boolean;
  filterPendingTaskDeletes?: (taskIds: string[]) => string[];
  runResolution: (localProject: Project, remoteProject: Project | undefined) => Promise<Result<Project, OperationError>>;
}

export interface ResolvedConflictSaveContext {
  projectId: string;
  userId: string;
  resolvedProject: Project;
  remoteProject: Project | undefined;
  pendingTaskDeleteIds: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  sessionContext: ProjectSessionContext;
  activeConflict: ProjectConflictSnapshot;
  conflictFingerprint?: ProjectConflictFingerprint;
  conflictRecord: ConflictRecord;
}

export interface ConflictResolutionContext {
  projectId: string;
  sessionContext: ProjectSessionContext;
  localProject: Project;
  remoteProject: Project | undefined;
  pendingTaskDeleteIds: string[];
  pendingTaskDeleteBaseUpdatedAtMap?: TaskDeleteBaseUpdatedAtMap;
  activeConflict: ProjectConflictSnapshot;
  conflictFingerprint?: ProjectConflictFingerprint;
  conflictRecord: ConflictRecord;
}
