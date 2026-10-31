import { ATTACHMENT_CONFIG } from '../config';
import type { Attachment } from '../models';

export type AttachmentUrlRefreshValue = { url: string; thumbnailUrl?: string };
export type AttachmentUrlRefreshCallback = (
  refreshedUrls: Map<string, AttachmentUrlRefreshValue>,
) => void;

export interface MonitoredAttachmentUrlRefreshEntry {
  userId: string;
  projectId: string;
  taskId: string;
  attachment: Attachment;
}

interface AttachmentUrlRefreshControllerContext {
  monitoredAttachments: Map<string, MonitoredAttachmentUrlRefreshEntry>;
  isConfigured: () => boolean;
  refreshUrl: (entry: MonitoredAttachmentUrlRefreshEntry) => Promise<AttachmentUrlRefreshValue | null>;
  warn: (message: string, data?: unknown) => void;
}

interface AttachmentUrlRefreshCycle {
  generation: number;
  ownerUserId: string | null;
  callback: AttachmentUrlRefreshCallback | null;
}

interface AttachmentUrlRefreshFlight extends AttachmentUrlRefreshCycle {
  promise: Promise<void>;
}

export class AttachmentUrlRefreshController {
  private ownerUserId: string | null = null;
  private generation = 0;
  private callback: AttachmentUrlRefreshCallback | null = null;
  private refreshFlight: AttachmentUrlRefreshFlight | null = null;
  private destroyed = false;

  constructor(private readonly context: AttachmentUrlRefreshControllerContext) {}

  setCallback(callback: AttachmentUrlRefreshCallback): void {
    if (!this.destroyed) this.callback = callback;
  }

  clearCallback(): void {
    this.callback = null;
  }

  monitor(userId: string, projectId: string, taskId: string, attachment: Attachment): void {
    if (this.destroyed) return;
    if (this.ownerUserId !== null && this.ownerUserId !== userId) {
      this.invalidateMonitoring();
    }
    this.ownerUserId = userId;
    this.context.monitoredAttachments.set(attachment.id, {
      userId,
      projectId,
      taskId,
      attachment,
    });
  }

  unmonitor(attachmentId: string): void {
    this.context.monitoredAttachments.delete(attachmentId);
  }

  clearMonitoring(): void {
    this.invalidateMonitoring();
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.callback = null;
    this.invalidateMonitoring();
  }

  refreshExpiredUrls(): Promise<void> {
    if (this.destroyed || this.context.monitoredAttachments.size === 0 || !this.context.isConfigured()) {
      return Promise.resolve();
    }

    const generation = this.generation;
    const ownerUserId = this.ownerUserId;
    const currentFlight = this.refreshFlight;
    if (currentFlight?.generation === generation && currentFlight.ownerUserId === ownerUserId) {
      return currentFlight.promise;
    }

    const cycle = { generation, ownerUserId, callback: this.callback };
    const promise = this.executeCycle(cycle)
      .catch(error => this.safeWarn('附件 URL 刷新周期失败', { error }))
      .finally(() => {
        if (this.refreshFlight?.promise === promise) this.refreshFlight = null;
      });
    this.refreshFlight = { ...cycle, promise };
    return promise;
  }

  private async executeCycle(cycle: AttachmentUrlRefreshCycle): Promise<void> {
    const refreshedUrls = new Map<string, AttachmentUrlRefreshValue>();
    const monitoredEntries = Array.from(this.context.monitoredAttachments.entries());
    const now = Date.now();

    for (const [attachmentId, entry] of monitoredEntries) {
      if (!this.isCycleCurrent(cycle)) return;
      await this.refreshEntry(cycle, attachmentId, entry, now, refreshedUrls);
    }

    if (!this.isCycleCurrent(cycle) || refreshedUrls.size === 0) return;
    if (!cycle.callback || this.callback !== cycle.callback) return;
    try {
      cycle.callback(refreshedUrls);
    } catch (error) {
      this.safeWarn('附件 URL 刷新回调失败', { error });
    }
  }

  private async refreshEntry(
    cycle: AttachmentUrlRefreshCycle,
    attachmentId: string,
    entry: MonitoredAttachmentUrlRefreshEntry,
    now: number,
    refreshedUrls: Map<string, AttachmentUrlRefreshValue>,
  ): Promise<void> {
    if (this.context.monitoredAttachments.get(attachmentId) !== entry) return;
    const signedAt = entry.attachment.signedAt ?? entry.attachment.createdAt;
    if (now - new Date(signedAt).getTime() <= ATTACHMENT_CONFIG.URL_EXPIRY_BUFFER) return;

    let newUrls: AttachmentUrlRefreshValue | null;
    try {
      newUrls = await this.context.refreshUrl(entry);
    } catch (error) {
      if (this.isCycleCurrent(cycle)) {
        this.safeWarn(`刷新附件 URL 失败: ${attachmentId}`, { error });
      }
      return;
    }

    if (!newUrls || !this.isCycleCurrent(cycle)) return;
    if (this.context.monitoredAttachments.get(attachmentId) !== entry) return;
    const signedAtNow = new Date().toISOString();
    const refreshedValue = { ...newUrls, signedAt: signedAtNow };
    refreshedUrls.set(attachmentId, refreshedValue);
    this.context.monitoredAttachments.set(attachmentId, {
      ...entry,
      attachment: {
        ...entry.attachment,
        url: newUrls.url,
        thumbnailUrl: newUrls.thumbnailUrl,
        signedAt: signedAtNow,
      },
    });
  }

  private isCycleCurrent(cycle: AttachmentUrlRefreshCycle): boolean {
    return !this.destroyed
      && this.generation === cycle.generation
      && this.ownerUserId === cycle.ownerUserId;
  }

  private invalidateMonitoring(): void {
    this.generation += 1;
    this.ownerUserId = null;
    this.refreshFlight = null;
    this.context.monitoredAttachments.clear();
  }

  private safeWarn(message: string, data?: unknown): void {
    try {
      this.context.warn(message, data);
    } catch {
      // Observability failures must not escape the background refresh loop.
    }
  }
}
