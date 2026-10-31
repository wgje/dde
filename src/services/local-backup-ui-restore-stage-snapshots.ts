import type { Project } from '../models';
import type {
  ExternalSourceLink,
  PendingExternalSourceLink,
} from '../app/core/external-sources/external-source.model';
import type { BackupPendingAttachmentUpload } from '../../supabase/functions/_shared/backup-utils';
import type { DataSafetyConflictRestoreSnapshot } from './data-safety-conflict-restore.helpers';
import type { DataSafetyOfflineSnapshotRestoreSnapshot } from './data-safety-offline-snapshot-restore.helpers';
import type { DataSafetyMetadataRestoreState } from './import-backup-data-safety-metadata.helpers';
import type { DeadLetterBackupRecord, QueueBackupRecord } from './queue-backup.service';
import type {
  LocalBackupUiRestoreMarker,
  LocalBackupUiRestoreStage,
} from './local-backup-ui-restore-types';
import { createSyncOperationId, isSyncOperationId } from '../utils/sync-operation-id';
import { isValidUUID } from '../utils/validation';
import {
  normalizeDockSnapshotRestoreSnapshot,
  normalizeLaunchSnapshotRestoreSnapshot,
  normalizeParkedTaskCacheRestoreSnapshot,
  type DockSnapshotRestoreSnapshot,
  type LaunchSnapshotRestoreSnapshot,
  type ParkedTaskCacheRestoreSnapshot,
} from './data-safety-indexeddb-local-state';

type UnknownRecord = Record<string, unknown>;

export interface LocalBackupUiRestoreProjectPreImageEntry {
  projectId: string;
  existed: boolean;
  project: Project | null;
}

export interface LocalBackupUiRestoreProjectPreImage {
  schemaVersion: 1;
  projects: LocalBackupUiRestoreProjectPreImageEntry[];
  externalSourceLinks: ExternalSourceLink[];
  externalSourcePendingLinks: PendingExternalSourceLink[];
  offlineSnapshot: DataSafetyOfflineSnapshotRestoreSnapshot;
  dockSnapshot: DockSnapshotRestoreSnapshot;
  launchSnapshot: LaunchSnapshotRestoreSnapshot;
  parkedTaskCache: ParkedTaskCacheRestoreSnapshot;
}

export interface LocalBackupUiRestoreActionQueuePreImage {
  indexedDb: QueueBackupRecord | null;
  localStorage: string | null;
}

export interface LocalBackupUiRestoreRetryQueuePreImage {
  schemaVersion: 2;
  indexedDb: UnknownRecord[] | null;
  localStorage: string | null;
  restoredItems: UnknownRecord[];
}

export interface LocalBackupUiRestoreRetryQueueFootprintPolicy {
  now: number;
  maxItemAgeMs: number;
  maxRetries: number;
}

export interface LocalBackupUiRestoreDeadLetterPreImage {
  indexedDb: DeadLetterBackupRecord | null;
  localStorage: string | null;
}

export type LocalBackupUiRestoreAttachmentOutboxItem = BackupPendingAttachmentUpload & {
  ownerUserId: string;
  operationId: string;
};

export interface LocalBackupUiRestoreStageSnapshots {
  projects: LocalBackupUiRestoreProjectPreImage;
  attachmentOutbox: LocalBackupUiRestoreAttachmentOutboxItem[];
  actionQueue: LocalBackupUiRestoreActionQueuePreImage;
  retryQueue: LocalBackupUiRestoreRetryQueuePreImage;
  deadLetters: LocalBackupUiRestoreDeadLetterPreImage;
  conflicts: DataSafetyConflictRestoreSnapshot;
  metadata: DataSafetyMetadataRestoreState;
}

