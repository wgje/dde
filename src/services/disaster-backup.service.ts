import { Injectable, inject } from '@angular/core';
import type { Project, Task, Connection } from '../models';
import { LoggerService } from './logger.service';
import { AuthService } from './auth.service';
import { ThemeService } from './theme.service';
import { UiStateService } from './ui-state.service';
import { PreferenceService } from './preference.service';
import { FocusPreferenceService } from './focus-preference.service';
import { BlackBoxService } from './black-box.service';
import { SupabaseClientService } from './supabase-client.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { FOCUS_CONFIG } from '../config/focus.config';
import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.service';
import {
  BACKUP_CONFIG,
  buildTableCounts,
  calculateChecksum,
  type BackupData,
  type BackupBlackBoxEntry,
  type BackupConnection,
  type BackupFocusSession,
  type BackupLocalState,
  type BackupProject,
  type BackupRoutineCompletion,
  type BackupRoutineTask,
  type BackupTask,
  type BackupTranscriptionUsage,
  type BackupUserPreferences,
  type BackupCoverage,
} from '../../supabase/functions/_shared/backup-utils';

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
  private readonly supabase = inject(SupabaseClientService);

  async buildLocalPayload(
    projects: Project[],
    options: LocalDisasterBackupOptions,
  ): Promise<BackupData> {
    const userId = this.resolveEffectiveUserId();

    const payloadBase = this.buildProjectPayload(projects, userId);
    const userPreferences = await this.collectUserPreferences(userId, options);
    const blackBoxEntries = this.collectBlackBoxEntries();
    const remoteState = await this.collectRemoteUserState(userId);
    const localState = await this.collectLocalState();

    const coverage: BackupCoverage = {
      includesProjectData: true,
      includesCloudUserState: !!userId && this.supabase.isConfigured,
      includesLocalState: true,
    };

    const provisionalPayload: BackupData = {
      version: BACKUP_CONFIG.VERSION,
      payloadVersion: BACKUP_CONFIG.VERSION,
      type: 'full',
      createdAt: new Date().toISOString(),
      checksum: '',
      tableCounts: {
        projects: 0,
        tasks: 0,
        connections: 0,
        userPreferences: 0,
        blackBoxEntries: 0,
        focusSessions: 0,
        transcriptionUsage: 0,
        routineTasks: 0,
        routineCompletions: 0,
      },
      coverage,
      ...payloadBase,
      userPreferences,
      blackBoxEntries,
      focusSessions: remoteState.focusSessions,
      transcriptionUsage: remoteState.transcriptionUsage,
      routineTasks: remoteState.routineTasks,
      routineCompletions: remoteState.routineCompletions,
      localState,
    };

    const tableCounts = buildTableCounts(provisionalPayload);
    const checksum = await this.calculatePayloadChecksum({
      ...provisionalPayload,
      tableCounts,
    });

    return {
      ...provisionalPayload,
      tableCounts,
      checksum,
    };
  }

  async buildLocalBlob(
    projects: Project[],
    options: LocalDisasterBackupOptions,
  ): Promise<{ payload: BackupData; blob: Blob }> {
    const payload = await this.buildLocalPayload(projects, options);
    const content = JSON.stringify(payload, null, 2);
    return {
      payload,
      blob: new Blob([content], { type: 'application/json' }),
    };
  }

  private buildProjectPayload(
    projects: Project[],
    userId: string | null,
  ): Pick<BackupData, 'projects' | 'tasks' | 'connections'> {
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
      createdAt: task.createdDate,
      updatedAt: task.updatedAt,
      deletedAt: task.deletedAt,
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

    const rows = await this.fetchUserScopedRows<SupabaseUserPreferenceRow>('user_preferences', userId);
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

  private collectBlackBoxEntries(): BackupBlackBoxEntry[] {
    const entriesMap = this.readValue<Map<string, BackupBlackBoxEntry>>(this.blackBoxService.entriesMap) ?? new Map();
    return Array.from(entriesMap.values()).map((entry) => ({
      id: entry.id,
      projectId: entry.projectId,
      userId: entry.userId,
      content: entry.content,
      date: entry.date,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      isRead: entry.isRead,
      isCompleted: entry.isCompleted,
      isArchived: entry.isArchived,
      snoozeUntil: entry.snoozeUntil,
      snoozeCount: entry.snoozeCount,
      deletedAt: entry.deletedAt,
      focusMeta: entry.focusMeta,
    }));
  }

  private async collectRemoteUserState(userId: string | null): Promise<{
    focusSessions: BackupFocusSession[];
    transcriptionUsage: BackupTranscriptionUsage[];
    routineTasks: BackupRoutineTask[];
    routineCompletions: BackupRoutineCompletion[];
  }> {
    const [focusSessions, transcriptionUsage, routineTasks, routineCompletions] = await Promise.all([
      this.fetchUserScopedRows<SupabaseFocusSessionRow>('focus_sessions', userId),
      this.fetchUserScopedRows<SupabaseTranscriptionUsageRow>('transcription_usage', userId),
      this.fetchUserScopedRows<SupabaseRoutineTaskRow>('routine_tasks', userId),
      this.fetchUserScopedRows<SupabaseRoutineCompletionRow>('routine_completions', userId),
    ]);

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

  private async fetchUserScopedRows<T>(table: string, userId: string | null): Promise<T[]> {
    if (!userId || !this.supabase.isConfigured) {
      return [];
    }

    const client = this.supabase.client();
    const query = client.from(table).select('*');
    const result = await query.eq('user_id', userId);

    if (result.error) {
      this.logger.error('Failed to fetch backup table', { table, error: result.error });
      throw new Error(`Failed to fetch ${table}: ${result.error.message}`);
    }

    return Array.isArray(result.data) ? (result.data as T[]) : [];
  }

  private async collectLocalState(): Promise<BackupLocalState> {
    const [
      indexedSnapshot,
      parkedTaskCache,
      retryQueue,
    ] = await Promise.all([
      this.readSnapshotFromIndexedDb(),
      this.readParkedTaskCache(),
      this.readRetryQueue(),
    ]);

    return {
      offlineSnapshot: {
        localStorage: this.safeGetLocalStorage('nanoflow.offline-cache-v2'),
        indexedDb: indexedSnapshot,
      },
      parkedTaskCache,
      retryQueue,
      actionQueue: this.safeParseJson(this.safeGetLocalStorage(LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY)),
      deadLetters: this.safeParseJson(this.safeGetLocalStorage(LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY)) ?? [],
      taskTombstones: this.safeParseJson(this.safeGetLocalStorage('nanoflow.local-tombstones')) ?? {},
      connectionTombstones: this.safeParseJson(this.safeGetLocalStorage('nanoflow.local-connection-tombstones')) ?? [],
    };
  }

  private async readSnapshotFromIndexedDb(): Promise<string | null> {
    const db = await this.openExistingDb('nanoflow-offline-snapshots');
    if (!db) return null;

    try {
      const row = await this.getByKey<{ data?: string }>(db, 'snapshots', 'offline-snapshot');
      return typeof row?.data === 'string' ? row.data : null;
    } finally {
      db.close();
    }
  }

  private async readParkedTaskCache(): Promise<{ entries: unknown[]; syncMetadata: Record<string, unknown> }> {
    const db = await this.openExistingDb(FOCUS_CONFIG.SYNC.IDB_NAME);
    if (!db) {
      return { entries: [], syncMetadata: {} };
    }

    try {
      const [entries, metadataRows] = await Promise.all([
        this.getAllFromStore(db, FOCUS_CONFIG.IDB_STORES.PARKED_TASKS),
        this.getAllFromStore<{ key: string; value: unknown }>(db, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA),
      ]);

      const syncMetadata = Object.fromEntries(
        metadataRows
          .filter((row): row is { key: string; value: unknown } => !!row && typeof row.key === 'string')
          .map((row) => [row.key, row.value]),
      );

      return { entries, syncMetadata };
    } finally {
      db.close();
    }
  }

  private async readRetryQueue(): Promise<unknown[]> {
    const db = await this.openExistingDb('nanoflow-retry-queue');
    if (!db) {
      return this.safeParseJson(this.safeGetLocalStorage('nanoflow.retry-queue')) ?? [];
    }

    try {
      return await this.getAllFromStore(db, 'offline_mutation_queue');
    } finally {
      db.close();
    }
  }

  private async openExistingDb(name: string): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;

    return new Promise((resolve) => {
      let createdDuringOpen = false;
      const request = indexedDB.open(name);

      request.onupgradeneeded = () => {
        createdDuringOpen = true;
        request.transaction?.abort();
      };

      request.onsuccess = () => {
        if (createdDuringOpen) {
          request.result.close();
          resolve(null);
          return;
        }
        resolve(request.result);
      };

      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  private async getAllFromStore<T = unknown>(db: IDBDatabase, storeName: string): Promise<T[]> {
    if (!db.objectStoreNames.contains(storeName)) {
      return [];
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as T[]);
      request.onerror = () => reject(request.error);
    });
  }

  private async getByKey<T>(
    db: IDBDatabase,
    storeName: string,
    key: IDBValidKey,
  ): Promise<T | null> {
    if (!db.objectStoreNames.contains(storeName)) {
      return null;
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve((request.result ?? null) as T | null);
      request.onerror = () => reject(request.error);
    });
  }

  private async calculatePayloadChecksum(payload: BackupData): Promise<string> {
    const json = JSON.stringify({
      ...payload,
      checksum: '',
    });
    return calculateChecksum(json);
  }

  private safeGetLocalStorage(key: string): string | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private safeParseJson(value: string | null): unknown {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
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
