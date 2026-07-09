import { Injectable } from '@angular/core';
import { clear, createStore, del, get, set, values } from 'idb-keyval';
import { TIMEOUT_CONFIG } from '../config/timeout.config';
import {
  extractSupabaseFunctionErrorMessage,
  readSupabaseFunctionErrorStatus,
} from '../utils/supabase-functions-error';
import type { BlackBoxWidgetNotifyAction } from './black-box-sync.types';

export interface DockDirectWidgetFocusNotifyInput {
  kind?: 'focus';
  focusSessionId: string;
  focusActive: boolean;
  updatedAt: string;
  /** 入队时的所属用户：flush 按当前会话 owner 过滤，防止换号后旧记录以新 JWT 重放 */
  ownerUserId: string;
}

export interface DockDirectWidgetBlackBoxNotifyInput {
  kind: 'black-box';
  entryId: string;
  blackBoxAction: BlackBoxWidgetNotifyAction;
  updatedAt: string;
  /** 入队时的所属用户：flush 按当前会话 owner 过滤，防止换号后旧记录以新 JWT 重放 */
  ownerUserId: string;
}

export type DockDirectWidgetNotifyInput =
  | DockDirectWidgetFocusNotifyInput
  | DockDirectWidgetBlackBoxNotifyInput;

// ownerUserId 由输入接口提供（必填）；升级前的持久化记录可能缺戳，
// flush 的 dropCrossOwnerRecords 按"不可验证归属"在运行时兜底丢弃
interface PendingDockDirectWidgetNotifyBase {
  operationId: string;
  webhookId: string;
  createdAt: string;
  queuedAt: string;
  attemptCount: number;
  lastError?: string;
}

export interface PendingDockDirectWidgetFocusNotifyRecord
  extends DockDirectWidgetFocusNotifyInput, PendingDockDirectWidgetNotifyBase {
  kind: 'focus';
}

export interface PendingDockDirectWidgetBlackBoxNotifyRecord
  extends DockDirectWidgetBlackBoxNotifyInput, PendingDockDirectWidgetNotifyBase {}

export type PendingDockDirectWidgetNotifyRecord =
  | PendingDockDirectWidgetFocusNotifyRecord
  | PendingDockDirectWidgetBlackBoxNotifyRecord;

export interface DockDirectWidgetNotifyFlushResult {
  ok: boolean;
  sentCount: number;
  remainingCount: number;
  errors: string[];
}

export interface DockDirectWidgetNotifyClient {
  functions: {
    invoke(
      name: string,
      options: {
        timeout: number;
        body: Record<string, unknown>;
      },
    ): Promise<{ data: unknown; error: { message?: string } | null }>;
  };
  /** 可选：flush 前解析当前会话 owner 用于跨账号记录过滤（真实 Supabase client 恒有） */
  auth?: {
    getSession(): Promise<{
      data: { session: { user?: { id?: string | null } | null } | null };
      error?: unknown;
    }>;
  };
}

interface DockDirectWidgetNotifySendResult {
  sentCount: number;
  error?: string;
}

const DOCK_DIRECT_WIDGET_NOTIFY_DB_NAME = 'nanoflow-dock-direct-widget-notify-outbox';
const DOCK_DIRECT_WIDGET_NOTIFY_STORE_NAME = 'pending-notifications';
const DOCK_DIRECT_WIDGET_NOTIFY_FALLBACK_KEY_PREFIX = 'nanoflow.dock-direct-widget-notify.';
const BLACK_BOX_NOTIFY_KEY_PREFIX = 'black-box:';
/**
 * 直连 widget-notify 是 best-effort 推送通道（小组件仍会通过轮询对齐）：
 * 单条记录的重试必须封顶，否则 schema 漂移等永久 4xx 拒绝会让 outbox 在每次重连时无限重放
 */
const DIRECT_WIDGET_NOTIFY_MAX_ATTEMPTS = 10;

const dockDirectWidgetNotifyStore = createStore(
  DOCK_DIRECT_WIDGET_NOTIFY_DB_NAME,
  DOCK_DIRECT_WIDGET_NOTIFY_STORE_NAME,
);

@Injectable({ providedIn: 'root' })
export class DockDirectWidgetNotifyOutboxService {
  /**
   * flush 单飞：flappy 网络下两次 restore 扇出可能重叠，
   * 读-发-删无锁并发会对同一批 pending 记录重复 invoke widget-notify。
   */
  private flushPendingNotificationsPromise: Promise<DockDirectWidgetNotifyFlushResult> | null = null;