export function snapshotForLocalBackupUiRestoreStage(
  snapshots: LocalBackupUiRestoreStageSnapshots,
  stage: LocalBackupUiRestoreStage,
): unknown {
  switch (stage) {
    case 'projects': return normalizeProjectSnapshot(snapshots.projects);
    case 'attachment-outbox': return snapshots.attachmentOutbox;
    case 'action-queue': return snapshots.actionQueue;
    case 'retry-queue': return snapshots.retryQueue;
    case 'dead-letters': return snapshots.deadLetters;
    case 'conflicts': return snapshots.conflicts;
    case 'metadata': return snapshots.metadata;
  }
}

export function upsertLocalBackupUiRestoreProjects(
  current: Project[],
  restored: Project[],
): Project[] {
  const next = new Map(current.map(project => [project.id, project]));
  for (const project of restored) next.set(project.id, project);
  return Array.from(next.values());
}

export function restoreTouchedProjects(
  current: Project[],
  snapshot: LocalBackupUiRestoreProjectPreImage,
): Project[] {
  const touchedIds = new Set(snapshot.projects.map(entry => entry.projectId));
  const next = current.filter(project => !touchedIds.has(project.id));
  for (const entry of snapshot.projects) {
    if (entry.existed && entry.project) next.push(entry.project);
  }
  return next;
}

export function mergeExternalSourceLinks(
  current: ExternalSourceLink[],
  restored: ExternalSourceLink[],
): ExternalSourceLink[] {
  const next = new Map(current.map(link => [link.id, link]));
  for (const link of restored) next.set(link.id, link);
  return sortLocalBackupUiRestoreExternalLinks(Array.from(next.values()));
}

export function mergePendingLinks(
  current: PendingExternalSourceLink[],
  restored: ExternalSourceLink[],
): PendingExternalSourceLink[] {
  const next = new Map(current.map(entry => [entry.link.id, entry]));
  const now = Date.now();
  for (const link of restored) {
    const previous = next.get(link.id);
    next.set(link.id, {
      link,
      operationId: previous?.operationId ?? createSyncOperationId(),
      localCommittedAt: previous?.localCommittedAt ?? now,
      syncState: 'pending_sync',
      retryCount: previous?.retryCount ?? 0,
      lastTriedAt: previous?.lastTriedAt,
      lastErrorCode: previous?.lastErrorCode,
    });
  }
  return sortLocalBackupUiRestorePendingLinks(Array.from(next.values()));
}

export function sortLocalBackupUiRestoreExternalLinks(
  links: ExternalSourceLink[],
): ExternalSourceLink[] {
  return [...links].sort((left, right) => left.id.localeCompare(right.id));
}

export function sortLocalBackupUiRestorePendingLinks(
  links: PendingExternalSourceLink[],
): PendingExternalSourceLink[] {
  return [...links].sort((left, right) => left.link.id.localeCompare(right.link.id));
}

export function sortLocalBackupUiRestoreAttachmentUploads(
  left: LocalBackupUiRestoreStageSnapshots['attachmentOutbox'][number],
  right: LocalBackupUiRestoreStageSnapshots['attachmentOutbox'][number],
): number {
  return left.blobKey.localeCompare(right.blobKey)
    || String(left.operationId).localeCompare(String(right.operationId));
}

export function serializeLocalBackupUiRestoreStageSnapshot(
  stage: LocalBackupUiRestoreStage,
  value: unknown,
): string {
  return JSON.stringify(sortObjectKeys(
    stage === 'retry-queue'
      ? normalizeRetryQueueStageSnapshot(value)
      : value,
  ));
}

function normalizeProjectSnapshot(
  snapshot: LocalBackupUiRestoreProjectPreImage,
): LocalBackupUiRestoreProjectPreImage {
  return {
    ...snapshot,
    externalSourceLinks: sortLocalBackupUiRestoreExternalLinks(snapshot.externalSourceLinks),
    externalSourcePendingLinks: sortLocalBackupUiRestorePendingLinks(
      snapshot.externalSourcePendingLinks,
    ),
    parkedTaskCache: {
      ...snapshot.parkedTaskCache,
      entries: [...snapshot.parkedTaskCache.entries].sort((left, right) => (
        String(left.taskId).localeCompare(String(right.taskId))
      )),
      syncMetadata: Object.fromEntries(
        Object.entries(snapshot.parkedTaskCache.syncMetadata).sort(([left], [right]) => (
          left.localeCompare(right)
        )),
      ),
    },
  };
}

function normalizeRetryQueueStageSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  return {
    schemaVersion: snapshot['schemaVersion'],
    indexedDb: snapshot['indexedDb'],
    localStorageItems: readRetryQueueComparableLocalStorageItems(snapshot['localStorage']),
    restoredItems: snapshot['restoredItems'],
  };
}

function readRetryQueueComparableLocalStorageItems(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return value;
    const record = parsed as Record<string, unknown>;
    return record['version'] === 1 && Array.isArray(record['items'])
      ? record['items']
      : value;
  } catch {
    return value;
  }
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortObjectKeys(entry)]),
  );
}

export function decodeLocalBackupUiRestoreStageSnapshots(
  marker: LocalBackupUiRestoreMarker,
): LocalBackupUiRestoreStageSnapshots {
  const ownerUserId = marker.ownerUserId;
  return {
    projects: decodeProjectState(marker.preImage.projectState, marker.touchedProjectIds, ownerUserId),
    attachmentOutbox: decodeAttachmentOutbox(marker.preImage.attachmentOutbox, ownerUserId),
    actionQueue: decodeActionQueue(marker.preImage.actionQueue, ownerUserId),
    retryQueue: decodeRetryQueue(marker.preImage.retryQueue, ownerUserId),
    deadLetters: decodeDeadLetters(marker.preImage.deadLetters, ownerUserId),
    conflicts: decodeConflicts(marker.preImage.conflicts),
    metadata: decodeMetadata(marker.preImage.metadata, ownerUserId),
  };
}

function decodeProjectState(
  value: unknown,
  touchedProjectIds: readonly string[],
  ownerUserId: string,
): LocalBackupUiRestoreProjectPreImage {
  const record = requireRecord(value, 'projectState');
  const dockSnapshot = normalizeDockSnapshotRestoreSnapshot(record['dockSnapshot']);
  const launchSnapshot = normalizeLaunchSnapshotRestoreSnapshot(
    record['launchSnapshot'],
    ownerUserId,
  );
  const parkedTaskCache = normalizeParkedTaskCacheRestoreSnapshot(
    record['parkedTaskCache'],
    ownerUserId,
  );
  if (record['schemaVersion'] !== 1 || !Array.isArray(record['projects'])
    || !Array.isArray(record['externalSourceLinks'])
    || !Array.isArray(record['externalSourcePendingLinks'])
    || !isOfflineSnapshot(record['offlineSnapshot'], ownerUserId)
    || !dockSnapshot
    || !launchSnapshot
    || !parkedTaskCache) {
    throw invalidSlot('projectState');
  }
  const projects = record['projects'].map(decodeProjectEntry);
  const projectIds = projects.map(entry => entry.projectId);
  if (!sameStrings(projectIds, touchedProjectIds)
    || !record['externalSourceLinks'].every(isExternalSourceLink)
    || !record['externalSourcePendingLinks'].every(isPendingExternalSourceLink)) {
    throw invalidSlot('projectState');
  }
  return {
    schemaVersion: 1,
    projects,
    externalSourceLinks: record['externalSourceLinks'],
    externalSourcePendingLinks: record['externalSourcePendingLinks'],
    offlineSnapshot: record['offlineSnapshot'],
    dockSnapshot,
    launchSnapshot,
    parkedTaskCache,
  };
}

function decodeProjectEntry(value: unknown): LocalBackupUiRestoreProjectPreImageEntry {
  const record = requireRecord(value, 'projectState');
  const projectId = record['projectId'];
  const existed = record['existed'];
  const project = record['project'];
  if (!isNonEmptyString(projectId) || typeof existed !== 'boolean'
    || (existed ? !isProject(project, projectId) : project !== null)) {
    throw invalidSlot('projectState');
  }
  return { projectId, existed, project: project as Project | null };
}

