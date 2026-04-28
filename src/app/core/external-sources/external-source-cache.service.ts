import { Injectable, inject } from "@angular/core";
import { del, get, keys, set, update } from "idb-keyval";
import { AuthService } from "../../../services/auth.service";
import { AUTH_CONFIG } from "../../../config/auth.config";
import { SIYUAN_CONFIG } from "../../../config/siyuan.config";
import type {
  ExternalSourceLink,
  LocalSiyuanPreviewCache,
  PendingExternalSourceLink,
  SiyuanLocalConfig,
} from "./external-source.model";

@Injectable({ providedIn: "root" })
export class ExternalSourceCacheService {
  private readonly auth = inject(AuthService);

  ownerId(): string {
    return this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private linksKey(userId = this.ownerId()): string {
    return `external-source-links:${userId}`;
  }

  previewKey(linkId: string, blockId: string, userId = this.ownerId()): string {
    return `siyuan-preview-cache:${userId}:${linkId}:${blockId}`;
  }

  private legacyPreviewKey(linkId: string, blockId: string): string {
    return `siyuan-preview-cache:${linkId}:${blockId}`;
  }

  private configKey(userId = this.ownerId()): string {
    return `siyuan-local-config:${userId}`;
  }

  private pendingLinksKey(userId = this.ownerId()): string {
    return `external-source-pending:${userId}`;
  }

  private deadLettersKey(userId = this.ownerId()): string {
    return `external-source-deadletters:${userId}`;
  }

  async loadLinks(): Promise<ExternalSourceLink[]> {
    const value = await get<ExternalSourceLink[]>(this.linksKey());
    return Array.isArray(value) ? value : [];
  }

  async saveLinks(links: ExternalSourceLink[]): Promise<void> {
    await set(this.linksKey(), links);
  }

  async loadPendingLinks(): Promise<PendingExternalSourceLink[]> {
    const value = await get<PendingExternalSourceLink[]>(this.pendingLinksKey());
    return Array.isArray(value) ? value.filter((entry) => entry?.link?.id) : [];
  }

  /**
   * 原子化 upsert：使用 idb-keyval.update 在同一 IDB readwrite 事务内完成
   * read-modify-write，避免与 flushPendingLinks 并发时丢写。
   */
  async upsertPendingLink(
    link: ExternalSourceLink,
    options: { resetRetryCount?: boolean } = {},
  ): Promise<void> {
    await update<PendingExternalSourceLink[]>(this.pendingLinksKey(), (current) => {
      const list = Array.isArray(current) ? current : [];
      const next = new Map(list.map((entry) => [entry.link.id, entry]));
      const previous = next.get(link.id);
      next.set(link.id, {
        link,
        retryCount: options.resetRetryCount ? 0 : previous?.retryCount ?? 0,
        lastTriedAt: previous?.lastTriedAt,
        lastErrorCode: previous?.lastErrorCode,
      });
      return Array.from(next.values());
    });
  }

  async removePendingLink(linkId: string): Promise<void> {
    await update<PendingExternalSourceLink[]>(this.pendingLinksKey(), (current) => {
      if (!Array.isArray(current)) return [];
      return current.filter((entry) => entry.link.id !== linkId);
    });
  }

  /**
   * 标记一次推送失败，递增 retryCount。超过 PENDING_MAX_RETRIES 则迁出到死信表。
   */
  async recordPendingFailure(linkId: string, errorCode: string): Promise<void> {
    let movedToDeadLetter: PendingExternalSourceLink | null = null;
    await update<PendingExternalSourceLink[]>(this.pendingLinksKey(), (current) => {
      const list = Array.isArray(current) ? current : [];
      const next: PendingExternalSourceLink[] = [];
      for (const entry of list) {
        if (entry.link.id !== linkId) {
          next.push(entry);
          continue;
        }
        const updated: PendingExternalSourceLink = {
          link: entry.link,
          retryCount: (entry.retryCount ?? 0) + 1,
          lastTriedAt: new Date().toISOString(),
          lastErrorCode: errorCode,
        };
        if (updated.retryCount > SIYUAN_CONFIG.PENDING_MAX_RETRIES) {
          movedToDeadLetter = updated;
        } else {
          next.push(updated);
        }
      }
      return next;
    });
    if (movedToDeadLetter) await this.appendDeadLetter(movedToDeadLetter);
  }

  async loadDeadLetters(): Promise<PendingExternalSourceLink[]> {
    const value = await get<PendingExternalSourceLink[]>(this.deadLettersKey());
    return Array.isArray(value) ? value : [];
  }

  private async appendDeadLetter(entry: PendingExternalSourceLink): Promise<void> {
    await update<PendingExternalSourceLink[]>(this.deadLettersKey(), (current) => {
      const list = Array.isArray(current) ? current : [];
      // 同 id 只保留最后一次失败记录，避免无界增长。
      const next = new Map(list.map((item) => [item.link.id, item]));
      next.set(entry.link.id, entry);
      return Array.from(next.values());
    });
  }

  async getPreview(
    linkId: string,
    blockId: string,
  ): Promise<LocalSiyuanPreviewCache | null> {
    const value = await get<LocalSiyuanPreviewCache>(
      this.previewKey(linkId, blockId),
    );
    if (value?.linkId === linkId && value.blockId === blockId) return value;

    const legacy = await get<LocalSiyuanPreviewCache>(
      this.legacyPreviewKey(linkId, blockId),
    );
    if (!legacy || legacy.linkId !== linkId || legacy.blockId !== blockId)
      return null;
    await this.savePreview(legacy);
    await del(this.legacyPreviewKey(linkId, blockId));
    return legacy;
  }

  async savePreview(cache: LocalSiyuanPreviewCache): Promise<void> {
    await set(this.previewKey(cache.linkId, cache.blockId), cache);
    await this.prunePreviewCache();
  }

  async deletePreview(linkId: string, blockId: string): Promise<void> {
    await Promise.all([
      del(this.previewKey(linkId, blockId)),
      del(this.legacyPreviewKey(linkId, blockId)),
    ]);
  }

  async deletePreviewsForLink(linkId: string): Promise<void> {
    const allKeys = await keys();
    const prefix = `siyuan-preview-cache:${this.ownerId()}:${linkId}:`;
    const legacyPrefix = `siyuan-preview-cache:${linkId}:`;
    await Promise.all(
      allKeys
        .filter(
          (key) =>
            typeof key === "string" &&
            (key.startsWith(prefix) || key.startsWith(legacyPrefix)),
        )
        .map((key) => del(key)),
    );
  }

  async clearPreviewCache(): Promise<void> {
    const allKeys = await keys();
    const prefix = `siyuan-preview-cache:${this.ownerId()}:`;
    await Promise.all(
      allKeys
        .filter((key) => typeof key === "string" && key.startsWith(prefix))
        .map((key) => del(key)),
    );
  }

  async loadConfig(): Promise<SiyuanLocalConfig> {
    const value = await get<SiyuanLocalConfig>(this.configKey());
    return {
      runtimeMode: value?.runtimeMode ?? "extension-relay",
      baseUrl: value?.baseUrl ?? SIYUAN_CONFIG.DEFAULT_BASE_URL,
      token: value?.token,
      previewStrategy: "excerpt-first",
      autoRefresh: value?.autoRefresh ?? "on-hover",
    };
  }

  async saveConfig(config: SiyuanLocalConfig): Promise<void> {
    await set(this.configKey(), config);
  }

  async forgetConfig(): Promise<void> {
    await del(this.configKey());
  }

  private async prunePreviewCache(): Promise<void> {
    const prefix = `siyuan-preview-cache:${this.ownerId()}:`;
    const allKeys = (await keys()).filter(
      (key): key is string => typeof key === "string" && key.startsWith(prefix),
    );
    if (allKeys.length <= SIYUAN_CONFIG.MAX_PREVIEW_CACHE_ENTRIES) return;

    const entries = await Promise.all(
      allKeys.map(async (key) => ({
        key,
        value: await get<LocalSiyuanPreviewCache>(key),
      })),
    );
    entries.sort(
      (a, b) => this.fetchedAtMs(a.value) - this.fetchedAtMs(b.value),
    );
    const excess = entries.slice(
      0,
      entries.length - SIYUAN_CONFIG.MAX_PREVIEW_CACHE_ENTRIES,
    );
    await Promise.all(excess.map((entry) => del(entry.key)));
  }

  private fetchedAtMs(value: LocalSiyuanPreviewCache | undefined): number {
    if (!value?.fetchedAt) return 0;
    const time = new Date(value.fetchedAt).getTime();
    return Number.isFinite(time) ? time : 0;
  }
}
