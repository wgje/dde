import { Injectable, inject } from '@angular/core';
import type { Project, Task, Connection } from '../models';
import { LoggerService } from './logger.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { FocusPreferenceService } from './focus-preference.service';
import { BlackBoxService } from './black-box.service';
import { ConflictStorageService } from './conflict-storage.service';
import { SupabaseClientService } from './supabase-client.service';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  calculateChecksum,
  type BackupData,
  type BackupBlackBoxEntry,
  type BackupConnection,
  type BackupFocusSession,
  type BackupProject,
  type BackupRoutineCompletion,
  type BackupRoutineTask,
  type BackupTask,
  type BackupTranscriptionUsage,
  type BackupUserPreferences,
  type BackupCoverage,
  type BackupExternalSourceLink,
} from '../../supabase/functions/_shared/backup-utils';
import {
  createLocalDisasterBackupPayload,
  type BackupPayloadBase,
} from './disaster-backup-payload.helpers';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import type { ExternalSourceLink } from '../app/core/external-sources/external-source.model';
import { supabaseErrorToError } from '../utils/supabase-error';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import {
  fetchAllSupabaseKeysetPagesByCursor,
  type SupabaseLimitQuery,
} from '../utils/supabase-pagination';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { DisasterBackupLocalStateReader } from './disaster-backup-local-state.reader';
import { SyncStateService } from '../core-bridge';
import { FOCUS_CONFIG } from '../config/focus.config';
import { isValidBlackBoxId, isValidBlackBoxProjectId } from './black-box-sync-push-uuid-guard';

/**
 * 允许被动态查询的备份表白名单
 *
 * 【2026-04-16 T0-3】任何动态表名必须先经过此白名单；
 * 禁止直接把用户输入或未审核的字符串传入 `supabase.from()`。
 */
const BACKUP_TABLES = [
  'user_preferences',
  'focus_sessions',
  'transcription_usage',
  'routine_tasks',
  'routine_completions',
] as const;
type BackupTable = (typeof BACKUP_TABLES)[number];

interface BackupTableKeysetQuery extends SupabaseLimitQuery {
  eq(col: string, val: string): BackupTableKeysetQuery;
  gt(col: string, val: string): BackupTableKeysetQuery;
  order(col: string, options?: { ascending?: boolean }): BackupTableKeysetQuery;
}

export interface LocalDisasterBackupOptions {
  autoBackupEnabled: boolean;
  autoBackupIntervalMs: number;
}

interface SupabaseUserPreferenceRow {
  id: string;
  created_at?: string;
  updated_at?: string;
}

interface SupabaseFocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at?: string | null;
  session_state: unknown;
  updated_at?: string;
}

interface SupabaseTranscriptionUsageRow {
  id: string;
  user_id: string;
  date: string;
  audio_seconds: number;
  created_at?: string;
}

