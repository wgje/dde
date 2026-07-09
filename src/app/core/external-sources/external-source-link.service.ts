import { DestroyRef, Injectable, computed, inject } from "@angular/core";
import { SupabaseClientService } from "../../../services/supabase-client.service";
import { AuthService } from "../../../services/auth.service";
import { ToastService } from "../../../services/toast.service";
import { LoggerService } from "../../../services/logger.service";
import {
  ExternalSourceLinkRemoteWriterService,
  type ExternalSourceSupabaseClient,
} from "../../../services/external-source-link-remote-writer.service";
import { AUTH_CONFIG } from "../../../config/auth.config";
import { SIYUAN_CONFIG } from "../../../config/siyuan.config";
import { ExternalSourceCacheService } from "./external-source-cache.service";
import { ExternalSourceLinkStore } from "./external-source-link.store";
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from "../../../utils/browser-network-suspension";
import { createSyncOperationId } from "../../../utils/sync-operation-id";
import type {
  ExternalSourceLink,
  ExternalSourceRole,
} from "./external-source.model";
import {
  parseSiyuanBlockLink,
  shortenSiyuanBlockId,
} from "./siyuan/siyuan-link-parser";
import { fetchAllSupabasePages } from "../../../utils/supabase-pagination";
import {
  buildExternalSourceUniqueConflictTombstone,
  classifyExternalSourcePushError,
  type ExternalSourceLinkRow,
  mergeExternalSourceLinks,
  normalizeExternalSourceLink,
  rowToExternalSourceLink,
  safeExternalSourceId,
} from "./external-source-link.helpers";

/** Postgres 唯一约束冲突 errorCode；命名常量便于检索 23505 的所有处理位置。 */
const POSTGRES_UNIQUE_VIOLATION = "23505";
const NETWORK_RESUME_RETRY_BUFFER_MS = 50;

type RemotePullResult = {
  links: ExternalSourceLink[];
  deferredBySuspension: boolean;
  failed?: boolean;
};

type PushLinkResult =
  | { outcome: "success" }
  | { outcome: "drop"; reason: "local-mode" | "no-client" | "duplicate" }
  | { outcome: "retry"; errorCode: string; deferredBySuspension?: boolean; retryLink?: ExternalSourceLink };

type UniqueConflictResolution =
  | { resolved: true }
  | { resolved: false; retryLink: ExternalSourceLink };

@Injectable({ providedIn: "root" })
export class ExternalSourceLinkService {
  private readonly store = inject(ExternalSourceLinkStore);
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly remoteWriter = inject(ExternalSourceLinkRemoteWriterService);
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
  /** 上一次成功 pullRemoteLinks 的时间戳（ms）；用于 refreshIfStale 的陈旧判定。 */
  private lastPullAt = 0;
  /** 缓存正在进行的 refreshIfStale，避免 visibility/online 事件并发各自 pull 一次。 */
  private refreshPromise: Promise<void> | null = null;
  /** 浏览器事件监听器解绑句柄，确保 service 销毁时不泄漏。 */
  private opportunisticListenersBound = false;
  private resumeSyncTimer: number | null = null;
  private resumeSyncForceRefresh = false;
  private resumeSyncGeneration = 0;
  private destroyed = false;