function decodeAttachmentOutbox(
  value: unknown,
  ownerUserId: string,
): LocalBackupUiRestoreAttachmentOutboxItem[] {
  if (!Array.isArray(value) || !value.every(upload => (
    isBackupAttachmentUpload(upload) && upload.ownerUserId === ownerUserId
  ))) {
    throw invalidSlot('attachmentOutbox');
  }
  return value;
}

function decodeActionQueue(value: unknown, ownerUserId: string): LocalBackupUiRestoreActionQueuePreImage {
  const record = requireRecord(value, 'actionQueue');
  const indexedDb = record['indexedDb'];
  if (!isNullableString(record['localStorage'])
    || (indexedDb !== null && !isQueueBackupRecord(indexedDb, ownerUserId))) {
    throw invalidSlot('actionQueue');
  }
  return { indexedDb, localStorage: record['localStorage'] };
}

function decodeRetryQueue(
  value: unknown,
  ownerUserId: string,
): LocalBackupUiRestoreRetryQueuePreImage {
  const record = requireRecord(value, 'retryQueue');
  const indexedDb = record['indexedDb'];
  const restoredItems = record['restoredItems'];
  if (record['schemaVersion'] !== 2
    || !isNullableString(record['localStorage'])
    || !Array.isArray(restoredItems)
    || !isValidRetryQueueRestoreItems(restoredItems, ownerUserId)
    || (indexedDb !== null && (!Array.isArray(indexedDb) || !indexedDb.every(isRecord)))) {
    throw invalidSlot('retryQueue');
  }
  return {
    schemaVersion: 2,
    indexedDb,
    localStorage: record['localStorage'],
    restoredItems: restoredItems.map(item => ({
      ...item,
      data: { ...(item['data'] as UnknownRecord) },
    })),
  };
}

export function normalizeLocalBackupUiRestoreRetryQueueFootprint(
  value: unknown,
  ownerUserId: string,
  policy: LocalBackupUiRestoreRetryQueueFootprintPolicy,
): UnknownRecord[] {
  if (!Array.isArray(value)
    || !isValidRetryQueueRestoreItems(value, ownerUserId)
    || !isRetryQueueFootprintPolicy(policy)
    || value.some(item => (
      policy.now - (item['createdAt'] as number) >= policy.maxItemAgeMs
      || (item['retryCount'] as number) >= policy.maxRetries
    ))) {
    throw invalidSlot('retryQueue');
  }
  return value.map(item => ({
    ...item,
    data: { ...(item['data'] as UnknownRecord) },
  }));
}

export function deriveLocalBackupUiRestoreRetryQueueRestoredItems(
  preImage: LocalBackupUiRestoreRetryQueuePreImage,
  current: Pick<LocalBackupUiRestoreRetryQueuePreImage, 'indexedDb' | 'localStorage'>,
  ownerUserId: string,
): UnknownRecord[] {
  const plannedItems = preImage.restoredItems;
  if (!isValidRetryQueueRestoreItems(plannedItems, ownerUserId)) {
    throw invalidSlot('retryQueue');
  }
  const preImageItems = readRetryQueueSnapshotItems(preImage.indexedDb, preImage.localStorage);
  const currentItems = readRetryQueueSnapshotItems(current.indexedDb, current.localStorage);
  return plannedItems
    .filter(plannedItem => (
      !preImageItems.some(preImageItem => retryQueueIdentitiesConflict(preImageItem, plannedItem))
      && currentItems.some(currentItem => sameRetryQueueItem(currentItem, plannedItem))
    ))
    .map(item => ({
      ...item,
      data: { ...(item['data'] as UnknownRecord) },
    }));
}

/**
 * Projects the RetryQueue merge without consulting the post-write storage.
 * The stage verifier uses this projection so a stable stale read cannot be
 * mistaken for a successful restore.
 */