interface SupabaseRoutineTaskRow {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day: number;
  is_enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

interface SupabaseRoutineCompletionRow {
  id: string;
  routine_id: string;
  user_id: string;
  date_key: string;
  count: number;
  updated_at?: string;
}

interface BackupRemoteUserState {
  focusSessions: BackupFocusSession[];
  transcriptionUsage: BackupTranscriptionUsage[];
  routineTasks: BackupRoutineTask[];
  routineCompletions: BackupRoutineCompletion[];
}

interface RemoteBackupReadState {
  deferred: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class DisasterBackupService {
  private readonly logger = inject(LoggerService).category('DisasterBackup');
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly uiState = inject(UiStateService);
  private readonly preferenceService = inject(PreferenceService);
  private readonly focusPreferenceService = inject(FocusPreferenceService);
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly externalSourceLinks = inject(ExternalSourceLinkService);
  private readonly externalSourceCache = inject(ExternalSourceCacheService);
  private readonly attachmentUploadOutbox = inject(AttachmentUploadOutboxService, { optional: true });
  private readonly syncStateService = inject(SyncStateService, { optional: true });
  private readonly dataSafetyAuditPersistence = new DataSafetyAuditPersistence();
  private readonly localStateReader = new DisasterBackupLocalStateReader({
    conflictStorage: this.conflictStorage,
    externalSourceCache: this.externalSourceCache,
    attachmentUploadOutbox: this.attachmentUploadOutbox,
    dataSafetyAuditPersistence: this.dataSafetyAuditPersistence,
    readSyncState: this.syncStateService
      ? () => {
          const state = this.syncStateService!.syncState();
          return {
            lastSyncTime: state.lastSyncTime,
            pendingCount: state.pendingCount,
          };
        }
      : undefined,
  });

  async buildLocalPayload(
    projects: Project[],
    options: LocalDisasterBackupOptions,
  ): Promise<BackupData> {
    const userId = this.resolveEffectiveUserId();
    const backupOwnerUserId = userId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const visibleProjectIds = new Set(projects.map((project) => project.id));
    const remoteReadState: RemoteBackupReadState = { deferred: false };

    await this.externalSourceLinks.ensureLoaded();
    const payloadBase = this.buildProjectPayload(projects, userId);
    const userPreferences = await this.collectUserPreferences(
      userId,
      options,
      remoteReadState,
    );
    const blackBoxEntries = await this.collectBlackBoxEntries(backupOwnerUserId);
    const remoteState = await this.collectRemoteUserState(userId, remoteReadState);
    const localState = await this.localStateReader.readLocalState(
      backupOwnerUserId,
      visibleProjectIds,
      userId,
    );

    const coverage: BackupCoverage = {
      includesProjectData: true,
      includesCloudUserState: !!userId && this.supabase.isConfigured && !remoteReadState.deferred,
      includesLocalState: true,
    };

    return createLocalDisasterBackupPayload({
      payloadBase,
      userPreferences,
      blackBoxEntries,
      remoteState,
      localState,
      coverage,
      calculateChecksum: json => calculateChecksum(json),
    });
  }

  async buildLocalBlob(
    projects: Project[],
    options: LocalDisasterBackupOptions,
  ): Promise<{ payload: BackupData; blob: Blob; deferredCloudUserState: boolean }> {
    const payload = await this.buildLocalPayload(projects, options);
    const content = JSON.stringify(payload, null, 2);
    return {
      payload,
      blob: new Blob([content], { type: 'application/json' }),
      deferredCloudUserState: this.shouldDeferLocalBackupWrite(payload),
    };
  }

  private shouldDeferLocalBackupWrite(payload: BackupData): boolean {
    return !!this.resolveEffectiveUserId()
      && this.supabase.isConfigured
      && !payload.coverage.includesCloudUserState;
  }

  private buildProjectPayload(
    projects: Project[],
    userId: string | null,
  ): BackupPayloadBase {
    const backupProjects: BackupProject[] = [];
    const backupTasks: BackupTask[] = [];
    const backupConnections: BackupConnection[] = [];

    for (const project of projects) {
      backupProjects.push({
        id: project.id,
        userId: userId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
        name: project.name,
        description: project.description,
        createdAt: project.createdDate,
        updatedAt: project.updatedAt,
        version: project.version,
      });

      for (const task of project.tasks ?? []) {
        backupTasks.push(this.mapTask(project.id, task));
      }

      for (const connection of project.connections ?? []) {
        backupConnections.push(this.mapConnection(project.id, connection));
      }
    }

    return {
      projects: backupProjects,
      tasks: backupTasks,
      connections: backupConnections,
    };
  }

  private mapTask(projectId: string, task: Task): BackupTask {
    return {
      id: task.id,
      projectId,
      title: task.title,
      content: task.content,
      parentId: task.parentId,
      stage: task.stage,
      order: task.order,
      rank: task.rank,
      status: task.status,
      x: task.x,
      y: task.y,
      displayId: task.displayId,
      shortId: task.shortId,
      attachments: task.attachments ?? [],
      tags: task.tags,
      priority: task.priority,
      dueDate: task.dueDate,
      expected_minutes: task.expected_minutes ?? null,
      cognitive_load: task.cognitive_load ?? null,
      wait_minutes: task.wait_minutes ?? null,
      parkingMeta: task.parkingMeta ?? null,
      attentionMeta: task.attentionMeta ?? null,
      createdAt: task.createdDate,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt ?? null,
      deletedAt: task.deletedAt,
      externalSourceLinks: this.mapExternalSourceLinks(task.id),
    };
  }

  private mapExternalSourceLinks(taskId: string): BackupExternalSourceLink[] | undefined {
    const links = this.externalSourceLinks.activeLinksForTask(taskId);
    if (links.length === 0) return undefined;
    return links.map(link => this.mapExternalSourceLink(link));
  }

  private mapExternalSourceLink(link: ExternalSourceLink): BackupExternalSourceLink {
    return {
      id: link.id,
      sourceType: link.sourceType,
      targetId: link.targetId,
      uri: link.uri,
      label: link.label,
      hpath: link.hpath,
      role: link.role,
      sortOrder: link.sortOrder,
      deletedAt: link.deletedAt,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    };
  }

  private mapConnection(projectId: string, connection: Connection): BackupConnection {
    return {
      id: connection.id,
      projectId,
      source: connection.source,
      target: connection.target,
      title: connection.title,
      description: connection.description,
      createdAt: undefined,
      updatedAt: connection.updatedAt,
      deletedAt: connection.deletedAt,
    };
  }

  private async collectUserPreferences(
    userId: string | null,
    options: LocalDisasterBackupOptions,
    remoteReadState: RemoteBackupReadState,
  ): Promise<BackupUserPreferences[]> {
    const focusPreferences = this.readValue<unknown>(this.focusPreferenceService.getPreferences?.bind(this.focusPreferenceService))
      ?? this.readValue<unknown>(this.focusPreferenceService.preferences);

    const base: BackupUserPreferences = {
      id: userId ? `local-pref-${userId}` : 'local-pref-anonymous',
      userId: userId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
      theme: this.readValue<string>(this.theme.theme) ?? 'default',
      layoutDirection: this.readValue<'ltr' | 'rtl'>(this.uiState.layoutDirection) ?? 'ltr',
      floatingWindowPref: this.readValue<'auto' | 'fixed'>(this.uiState.floatingWindowPref) ?? 'auto',
      colorMode: this.readValue<string>(this.theme.colorMode) ?? 'system',
      autoResolveConflicts: this.readValue<boolean>(this.preferenceService.autoResolveConflicts) ?? true,
      localBackupEnabled: options.autoBackupEnabled,
      localBackupIntervalMs: options.autoBackupIntervalMs,
      focusPreferences,
    };

    const rows = await this.fetchUserScopedRows<SupabaseUserPreferenceRow>(
      'user_preferences',
      userId,
      remoteReadState,
    );
    if (rows.length === 0) {
      return [base];
    }

    return rows.map((row) => ({
      ...base,
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  private async collectBlackBoxEntries(ownerUserId: string): Promise<BackupBlackBoxEntry[]> {
    const durable = projectBlackBoxRows(await readDurableBlackBoxRows(), ownerUserId);
    const memorySource = this.readValue<unknown>(this.blackBoxService.entriesMap);
    if (!(memorySource instanceof Map)) throw new Error('Black Box export memory evidence is invalid');
    const memory = projectBlackBoxRows([...memorySource.entries()].map(([key, value]) => ({ key, value })), ownerUserId, true);
    if (memory.length > 0 && !sameValue(memory, durable)) {
      throw new Error('Black Box export durable and memory evidence diverged');
    }
    return durable;
  }

  private async collectRemoteUserState(
    userId: string | null,
    remoteReadState: RemoteBackupReadState,
  ): Promise<BackupRemoteUserState> {
    const [focusSessions, transcriptionUsage, routineTasks, routineCompletions] = await Promise.all([
      this.fetchUserScopedRows<SupabaseFocusSessionRow>('focus_sessions', userId, remoteReadState),
      this.fetchUserScopedRows<SupabaseTranscriptionUsageRow>(
        'transcription_usage',
        userId,
        remoteReadState,
      ),
      this.fetchUserScopedRows<SupabaseRoutineTaskRow>('routine_tasks', userId, remoteReadState),
      this.fetchUserScopedRows<SupabaseRoutineCompletionRow>(
        'routine_completions',
        userId,
        remoteReadState,
      ),
    ]);

    return this.mapRemoteUserState(
      focusSessions,
      transcriptionUsage,
      routineTasks,
      routineCompletions,
    );
  }

  private mapRemoteUserState(
    focusSessions: SupabaseFocusSessionRow[],
    transcriptionUsage: SupabaseTranscriptionUsageRow[],
    routineTasks: SupabaseRoutineTaskRow[],
    routineCompletions: SupabaseRoutineCompletionRow[],
  ): BackupRemoteUserState {
    return {
      focusSessions: focusSessions.map((row) => ({
        id: row.id,
        userId: row.user_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        sessionState: row.session_state,
        updatedAt: row.updated_at,
      })),
      transcriptionUsage: transcriptionUsage.map((row) => ({
        id: row.id,
        userId: row.user_id,
        date: row.date,
        audioSeconds: row.audio_seconds,
        createdAt: row.created_at,
      })),
      routineTasks: routineTasks.map((row) => ({
        id: row.id,
        userId: row.user_id,
        title: row.title,
        maxTimesPerDay: row.max_times_per_day,
        isEnabled: row.is_enabled,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      routineCompletions: routineCompletions.map((row) => ({
        id: row.id,
        routineId: row.routine_id,
        userId: row.user_id,
        dateKey: row.date_key,
        count: row.count,
        updatedAt: row.updated_at,
      })),
    };
  }

  private async fetchUserScopedRows<T>(
    table: BackupTable,
    userId: string | null,
    remoteReadState: RemoteBackupReadState,
  ): Promise<T[]> {
    // 白名单断言（防御性），阻止未来误传非白名单字符串
    if (!BACKUP_TABLES.includes(table)) {
      throw new Error(`[disaster-backup] Unsupported backup table: ${String(table)}`);
    }

    if (!userId || !this.supabase.isConfigured) {
      return [];
    }

    if (remoteReadState.deferred) {
      return [];
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.markRemoteBackupReadDeferred(remoteReadState, table, 'browser-window');
      return [];
    }

    try {
      const client = this.supabase.client();
      const result = await fetchAllSupabaseKeysetPagesByCursor<T, string>(cursor =>
        this.buildBackupTableKeysetQuery(client, table, userId, cursor), {
        readCursor: row => this.readBackupRowId(row),
        cursorKey: (cursor) => cursor,
        isCursorAfter: (previous, next) => next > previous,
      });

      if (result.error) {
        const enhanced = supabaseErrorToError(result.error);
        if (isBrowserNetworkSuspendedError(enhanced)) {
          this.markRemoteBackupReadDeferred(remoteReadState, table, enhanced.errorType);
          return [];
        }

        this.logger.error('Failed to fetch backup table', { table, error: result.error });
        throw new Error(`Backup table ${table} query failed: ${enhanced.message}`);
      }

      return Array.isArray(result.data)
        ? this.sortBackupRows(table, result.data as T[])
        : [];
    } catch (error) {
      const enhanced = supabaseErrorToError(error);
      if (isBrowserNetworkSuspendedError(enhanced)) {
        this.markRemoteBackupReadDeferred(remoteReadState, table, enhanced.errorType);
        return [];
      }

      throw error;
    }
  }

  private buildBackupTableKeysetQuery(
    client: unknown,
    table: BackupTable,
    userId: string,
    cursor: string | null,
  ): BackupTableKeysetQuery {
    const typedClient = client as {
      from(table: BackupTable): {
        select(columns: string): {
          eq(column: string, value: string): BackupTableKeysetQuery;
        };
      };
    };
    let query = typedClient.from(table).select('*').eq('user_id', userId);
    if (cursor) query = query.gt('id', cursor);
    return query.order('id', { ascending: true });
  }

  private resolveBackupTableOrderColumn(table: BackupTable): string {
    if (table === 'transcription_usage') {
      return 'date';
    }
    if (table === 'focus_sessions') {
      return 'updated_at';
    }
    return 'updated_at';
  }

  private readBackupRowId(row: unknown): string | null {
    if (!row || typeof row !== 'object' || !('id' in row)) return null;
    const id = row.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  private sortBackupRows<T>(table: BackupTable, rows: T[]): T[] {
    const orderColumn = this.resolveBackupTableOrderColumn(table);
    return [...rows].sort((left, right) => {
      const order = this.compareBackupRowValues(
        this.readBackupRowValue(left, orderColumn),
        this.readBackupRowValue(right, orderColumn),
      );
      if (order !== 0) return order;
      return this.compareBackupRowValues(
        this.readBackupRowValue(left, 'id'),
        this.readBackupRowValue(right, 'id'),
      );
    });
  }

  private readBackupRowValue(row: unknown, column: string): string | null {
    if (!row || typeof row !== 'object' || !(column in row)) return null;
    const value = row[column as keyof typeof row];
    return typeof value === 'string' ? value : null;
  }

  private compareBackupRowValues(left: string | null, right: string | null): number {
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return left.localeCompare(right);
  }

  private markRemoteBackupReadDeferred(
    remoteReadState: RemoteBackupReadState,
    table: BackupTable,
    reason: string,
  ): void {
    remoteReadState.deferred = true;
    this.logger.debug('备份远端用户状态读取已延后，继续生成本地备份', { table, reason });
  }

  private resolveEffectiveUserId(): string | null {
    const currentUserId = this.auth.currentUserId?.();
    if (currentUserId) {
      return currentUserId;
    }

    if (typeof localStorage !== 'undefined' && localStorage.getItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY) === 'true') {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    return null;
  }

  private readValue<T>(source: unknown): T | undefined {
    if (typeof source === 'function') {
      return source() as T;
    }
    return source as T | undefined;
  }
}

type UnknownRecord = Record<string, unknown>;

async function readDurableBlackBoxRows(): Promise<unknown[]> {
  const db = await openExistingBlackBoxDb();
  if (!db) return [];
  try {
    const storeName = FOCUS_CONFIG.IDB_STORES.BLACK_BOX_ENTRIES;
    if (!db.objectStoreNames.contains(storeName)) return [];
    return await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      let rows: unknown[] | null = null;
      request.onsuccess = () => { rows = request.result ?? []; };
      tx.oncomplete = () => rows === null
        ? reject(new Error('Black Box export read completed without rows'))
        : resolve(rows);
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error('Black Box export transaction failed'));
      tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Black Box export transaction aborted'));
    });
  } catch (error) {
    throw new Error(`Black Box export durable read failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}

function openExistingBlackBoxDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let absent = false;
    const request = indexedDB.open(FOCUS_CONFIG.SYNC.IDB_NAME);
    request.onupgradeneeded = () => { absent = true; request.transaction?.abort(); };
    request.onsuccess = () => { absent ? (request.result.close(), resolve(null)) : resolve(request.result); };
    request.onerror = () => absent ? resolve(null) : reject(request.error ?? new Error('Black Box export open failed'));
    request.onblocked = () => reject(new Error('Black Box export open blocked'));
  });
}

function projectBlackBoxRows(rows: unknown[], ownerUserId: string, keyed = false): BackupBlackBoxEntry[] {
  const projected: BackupBlackBoxEntry[] = [];
  for (const candidate of rows) {
    const wrapper = keyed && isRecord(candidate) ? candidate : null;
    const row = wrapper ? wrapper['value'] : candidate;
    if (!isRecord(row) || !nonEmpty(row['userId'])) throw new Error('Black Box export row has an invalid owner');
    if (row['userId'] !== ownerUserId) continue;
    const entry = projectBlackBoxRow(row);
    if (wrapper && wrapper['key'] !== entry.id) throw new Error('Black Box export memory key is invalid');
    projected.push(entry);
  }
  return projected.sort((left, right) => left.id.localeCompare(right.id));
}

function projectBlackBoxRow(row: UnknownRecord): BackupBlackBoxEntry {
  const id = row['id'];
  const projectId = row['projectId'];
  const userId = row['userId'];
  const content = row['content'];
  const date = row['date'];
  const createdAt = row['createdAt'];
  const updatedAt = row['updatedAt'];
  const completedAt = row['completedAt'];
  const isRead = row['isRead'];
  const isCompleted = row['isCompleted'];
  const isArchived = row['isArchived'];
  const snoozeUntil = row['snoozeUntil'];
  const snoozeCount = row['snoozeCount'];
  const deletedAt = row['deletedAt'];
  const focusMeta = row['focusMeta'];
  const valid = typeof id === 'string' && isValidBlackBoxId(id)
    && isValidBlackBoxProjectId(projectId as string | null | undefined)
    && typeof userId === 'string' && userId.length > 0
    && typeof content === 'string' && validDate(date as string)
    && validTimestamp(createdAt as string) && validTimestamp(updatedAt as string)
    && optionalTimestamp(completedAt as string | null | undefined) && typeof isRead === 'boolean'
    && typeof isCompleted === 'boolean' && typeof isArchived === 'boolean'
    && optionalDate(snoozeUntil as string | null | undefined) && optionalCount(snoozeCount as number | undefined)
    && (deletedAt === null || validTimestamp(deletedAt as string))
    && (focusMeta === undefined || isJsonValue(focusMeta));
  if (!valid) throw new Error('Black Box export contains a malformed current-owner row');
  return {
    id, projectId: projectId as string | null, userId,
    content, date: date as string, createdAt: createdAt as string,
    updatedAt: updatedAt as string, completedAt: completedAt as string | null | undefined,
    isRead, isCompleted, isArchived,
    snoozeUntil: snoozeUntil as string | null | undefined, snoozeCount: snoozeCount as number | undefined,
    deletedAt: deletedAt as string | null, focusMeta,
  };
}

function isRecord(value: unknown): value is UnknownRecord { return !!value && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function validTimestamp(value: unknown): value is string { return nonEmpty(value) && Number.isFinite(Date.parse(value)); }
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}
function optionalTimestamp(value: unknown): boolean { return value === undefined || value === null || validTimestamp(value); }
function optionalDate(value: unknown): boolean { return value === undefined || value === null || validDate(value); }
function optionalCount(value: unknown): boolean { return value === undefined || Number.isInteger(value) && (value as number) >= 0; }
function isJsonValue(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
    || Array.isArray(value) && value.every(isJsonValue)
    || isRecord(value) && Object.values(value).every(isJsonValue);
}
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, i) => sameValue(item, right[i]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left); return keys.length === Object.keys(right).length && keys.every(key => key in right && sameValue(left[key], right[key]));
}