  constructor() {
    // 单例 service 在 root 注入器销毁时（HMR/SSR teardown）解绑事件监听器，避免内存泄漏。
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.resumeSyncGeneration += 1;
      this.clearResumeSyncTimer();
      this.unbindOpportunisticListeners();
    });
  }

  async ensureLoaded(): Promise<void> {
    if (this.destroyed) return;
    const ownerId = this.currentUserId();
    if (this.initialized && this.loadedOwnerId === ownerId) return;
    if (this.loadPromise && this.loadedOwnerId === ownerId) return this.loadPromise;
    const loadPromise = this.runEnsureLoaded(ownerId).finally(() => {
      if (this.loadPromise === loadPromise) {
        this.loadPromise = null;
      }
    });
    this.loadPromise = loadPromise;
    return this.loadPromise;
  }

  private async runEnsureLoaded(ownerId: string): Promise<void> {
    this.initialized = true;
    this.loadedOwnerId = ownerId;

    const localLinks = await this.cache.loadLinks(ownerId);
    if (!this.isCurrentOwner(ownerId)) return;

    this.store.replaceAll(mergeExternalSourceLinks(localLinks, []));
    const remotePull = await this.pullRemoteLinks(ownerId);
    if (!this.isCurrentOwner(ownerId)) return;

    const merged = mergeExternalSourceLinks(localLinks, remotePull.links);
    this.store.replaceAll(merged);
    await this.cache.saveLinks(merged, ownerId);
    if (!this.isCurrentOwner(ownerId)) return;

    if (!remotePull.deferredBySuspension && !remotePull.failed) {
      this.lastPullAt = Date.now();
      await this.pushLocalNewerLinks(merged, remotePull.links);
      if (!this.isCurrentOwner(ownerId)) return;
      void this.flushPendingLinks();
    }
    this.bindOpportunisticListeners();
  }

  /**
   * 机会式远端刷新：visibility/online 事件 + 显式 force 触发。
   * 当 lastPullAt 早于 REMOTE_REFRESH_STALE_MS 时重新 pull-merge；否则跳过以节省请求。
   * 与 ensureLoaded 共享 owner 切换语义；并发调用复用同一 in-flight promise。
   */
  async refreshIfStale(force = false): Promise<void> {
    if (this.destroyed) return;
    if (!this.initialized) return;
    const ownerId = this.currentUserId();
    if (this.loadedOwnerId !== ownerId) return; // owner 切换会经 ensureLoaded 处理
    if (!force && Date.now() - this.lastPullAt < SIYUAN_CONFIG.REMOTE_REFRESH_STALE_MS) return;
    if (this.refreshPromise) return this.refreshPromise;
    const refreshPromise = this.runRefresh(ownerId).finally(() => {
      if (this.refreshPromise === refreshPromise) {
        this.refreshPromise = null;
      }
    });
    this.refreshPromise = refreshPromise;
    return this.refreshPromise;
  }

  private async runRefresh(ownerId: string): Promise<void> {
    const localLinks = await this.cache.loadLinks(ownerId);
    if (!this.isCurrentOwner(ownerId)) return;

    const remotePull = await this.pullRemoteLinks(ownerId);
    if (!this.isCurrentOwner(ownerId)) return;
    if (remotePull.deferredBySuspension || remotePull.failed) {
      return;
    }

    this.lastPullAt = Date.now();
    const merged = mergeExternalSourceLinks(localLinks, remotePull.links);
    this.store.replaceAll(merged);
    await this.cache.saveLinks(merged, ownerId);
    if (!this.isCurrentOwner(ownerId)) return;

    await this.pushLocalNewerLinks(merged, remotePull.links);
  }

  private bindOpportunisticListeners(): void {
    if (this.opportunisticListenersBound || typeof window === "undefined") return;
    this.opportunisticListenersBound = true;
    // 用箭头函数稳定引用，便于 unbind 时移除同一实例。
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("online", this.onOnline);
  }

  private unbindOpportunisticListeners(): void {
    if (!this.opportunisticListenersBound || typeof window === "undefined") return;
    this.opportunisticListenersBound = false;
    this.removeOpportunisticListener(
      "visibility",
      () => document.removeEventListener("visibilitychange", this.onVisibilityChange),
    );
    this.removeOpportunisticListener(
      "online",
      () => window.removeEventListener("online", this.onOnline),
    );
  }

  private removeOpportunisticListener(label: "visibility" | "online", remove: () => void): void {
    try {
      remove();
      return;
    } catch (error) {
      this.warnOpportunisticListenerCleanupFailure(label, error);
    }

    try {
      remove();
    } catch (error) {
      this.warnOpportunisticListenerCleanupFailure(label, error);
    }
  }

  private warnOpportunisticListenerCleanupFailure(label: "visibility" | "online", error: unknown): void {
    try {
      this.logger.warn(`思源锚点 ${label} 监听解绑失败，继续清理其他监听`, {
        message: error instanceof Error ? error.message : "unknown",
      });
    } catch {
      // Listener cleanup is best-effort; warning sinks must not block remaining unbinds.
    }
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      this.scheduleResumeSync(false);
    }
  };

  private readonly onOnline = (): void => {
    // 网络恢复时要等待浏览器恢复保护期结束，再 flush pending / 拉远端真相。
    this.scheduleResumeSync(true);
  };

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
    const parsed = this.parseSiyuanInput(input);
    if (!parsed) return null;

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
      id: createSyncOperationId(),
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
    await this.persistLocalChangeForSync(link, { resetRetryCount: true });
    void this.flushPendingLinks();
    this.toast.success("已关联思源块");
    return link;
  }

  async replaceSiyuanBlock(
    linkId: string,
    input: string,
  ): Promise<ExternalSourceLink | null> {
    const parsed = this.parseSiyuanInput(input);
    if (!parsed) return null;

    await this.ensureLoaded();
    const existing = this.store.getLink(linkId);
    if (!existing || existing.deletedAt) return null;
    if (existing.targetId === parsed.blockId) return existing;

    const duplicate = this.store
      .activeLinksForTask(existing.taskId)
      .find(
        (link) =>
          link.id !== existing.id &&
          link.sourceType === "siyuan-block" &&
          link.targetId === parsed.blockId,
      );
    if (duplicate) {
      const now = new Date().toISOString();
      const tombstone = { ...existing, deletedAt: now, updatedAt: now };
      await this.persistLocalChangeForSync(tombstone, { resetRetryCount: true });
      await this.cache.deletePreviewsForLink(tombstone.id);
      void this.flushPendingLinks();
      this.toast.info("已切换到已有思源关联");
      return duplicate;
    }

    const now = new Date().toISOString();
    const link = normalizeExternalSourceLink({
      ...existing,
      targetId: parsed.blockId,
      uri: parsed.uri,
      label: `思源 ${shortenSiyuanBlockId(parsed.blockId)}`,
      hpath: undefined,
      deletedAt: null,
      updatedAt: now,
    });
    await this.persistLocalChangeForSync(link, { resetRetryCount: true });
    await this.cache.deletePreviewsForLink(link.id);
    void this.flushPendingLinks();
    this.toast.success("已更新思源关联");
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
    await this.persistLocalChangeForSync(link, { resetRetryCount: true });
    await this.cache.deletePreviewsForLink(link.id);
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
    const link = normalizeExternalSourceLink({
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await this.persistLocalChangeForSync(link, { resetRetryCount: true });
    void this.flushPendingLinks();
  }

  async importPointers(links: ExternalSourceLink[]): Promise<void> {
    if (links.length === 0) return;
    await this.ensureLoaded();
    for (const rawLink of links) {
      const link = normalizeExternalSourceLink(rawLink);
      await this.persistLocalChangeForSync(link, { resetRetryCount: true });
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
    if (this.destroyed) return;
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPendingLinksInternal().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async flushPendingLinksInternal(): Promise<void> {
    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后刷新思源锚点 pending 队列")) {
      return;
    }

    const pending = await this.cache.loadPendingLinks();
    for (const entry of pending) {
      const result = await this.pushLink(entry.link, entry.operationId);
      if (result.outcome === "success" || result.outcome === "drop") {
        await this.cache.removePendingLink(entry.link.id);
      } else if (result.deferredBySuspension) {
        return;
      } else {
        const retryLink = result.retryLink ?? entry.link;
        if (result.retryLink) {
          await this.cache.upsertPendingLink(retryLink, { resetRetryCount: false });
        }
        await this.cache.recordPendingFailure(retryLink.id, result.errorCode);
      }
    }
  }

  private async persistLocal(link: ExternalSourceLink): Promise<void> {
    const links = this.mergeLocalLink(link);
    await this.cache.saveLinks(links);
    this.store.replaceAll(links);
  }

  private async persistLocalChangeForSync(
    link: ExternalSourceLink,
    options: { resetRetryCount?: boolean } = {},
  ): Promise<void> {
    await this.cache.upsertPendingLink(link, options);
    try {
      await this.persistLocal(link);
    } catch (error) {
      await this.removePendingLinkAfterLocalPersistFailure(link.id, error);
      throw error;
    }
  }

  private async removePendingLinkAfterLocalPersistFailure(linkId: string, error: unknown): Promise<void> {
    try {
      await this.cache.removePendingLink(linkId);
    } catch (cleanupError) {
      this.logger.warn("思源锚点本地持久化失败后清理 pending 队列失败", {
        linkId: safeExternalSourceId(linkId),
        message: error instanceof Error ? error.message : "unknown",
        cleanupMessage: cleanupError instanceof Error ? cleanupError.message : "unknown",
      });
    }
  }

  private mergeLocalLink(link: ExternalSourceLink): ExternalSourceLink[] {
    const next = new Map(this.links().map((item) => [item.id, item]));
    next.set(link.id, link);
    return mergeExternalSourceLinks(Array.from(next.values()), []);
  }

  private async pullRemoteLinks(ownerId = this.currentUserId()): Promise<RemotePullResult> {
    const userId = ownerId;
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return { links: [], deferredBySuspension: false, failed: false };
    }

    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后拉取思源锚点", { userId })) {
      return { links: [], deferredBySuspension: true, failed: false };
    }

    const client = await this.getClient();
    if (!client) {
      return { links: [], deferredBySuspension: false, failed: true };
    }

    try {
      const { data, error } = await fetchAllSupabasePages<ExternalSourceLinkRow>(() =>
        client
          .from("external_source_links")
          .select(
            "id,user_id,task_id,source_type,target_id,uri,label,hpath,role,sort_order,deleted_at,created_at,updated_at",
          )
          .eq("user_id", userId)
          .order("updated_at", { ascending: true })
          .order("id", { ascending: true }),
      );
      if (error) throw error;
      return {
        links: (data ?? []).map((row) => rowToExternalSourceLink(row)),
        deferredBySuspension: false,
        failed: false,
      };
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
        this.logSuspensionDeferral("浏览器网络挂起，延后拉取思源锚点", { userId });
        return { links: [], deferredBySuspension: true, failed: false };
      }

      this.logger.warn("拉取思源锚点失败，保留本地状态", {
        message: error instanceof Error ? error.message : "unknown",
      });
      return { links: [], deferredBySuspension: false, failed: true };
    }
  }

  private async pushLocalNewerLinks(
    localLinks: ExternalSourceLink[],
    remoteLinks: ExternalSourceLink[],
  ): Promise<void> {
    const remoteById = new Map(remoteLinks.map((link) => [link.id, link]));
    const localsToPush = localLinks.filter((local) => {
      const remote = remoteById.get(local.id);
      return !remote || local.updatedAt > remote.updatedAt;
    });

    if (localsToPush.length === 0) {
      return;
    }

    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后推送本地较新的思源锚点", {
      linkCount: localsToPush.length,
    })) {
      for (const local of localsToPush) {
        await this.cache.upsertPendingLink(local, { resetRetryCount: false });
      }
      return;
    }

    for (let index = 0; index < localsToPush.length; index += 1) {
      const local = localsToPush[index];
      const pendingEntry = await this.cache.upsertPendingLink(local, { resetRetryCount: false });
      const result = await this.pushLink(pendingEntry.link, pendingEntry.operationId);
      if (result.outcome === "success" || result.outcome === "drop") {
        await this.cache.removePendingLink(local.id);
        continue;
      }

      const retryLink = result.retryLink ?? local;
      if (result.retryLink) {
        await this.cache.upsertPendingLink(retryLink, { resetRetryCount: false });
      }
      if (result.deferredBySuspension) {
        for (const deferred of localsToPush.slice(index + 1)) {
          await this.cache.upsertPendingLink(deferred, { resetRetryCount: false });
        }
        return;
      }

      await this.cache.recordPendingFailure(retryLink.id, result.errorCode);
    }
  }

  private async pushLink(
    link: ExternalSourceLink,
    operationId: string,
  ): Promise<PushLinkResult> {
    const userId = this.currentUserId();
    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后推送思源锚点", {
      linkId: safeExternalSourceId(link.id),
    })) {
      return { outcome: "retry", errorCode: "browser-network-suspended", deferredBySuspension: true };
    }

    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID)
      return { outcome: "drop", reason: "local-mode" };
    const client = await this.getClient();
    if (!client) return { outcome: "retry", errorCode: "no-client" };
    try {
      const { error } = await this.remoteWriter.upsertLink(client, link, userId, operationId);
      if (error) {
        const errorCode = (error as { code?: string }).code ?? "unknown";
        // 23505 = Postgres unique_violation：另一端已绑定同一 (task, target)。
        // 不再重试，丢弃 pending 项让下一次 ensureLoaded 重新拉远端真相。
        if (errorCode === POSTGRES_UNIQUE_VIOLATION) {
          return this.handleUniqueConflict(link, operationId, userId, client);
        }
        throw error;
      }
      return { outcome: "success" };
    } catch (error) {
      if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
        this.logSuspensionDeferral("浏览器网络挂起，延后推送思源锚点", {
          linkId: safeExternalSourceId(link.id),
        });
        return { outcome: "retry", errorCode: "browser-network-suspended", deferredBySuspension: true };
      }

      const errorCode = classifyExternalSourcePushError(error);
      this.logger.warn("推送思源锚点失败，已保留本机重试", {
        linkId: safeExternalSourceId(link.id),
        errorCode,
        message: error instanceof Error ? error.message : "unknown",
      });
      return { outcome: "retry", errorCode };
    }
  }

  private async handleUniqueConflict(
    link: ExternalSourceLink,
    operationId: string,
    userId: string,
    client: ExternalSourceSupabaseClient,
  ): Promise<PushLinkResult> {
    this.logger.info("思源锚点唯一冲突，尝试切换到远端已有关联", {
      linkId: safeExternalSourceId(link.id),
    });
    const resolution = await this.resolveUniqueConflict(link, operationId, userId, client);
    if (resolution.resolved) {
      return { outcome: "success" };
    }
    return {
      outcome: "retry",
      errorCode: POSTGRES_UNIQUE_VIOLATION,
      retryLink: resolution.retryLink,
    };
  }

  private async resolveUniqueConflict(
    link: ExternalSourceLink,
    operationId: string,
    userId: string,
    client: ExternalSourceSupabaseClient,
  ): Promise<UniqueConflictResolution> {
    const tombstone = buildExternalSourceUniqueConflictTombstone(link);
    try {
      await this.upsertUniqueConflictTombstone(tombstone, operationId, userId, client);
      await this.persistUniqueConflictTombstone(tombstone);
      await this.refreshAfterUniqueConflict();
      this.toast.info("思源锚点已在其他设备建立，已切换到已有关联");
      return { resolved: true };
    } catch (error) {
      await this.keepUniqueConflictTombstonePending(link, tombstone);
      this.logger.warn("思源锚点唯一冲突收敛失败，等待下次刷新", {
        linkId: safeExternalSourceId(link.id),
        message: error instanceof Error ? error.message : "unknown",
      });
      this.toast.info("思源锚点已在其他设备建立，稍后自动刷新合并");
      return { resolved: false, retryLink: tombstone };
    }
  }

  private async upsertUniqueConflictTombstone(
    tombstone: ExternalSourceLink,
    operationId: string,
    userId: string,
    client: ExternalSourceSupabaseClient,
  ): Promise<void> {
    const { error } = await this.remoteWriter.upsertLink(client, tombstone, userId, operationId);
    if (error) throw error;
  }

  private async persistUniqueConflictTombstone(
    tombstone: ExternalSourceLink,
  ): Promise<void> {
    await this.persistLocal(tombstone);
    await this.cache.deletePreviewsForLink(tombstone.id);
  }

  private async refreshAfterUniqueConflict(): Promise<void> {
    const remotePull = await this.pullRemoteLinks();
    if (remotePull.deferredBySuspension || remotePull.failed) {
      throw new Error("remote pull unavailable after unique conflict");
    }

    this.lastPullAt = Date.now();
    const localLinks = await this.cache.loadLinks();
    const merged = mergeExternalSourceLinks(localLinks, remotePull.links);
    this.store.replaceAll(merged);
    await this.cache.saveLinks(merged);
  }

  private async keepUniqueConflictTombstonePending(
    link: ExternalSourceLink,
    tombstone: ExternalSourceLink,
  ): Promise<void> {
    try {
      await this.persistLocalChangeForSync(tombstone, { resetRetryCount: false });
      await this.cache.deletePreviewsForLink(tombstone.id);
    } catch (localError) {
      this.logger.warn("思源锚点唯一冲突本地墓碑保留失败", {
        linkId: safeExternalSourceId(link.id),
        message: localError instanceof Error ? localError.message : "unknown",
      });
    }
  }

  private async getClient(): Promise<ExternalSourceSupabaseClient | null> {
    return this.remoteWriter.getClient();
  }

  private currentUserId(): string {
    return this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private isCurrentOwner(ownerId: string): boolean {
    return this.currentUserId() === ownerId && this.loadedOwnerId === ownerId;
  }

  private parseSiyuanInput(
    input: string,
  ): NonNullable<ReturnType<typeof parseSiyuanBlockLink>> | null {
    const parsed = parseSiyuanBlockLink(input);
    if (parsed) return parsed;
    this.toast.error(
      "思源链接无效",
      "请粘贴 siyuan://blocks/{id} 或思源块 ID",
    );
    return null;
  }

  private deferRemoteWorkForSuspension(
    message: string,
    details?: Record<string, unknown>,
  ): boolean {
    if (!isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    this.logSuspensionDeferral(message, details);
    return true;
  }

  private logSuspensionDeferral(
    message: string,
    details?: Record<string, unknown>,
  ): void {
    this.logger.info(message, {
      ...details,
      resumeDelayMs: getRemainingBrowserNetworkResumeDelayMs(),
    });
    this.scheduleResumeSync(true);
  }

  private scheduleResumeSync(forceRefresh = false): void {
    if (this.destroyed || typeof window === "undefined") {
      return;
    }

    this.resumeSyncForceRefresh ||= forceRefresh;

    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return;
    }

    if (this.resumeSyncTimer != null) {
      return;
    }

    const delayMs = Math.max(100, getRemainingBrowserNetworkResumeDelayMs() + NETWORK_RESUME_RETRY_BUFFER_MS);
    const generation = this.resumeSyncGeneration;
    try {
      this.resumeSyncTimer = window.setTimeout(() => {
        if (this.destroyed || generation !== this.resumeSyncGeneration) {
          return;
        }
        const shouldForceRefresh = this.resumeSyncForceRefresh;
        this.resumeSyncForceRefresh = false;
        this.resumeSyncTimer = null;
        void this.refreshIfStale(shouldForceRefresh);
        void this.flushPendingLinks();
      }, delayMs);
    } catch (error) {
      this.resumeSyncTimer = null;
      this.warnResumeSyncTimerScheduleFailure(error);
    }
  }

  private clearResumeSyncTimer(): void {
    const resumeSyncTimer = this.resumeSyncTimer;
    this.resumeSyncTimer = null;
    if (resumeSyncTimer != null) {
      try {
        clearTimeout(resumeSyncTimer);
      } catch (error) {
        this.warnResumeSyncTimerCleanupFailure(error);
      }
    }
    this.resumeSyncForceRefresh = false;
  }

  private warnResumeSyncTimerScheduleFailure(error: unknown): void {
    try {
      this.logger.warn("思源锚点恢复 timer 注册失败，等待下一次恢复事件重试", {
        message: error instanceof Error ? error.message : "unknown",
      });
    } catch {
      // Warning sinks must not interrupt external source resume scheduling.
    }
  }

  private warnResumeSyncTimerCleanupFailure(error: unknown): void {
    try {
      this.logger.warn("思源锚点恢复 timer 清理失败，继续清理其他资源", {
        message: error instanceof Error ? error.message : "unknown",
      });
    } catch {
      // Warning sinks must not interrupt external source teardown.
    }
  }
}