export function projectLocalBackupUiRestoreRetryQueueItems(
  preImage: LocalBackupUiRestoreRetryQueuePreImage,
  restoredItems: readonly UnknownRecord[],
  ownerUserId: string,
): UnknownRecord[] {
  if (!isValidRetryQueueRestoreItems(preImage.restoredItems, ownerUserId)
    || !isValidRetryQueueRestoreItems(restoredItems, ownerUserId)) {
    throw invalidSlot('retryQueue');
  }

  const currentItems = readRetryQueueSnapshotItems(preImage.indexedDb, preImage.localStorage);
  const mergedItems: UnknownRecord[] = currentItems.map(item => cloneRetryQueueItem(item));
  const currentIdentities = new Set(currentItems.map(item => retryQueueRestoreIdentity(item)));
  const currentEntityKeys = new Set(currentItems.map(item => retryQueueEntityKey(item)));
  const restoredEntityIndexes = new Map<string, number>();

  for (const restoredItem of restoredItems) {
    const identity = retryQueueRestoreIdentity(restoredItem);
    if (currentIdentities.has(identity)) continue;

    const entityKey = retryQueueEntityKey(restoredItem);
    if (currentEntityKeys.has(entityKey)) continue;

    const existingRestoredIndex = restoredEntityIndexes.get(entityKey);
    if (existingRestoredIndex !== undefined) {
      const existing = mergedItems[existingRestoredIndex];
      if (existing && Number(restoredItem['createdAt']) >= Number(existing['createdAt'])) {
        mergedItems[existingRestoredIndex] = cloneRetryQueueItem(restoredItem);
      }
      continue;
    }

    restoredEntityIndexes.set(entityKey, mergedItems.length);
    currentIdentities.add(identity);
    mergedItems.push(cloneRetryQueueItem(restoredItem));
  }

  return mergedItems;
}

function decodeDeadLetters(value: unknown, ownerUserId: string): LocalBackupUiRestoreDeadLetterPreImage {
  const record = requireRecord(value, 'deadLetters');
  const indexedDb = record['indexedDb'];
  if (!isNullableString(record['localStorage'])
    || (indexedDb !== null && !isDeadLetterBackupRecord(indexedDb, ownerUserId))) {
    throw invalidSlot('deadLetters');
  }
  return { indexedDb, localStorage: record['localStorage'] };
}

function decodeConflicts(value: unknown): DataSafetyConflictRestoreSnapshot {
  const record = requireRecord(value, 'conflicts');
  const indexedDbRecords = record['indexedDbRecords'];
  const fallbackEntries = record['fallbackLocalStorageEntries'];
  if ((indexedDbRecords !== null
    && (!Array.isArray(indexedDbRecords) || !indexedDbRecords.every(isRecord)))
    || !isStringRecord(fallbackEntries)) {
    throw invalidSlot('conflicts');
  }
  return { indexedDbRecords, fallbackLocalStorageEntries: fallbackEntries } as DataSafetyConflictRestoreSnapshot;
}

function decodeMetadata(value: unknown, ownerUserId: string): DataSafetyMetadataRestoreState {
  const record = requireRecord(value, 'metadata');
  const projectCursors = record['projectCursors'];
  const replayLog = record['replayLog'];
  const connectionTombstones = record['connectionTombstones'];
  if (!Array.isArray(projectCursors) || !projectCursors.every(cursor => isProjectCursor(cursor, ownerUserId))
    || !isNullableString(record['lastSyncTime'])
    || !Array.isArray(replayLog) || !replayLog.every(isRecord)
    || (record['lastWriteExplain'] !== null && !isRecord(record['lastWriteExplain']))
    || !isRecord(record['taskTombstones'])
    || !Array.isArray(connectionTombstones) || !connectionTombstones.every(isRecord)) {
    throw invalidSlot('metadata');
  }
  return record as unknown as DataSafetyMetadataRestoreState;
}

