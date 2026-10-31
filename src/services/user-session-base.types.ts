import { FOCUS_CONFIG } from '../config/focus.config';
import { CACHE_CONFIG } from '../config/sync.config';
import type { Project } from '../models';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';

export type StartupProjectCatalogStage = 'unresolved' | 'partial' | 'resolved';

export interface SessionGuardContext {
  userId: string | null;
  generation: number;
}

export interface SetCurrentUserOptions {
  forceLoad?: boolean;
  skipPersistentReload?: boolean;
  previousUserIdHint?: string | null;
  preserveOfflineSnapshot?: boolean;
}

export interface SetCurrentUserContext {
  userId: string | null;
  previousUserId: string | null;
  isUserChange: boolean;
  forceLoad: boolean;
  skipPersistentReload: boolean;
  preserveOfflineSnapshot: boolean;
  shouldClearPrehydratedSnapshotState: boolean;
}

export interface OwnerChangePreparation {
  shouldPreserveGuestDrafts: boolean;
  shouldResetProjectSelection: boolean;
  shouldClearOfflineSnapshot: boolean;
}

export type StartupSnapshotResult = {
  source: 'idb' | 'localStorage' | 'none';
  projectCount: number;
  bytes: number;
  migratedLegacy: boolean;
  projects: Project[];
  ownerUserId?: string | null;
};

export const DOCK_SNAPSHOT_DB_NAME = 'keyval-store';

export const GUEST_DATA_STORAGE_KEY = 'nanoflow.guest-data';

export const FULL_WIPE_LOCAL_STORAGE_KEYS = [
  CACHE_CONFIG.OFFLINE_CACHE_KEY,
  'nanoflow.offline-cache',
  'nanoflow.retry-queue',
  LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY,
  LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY,
  'nanoflow.local-tombstones',
  'nanoflow.local-connection-tombstones',
  'nanoflow.auth-cache',
  'nanoflow.escape-pod',
  'nanoflow.safari-warning-time',
  GUEST_DATA_STORAGE_KEY,
  'nanoflow.launch-snapshot.v1',
  'nanoflow.launch-snapshot.v2',
] as const;

export const FULL_WIPE_INDEXED_DB_NAMES = [
  'nanoflow-db',
  'nanoflow-queue-backup',
  'nanoflow-retry-queue',
  'nanoflow-conflicts',
  'nanoflow-offline-snapshots',
  FOCUS_CONFIG.SYNC.IDB_NAME,
  DOCK_SNAPSHOT_DB_NAME,
  // Widget 直推 outbox：记录不带 owner，登出必须清空，否则下一个登录账号的
  // 连接恢复 flush 会用新 JWT 重放上一个账号的 focus/black-box 通知
  'nanoflow-dock-direct-widget-notify-outbox',
  'nanoflow-user-preferences-sync',
  'nanoflow-pending-preference-outbox',
  'nanoflow-attachment-upload-outbox',
  'nanoflow-attachment-cleanup-outbox',
] as const;

export const FULL_WIPE_LOCAL_STORAGE_PREFIXES = [
  'nanoflow.project-manifest-watermark',
  'nanoflow.blackbox-manifest-watermark',
  'nanoflow.idb-fallback.',
  // Widget 直推 outbox 的 localStorage 兜底记录（IDB 写失败时的降级存储）
  'nanoflow.dock-direct-widget-notify.',
  'nanoflow.userPreferencesBaseline.',
  'nanoflow.pendingPreferenceOutbox.',
  'nanoflow.attachment-upload-outbox.',
  'nanoflow.attachment-cleanup-outbox.',
];

export type ProjectHydrationLoadResult =
  | { status: 'loaded'; project: Project }
  | { status: 'inaccessible' }
  | { status: 'retry' }
  | { status: 'stale' };

export type ProjectListMetadataRow = {
  id: string;
  title: string | null;
  description: string | null;
  created_date: string | null;
  updated_at: string | null;
  version: number | null;
  owner_id: string | null;
};

export type ProjectListMetadataQueryResult =
  | { status: 'ok'; rows: ProjectListMetadataRow[] }
  | { status: 'deferred' };

export type ProjectListMetadataUpdateResult = {
  projects: Project[];
  hasChanges: boolean;
};

export type ProjectListMetadataPrimeManifestResult = {
  continueSync: boolean;
  pendingManifestWatermark: string | null;
};

export type BackgroundWatermarkProbeResult = {
  skipProjectSyncSlowPath: boolean;
  pendingProjectManifestWatermark: string | null;
};

export type BackgroundActiveProjectPreflightResult = {
  activeProjectId: string | null;
  accessPreflightConfirmed: boolean;
};

export type BackgroundCurrentProjectSyncResult = {
  activeProjectId: string | null;
  currentProjectSynced: boolean;
};

export type BackgroundActiveHydrationResult = BackgroundCurrentProjectSyncResult & {
  stale: boolean;
};

export type BackgroundSyncPipelineResult = BackgroundCurrentProjectSyncResult & {
  stale: boolean;
};

export type BackgroundSyncProbeStageResult = {
  activeProjectId: string | null;
  accessPreflightConfirmed: boolean;
  skipProjectSyncSlowPath: boolean;
  pendingProjectManifestWatermark: string | null;
  stale: boolean;
};

export type LocalProjectRestorePlan = {
  projects: Project[];
  usedSeed: boolean;
};
