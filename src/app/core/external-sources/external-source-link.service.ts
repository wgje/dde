import { Injectable, computed, inject } from "@angular/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseClientService } from "../../../services/supabase-client.service";
import { AuthService } from "../../../services/auth.service";
import { ToastService } from "../../../services/toast.service";
import { LoggerService } from "../../../services/logger.service";
import { AUTH_CONFIG } from "../../../config/auth.config";
import { SIYUAN_CONFIG } from "../../../config/siyuan.config";
import { ExternalSourceCacheService } from "./external-source-cache.service";
import { ExternalSourceLinkStore } from "./external-source-link.store";
import type {
  ExternalSourceLink,
  ExternalSourceRole,
} from "./external-source.model";
import {
  normalizeSiyuanUri,
  parseSiyuanBlockLink,
  shortenSiyuanBlockId,
} from "./siyuan/siyuan-link-parser";

interface ExternalSourceLinkRow {
  id: string;
  user_id: string;
  task_id: string;
  source_type: "siyuan-block";
  target_id: string;
  uri: string;
  label: string | null;
  hpath: string | null;
  role: ExternalSourceRole | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ExternalSourceLinkTableSchema {
  public: {
    Tables: {
      external_source_links: {
        Row: ExternalSourceLinkRow;
        Insert: ExternalSourceLinkRow;
        Update: Partial<ExternalSourceLinkRow>;
        Relationships: [];
      };
    };
  };
}

type ExternalSourceSupabaseClient =
  SupabaseClient<ExternalSourceLinkTableSchema>;

@Injectable({ providedIn: "root" })
export class ExternalSourceLinkService {
  private readonly store = inject(ExternalSourceLinkStore);
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly logger =
    inject(LoggerService).category("ExternalSourceLink");

  readonly links = this.store.links;
  readonly activeLinks = computed(() =>
    this.links().filter((link) => !link.deletedAt),
  );
  private initialized = false;
  private loadedOwnerId: string | null = null;
  private flushPromise: Promise<void> | null = null;

  async ensureLoaded(): Promise<void> {
    const ownerId = this.currentUserId();
    if (this.initialized && this.loadedOwnerId === ownerId) return;
    this.initialized = true;
    this.loadedOwnerId = ownerId;

    const localLinks = await this.cache.loadLinks();
    this.store.replaceAll(this.mergeLinks(localLinks, []));
    const remoteLinks = await this.pullRemoteLinks();
    const merged = this.mergeLinks(localLinks, remoteLinks);
    this.store.replaceAll(merged);
    await this.cache.saveLinks(merged);
    await this.pushLocalNewerLinks(merged, remoteLinks);
    void this.flushPendingLinks();
  }

  activeLinksForTask(taskId: string): ExternalSourceLink[] {
    void this.ensureLoaded();
    return this.store.activeLinksForTask(taskId);
  }

  firstActiveLinkForTask(taskId: string): ExternalSourceLink | null {
    void this.ensureLoaded();
    return this.store.firstActiveLinkForTask(taskId);
  }