function isProject(value: unknown, projectId: string): value is Project {
  if (!isRecord(value) || value['id'] !== projectId || !isNonEmptyString(value['name'])
    || !Array.isArray(value['tasks']) || !Array.isArray(value['connections'])) return false;
  return value['tasks'].every(task => (
    isRecord(task) && isNonEmptyString(task['id']) && typeof task['content'] === 'string'
  )) && value['connections'].every(isRecord);
}

function isBackupAttachmentUpload(
  value: unknown,
): value is LocalBackupUiRestoreAttachmentOutboxItem {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value['ownerUserId'])
    && isNonEmptyString(value['operationId'])
    && isNonEmptyString(value['attachmentId'])
    && isNonEmptyString(value['blobKey'])
    && isNonEmptyString(value['fileName'])
    && typeof value['mimeType'] === 'string'
    && typeof value['size'] === 'number' && Number.isFinite(value['size'])
    && isNonEmptyString(value['createdAt'])
    && value['encoding'] === 'base64'
    && typeof value['blobBase64'] === 'string';
}

function isRetryQueueRestoreItem(value: unknown, ownerUserId: string): value is UnknownRecord {
  if (!isRecord(value) || !isRecord(value['data'])) return false;
  return typeof value['id'] === 'string'
    && isValidUUID(value['id'])
    && isSyncOperationId(value['operationId'])
    && (value['type'] === 'task'
      || value['type'] === 'project'
      || value['type'] === 'connection'
      || value['type'] === 'blackbox')
    && (value['operation'] === 'upsert' || value['operation'] === 'delete')
    && typeof value['data']['id'] === 'string'
    && isValidUUID(value['data']['id'])
    && value['sourceUserId'] === ownerUserId
    && Number.isInteger(value['retryCount'])
    && (value['retryCount'] as number) >= 0
    && typeof value['createdAt'] === 'number'
    && Number.isFinite(value['createdAt']);
}

function isValidRetryQueueRestoreItems(
  value: readonly unknown[],
  ownerUserId: string,
): value is UnknownRecord[] {
  if (!value.every(item => isRetryQueueRestoreItem(item, ownerUserId))) return false;
  const ids = new Set<string>();
  const operationIds = new Set<string>();
  const effectiveIdentities = new Set<string>();
  for (const item of value) {
    const id = canonicalUuidIdentity(item['id']);
    const operationId = canonicalUuidIdentity(item['operationId']);
    const effectiveIdentity = retryQueueEffectiveIdentity(item);
    if (ids.has(id)
      || operationIds.has(operationId)
      || effectiveIdentities.has(effectiveIdentity)) {
      return false;
    }
    ids.add(id);
    operationIds.add(operationId);
    effectiveIdentities.add(effectiveIdentity);
  }
  return true;
}

function isRetryQueueFootprintPolicy(
  policy: LocalBackupUiRestoreRetryQueueFootprintPolicy,
): boolean {
  return Number.isFinite(policy.now)
    && Number.isFinite(policy.maxItemAgeMs)
    && policy.maxItemAgeMs > 0
    && Number.isInteger(policy.maxRetries)
    && policy.maxRetries > 0;
}

function readRetryQueueSnapshotItems(
  indexedDb: UnknownRecord[] | null,
  localStorageValue: string | null,
): UnknownRecord[] {
  const items = [...(indexedDb ?? [])];
  if (localStorageValue === null) return items;
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorageValue);
  } catch {
    throw invalidSlot('retryQueue');
  }
  if (!isRecord(parsed)
    || parsed['version'] !== 1
    || !Array.isArray(parsed['items'])
    || !parsed['items'].every(isRecord)) {
    throw invalidSlot('retryQueue');
  }
  return items.concat(parsed['items']);
}

function retryQueueIdentitiesConflict(left: UnknownRecord, right: UnknownRecord): boolean {
  return canonicalUuidIdentity(left['id']) === canonicalUuidIdentity(right['id'])
    || canonicalUuidIdentity(left['operationId']) === canonicalUuidIdentity(right['operationId'])
    || retryQueueEffectiveIdentity(left) === retryQueueEffectiveIdentity(right);
}