  async enqueueLatest(input: DockDirectWidgetNotifyInput): Promise<PendingDockDirectWidgetNotifyRecord> {
    if (this.isBlackBoxInput(input)) {
      return this.enqueueLatestBlackBox(input);
    }

    return this.enqueueLatestFocus(input);
  }

  private async enqueueLatestFocus(
    input: DockDirectWidgetFocusNotifyInput,
  ): Promise<PendingDockDirectWidgetFocusNotifyRecord> {
    const focusSessionId = input.focusSessionId.trim();
    if (!focusSessionId) {
      throw new Error('focusSessionId is required for direct widget notify outbox');
    }

    const existing = await this.readStoredRecord(focusSessionId);
    const now = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const record: PendingDockDirectWidgetFocusNotifyRecord = {
      kind: 'focus',
      operationId,
      webhookId: `pwa-direct-${operationId}`,
      focusSessionId,
      focusActive: input.focusActive,
      updatedAt: input.updatedAt,
      createdAt: existing?.createdAt ?? now,
      queuedAt: now,
      attemptCount: 0,
      ownerUserId: input.ownerUserId,
    };
    await this.writeRecord(record);
    return record;
  }

  private async enqueueLatestBlackBox(
    input: DockDirectWidgetBlackBoxNotifyInput,
  ): Promise<PendingDockDirectWidgetBlackBoxNotifyRecord> {
    const entryId = input.entryId.trim();
    if (!entryId) {
      throw new Error('entryId is required for black-box direct widget notify outbox');
    }

    const key = this.getBlackBoxRecordKey(entryId, input.blackBoxAction);
    const existing = await this.readStoredRecord(key);
    const now = new Date().toISOString();
    const operationId = crypto.randomUUID();
    const record: PendingDockDirectWidgetBlackBoxNotifyRecord = {
      kind: 'black-box',
      operationId,
      webhookId: `pwa-blackbox-${operationId}`,
      entryId,
      blackBoxAction: input.blackBoxAction,
      updatedAt: input.updatedAt,
      createdAt: existing?.createdAt ?? now,
      queuedAt: now,
      attemptCount: 0,
      ownerUserId: input.ownerUserId,
    };
    await this.writeRecord(record);
    return record;
  }

  async listPendingNotifications(): Promise<PendingDockDirectWidgetNotifyRecord[]> {
    let records: PendingDockDirectWidgetNotifyRecord[] = [];
    try {
      records = await values<PendingDockDirectWidgetNotifyRecord>(dockDirectWidgetNotifyStore);
    } catch {
      records = [];
    }

    const byKey = new Map(records.map(record => [this.getRecordKey(record), record]));
    this.loadAllFallbackRecords().forEach(record => {
      const key = this.getRecordKey(record);
      if (!byKey.has(key)) {
        byKey.set(key, record);
      }
    });

    return Array.from(byKey.values())
      .sort((left, right) =>
        left.queuedAt.localeCompare(right.queuedAt) || this.getRecordKey(left).localeCompare(this.getRecordKey(right))
      );
  }

  async flushPendingNotifications(
    client: DockDirectWidgetNotifyClient | null,
  ): Promise<DockDirectWidgetNotifyFlushResult> {
    if (this.flushPendingNotificationsPromise) {
      return this.flushPendingNotificationsPromise;
    }

    this.flushPendingNotificationsPromise = this.flushPendingNotificationsInternal(client)
      .finally(() => {
        this.flushPendingNotificationsPromise = null;
      });
    return this.flushPendingNotificationsPromise;
  }

  private async flushPendingNotificationsInternal(
    client: DockDirectWidgetNotifyClient | null,
  ): Promise<DockDirectWidgetNotifyFlushResult> {
    let pending = await this.listPendingNotifications();
    if (pending.length === 0) {
      return {
        ok: true,
        sentCount: 0,
        remainingCount: 0,
        errors: [],
      };
    }

    if (!client) {
      const message = 'Supabase client unavailable';
      await this.markRecordsFailed(pending, message);
      return {
        ok: false,
        sentCount: 0,
        remainingCount: pending.length,
        errors: [message],
      };
    }

    pending = await this.dropCrossOwnerRecords(client, pending);

    const errors: string[] = [];
    let sentCount = 0;

    for (const record of pending) {
      const result = await this.sendPendingNotification(client, record);
      sentCount += result.sentCount;
      if (result.error) {
        errors.push(result.error);
      }
    }

    return {
      ok: errors.length === 0,
      sentCount,
      remainingCount: (await this.listPendingNotifications()).length,
      errors,
    };
  }

