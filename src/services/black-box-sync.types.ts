import { TIMEOUT_CONFIG } from '../config/timeout.config';
import { type BlackBoxEntry } from '../models/focus';
import { type BlackBoxSyncCursor } from './black-box-sync-cursor';
import { SupabaseClientService } from './supabase-client.service';
import { type SyncRpcResult } from './sync-rpc-client.service';

/**
 * IndexedDB 中的黑匣子条目格式
 */
export interface IDBBlackBoxEntry extends BlackBoxEntry {
  /** 本地版本号，用于冲突检测 */
  _localVersion?: number;
}

export type BlackBoxSupabaseClient = NonNullable<Awaited<ReturnType<SupabaseClientService['clientAsync']>>>;

/**
 * RetryQueue 回调接口
 * 由 SimpleSyncService 通过 setRetryQueueHandler 注入
 */
export type RetryQueueHandler = (entry: BlackBoxEntry) => Promise<boolean>;
export const BLACKBOX_RPC_REMOTE_NEWER_RECONCILE_REASON = 'rpc-remote-newer';
export const BLACKBOX_RPC_STALE_PAYLOAD_RECONCILE_REASON = 'rpc-stale-payload';
export type BlackBoxRemoteReconcileReason =
  | typeof BLACKBOX_RPC_REMOTE_NEWER_RECONCILE_REASON
  | typeof BLACKBOX_RPC_STALE_PAYLOAD_RECONCILE_REASON;
export type BlackBoxMergeMode = 'remote-pull' | 'authoritative-reconcile';
export type BlackBoxPushPreflightDoneOutcome = { status: 'done'; result: boolean };
export type BlackBoxPushPreflightOutcome =
  | {
      status: 'continue';
      entry: BlackBoxEntry;
      preflightServerEntry: BlackBoxEntry | null;
      syncRpcBaseUpdatedAt: string | null;
    }
  | BlackBoxPushPreflightDoneOutcome;
export type BlackBoxPushPreflightRowOutcome =
  | { status: 'continue'; serverRow: unknown | null }
  | BlackBoxPushPreflightDoneOutcome;
export type BlackBoxPushPreflightConflictOutcome =
  | { status: 'continue' }
  | BlackBoxPushPreflightDoneOutcome
  | { status: 'merge-local-and-push'; mergedEntry: BlackBoxEntry };
export type BlackBoxSavedRow = { id?: string; updated_at?: string | null };
export type BlackBoxUpsertWriteResult = {
  savedRow: BlackBoxSavedRow | null;
  error: unknown | null;
  deferred?: boolean;
};
export type BlackBoxPushGuardOutcome =
  | { status: 'continue'; sessionUserId: string }
  | BlackBoxPushPreflightDoneOutcome;
export type BlackBoxPushPreparedEntryOutcome =
  | { status: 'continue'; entry: BlackBoxEntry }
  | BlackBoxPushPreflightDoneOutcome;

export interface PullChangesOptions {
  reason?: 'startup' | 'resume' | 'manual' | 'panel-open' | 'gate-review';
  force?: boolean;
  expectedUserId?: string;
  expectedRealtimeGeneration?: number;
}
export type BlackBoxPullReason = NonNullable<PullChangesOptions['reason']>;
export type BlackBoxPullContext = {
  reason: BlackBoxPullReason;
  force: boolean;
  expectedUserId?: string;
  expectedRealtimeGeneration?: number;
  pendingEntriesNeedRemoteReconciliation: boolean;
};
export type BlackBoxPullGuardOutcome =
  | { status: 'continue'; preferRemoteForSyncedLocalDuringPull: boolean }
  | { status: 'done' };
export type BlackBoxPullInFlightOutcome =
  | { status: 'continue' }
  | { status: 'done' };
export type BlackBoxRemotePullContext = {
  client: BlackBoxSupabaseClient;
  scopedUserId: string;
};
export type BlackBoxRemotePullPreparationOutcome =
  | { status: 'continue'; context: BlackBoxRemotePullContext }
  | { status: 'done'; result: boolean };
export type BlackBoxPullCursorWindowOutcome =
  | { status: 'continue'; effectiveLastSync: string; repairingFutureCursor: boolean }
  | { status: 'done'; result: boolean };
export type BlackBoxDeltaPullContext = {
  client: BlackBoxSupabaseClient;
  scopedUserId: string;
  effectiveLastSync: string;
  preferRemoteForSyncedLocalDuringPull: boolean;
  repairingFutureCursor: boolean;
  expectedUserId: string | undefined;
  expectedRealtimeGeneration: number | undefined;
};
export type BlackBoxDeltaPullResult =
  | { status: 'completed'; pulledRowCount: number; error: unknown | null }
  | { status: 'aborted'; result: boolean };
export type BlackBoxCompletedDeltaPullResult = Extract<BlackBoxDeltaPullResult, { status: 'completed' }>;
export type BlackBoxDeltaPage = { data: unknown[] | null; error: unknown };
export type BlackBoxDeltaPageCursorOutcome =
  | { status: 'continue'; pageCursor: BlackBoxSyncCursor }
  | { status: 'done' };

export type BlackBoxWidgetNotifyAction = 'read' | 'complete';

export const DIRECT_WIDGET_NOTIFY_TIMEOUT_MS = TIMEOUT_CONFIG.QUICK;

export interface ScheduleBlackBoxSyncOptions {
  immediate?: boolean;
  widgetNotifyAction?: BlackBoxWidgetNotifyAction;
}

export interface LoadBlackBoxLocalOptions {
  expectedUserId?: string;
  requireCurrentUser?: boolean;
}

export type { SyncRpcResult };