function retryQueueRestoreIdentity(item: UnknownRecord): string {
  return `operation:${canonicalUuidIdentity(item['operationId'])}`;
}

function retryQueueEntityKey(item: UnknownRecord): string {
  return retryQueueEffectiveIdentity(item);
}

function cloneRetryQueueItem(item: UnknownRecord): UnknownRecord {
  return {
    ...item,
    data: isRecord(item['data']) ? { ...item['data'] } : item['data'],
  };
}

function retryQueueEffectiveIdentity(item: UnknownRecord): string {
  const data = isRecord(item['data']) ? item['data'] : {};
  return `${String(item['sourceUserId'])}\u0000${String(item['type'])}\u0000${canonicalUuidIdentity(data['id'])}`;
}

function canonicalUuidIdentity(value: unknown): string {
  return typeof value === 'string' && isValidUUID(value) ? value.toLowerCase() : String(value);
}

function sameRetryQueueItem(left: UnknownRecord, right: UnknownRecord): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isQueueBackupRecord(value: unknown, ownerUserId: string): value is QueueBackupRecord {
  return isRecord(value)
    && value['id'] === `queue-backup:${ownerUserId}`
    && value['ownerUserId'] === ownerUserId
    && isNonEmptyString(value['savedAt'])
    && Array.isArray(value['actions']);
}

function isDeadLetterBackupRecord(value: unknown, ownerUserId: string): value is DeadLetterBackupRecord {
  return isRecord(value)
    && value['id'] === `dead-letter-backup:${ownerUserId}`
    && value['ownerUserId'] === ownerUserId
    && isNonEmptyString(value['savedAt'])
    && Array.isArray(value['deadLetters']);
}

function isOfflineSnapshot(
  value: unknown,
  ownerUserId: string,
): value is DataSafetyOfflineSnapshotRestoreSnapshot {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'scopedIndexedDbRecord,scopedLocalStorageValue'
    || !isOwnerScopedOfflinePayload(value['scopedLocalStorageValue'], ownerUserId)) {
    return false;
  }
  const indexedDb = value['scopedIndexedDbRecord'];
  return indexedDb === null
    || (isRecord(indexedDb)
      && indexedDb['id'] === `offline-snapshot:${ownerUserId}`
      && indexedDb['ownerUserId'] === ownerUserId
      && isNonEmptyString(indexedDb['id']));
}

function isOwnerScopedOfflinePayload(value: unknown, ownerUserId: string): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && parsed['ownerUserId'] === ownerUserId;
  } catch {
    return false;
  }
}

function isExternalSourceLink(value: unknown): value is ExternalSourceLink {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value['id'])
    && isNonEmptyString(value['taskId'])
    && value['sourceType'] === 'siyuan-block'
    && typeof value['targetId'] === 'string'
    && typeof value['uri'] === 'string'
    && typeof value['sortOrder'] === 'number'
    && isNonEmptyString(value['createdAt'])
    && isNonEmptyString(value['updatedAt']);
}

function isPendingExternalSourceLink(value: unknown): value is PendingExternalSourceLink {
  return isRecord(value)
    && isExternalSourceLink(value['link'])
    && isNonEmptyString(value['operationId'])
    && typeof value['localCommittedAt'] === 'number'
    && isNonEmptyString(value['syncState'])
    && typeof value['retryCount'] === 'number';
}

function isProjectCursor(value: unknown, ownerUserId: string): boolean {
  return isRecord(value)
    && isNonEmptyString(value['projectId'])
    && value['userId'] === ownerUserId
    && isRecord(value['cursor']);
}

function requireRecord(value: unknown, slot: string): UnknownRecord {
  if (!isRecord(value)) throw invalidSlot(slot);
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function invalidSlot(slot: string): Error {
  return new Error(`local backup UI restore ${slot} pre-image is invalid`);
}