  /**
   * 换号防护：sign-out 全量擦除覆盖不了 partial-wipe / 直接切号路径，
   * flush 前按当前会话 owner 过滤——其他 owner 或缺戳（升级前遗留、无法验证归属）的记录
   * 直接丢弃而不是以当前 JWT 发送（widget-notify 会把 payload 归到当前 JWT 用户名下）。
   * 直推是 best-effort 加速通道，小组件轮询会最终对齐，丢弃不影响数据正确性。
   * 会话 owner 解析不出来（测试桩无 auth / 会话缺失）时不过滤，交由 invoke 的 401 路径处理。
   */
  private async dropCrossOwnerRecords(
    client: DockDirectWidgetNotifyClient,
    pending: PendingDockDirectWidgetNotifyRecord[],
  ): Promise<PendingDockDirectWidgetNotifyRecord[]> {
    const currentOwnerId = await this.resolveClientOwnerId(client);
    if (!currentOwnerId) {
      return pending;
    }

    const kept: PendingDockDirectWidgetNotifyRecord[] = [];
    for (const record of pending) {
      if (record.ownerUserId === currentOwnerId) {
        kept.push(record);
        continue;
      }
      await this.removeRecord(record);
    }
    return kept;
  }

  private async resolveClientOwnerId(client: DockDirectWidgetNotifyClient): Promise<string | null> {
    if (!client.auth) {
      return null;
    }

    try {
      const sessionResult = await client.auth.getSession();
      const ownerId = sessionResult.data.session?.user?.id;
      return typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：会话解析失败时不过滤，交由 invoke 的 401 路径处理
      return null;
    }
  }

  async removeRecord(recordOrKey: PendingDockDirectWidgetNotifyRecord | string): Promise<void> {
    const key = typeof recordOrKey === 'string'
      ? recordOrKey.trim()
      : this.getRecordKey(recordOrKey);
    if (!key) {
      return;
    }

    try {
      await del(key, dockDirectWidgetNotifyStore);
    } finally {
      this.removeFallbackRecord(key);
    }
  }

  async clearPendingNotificationsForTests(): Promise<void> {
    try {
      await clear(dockDirectWidgetNotifyStore);
    } finally {
      this.clearFallbackRecords();
    }
  }

  buildInvokeBody(record: PendingDockDirectWidgetNotifyRecord): Record<string, unknown> {
    if (this.isBlackBoxRecord(record)) {
      return {
        directNotify: true,
        webhookId: record.webhookId,
        table: 'black_box_entries',
        entryId: record.entryId,
        blackBoxAction: record.blackBoxAction,
        updatedAt: record.updatedAt,
      };
    }

    return {
      directNotify: true,
      webhookId: record.webhookId,
      focusActive: record.focusActive,
      focusSessionId: record.focusSessionId,
      updatedAt: record.updatedAt,
    };
  }

  private async readStoredRecord(key: string): Promise<PendingDockDirectWidgetNotifyRecord | null> {
    try {
      const record = await get<PendingDockDirectWidgetNotifyRecord>(key, dockDirectWidgetNotifyStore);
      if (record) {
        return record;
      }
    } catch {
      // Fall through to localStorage fallback.
    }

    return this.loadFallbackRecord(key);
  }

  private async sendPendingNotification(
    client: DockDirectWidgetNotifyClient,
    record: PendingDockDirectWidgetNotifyRecord,
  ): Promise<DockDirectWidgetNotifySendResult> {
    try {
      const { error } = await client.functions.invoke('widget-notify', {
        timeout: TIMEOUT_CONFIG.QUICK,
        body: this.buildInvokeBody(record),
      });
      if (error) {
        // 保留 Edge Function 响应体里的业务错误信息（如 INVALID_PAYLOAD），而不是外层 transport 文案
        const message = await extractSupabaseFunctionErrorMessage(error, 'Widget direct notify failed');
        return this.recordSendFailure(record, message, readSupabaseFunctionErrorStatus(error));
      }

      await this.removeRecord(record);
      return { sentCount: 1 };
    } catch (error) {
      const message = await extractSupabaseFunctionErrorMessage(error, 'Widget direct notify failed');
      return this.recordSendFailure(record, message, readSupabaseFunctionErrorStatus(error));
    }
  }

