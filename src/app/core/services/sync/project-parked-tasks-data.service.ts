import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FIELD_SELECT_CONFIG } from '../../../../config/sync.config';
import { FOCUS_CONFIG } from '../../../../config/focus.config';
import type { Task } from '../../../../models';
import type { TaskRow } from '../../../../models/supabase-types';
import { LoggerService } from '../../../../services/logger.service';
import {
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { openIndexedDBAdaptive } from '../../../../utils/indexeddb-open';
import { fetchAllSupabasePages } from '../../../../utils/supabase-pagination';
import { getCompatibleTaskSelectFields, markTaskCompletedAtColumnUnavailable } from '../../../../utils/task-schema-compat';
import { supabaseErrorToError } from '../../../../utils/supabase-error';

interface ParkedTaskCacheRecord {
  taskId: string;
  projectId: string;
  task: Task;
  updatedAt: string;
}

interface ParkedTaskDeltaRow extends Partial<TaskRow> {
  project_id?: string;
}

interface ParkedTaskDeltaState {
  updatedRows: ParkedTaskDeltaRow[];
  entryMap: Map<string, ParkedTaskEntry>;
  removedTasks: Map<string, ParkedTaskRemoval>;
  knownTaskChecksIncomplete: boolean;
}

interface ParkedTaskRowsResult {
  data: ParkedTaskDeltaRow[] | null;
  error: { code?: string; message?: string; details?: string; hint?: string } | null;
}

interface ProjectIdRow {
  id?: string | null;
}

interface ParkedTaskCursor {
  updatedAt: string;
  id: string | null;
}

interface ParkedTaskCursorQuery {
  gt: (column: string, value: string) => unknown;
  or: (filters: string) => unknown;
}

export interface ParkedTaskEntry {
  task: Task;
  projectId: string;
}

export interface ParkedTaskCacheSnapshot {
  entries: ParkedTaskEntry[];
  cursor: string | null;
}

export interface ParkedTaskDeltaResult {
  entries: ParkedTaskEntry[];
  removedTasks: ParkedTaskRemoval[];
  removedTaskIds: string[];
  nextCursor: string | null;
}

export interface ParkedTaskRemoval {
  taskId: string;
  updatedAt: string | null;
}

export type ProjectDataClientProvider = () => Promise<SupabaseClient | null>;
export type ProjectDataAuthRetryHandler = <T>(context: string, fn: () => Promise<T>) => Promise<T>;
export type TaskRowMapper = (row: TaskRow | Partial<TaskRow>) => Task;

@Injectable({ providedIn: 'root' })
export class ProjectParkedTasksDataService {
  private readonly logger = inject(LoggerService).category('ProjectData');

  private readonly PARKING_SYNC_CURSOR_KEY = 'parking_last_sync_time';
  private readonly PARKING_SYNC_CURSOR_V2_PREFIX = 'parked-task-cursor:v1:';

  async loadParkedTasksCache(): Promise<ParkedTaskCacheSnapshot> {
    if (typeof indexedDB === 'undefined') {
      return { entries: [], cursor: null };
    }

    try {
      const db = await this.openFocusModeDB();
      return await new Promise<ParkedTaskCacheSnapshot>((resolve, reject) => {
        const tx = db.transaction(
          [FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA],
          'readonly',
        );

        const parkedStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS);
        const metaStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA);

        const parkedReq = parkedStore.getAll();
        const cursorReq = metaStore.get(this.PARKING_SYNC_CURSOR_KEY);

        tx.oncomplete = () => {
          const rows = Array.isArray(parkedReq.result) ? parkedReq.result : [];
          const entries: ParkedTaskEntry[] = rows
            .filter((row): row is ParkedTaskCacheRecord =>
              !!row &&
              typeof row === 'object' &&
              'taskId' in row &&
              'projectId' in row &&
              'task' in row
            )
            .map((row) => ({
              task: row.task,
              projectId: row.projectId,
            }));

          const cursor = cursorReq.result?.value
            ? String(cursorReq.result.value)
            : null;

          resolve({ entries, cursor });
        };

        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      this.logger.warn('读取停泊任务缓存失败，降级为空缓存', { error });
      return { entries: [], cursor: null };
    }
  }

  async saveParkedTasksCache(snapshot: ParkedTaskCacheSnapshot): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    try {
      const db = await this.openFocusModeDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          [FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, FOCUS_CONFIG.IDB_STORES.SYNC_METADATA],
          'readwrite',
        );
        const parkedStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS);
        const metaStore = tx.objectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA);

        parkedStore.clear();
        for (const entry of snapshot.entries) {
          const updatedAt = entry.task.updatedAt ?? new Date().toISOString();
          parkedStore.put({
            taskId: entry.task.id,
            projectId: entry.projectId,
            task: entry.task,
            updatedAt,
          } as ParkedTaskCacheRecord);
        }
        metaStore.put({
          key: this.PARKING_SYNC_CURSOR_KEY,
          value: snapshot.cursor ?? null,
        });

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      this.logger.warn('保存停泊任务缓存失败（不阻断主流程）', { error });
    }
  }

  async pullParkedTasksDelta(
    since: string | null,
    knownParkedTaskIds: string[],
    projectIds: readonly string[],
    dependencies: {
      getClient: ProjectDataClientProvider;
      withAuthRetry: ProjectDataAuthRetryHandler;
      rowToTask: TaskRowMapper;
      normalizeIds: (ids: readonly string[]) => string[];
      chunkIds: (ids: readonly string[], size: number) => string[][];
    },
  ): Promise<ParkedTaskDeltaResult> {
    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起窗口内跳过停泊任务增量拉取', { since });
      return this.emptyDelta(since);
    }

    const client = await dependencies.getClient();
    if (!client) {
      return this.emptyDelta(since);
    }

    const localProjectIdHints = dependencies.normalizeIds(projectIds);

    try {
      return await dependencies.withAuthRetry('pullParkedTasksDelta', () => this.pullParkedTasksDeltaWithClient(
        client,
        since,
        knownParkedTaskIds,
        localProjectIdHints,
        dependencies,
      ));
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error)) {
        this.logger.debug('浏览器网络挂起期间已跳过停泊任务增量拉取', { since });
        return this.emptyDelta(since);
      }

      this.logger.warn('增量拉取停泊任务失败，保持现有缓存', { error, since });
      return this.emptyDelta(since);
    }
  }

  private async pullParkedTasksDeltaWithClient(
    client: SupabaseClient,
    since: string | null,
    knownParkedTaskIds: string[],
    localProjectIdHints: string[],
    dependencies: {
      rowToTask: TaskRowMapper;
      normalizeIds: (ids: readonly string[]) => string[];
      chunkIds: (ids: readonly string[], size: number) => string[][];
    },
  ): Promise<ParkedTaskDeltaResult> {
    // 本地项目 id 列表非空时直接使用（每个周期 tick 省 1 个远端 projects 查询）：
    // 另一设备新建的项目会先经主项目清单同步进入本地列表，下一轮 tick 自然覆盖；
    // 仅本地列表为空（冷启动未就绪）时才回退远端查询
    const scopedProjectIds = localProjectIdHints.length > 0
      ? localProjectIdHints
      : await this.loadParkedSyncProjectIds(client, dependencies.normalizeIds);
    if (scopedProjectIds.length === 0) {
      this.logger.debug('停泊任务增量拉取缺少远端项目范围，跳过任务查询', {
        since,
        localProjectCount: localProjectIdHints.length,
      });
      return this.emptyDelta(since);
    }

    const state: ParkedTaskDeltaState = {
      updatedRows: [],
      entryMap: new Map<string, ParkedTaskEntry>(),
      removedTasks: new Map<string, ParkedTaskRemoval>(),
      knownTaskChecksIncomplete: false,
    };
    const projectChunks = dependencies.chunkIds(scopedProjectIds, 50);
    const selectFields = () => getCompatibleTaskSelectFields(`project_id,${FIELD_SELECT_CONFIG.TASK_LIST_FIELDS}`);
    const parkedResult = await this.loadParkedRowsWithSchemaFallback(client, projectChunks, since, selectFields);

    if (parkedResult.error) {
      throw supabaseErrorToError(parkedResult.error);
    }

    this.applyParkedRows(parkedResult.data ?? [], state, dependencies.rowToTask);
    await this.applyKnownParkedTaskChanges(
      client,
      since,
      knownParkedTaskIds,
      selectFields,
      state,
      dependencies,
    );

    return this.buildParkedDeltaResult(since, state);
  }

  private applyParkedRows(
    rows: ParkedTaskDeltaRow[],
    state: ParkedTaskDeltaState,
    rowToTask: TaskRowMapper,
  ): void {
    for (const rawRow of rows) {
      const projectId = rawRow.project_id ? String(rawRow.project_id) : '';
      if (!projectId || !rawRow.id) continue;
      const task = rowToTask(rawRow);
      state.entryMap.set(task.id, { task, projectId });
      state.updatedRows.push(rawRow);
    }
  }

  private buildParkedDeltaResult(
    since: string | null,
    state: ParkedTaskDeltaState,
  ): ParkedTaskDeltaResult {
    return {
      entries: Array.from(state.entryMap.values()),
      removedTasks: Array.from(state.removedTasks.values()),
      removedTaskIds: Array.from(state.removedTasks.keys()),
      nextCursor: state.knownTaskChecksIncomplete
        ? since
        : this.computeParkedCursor(since, state.updatedRows),
    };
  }

  private async loadParkedRowsWithSchemaFallback(
    client: SupabaseClient,
    projectChunks: string[][],
    since: string | null,
    selectFields: () => string,
  ): Promise<ParkedTaskRowsResult> {
    const maxSchemaFallbackAttempts = 3;
    let parkedResult = await this.loadParkedRows(client, projectChunks, since, selectFields);

    for (let attempt = 1; parkedResult.error && attempt < maxSchemaFallbackAttempts; attempt += 1) {
      if (!markTaskCompletedAtColumnUnavailable(parkedResult.error)) break;
      this.logger.warn('tasks 可选字段缺失，停泊任务增量拉取已降级为旧 schema 字段', {
        since,
        error: parkedResult.error,
      });
      parkedResult = await this.loadParkedRows(client, projectChunks, since, selectFields);
    }

    return parkedResult;
  }

  private async loadParkedRows(
    client: SupabaseClient,
    projectChunks: string[][],
    since: string | null,
    selectFields: () => string,
  ): Promise<ParkedTaskRowsResult> {
    const rows: ParkedTaskDeltaRow[] = [];

    for (const projectChunk of projectChunks) {
      const result = await fetchAllSupabasePages<ParkedTaskDeltaRow>(() => {
        let parkedQuery = client
          .from('tasks')
          .select(selectFields())
          .not('parking_meta', 'is', null)
          .is('deleted_at', null)
          .in('project_id', projectChunk);

        parkedQuery = this.applyParkedCursorFilter(parkedQuery, since);

        return parkedQuery
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true });
      });
      if (result.error) {
        return { data: null, error: result.error };
      }

      rows.push(...((result.data ?? []) as ParkedTaskDeltaRow[]));
    }

    return { data: rows, error: null };
  }

  private async applyKnownParkedTaskChanges(
    client: SupabaseClient,
    since: string | null,
    knownParkedTaskIds: string[],
    selectFields: () => string,
    state: ParkedTaskDeltaState,
    dependencies: {
      rowToTask: TaskRowMapper;
      chunkIds: (ids: readonly string[], size: number) => string[][];
    },
  ): Promise<void> {
    if (knownParkedTaskIds.length === 0) return;

    for (const chunk of dependencies.chunkIds(knownParkedTaskIds, 100)) {
      let changedRows: ParkedTaskDeltaRow[] | null = null;
      try {
        const { data, error } = await fetchAllSupabasePages<ParkedTaskDeltaRow>(() => {
          let changedQuery = client
            .from('tasks')
            .select(selectFields())
            .in('id', chunk);

          changedQuery = this.applyParkedCursorFilter(changedQuery, since);

          return changedQuery
            .order('updated_at', { ascending: true })
            .order('id', { ascending: true });
        });

        if (error) {
          this.markKnownParkedTaskCheckIncomplete(state, since, chunk, error);
          continue;
        }

        changedRows = (data ?? []) as ParkedTaskDeltaRow[];
      } catch (error) {
        this.markKnownParkedTaskCheckIncomplete(state, since, chunk, error);
        continue;
      }

      this.applyChangedParkedRows(changedRows, state, dependencies.rowToTask);
    }
  }

  private markKnownParkedTaskCheckIncomplete(
    state: ParkedTaskDeltaState,
    since: string | null,
    chunk: readonly string[],
    error: unknown,
  ): void {
    state.knownTaskChecksIncomplete = true;
    if (isBrowserNetworkSuspendedError(error)) {
      this.logger.debug('浏览器网络挂起期间停泊任务 known-id 检查未完成，将在下次重试', {
        since,
        chunkSize: chunk.length,
      });
      return;
    }

    this.logger.warn('停泊任务 known-id 增量检查失败，保留已拉取的停泊任务增量并在下次重试', {
      error,
      since,
      chunkSize: chunk.length,
    });
  }

  private applyChangedParkedRows(
    changedRows: ParkedTaskDeltaRow[],
    state: ParkedTaskDeltaState,
    rowToTask: TaskRowMapper,
  ): void {
    for (const rawRow of changedRows) {
      state.updatedRows.push(rawRow);
      if (!rawRow.id) continue;

      if (!this.isParkedTaskDeltaRow(rawRow)) {
        const taskId = String(rawRow.id);
        state.removedTasks.set(taskId, {
          taskId,
          updatedAt: rawRow.updated_at ? String(rawRow.updated_at) : null,
        });
        state.entryMap.delete(String(rawRow.id));
        continue;
      }

      const projectId = rawRow.project_id ? String(rawRow.project_id) : '';
      if (!projectId) continue;
      const task = rowToTask(rawRow);
      state.entryMap.set(task.id, { task, projectId });
    }
  }

  private isParkedTaskDeltaRow(row: ParkedTaskDeltaRow): boolean {
    const parkingMeta = (row as { parking_meta?: unknown }).parking_meta;
    return parkingMeta !== null && parkingMeta !== undefined && row.deleted_at === null;
  }

  private applyParkedCursorFilter<T>(
    query: T,
    cursorText: string | null,
  ): T {
    const cursor = this.parseParkedCursor(cursorText);
    if (!cursor) return query;
    const cursorQuery = query as unknown as ParkedTaskCursorQuery;
    if (!cursor.id) return cursorQuery.gt('updated_at', cursor.updatedAt) as T;
    return cursorQuery.or(`updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`) as T;
  }

  private computeParkedCursor(since: string | null, rows: ParkedTaskDeltaRow[]): string | null {
    const initialCursor = this.parseParkedCursor(since);
    let maxTs = initialCursor ? Date.parse(initialCursor.updatedAt) : 0;
    let maxId = initialCursor?.id ?? null;
    let maxUpdatedAt = initialCursor?.updatedAt ?? null;

    for (const row of rows) {
      if (!row.updated_at || !row.id) continue;
      const ts = Date.parse(String(row.updated_at));
      const id = String(row.id);
      if (Number.isNaN(ts)) {
        continue;
      }
      if (ts > maxTs || (ts === maxTs && (!maxId || id > maxId))) {
        maxTs = ts;
        maxId = id;
        maxUpdatedAt = new Date(ts).toISOString();
      }
    }
    if (!maxTs || !maxUpdatedAt) return since;
    return maxId
      ? this.encodeParkedCursor(maxUpdatedAt, maxId)
      : maxUpdatedAt;
  }

  private parseParkedCursor(cursorText: string | null): ParkedTaskCursor | null {
    if (!cursorText) return null;
    if (cursorText.startsWith(this.PARKING_SYNC_CURSOR_V2_PREFIX)) {
      const encoded = cursorText.slice(this.PARKING_SYNC_CURSOR_V2_PREFIX.length);
      const separatorIndex = encoded.indexOf(':');
      if (separatorIndex <= 0) return null;
      const updatedAt = decodeURIComponent(encoded.slice(0, separatorIndex));
      const id = decodeURIComponent(encoded.slice(separatorIndex + 1));
      return Number.isNaN(Date.parse(updatedAt)) || !id
        ? null
        : { updatedAt, id };
    }

    return Number.isNaN(Date.parse(cursorText))
      ? null
      : { updatedAt: cursorText, id: null };
  }

  private encodeParkedCursor(updatedAt: string, id: string): string {
    return `${this.PARKING_SYNC_CURSOR_V2_PREFIX}${encodeURIComponent(updatedAt)}:${encodeURIComponent(id)}`;
  }

  private async loadParkedSyncProjectIds(
    client: SupabaseClient,
    normalizeIds: (ids: readonly string[]) => string[],
  ): Promise<string[]> {
    const { data, error } = await fetchAllSupabasePages<ProjectIdRow>(() => client
      .from('projects')
      .select('id')
      .is('deleted_at', null)
      .order('id', { ascending: true }));

    if (error) {
      throw supabaseErrorToError(error);
    }

    return normalizeIds(
      ((data ?? []) as ProjectIdRow[])
        .map((row) => row.id ? String(row.id) : ''),
    );
  }

  private async openFocusModeDB(): Promise<IDBDatabase> {
    return openIndexedDBAdaptive({
      dbName: FOCUS_CONFIG.SYNC.IDB_NAME,
      targetVersion: FOCUS_CONFIG.SYNC.IDB_VERSION,
      requiredStores: [
        FOCUS_CONFIG.IDB_STORES.PARKED_TASKS,
        FOCUS_CONFIG.IDB_STORES.SYNC_METADATA,
      ],
      ensureStores: (db) => {
        if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS)) {
          db.createObjectStore(FOCUS_CONFIG.IDB_STORES.PARKED_TASKS, { keyPath: 'taskId' });
        }
        if (!db.objectStoreNames.contains(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA)) {
          db.createObjectStore(FOCUS_CONFIG.IDB_STORES.SYNC_METADATA, { keyPath: 'key' });
        }
      },
    });
  }

  private emptyDelta(since: string | null): ParkedTaskDeltaResult {
    return { entries: [], removedTasks: [], removedTaskIds: [], nextCursor: since };
  }
}
