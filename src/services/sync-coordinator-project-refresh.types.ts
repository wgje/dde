import type { Project } from '../models';
import type { LocalProjectRefreshState } from './sync-coordinator-signatures';

export interface DownloadMergeRemoteSnapshot {
  metas: Project[] | null;
  projects: Project[];
}

export interface DownloadMergeContext {
  userId: string;
  accessibleProjectIds: Set<string>;
  localProjects: Project[];
  localProjectsSignature: string;
  localProjectMap: Map<string, Project>;
  remoteProjects: Project[];
  remoteProjectMap: Map<string, Project>;
  missingRemoteProjectMetas: Project[];
  mergedProjects: Project[];
}

export interface RefreshActiveProjectContext {
  ownerId: string;
  projectId: string;
  localProject: Project | undefined;
  localState: LocalProjectRefreshState;
}

export type RefreshActiveProjectResult = {
  refreshed: boolean;
  skippedReason?: string;
  fastPathHit?: boolean;
};

export interface ActiveProjectWatermarkProbeResult {
  result?: RefreshActiveProjectResult;
  remoteWatermark: string | null;
}
