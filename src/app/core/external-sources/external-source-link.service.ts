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
  /** 缓存正在进行的 ensureLoaded，防止并发 caller 各自跑一次 pull/merge。 */
  private loadPromise: Promise<void> | null = null;

  async ensureLoaded(): Promise<void> {
    const ownerId = this.currentUserId();
    if (this.initialized && this.loadedOwnerId === ownerId) return;
    if (this.loadPromise && this.loadedOwnerId === ownerId) return this.loadPromise;
    this.loadPromise = this.runEnsureLoaded(ownerId).finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private async runEnsureLoaded(ownerId: string): Promise<void> {
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
    await this.cache.upsertPendingLink(link, { resetRetryCount: true });
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
    await this.cache.upsertPendingLink(link, { resetRetryCount: true });
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
    await this.cache.upsertPendingLink(link, { resetRetryCount: true });
    void this.flushPendingLinks();
  }

  async importPointers(links: ExternalSourceLink[]): Promise<void> {
    if (links.length === 0) return;
    await this.ensureLoaded();
    for (const rawLink of links) {
      const link = this.normalizeLink(rawLink);
      await this.persistLocal(link);
      await this.cache.upsertPendingLink(link, { resetRetryCount: true });
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
    // 用新窗口承载 siyuan:// protocol handler，避免替换 SPA 自身的 URL 导致状态被清空。
    // 浏览器拒绝识别此 protocol 时，新窗口会被立刻关闭，但当前应用保持完整。
    const opened = window.open(parsed.uri, "_blank", "noopener,noreferrer");
    if (!opened) this.toast.info("浏览器已拦截弹窗，请在原块上右键打开");
  }

  async flushPendingLinks(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPendingLinksInternal().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async flushPendingLinksInternal(): Promise<void> {
    const pending = await this.cache.loadPendingLinks();
    for (const entry of pending) {
      const result = await this.pushLink(entry.link);
      if (result.outcome === "success" || result.outcome === "drop") {
        await this.cache.removePendingLink(entry.link.id);
      } else {
        await this.cache.recordPendingFailure(entry.link.id, result.errorCode);
      }
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
      if (remote && local.updatedAt <= remote.updatedAt) continue;
      // 已确认在线（pullRemoteLinks 成功），优先直接推送，避免 IndexedDB 写放大；
      // 推送失败时再走 pending + retry 路径。
      const result = await this.pushLink(local);
      if (result.outcome !== "success" && result.outcome !== "drop") {
        await this.cache.upsertPendingLink(local, { resetRetryCount: true });
      }
    }
  }

  private async pushLink(
    link: ExternalSourceLink,
  ): Promise<
    | { outcome: "success" }
    | { outcome: "drop"; reason: "local-mode" | "no-client" | "duplicate" }
    | { outcome: "retry"; errorCode: string }
  > {
    const client = await this.getClient();
    const userId = this.currentUserId();
    if (!client) return { outcome: "drop", reason: "no-client" };
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID)
      return { outcome: "drop", reason: "local-mode" };
    try {
      const { error } = await client
        .from("external_source_links")
        .upsert(this.linkToRow(link, userId) as unknown as never, {
          onConflict: "id",
        });
      if (error) {
        const errorCode = (error as { code?: string }).code ?? "unknown";
        // 23505 = Postgres unique_violation：另一端已绑定同一 (task, target)。
        // 不再重试，丢弃 pending 项让下一次 ensureLoaded 重新拉远端真相。
        if (errorCode === "23505") {
          this.logger.info("思源锚点唯一冲突，丢弃本机 pending", {
            linkId: this.safeId(link.id),
          });
          return { outcome: "drop", reason: "duplicate" };
        }
        throw error;
      }
      return { outcome: "success" };
    } catch (error) {
      const errorCode = this.classifyPushError(error);
      this.logger.warn("推送思源锚点失败，已保留本机重试", {
        linkId: this.safeId(link.id),
        errorCode,
        message: error instanceof Error ? error.message : "unknown",
      });
      return { outcome: "retry", errorCode };
    }
  }

  private classifyPushError(error: unknown): string {
    if (error && typeof error === "object") {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) return code;
      const status = (error as { status?: unknown }).status;
      if (status === 401 || status === 403) return "auth";
    }
    return "unknown";
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
    // 排序在 updatedAt 持平时按 id 升序，保证多端 collapse 选出同一 winner，避免相互踩。
    const sorted = links.slice().sort((a, b) => {
      const cmp = a.updatedAt.localeCompare(b.updatedAt);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
    for (const link of sorted) {
      if (link.deletedAt) continue;
      const key = `${link.taskId}|${link.sourceType}|${link.targetId}`;
      const existing = activeByNaturalKey.get(key);
      if (!existing) {
        activeByNaturalKey.set(key, link);
        continue;
      }
      const winner = this.pickCollapseWinner(existing, link);
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

  private pickCollapseWinner(
    a: ExternalSourceLink,
    b: ExternalSourceLink,
  ): ExternalSourceLink {
    const cmp = a.updatedAt.localeCompare(b.updatedAt);
    if (cmp > 0) return a;
    if (cmp < 0) return b;
    // updatedAt 相同时按 id 升序确定唯一 winner（多端一致）。
    return a.id.localeCompare(b.id) <= 0 ? a : b;
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
