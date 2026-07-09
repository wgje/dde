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
import { fetchAllSupabasePages, type SupabaseRangeQuery } from '../utils/supabase-pagination';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { DisasterBackupLocalStateReader } from './disaster-backup-local-state.reader';

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

interface BackupTableRangeQuery extends SupabaseRangeQuery {
  eq(col: string, val: string): BackupTableRangeQuery;
  order(col: string, options?: { ascending?: boolean }): BackupTableRangeQuery;
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
  private readonly dataSafetyAuditPersistence = new DataSafetyAuditPersistence();
  private readonly localStateReader = new DisasterBackupLocalStateReader({
    conflictStorage: this.conflictStorage,
    externalSourceCache: this.externalSourceCache,
    attachmentUploadOutbox: this.attachmentUploadOutbox,
    dataSafetyAuditPersistence: this.dataSafetyAuditPersistence,
  });

  async buildLocalPayload(
    projects: Project[],
    options: LocalDisasterBackupOptions,
  ): Promise<BackupData> {
    const userId = this.resolveEffectiveUserId();
    const visibleProjectIds = new Set(projects.map((project) => project.id));
    const remoteReadState: RemoteBackupReadState = { deferred: false };

    await this.externalSourceLinks.ensureLoaded();
    const payloadBase = this.buildProjectPayload(projects, userId);
    const userPreferences = await this.collectUserPreferences(userId, options, remoteReadState);
    const blackBoxEntries = this.collectBlackBoxEntries(userId);
    const remoteState = await this.collectRemoteUserState(userId, remoteReadState);
    const localState = await this.localStateReader.readLocalState(userId, visibleProjectIds);

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

    const rows = await this.fetchUserScopedRows<SupabaseUserPreferenceRow>('user_preferences', userId, remoteReadState);
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

  private collectBlackBoxEntries(userId: string | null): BackupBlackBoxEntry[] {
    const entriesMap = this.readValue<Map<string, BackupBlackBoxEntry>>(this.blackBoxService.entriesMap) ?? new Map();
    return Array.from(entriesMap.values()).map((entry) => ({
      ...entry,
    })).filter((entry) => {
      if (!userId) {
        return entry.userId === AUTH_CONFIG.LOCAL_MODE_USER_ID;
      }

      return entry.userId === userId;
    }).map((entry) => ({
      id: entry.id,
      projectId: entry.projectId,
      userId: entry.userId,
      content: entry.content,
      date: entry.date,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      completedAt: entry.completedAt,
      isRead: entry.isRead,
      isCompleted: entry.isCompleted,
      isArchived: entry.isArchived,
      snoozeUntil: entry.snoozeUntil,
      snoozeCount: entry.snoozeCount,
      deletedAt: entry.deletedAt,
      focusMeta: entry.focusMeta,
    }));
  }

  private async collectRemoteUserState(
    userId: string | null,
    remoteReadState: RemoteBackupReadState,
  ): Promise<{
    focusSessions: BackupFocusSession[];
    transcriptionUsage: BackupTranscriptionUsage[];
    routineTasks: BackupRoutineTask[];
    routineCompletions: BackupRoutineCompletion[];
  }> {
    const [focusSessions, transcriptionUsage, routineTasks, routineCompletions] = await Promise.all([
      this.fetchUserScopedRows<SupabaseFocusSessionRow>('focus_sessions', userId, remoteReadState),
      this.fetchUserScopedRows<SupabaseTranscriptionUsageRow>('transcription_usage', userId, remoteReadState),
      this.fetchUserScopedRows<SupabaseRoutineTaskRow>('routine_tasks', userId, remoteReadState),
      this.fetchUserScopedRows<SupabaseRoutineCompletionRow>('routine_completions', userId, remoteReadState),
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

    if (isBrowserNetworkSuspendedWindow()) {
      this.markRemoteBackupReadDeferred(remoteReadState, table, 'browser-window');
      return [];
    }

    try {
      const client = this.supabase.client();
      // Supabase 客户端类型对动态表名 union 推导较慢，使用 unknown 收敛于入口
      // 实际类型由白名单 + `T` 参数保证
      const result = await fetchAllSupabasePages<T>(() => (client.from as unknown as (t: BackupTable) => {
        select(cols: string): {
          eq(col: string, val: string): BackupTableRangeQuery;
        };
      })(table)
        .select('*')
        .eq('user_id', userId)
        .order(this.resolveBackupTableOrderColumn(table), { ascending: true })
        .order('id', { ascending: true }));

      if (result.error) {
        const enhanced = supabaseErrorToError(result.error);
        if (isBrowserNetworkSuspendedError(enhanced)) {
          this.markRemoteBackupReadDeferred(remoteReadState, table, enhanced.errorType);
          return [];
        }

        this.logger.error('Failed to fetch backup table', { table, error: result.error });
        throw new Error(`Backup table ${table} query failed: ${enhanced.message}`);
      }

      return Array.isArray(result.data) ? (result.data as T[]) : [];
    } catch (error) {
      const enhanced = supabaseErrorToError(error);
      if (isBrowserNetworkSuspendedError(enhanced)) {
        this.markRemoteBackupReadDeferred(remoteReadState, table, enhanced.errorType);
        return [];
      }

      throw error;
    }
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
