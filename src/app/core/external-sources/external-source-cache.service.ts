import { Injectable, inject } from "@angular/core";
import { del, get, keys, set } from "idb-keyval";
import { AuthService } from "../../../services/auth.service";
import { AUTH_CONFIG } from "../../../config/auth.config";
import { SIYUAN_CONFIG } from "../../../config/siyuan.config";
import type {
  ExternalSourceLink,
  LocalSiyuanPreviewCache,
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

  async loadLinks(): Promise<ExternalSourceLink[]> {
    const value = await get<ExternalSourceLink[]>(this.linksKey());
    return Array.isArray(value) ? value : [];
  }

  async saveLinks(links: ExternalSourceLink[]): Promise<void> {
    await set(this.linksKey(), links);
  }

  async loadPendingLinks(): Promise<ExternalSourceLink[]> {
    const value = await get<ExternalSourceLink[]>(this.pendingLinksKey());
    return Array.isArray(value) ? value : [];
  }

  async upsertPendingLink(link: ExternalSourceLink): Promise<void> {
    const pending = await this.loadPendingLinks();
    const next = new Map(pending.map((item) => [item.id, item]));
    next.set(link.id, link);
    await set(this.pendingLinksKey(), Array.from(next.values()));
  }

  async removePendingLink(linkId: string): Promise<void> {
    const pending = await this.loadPendingLinks();
    const next = pending.filter((link) => link.id !== linkId);
    await set(this.pendingLinksKey(), next);
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