  private async recordSendFailure(
    record: PendingDockDirectWidgetNotifyRecord,
    message: string,
    status: number | null,
  ): Promise<DockDirectWidgetNotifySendResult> {
    if (this.isPermanentSendFailure(record, status)) {
      await this.removeRecord(record);
      return { sentCount: 0, error: message };
    }

    await this.markRecordsFailed([record], message);
    return { sentCount: 0, error: message };
  }

  /**
   * 4xx 业务拒绝（401 会话可刷新 / 408 超时 / 429 限流除外）和达到重试上限的记录不再保留：
   * 直连通知只是加速通道，小组件轮询会最终对齐，无限重放只会持续消耗流量
   */
  private isPermanentSendFailure(
    record: PendingDockDirectWidgetNotifyRecord,
    status: number | null,
  ): boolean {
    if (record.attemptCount + 1 >= DIRECT_WIDGET_NOTIFY_MAX_ATTEMPTS) {
      return true;
    }

    if (status === null) {
      return false;
    }

    return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
  }

  private async writeRecord(record: PendingDockDirectWidgetNotifyRecord): Promise<void> {
    const key = this.getRecordKey(record);
    try {
      await set(key, record, dockDirectWidgetNotifyStore);
      this.removeFallbackRecord(key);
    } catch {
      this.saveFallbackRecord(record);
    }
  }

  private async markRecordsFailed(
    records: PendingDockDirectWidgetNotifyRecord[],
    error: string,
  ): Promise<void> {
    const queuedAt = new Date().toISOString();
    for (const record of records) {
      await this.writeRecord({
        ...record,
        queuedAt,
        attemptCount: record.attemptCount + 1,
        lastError: error,
      });
    }
  }

  private saveFallbackRecord(record: PendingDockDirectWidgetNotifyRecord): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(this.getFallbackKey(this.getRecordKey(record)), JSON.stringify(record));
  }

  private loadFallbackRecord(key: string): PendingDockDirectWidgetNotifyRecord | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }

    let raw: string | null = null;
    let shouldRemoveFallback = false;
    try {
      raw = localStorage.getItem(this.getFallbackKey(key));
    } catch {
      shouldRemoveFallback = true;
    }

    if (!raw) {
      if (shouldRemoveFallback) {
        this.removeFallbackRecord(key);
      }
      return null;
    }

    try {
      return JSON.parse(raw) as PendingDockDirectWidgetNotifyRecord;
    } catch {
      this.removeFallbackRecord(key);
    }

    return null;
  }

  private loadAllFallbackRecords(): PendingDockDirectWidgetNotifyRecord[] {
    return this.listFallbackKeys()
      .map(key => this.loadFallbackRecord(key.slice(DOCK_DIRECT_WIDGET_NOTIFY_FALLBACK_KEY_PREFIX.length)))
      .filter((record): record is PendingDockDirectWidgetNotifyRecord => record !== null);
  }

  private removeFallbackRecord(key: string): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.removeItem(this.getFallbackKey(key));
  }

  private clearFallbackRecords(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    this.listFallbackKeys().forEach(key => localStorage.removeItem(key));
  }

  private listFallbackKeys(): string[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(DOCK_DIRECT_WIDGET_NOTIFY_FALLBACK_KEY_PREFIX)) {
        keys.push(key);
      }
    }
    return keys;
  }

  private getFallbackKey(key: string): string {
    return `${DOCK_DIRECT_WIDGET_NOTIFY_FALLBACK_KEY_PREFIX}${key}`;
  }

  private getRecordKey(record: PendingDockDirectWidgetNotifyRecord): string {
    if (this.isBlackBoxRecord(record)) {
      return this.getBlackBoxRecordKey(record.entryId, record.blackBoxAction);
    }
    return record.focusSessionId.trim();
  }

  private getBlackBoxRecordKey(entryId: string, action: BlackBoxWidgetNotifyAction): string {
    return `${BLACK_BOX_NOTIFY_KEY_PREFIX}${entryId}:${action}`;
  }

  private isBlackBoxInput(input: DockDirectWidgetNotifyInput): input is DockDirectWidgetBlackBoxNotifyInput {
    return input.kind === 'black-box';
  }

  private isBlackBoxRecord(
    record: PendingDockDirectWidgetNotifyRecord,
  ): record is PendingDockDirectWidgetBlackBoxNotifyRecord {
    return record.kind === 'black-box';
  }
}