  async bindSiyuanBlock(
    taskId: string,
    input: string,
    role: ExternalSourceRole = "context",
  ): Promise<ExternalSourceLink | null> {
    const parsed = parseSiyuanBlockLink(input);
    if (!parsed) {
      this.toast.error(
        "思源链接无效",
        "请粘贴 siyuan://blocks/{id} 或思源块 ID",
      );
      return null;
    }

    await this.ensureLoaded();
    const existing = this.store
      .activeLinksForTask(taskId)
      .find(
        (link) =>
          link.sourceType === "siyuan-block" &&
          link.targetId === parsed.blockId,
      );
    if (existing) return existing;

    const now = new Date().toISOString();
    const link: ExternalSourceLink = {
      id: crypto.randomUUID(),
      taskId,
      sourceType: "siyuan-block",
      targetId: parsed.blockId,
      uri: parsed.uri,
      label: `思源 ${shortenSiyuanBlockId(parsed.blockId)}`,
      role,
      sortOrder: this.store.activeLinksForTask(taskId).length,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.persistLocal(link);
    await this.cache.upsertPendingLink(link);
    void this.flushPendingLinks();
    this.toast.success("已关联思源块");
    return link;
  }

  async removeLink(linkId: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.store.getLink(linkId);
    if (!existing) return;
    const link = {
      ...existing,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.persistLocal(link);
    await this.cache.deletePreviewsForLink(link.id);
    await this.cache.upsertPendingLink(link);
    void this.flushPendingLinks();
    this.toast.info("已解除思源关联");
  }

  async updateMetadata(
    linkId: string,
    patch: Pick<
      Partial<ExternalSourceLink>,
      "label" | "hpath" | "role" | "sortOrder"
    >,
  ): Promise<void> {
    await this.ensureLoaded();
    const existing = this.store.getLink(linkId);
    if (!existing) return;
    const link = this.normalizeLink({
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await this.persistLocal(link);
    await this.cache.upsertPendingLink(link);
    void this.flushPendingLinks();
  }

  async importPointers(links: ExternalSourceLink[]): Promise<void> {
    if (links.length === 0) return;
    await this.ensureLoaded();
    for (const rawLink of links) {
      const link = this.normalizeLink(rawLink);
      await this.persistLocal(link);
      await this.cache.upsertPendingLink(link);
    }
    void this.flushPendingLinks();
  }

  openLink(link: ExternalSourceLink): void {
    if (typeof window === "undefined") return;
    const parsed = parseSiyuanBlockLink(link.uri || link.targetId);
    if (!parsed || parsed.blockId !== link.targetId) {
      this.toast.error("思源链接无效", "已阻止打开非 siyuan:// 块链接");
      return;
    }
    window.location.href = parsed.uri;
  }

  async flushPendingLinks(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPendingLinksInternal().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async flushPendingLinksInternal(): Promise<void> {
    const pending = this.mergeLinks(await this.cache.loadPendingLinks(), []);
    for (const link of pending) {
      if (await this.pushLink(link))
        await this.cache.removePendingLink(link.id);
    }
  }

  private async persistLocal(link: ExternalSourceLink): Promise<void> {
    this.store.upsert(link);
    await this.cache.saveLinks(this.mergeLinks(this.links(), []));
  }

  private async pullRemoteLinks(): Promise<ExternalSourceLink[]> {
    const client = await this.getClient();
    const userId = this.currentUserId();
    if (!client || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) return [];
    try {
      const { data, error } = await client
        .from("external_source_links")
        .select(
          "id,user_id,task_id,source_type,target_id,uri,label,hpath,role,sort_order,deleted_at,created_at,updated_at",
        )
        .eq("user_id", userId);
      if (error) throw error;
      return (data ?? []).map((row) => this.rowToLink(row));
    } catch (error) {
      this.logger.warn("拉取思源锚点失败，保留本地状态", {
        message: error instanceof Error ? error.message : "unknown",
      });
      return [];
    }
  }

  private async pushLocalNewerLinks(
    localLinks: ExternalSourceLink[],
    remoteLinks: ExternalSourceLink[],
  ): Promise<void> {
    const remoteById = new Map(remoteLinks.map((link) => [link.id, link]));
    for (const local of localLinks) {
      const remote = remoteById.get(local.id);
      if (!remote || local.updatedAt > remote.updatedAt)
        await this.cache.upsertPendingLink(local);
    }
  }

  private async pushLink(link: ExternalSourceLink): Promise<boolean> {
    const client = await this.getClient();
    const userId = this.currentUserId();
    if (!client || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) return true;
    try {
      const { error } = await client
        .from("external_source_links")
        .upsert(this.linkToRow(link, userId) as unknown as never, { onConflict: "id" });
      if (error) throw error;
      return true;
    } catch (error) {
      this.logger.warn("推送思源锚点失败，已保留本机重试", {
        linkId: this.safeId(link.id),
        message: error instanceof Error ? error.message : "unknown",
      });
      await this.cache.upsertPendingLink(link);
      return false;
    }
  }

  private async getClient(): Promise<ExternalSourceSupabaseClient | null> {
    const client = await this.supabase.clientAsync();
    return client as unknown as ExternalSourceSupabaseClient | null;
  }

  private currentUserId(): string {
    return this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private mergeLinks(
    localLinks: ExternalSourceLink[],
    remoteLinks: ExternalSourceLink[],
  ): ExternalSourceLink[] {
    const byId = new Map<string, ExternalSourceLink>();
    for (const rawLink of [...localLinks, ...remoteLinks]) {
      const link = this.normalizeLink(rawLink);
      const existing = byId.get(link.id);
      if (!existing || existing.updatedAt < link.updatedAt)
        byId.set(link.id, link);
    }
    return this.collapseActiveDuplicates(Array.from(byId.values()));
  }

  private collapseActiveDuplicates(
    links: ExternalSourceLink[],
  ): ExternalSourceLink[] {
    const activeByNaturalKey = new Map<string, ExternalSourceLink>();
    const next = new Map(links.map((link) => [link.id, link]));
    const now = new Date().toISOString();
    for (const link of links.sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
    )) {
      if (link.deletedAt) continue;
      const key = `${link.taskId}|${link.sourceType}|${link.targetId}`;
      const existing = activeByNaturalKey.get(key);
      if (!existing) {
        activeByNaturalKey.set(key, link);
        continue;
      }
      const winner = existing.updatedAt >= link.updatedAt ? existing : link;
      const loser = winner.id === existing.id ? link : existing;
      activeByNaturalKey.set(key, winner);
      next.set(loser.id, {
        ...loser,
        deletedAt: loser.deletedAt ?? now,
        updatedAt: loser.updatedAt > now ? loser.updatedAt : now,
      });
    }
    return Array.from(next.values());
  }

  private normalizeLink(link: ExternalSourceLink): ExternalSourceLink {
    const parsed =
      parseSiyuanBlockLink(link.targetId) ?? parseSiyuanBlockLink(link.uri);
    const targetId = parsed?.blockId ?? link.targetId;
    return {
      ...link,
      id: this.truncate(link.id, SIYUAN_CONFIG.MAX_LINK_ID_LENGTH),
      sourceType: "siyuan-block",
      targetId,
      uri: normalizeSiyuanUri(targetId),
      label: this.optionalTruncate(link.label, SIYUAN_CONFIG.MAX_LABEL_LENGTH),
      hpath: this.optionalTruncate(link.hpath, SIYUAN_CONFIG.MAX_HPATH_LENGTH),
      sortOrder: Number.isFinite(link.sortOrder) ? link.sortOrder : 0,
      deletedAt: link.deletedAt ?? null,
    };
  }

  private linkToRow(
    link: ExternalSourceLink,
    userId: string,
  ): ExternalSourceLinkRow {
    const normalized = this.normalizeLink(link);
    return {
      id: normalized.id,
      user_id: userId,
      task_id: normalized.taskId,
      source_type: normalized.sourceType,
      target_id: normalized.targetId,
      uri: this.truncate(normalized.uri, SIYUAN_CONFIG.MAX_URI_LENGTH),
      label: normalized.label ?? null,
      hpath: normalized.hpath ?? null,
      role: normalized.role ?? null,
      sort_order: normalized.sortOrder,
      deleted_at: normalized.deletedAt ?? null,
      created_at: normalized.createdAt,
      updated_at: normalized.updatedAt,
    };
  }

  private rowToLink(row: ExternalSourceLinkRow): ExternalSourceLink {
    return this.normalizeLink({
      id: row.id,
      taskId: row.task_id,
      sourceType: row.source_type,
      targetId: row.target_id,
      uri: row.uri,
      label: row.label ?? undefined,
      hpath: row.hpath ?? undefined,
      role: row.role ?? undefined,
      sortOrder: row.sort_order,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private optionalTruncate(
    value: string | undefined,
    maxLength: number,
  ): string | undefined {
    if (!value) return undefined;
    return this.truncate(value, maxLength);
  }

  private truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private safeId(value: string): string {
    return value.length > 12 ? `${value.slice(0, 8)}…` : value;
  }
}
