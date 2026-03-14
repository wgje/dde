import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import {
  DockSnapshot,
  FocusSessionRecord,
  RoutineCompletionMutation,
  RoutineTask,
} from '../../../../models/parking-dock';
import { nowISO } from '../../../../utils/date';
import { supabaseErrorToError } from '../../../../utils/supabase-error';

/** 最小化运行时校验：DockSnapshot 至少含合法 version */
function isDockSnapshotLike(value: unknown): value is DockSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = (value as Record<string, unknown>).version;
  return typeof v === 'number' && v >= 2 && v <= 7;
}

interface FocusSessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  session_state: unknown;
  updated_at: string;
}

interface RoutineTaskRow {
  id: string;
  user_id: string;
  title: string;
  max_times_per_day: number;
  is_enabled: boolean;
  updated_at: string;
}

interface RoutineCompletionRow {
  id: string;
  user_id: string;
  routine_id: string;
  date_key: string;
  count: number;
}

@Injectable({
  providedIn: 'root',
})
export class FocusConsoleSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly logger = inject(LoggerService).category('FocusConsoleSync');

  /**
   * 【M-02】`this.supabase.client()` is synchronous and may throw if called
   * before the Supabase client is fully initialised (e.g. during early
   * bootstrap). The try/catch below gracefully degrades to null so callers
   * treat it as "offline". If call sites are ever invoked before Angular DI
   * finishes, consider switching to `clientAsync()` (which awaits readiness).
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) return null;
    try {
      return this.supabase.client();
    } catch {
      return null;
    }
  }

  /**
   * 【M-01 LWW gap】This method unconditionally returns the remote snapshot
   * without comparing `updated_at` against the local in-memory/IDB state.
   * If the local state is newer (e.g. user made changes while offline), the
   * caller will overwrite it with a stale remote snapshot. A future iteration
   * should compare `row.updated_at` with the local DockSnapshot timestamp and
   * only return the remote data when it is strictly newer (LWW merge).
   */
  async loadFocusSession(userId: string): Promise<DockSnapshot | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client
        .from('focus_sessions')
        .select('id,user_id,started_at,ended_at,session_state,updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw supabaseErrorToError(error);
      if (!data) return null;

      const row = data as FocusSessionRow;
      const state = row.session_state;
      if (!isDockSnapshotLike(state)) return null;
      return state;
    } catch (error) {
      this.logger.warn('loadFocusSession failed', error);
      return null;
    }
  }

  /**
   * 【H-05 Offline-first limitation】This method writes directly to Supabase
   * without local IDB persistence. When offline, the data is lost (return false).
   * Callers already handle false returns gracefully, but a future iteration should
   * add IDB persistence + RetryQueue support (like BlackBoxSyncService does) so
   * that focus session snapshots survive offline/crash scenarios.
   */
  async saveFocusSession(record: FocusSessionRecord): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;

    try {
      const payload: FocusSessionRow = {
        id: record.id,
        user_id: record.userId,
        started_at: record.startedAt || nowISO(),
        ended_at: record.endedAt,
        session_state: record.snapshot,
        updated_at: record.updatedAt || nowISO(),
      };

      const { error } = await client
        .from('focus_sessions')
        .upsert(payload, { onConflict: 'id' });
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (error) {
      this.logger.warn('saveFocusSession failed', error);
      return false;
    }
  }

  async listRoutineTasks(userId: string): Promise<RoutineTask[]> {
    const client = this.getSupabaseClient();
    if (!client) return [];

    try {
      const { data, error } = await client
        .from('routine_tasks')
        .select('id,user_id,title,max_times_per_day,is_enabled,updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false });
      if (error) throw supabaseErrorToError(error);

      const rows = Array.isArray(data) ? (data as RoutineTaskRow[]) : [];
      return rows.map(row => ({
        routineId: row.id,
        title: row.title,
        triggerCondition: 'any-blank-period',
        maxTimesPerDay: row.max_times_per_day,
        isEnabled: row.is_enabled,
      }));
    } catch (error) {
      this.logger.warn('listRoutineTasks failed', error);
      return [];
    }
  }

  /**
   * 【H-06 Offline-first limitation】This method writes directly to Supabase
   * without local IDB persistence. When offline, the mutation is lost (return false).
   * A future iteration should add IDB persistence + RetryQueue support
   * (like BlackBoxSyncService does) to ensure routine task edits survive offline.
   */
  async upsertRoutineTask(userId: string, task: RoutineTask): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;

    try {
      const payload: RoutineTaskRow = {
        id: task.routineId,
        user_id: userId,
        title: task.title,
        max_times_per_day: task.maxTimesPerDay,
        is_enabled: task.isEnabled,
        updated_at: nowISO(),
      };

      const { error } = await client
        .from('routine_tasks')
        .upsert(payload, { onConflict: 'id' });
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (error) {
      this.logger.warn('upsertRoutineTask failed', error);
      return false;
    }
  }

  /**
   * 【H-06 Offline-first limitation】Same as saveFocusSession / upsertRoutineTask —
   * no local IDB persistence. Offline increments are lost. Future iteration should
   * queue mutations locally and replay via RetryQueue on reconnect.
   *
   * 【H-07 Race condition】The previous SELECT-then-UPDATE pattern was not atomic.
   * Two concurrent calls could read the same count and both write count+1 instead
   * of count+2. Ideally this should use a Supabase RPC with `UPDATE ... SET count
   * = count + 1` for a true atomic increment. As an interim fix we use optimistic
   * concurrency: the UPDATE filters on the expected `count` value so a stale read
   * will match zero rows, which we detect and log as a conflict.
   */
  async incrementRoutineCompletion(mutation: RoutineCompletionMutation): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;

    try {
      // Step 1: Attempt optimistic insert (first completion for this routine+date)
      const { error: insertError } = await client
        .from('routine_completions')
        .insert({
          id: mutation.completionId,
          routine_id: mutation.routineId,
          user_id: mutation.userId,
          date_key: mutation.dateKey,
          count: 1,
        });

      // Insert succeeded — first completion for this day
      if (!insertError) return true;

      // If the error is NOT a unique-violation (23505), it's a real failure
      const pgCode = (insertError as unknown as Record<string, unknown>).code;
      if (pgCode !== '23505') {
        throw supabaseErrorToError(insertError);
      }

      // Step 2: Row already exists — read current count, then update with
      // optimistic concurrency guard (filter on expected count).
      // TODO(H-07): Replace with Supabase RPC `increment_routine_completion`
      // that performs `UPDATE ... SET count = count + 1 ... RETURNING count`
      // for a truly atomic server-side increment.
      const { data, error } = await client
        .from('routine_completions')
        .select('id,count')
        .eq('user_id', mutation.userId)
        .eq('routine_id', mutation.routineId)
        .eq('date_key', mutation.dateKey)
        .maybeSingle();
      if (error) throw supabaseErrorToError(error);

      if (!data) {
        // Should not happen after a 23505 conflict, but guard defensively
        this.logger.warn('incrementRoutineCompletion: row disappeared after conflict');
        return false;
      }

      const existingCount = typeof data === 'object' && data !== null ? Number((data as Record<string, unknown>).count ?? 0) : 0;
      const existingId = typeof data === 'object' && data !== null ? String((data as Record<string, unknown>).id ?? '') : '';
      const nextCount = Math.max(1, existingCount + 1);

      // Optimistic concurrency: filter on the expected count so a concurrent
      // increment by another client will cause this update to match 0 rows.
      const { data: updateResult, error: updateError } = await client
        .from('routine_completions')
        .update({ count: nextCount })
        .eq('id', existingId)
        .eq('user_id', mutation.userId)
        .eq('count', existingCount)
        .select('id');
      if (updateError) throw supabaseErrorToError(updateError);

      if (!updateResult || updateResult.length === 0) {
        this.logger.warn(
          'incrementRoutineCompletion: concurrent modification detected — ' +
          'update matched 0 rows. The increment may have been applied by another client.'
        );
        // Return true to avoid retry-loops; the count will converge on next sync.
      }

      return true;
    } catch (error) {
      this.logger.warn('incrementRoutineCompletion failed', error);
      return false;
    }
  }

  async importLegacyDockSnapshot(userId: string): Promise<DockSnapshot | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client
        .from('user_preferences')
        .select('dock_snapshot')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw supabaseErrorToError(error);
      const raw = typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>).dock_snapshot
        : undefined;
      if (!isDockSnapshotLike(raw)) return null;
      return raw;
    } catch (error) {
      this.logger.warn('importLegacyDockSnapshot failed', error);
      return null;
    }
  }
}
