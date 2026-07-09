import { TIMEOUT_CONFIG } from '../config/timeout.config';
import type { DockSnapshot } from '../models/parking-dock';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import type {
  DockDirectWidgetNotifyOutboxService,
  PendingDockDirectWidgetNotifyRecord,
} from './dock-direct-widget-notify-outbox.service';
import type { CategoryLogger } from './logger.service';
import type { SupabaseClientService } from './supabase-client.service';

const DIRECT_WIDGET_NOTIFY_TIMEOUT_MS = TIMEOUT_CONFIG.QUICK;
const DIRECT_WIDGET_NOTIFY_DEDUP_WINDOW_MS = 1000;

interface DockDirectWidgetNotifyInvocation {
  body: Record<string, unknown>;
  pendingRecord: PendingDockDirectWidgetNotifyRecord | null;
}

export interface DockDirectWidgetNotifyControllerOptions {
  isDestroyed: () => boolean;
  logger: Pick<CategoryLogger, 'debug'>;
  outbox?: Pick<DockDirectWidgetNotifyOutboxService, 'buildInvokeBody' | 'enqueueLatest' | 'removeRecord'>;
  supabase: SupabaseClientService;
}

export class DockDirectWidgetNotifyController {
  private notifyRequestId = 0;
  private readonly activeNotifyKeys = new Set<string>();
  private readonly recentNotifyKeys = new Map<string, ReturnType<typeof globalThis.setTimeout>>();

  constructor(private readonly options: DockDirectWidgetNotifyControllerOptions) {}

  dispose(): void {
    this.notifyRequestId += 1;
    this.activeNotifyKeys.clear();
    for (const timer of this.recentNotifyKeys.values()) {
      globalThis.clearTimeout(timer);
    }
    this.recentNotifyKeys.clear();
  }

  async notifyFocusChange(
    userId: string,
    snapshot: DockSnapshot,
    focusActive: boolean,
  ): Promise<void> {
    if (this.options.isDestroyed()) {
      return;
    }

    const requestId = ++this.notifyRequestId;
    const context = { userId, focusActive, source: 'focus' };
    if (this.shouldSkipDirectWidgetNotify(context)) {
      return;
    }

    const focusSessionId = this.getFocusSessionId(snapshot);
    if (!focusSessionId) {
      this.options.logger.debug('direct widget-notify skipped without focus session id', {
        userId,
        focusActive,
      });
      return;
    }

    const notifyKey = this.createNotifyKey(focusSessionId, focusActive);
    if (this.isNotifyKeyDeduped(notifyKey)) {
      this.options.logger.debug('direct widget-notify skipped as duplicate', {
        userId,
        focusActive,
        focusSessionId,
      });
      return;
    }

    this.activeNotifyKeys.add(notifyKey);

    if (!(await this.hasUsableDirectWidgetNotifySession(context))
      || !this.isCurrentRequest(requestId)) {
      this.activeNotifyKeys.delete(notifyKey);
      return;
    }

    await this.invokeWidgetNotify(userId, snapshot, focusActive, focusSessionId, requestId, notifyKey);
  }

  private isCurrentRequest(requestId: number): boolean {
    return !this.options.isDestroyed() && requestId === this.notifyRequestId;
  }

  private createNotifyKey(focusSessionId: string, focusActive: boolean): string {
    return `${focusSessionId}:${focusActive ? 'on' : 'off'}`;
  }

  private isNotifyKeyDeduped(notifyKey: string): boolean {
    return this.activeNotifyKeys.has(notifyKey) || this.recentNotifyKeys.has(notifyKey);
  }

  private getFocusSessionId(snapshot: DockSnapshot): string | null {
    const candidates = [
      snapshot.session?.focusSessionId,
      snapshot.focusSessionState?.sessionId,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return null;
  }

  private shouldSkipDirectWidgetNotify(context: Record<string, unknown>): boolean {
    if (!isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    this.options.logger.debug('direct widget-notify skipped during browser network suspension', {
      ...context,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    return true;
  }

  private async hasUsableDirectWidgetNotifySession(
    context: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const sessionResult = await this.options.supabase.getSession();
      const session = sessionResult.data.session;

      if (!session?.access_token || sessionResult.error) {
        this.options.logger.debug('direct widget-notify skipped without active session', {
          ...context,
          reason: sessionResult.error?.name ?? 'session-missing',
        });
        return false;
      }

      return true;
    } catch (error) {
      this.options.logger.debug('direct widget-notify skipped while reading session', {
        ...context,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async invokeWidgetNotify(
    userId: string,
    snapshot: DockSnapshot,
    focusActive: boolean,
    focusSessionId: string,
    requestId: number,
    notifyKey: string,
  ): Promise<void> {
    try {
      const invocation = await this.createWidgetNotifyInvocation(snapshot, focusActive, focusSessionId, userId);
      const client = await this.options.supabase.clientAsync();
      if (!client || !this.isCurrentRequest(requestId)) {
        this.activeNotifyKeys.delete(notifyKey);
        return;
      }

      const { error } = await client.functions.invoke('widget-notify', {
        timeout: DIRECT_WIDGET_NOTIFY_TIMEOUT_MS,
        body: invocation.body,
      });
      this.markRecentNotify(notifyKey);
      if (error) {
        this.options.logger.debug('direct widget-notify skipped', {
          userId,
          focusActive,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (invocation.pendingRecord) {
        await this.options.outbox?.removeRecord(invocation.pendingRecord);
      }
    } catch (error) {
      this.options.logger.debug('direct widget-notify threw', {
        userId,
        focusActive,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeNotifyKeys.delete(notifyKey);
    }
  }

  private async createWidgetNotifyInvocation(
    snapshot: DockSnapshot,
    focusActive: boolean,
    focusSessionId: string,
    ownerUserId: string,
  ): Promise<DockDirectWidgetNotifyInvocation> {
    const updatedAt = snapshot.savedAt ?? new Date().toISOString();
    const pendingRecord = this.options.outbox
      ? await this.options.outbox.enqueueLatest({
        focusSessionId,
        focusActive,
        updatedAt,
        ownerUserId,
      })
      : null;
    const webhookId = pendingRecord?.webhookId
      ?? `pwa-direct-${focusSessionId}-${focusActive ? 'on' : 'off'}-${Math.floor(Date.now() / 1000)}`;
    const body = pendingRecord && this.options.outbox
      ? this.options.outbox.buildInvokeBody(pendingRecord)
      : {
        directNotify: true,
        webhookId,
        focusActive,
        focusSessionId,
        updatedAt,
      };
    return { body, pendingRecord };
  }

  private markRecentNotify(notifyKey: string): void {
    const existingTimer = this.recentNotifyKeys.get(notifyKey);
    if (existingTimer !== undefined) {
      globalThis.clearTimeout(existingTimer);
    }

    const timer = globalThis.setTimeout(() => {
      if (this.recentNotifyKeys.get(notifyKey) === timer) {
        this.recentNotifyKeys.delete(notifyKey);
      }
    }, DIRECT_WIDGET_NOTIFY_DEDUP_WINDOW_MS);
    this.recentNotifyKeys.set(notifyKey, timer);
  }
}
