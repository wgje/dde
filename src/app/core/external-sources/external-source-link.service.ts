import { DestroyRef, Injectable, computed, inject } from "@angular/core";
import { SupabaseClientService } from "../../../services/supabase-client.service";
import { AuthService } from "../../../services/auth.service";
import { ToastService } from "../../../services/toast.service";
import { LoggerService } from "../../../services/logger.service";
import { ExternalSourceLinkRemoteWriterService, type ExternalSourceSupabaseClient } from "../../../services/external-source-link-remote-writer.service";
import { AUTH_CONFIG } from "../../../config/auth.config";
import { SIYUAN_CONFIG } from "../../../config/siyuan.config";
import { ExternalSourceCacheService } from "./external-source-cache.service";
import { ExternalSourceLinkStore } from "./external-source-link.store";
import { getRemainingBrowserNetworkResumeDelayMs, isBrowserNetworkSuspendedError, isBrowserNetworkSuspendedWindow } from "../../../utils/browser-network-suspension";
import { createSyncOperationId } from "../../../utils/sync-operation-id";
import type { ExternalSourceLink, ExternalSourceRole, PendingExternalSourceLink } from "./external-source.model";
import { parseSiyuanBlockLink, shortenSiyuanBlockId } from "./siyuan/siyuan-link-parser";
import { fetchAllSupabaseKeysetPagesByCursor, type SupabasePageResult } from "../../../utils/supabase-pagination";
import {
  buildExternalSourceUniqueConflictTombstone, classifyExternalSourcePushError, type ExternalSourceLinkRow,
  mergeExternalSourceLinks, normalizeExternalSourceLink, rowToExternalSourceLink, safeExternalSourceId,
} from "./external-source-link.helpers";
import { clearExternalSourceLinkResumeSyncTimer, scheduleExternalSourceLinkResumeSyncTimer } from "./external-source-link-resume-sync.helpers";
import { localBackupUiRestoreWriterQuiescence } from "../../../services/local-backup-ui-restore-writer-quiescence.service";

/** Postgres 唯一约束冲突 errorCode；命名常量便于检索 23505 的所有处理位置。 */
const POSTGRES_UNIQUE_VIOLATION = "23505";
const NETWORK_RESUME_RETRY_BUFFER_MS = 50;
type RemotePullResult = { links: ExternalSourceLink[]; deferredBySuspension: boolean; failed?: boolean };
const FAILED_REMOTE_PULL: RemotePullResult = { links: [], deferredBySuspension: false, failed: true };

type PushLinkResult =
  | { outcome: "success"; pendingEntry?: PendingExternalSourceLink }
  | { outcome: "drop"; reason: "local-mode" | "no-client" | "duplicate"; pendingEntry?: PendingExternalSourceLink }
  | { outcome: "stale-owner" }
  | { outcome: "retry"; errorCode: string; deferredBySuspension?: boolean; pendingEntry?: PendingExternalSourceLink };
type AuthIdentityFence = { ownerId: string; authFence: string };
type ImportLinkSnapshot = { previousLink: ExternalSourceLink | undefined; previousPending: PendingExternalSourceLink | undefined; fingerprints: Set<string>; operationIds: Set<string> };

const externalSourceLinkFingerprint = (link: ExternalSourceLink | undefined): string => JSON.stringify(link && [link.id, link.taskId, link.sourceType, link.targetId, link.uri, link.label, link.hpath, link.role, link.sortOrder, link.deletedAt, link.createdAt, link.updatedAt]);
@Injectable({ providedIn: "root" })
export class ExternalSourceLinkService {
  private readonly store = inject(ExternalSourceLinkStore);
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly remoteWriter = inject(ExternalSourceLinkRemoteWriterService);
  private readonly logger = inject(LoggerService).category("ExternalSourceLink");
  readonly links = this.store.links;
  readonly activeLinks = computed(() => this.links().filter((link) => !link.deletedAt));
  private initialized = false;
  private loadedOwnerId: string | null = null;
  private flushFlight: { token: AuthIdentityFence; promise: Promise<void> } | null = null;
  private importPromise: Promise<void> | null = null;
  private loadPromise: Promise<void> | null = null;
  private lastPullAt = 0;
  private refreshPromise: Promise<void> | null = null;
  private opportunisticListenersBound = false;
  private resumeSyncTimer: number | null = null;
  private resumeSyncForceRefresh = false;
  private resumeSyncGeneration = 0;
  private destroyed = false;
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.resumeSyncGeneration += 1;
      this.clearResumeSyncTimer();
      this.unbindOpportunisticListeners();
    });
  }
  async ensureLoaded(): Promise<void> { return localBackupUiRestoreWriterQuiescence.runContinuationAsync(this.currentUserId(), 'external-source', async () => {
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
  }); }
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
      this.runInBackground(this.flushPendingLinks(), "flush after initial load");
    }
    this.bindOpportunisticListeners();
  }
  /**
   * 机会式远端刷新：visibility/online 事件 + 显式 force 触发。
   * 当 lastPullAt 早于 REMOTE_REFRESH_STALE_MS 时重新 pull-merge；否则跳过以节省请求。
   * 与 ensureLoaded 共享 owner 切换语义；并发调用复用同一 in-flight promise。
   */
  async refreshIfStale(force = false): Promise<void> { return localBackupUiRestoreWriterQuiescence.runContinuationAsync(this.currentUserId(), 'external-source', async () => {
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
  }); }
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
    this.runInBackground(this.ensureLoaded(), "load links for task");
    return this.store.activeLinksForTask(taskId);
  }

  firstActiveLinkForTask(taskId: string): ExternalSourceLink | null {
    this.runInBackground(this.ensureLoaded(), "load first link for task");
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
    this.runInBackground(this.flushPendingLinks(), "flush after bind");
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
      this.runInBackground(this.flushPendingLinks(), "flush after duplicate replacement");
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
    this.runInBackground(this.flushPendingLinks(), "flush after replacement");
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
    this.runInBackground(this.flushPendingLinks(), "flush after removal");
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
    this.runInBackground(this.flushPendingLinks(), "flush after metadata update");
  }

  async importPointers(links: ExternalSourceLink[], commit?: () => void | Promise<void>): Promise<void> { return localBackupUiRestoreWriterQuiescence.runContinuationAsync(this.currentUserId(), 'external-source', async () => {
    if (links.length === 0) return await commit?.();
    const ownerId = this.currentUserId(), priorImport = this.importPromise, priorFlush = this.flushFlight?.promise;
    const transaction = Promise.resolve().then(async () => {
      if (priorImport) await priorImport; if (priorFlush) await priorFlush;
      this.assertImportOwner(ownerId); await this.ensureLoaded();
      if (!this.isCurrentOwner(ownerId)) throw new Error("External source link import owner changed");
      const linksBefore = new Map((await this.cache.loadLinks(ownerId)).map(link => [link.id, link])); this.assertImportOwner(ownerId);
      const pendingBefore = new Map((await this.cache.loadPendingLinks()).map(entry => [entry.link.id, entry])); this.assertImportOwner(ownerId);
      const writes = links.map(normalizeExternalSourceLink), snapshots = new Map<string, ImportLinkSnapshot>();
      for (const link of writes) {
        const snapshot = snapshots.get(link.id) ?? { previousLink: linksBefore.get(link.id), previousPending: pendingBefore.get(link.id), fingerprints: new Set<string>(), operationIds: new Set<string>() };
        snapshot.fingerprints.add(externalSourceLinkFingerprint(link)); snapshots.set(link.id, snapshot);
      }
      const stagedLinks = new Map(linksBefore);
      try {
        for (const link of writes) {
          this.assertImportOwner(ownerId);
          const pending = await this.cache.upsertPendingLink(link, { resetRetryCount: false });
          snapshots.get(link.id)!.operationIds.add(pending.operationId); this.assertImportOwner(ownerId);
          stagedLinks.set(link.id, link);
          await this.cache.saveLinks(mergeExternalSourceLinks(Array.from(stagedLinks.values()), []), ownerId);
          this.assertImportOwner(ownerId);
        }
        await commit?.(); if (!this.isCurrentOwner(ownerId)) throw new Error("External source link import owner changed");
        this.store.replaceAll(mergeExternalSourceLinks(Array.from(stagedLinks.values()), []));
      } catch (error) {
        const currentLinks = new Map((await this.cache.loadLinks(ownerId)).map(link => [link.id, link]));
        for (const [linkId, snapshot] of snapshots) {
          const current = currentLinks.get(linkId);
          if (!current || !snapshot.fingerprints.has(externalSourceLinkFingerprint(current))) continue;
          if (snapshot.previousLink) currentLinks.set(linkId, snapshot.previousLink); else currentLinks.delete(linkId);
        }
        const restoredLinks = mergeExternalSourceLinks(Array.from(currentLinks.values()), []); await this.cache.saveLinks(restoredLinks, ownerId);
        if (this.isCurrentOwner(ownerId)) {
          this.store.replaceAll(restoredLinks);
          for (const [linkId, snapshot] of snapshots) {
            const current = (await this.cache.loadPendingLinks()).find(entry => entry.link.id === linkId);
            if (!current || !snapshot.operationIds.has(current.operationId) || !snapshot.fingerprints.has(externalSourceLinkFingerprint(current.link))) continue;
            await this.cache.restorePendingLinkSnapshot(linkId, current.operationId, snapshot.previousPending);
          }
        }
        throw error;
      }
    });
    this.importPromise = transaction;
    try { await transaction; } finally { if (this.importPromise === transaction) this.importPromise = null; }
    this.runInBackground(this.flushPendingLinks(), "flush after import");
  }); }
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
    return localBackupUiRestoreWriterQuiescence.runContinuationAsync(this.currentUserId(), "external-source", async () => {
      const importPromise = this.importPromise;
      if (importPromise) await importPromise.catch(() => undefined);
      if (this.destroyed) return;
      const token = this.captureAuthIdentityFence();
      const active = this.flushFlight;
      if (active) {
        if (this.sameAuthIdentityFence(active.token, token)) return active.promise;
        await active.promise.catch(() => undefined);
        if (!this.isAuthIdentityFenceCurrent(token)) return;
        const competing = this.flushFlight;
        if (competing) return this.sameAuthIdentityFence(competing.token, token)
          ? competing.promise : undefined;
      }
      const promise = this.flushPendingLinksInternal(token);
      this.flushFlight = { token, promise };
      try { await promise; } finally {
        if (this.flushFlight?.promise === promise) this.flushFlight = null;
      }
    });
  }
  private async flushPendingLinksInternal(token: AuthIdentityFence): Promise<void> {
    if (!this.isAuthIdentityFenceCurrent(token)) return;
    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后刷新思源锚点 pending 队列")) {
      return;
    }
    const pending = await this.cache.loadPendingLinks(token.ownerId);
    if (!this.isAuthIdentityFenceCurrent(token)) return;
    for (const entry of pending) {
      if (!this.isAuthIdentityFenceCurrent(token)) return;
      const result = await this.pushLink(entry.link, entry.operationId, token);
      if (!this.isAuthIdentityFenceCurrent(token) || result.outcome === "stale-owner") return;
      const retryEntry = result.pendingEntry ?? entry;
      if (result.outcome === "success" || result.outcome === "drop") {
        await this.cache.removePendingLink(retryEntry.link.id, retryEntry.operationId);
        if (!this.isAuthIdentityFenceCurrent(token)) return;
        continue;
      }
      if (result.deferredBySuspension) return;
      await this.cache.recordPendingFailure(retryEntry.link.id, retryEntry.operationId, result.errorCode);
      if (!this.isAuthIdentityFenceCurrent(token)) return;
    }
  }
  private async persistLocal(link: ExternalSourceLink): Promise<void> {
    const links = this.mergeLocalLink(link);
    await this.cache.saveLinks(links);
    this.store.replaceAll(links);
  }
  private async persistLocalChangeForSync(link: ExternalSourceLink, options: { resetRetryCount?: boolean } = {}, onPending?: (pending: PendingExternalSourceLink) => void): Promise<PendingExternalSourceLink> { return localBackupUiRestoreWriterQuiescence.runContinuationAsync(this.currentUserId(), 'external-source', async () => {
    const pending = await this.cache.upsertPendingLink(link, options);
    onPending?.(pending);
    try {
      await this.persistLocal(link);
    } catch (error) {
      await this.removePendingLinkAfterLocalPersistFailure(pending, error);
      throw error;
    }
    return pending;
  }); }

  private async removePendingLinkAfterLocalPersistFailure(pending: PendingExternalSourceLink, error: unknown): Promise<void> {
    try {
      await this.cache.removePendingLink(pending.link.id, pending.operationId);
    } catch (cleanupError) {
      this.logger.warn("思源锚点本地持久化失败后清理 pending 队列失败", {
        linkId: safeExternalSourceId(pending.link.id),
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

  private async fetchExternalSourceLinkPages(
    client: ExternalSourceSupabaseClient,
    userId: string,
  ): Promise<SupabasePageResult<ExternalSourceLinkRow>> {
    return await fetchAllSupabaseKeysetPagesByCursor<
      ExternalSourceLinkRow,
      string
    >((cursor) => {
      let query = client
        .from("external_source_links")
        .select(
          "id,user_id,task_id,source_type,target_id,uri,label,hpath,role,sort_order,deleted_at,created_at,updated_at",
        )
        .eq("user_id", userId);
      if (cursor) {
        query = query.gt("id", cursor);
      }
      return query.order("id", { ascending: true });
    }, {
      readCursor: (row) => typeof row.id === "string" && row.id.length > 0
        ? row.id
        : null,
      cursorKey: (cursor) => cursor,
      isCursorAfter: (previous, next) => next > previous,
    });
  }

  private async pullRemoteLinks(ownerId = this.currentUserId(), token?: AuthIdentityFence): Promise<RemotePullResult> {
    const userId = ownerId;
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return { links: [], deferredBySuspension: false, failed: false };
    }

    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后拉取思源锚点", { userId })) {
      return { links: [], deferredBySuspension: true, failed: false };
    }
    const client = await this.getClient();
    if (token && !this.isAuthIdentityFenceCurrent(token)) return FAILED_REMOTE_PULL;
    if (!client) return FAILED_REMOTE_PULL;

    try {
      const { data, error } = await this.fetchExternalSourceLinkPages(client, userId);
      if (token && !this.isAuthIdentityFenceCurrent(token)) return FAILED_REMOTE_PULL;
      if (error) throw error;
      return {
        links: (data ?? []).map((row: ExternalSourceLinkRow) => rowToExternalSourceLink(row)),
        deferredBySuspension: false,
        failed: false,
      };
    } catch (error) {
      if (token && !this.isAuthIdentityFenceCurrent(token)) return FAILED_REMOTE_PULL;
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
    const token = this.captureAuthIdentityFence();
    const remoteById = new Map(remoteLinks.map((link) => [link.id, link]));
    const localsToPush = localLinks.filter((local) => {
      const remote = remoteById.get(local.id);
      return !remote || local.updatedAt > remote.updatedAt;
    });
    for (const local of localsToPush) {
      if (!this.isAuthIdentityFenceCurrent(token)) return;
      await this.cache.upsertPendingLink(local, { resetRetryCount: false });
      if (!this.isAuthIdentityFenceCurrent(token)) return;
    }
    if (localsToPush.length > 0) await this.flushPendingLinksInternal(token);
  }

  private async pushLink(
    link: ExternalSourceLink,
    operationId: string,
    token: AuthIdentityFence,
  ): Promise<PushLinkResult> {
    const userId = token.ownerId;
    if (!this.isAuthIdentityFenceCurrent(token)) return { outcome: "stale-owner" };
    if (this.deferRemoteWorkForSuspension("浏览器网络挂起，延后推送思源锚点", {
      linkId: safeExternalSourceId(link.id),
    })) {
      return { outcome: "retry", errorCode: "browser-network-suspended", deferredBySuspension: true };
    }

    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID)
      return { outcome: "drop", reason: "local-mode" };
    const client = await this.getClient();
    if (!this.isAuthIdentityFenceCurrent(token)) return { outcome: "stale-owner" };
    if (!client) return { outcome: "retry", errorCode: "no-client" };
    try {
      const { error } = await this.remoteWriter.upsertLink(client, link, userId, operationId);
      if (!this.isAuthIdentityFenceCurrent(token)) return { outcome: "stale-owner" };
      if (error) {
        const errorCode = (error as { code?: string }).code ?? "unknown";
        // 23505 = Postgres unique_violation：另一端已绑定同一 (task, target)。
        // 不再重试，丢弃 pending 项让下一次 ensureLoaded 重新拉远端真相。
        if (errorCode === POSTGRES_UNIQUE_VIOLATION) {
          return this.handleUniqueConflict(link, operationId, client, token);
        }
        throw error;
      }
      return { outcome: "success" };
    } catch (error) {
      if (!this.isAuthIdentityFenceCurrent(token)) return { outcome: "stale-owner" };
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
    client: ExternalSourceSupabaseClient,
    token: AuthIdentityFence,
  ): Promise<PushLinkResult> {
    if (!this.isAuthIdentityFenceCurrent(token)) return { outcome: "stale-owner" };
    this.logger.info("思源锚点唯一冲突，尝试切换到远端已有关联", {
      linkId: safeExternalSourceId(link.id),
    });
    const tombstone = buildExternalSourceUniqueConflictTombstone(link);
    let pendingEntry: PendingExternalSourceLink | null = null;
    try {
      pendingEntry = await this.cache.replacePendingLinkForRetry(link.id, operationId, tombstone, token.ownerId);
      if (!pendingEntry) return { outcome: "drop", reason: "duplicate" };
      if (!this.isAuthIdentityFenceCurrent(token)) return this.rollbackUniqueConflictPending(link, pendingEntry, token);
      const { error } = await this.remoteWriter.upsertLink(
        client, pendingEntry.link, token.ownerId, pendingEntry.operationId,
      );
      if (!this.isAuthIdentityFenceCurrent(token)) return this.rollbackUniqueConflictPending(link, pendingEntry, token);
      if (error) throw error;
      if (!(await this.persistUniqueConflictTombstone(pendingEntry.link, token))) return this.rollbackUniqueConflictPending(link, pendingEntry, token);
      if (!(await this.refreshAfterUniqueConflict(token))) return this.rollbackUniqueConflictPending(link, pendingEntry, token);
      if (!this.isAuthIdentityFenceCurrent(token)) return this.rollbackUniqueConflictPending(link, pendingEntry, token);
      this.toast.info("思源锚点已在其他设备建立，已切换到已有关联");
      return { outcome: "success", pendingEntry };
    } catch (error) {
      if (!this.isAuthIdentityFenceCurrent(token)) return pendingEntry
        ? this.rollbackUniqueConflictPending(link, pendingEntry, token) : { outcome: "stale-owner" };
      if (pendingEntry && !(await this.keepUniqueConflictTombstonePending(link, pendingEntry.link, token))) return { outcome: "stale-owner" };
      if (!this.isAuthIdentityFenceCurrent(token)) return { outcome: "stale-owner" };
      this.logger.warn("思源锚点唯一冲突收敛失败，等待下次刷新", {
        linkId: safeExternalSourceId(link.id),
        message: error instanceof Error ? error.message : "unknown",
      });
      this.toast.info("思源锚点已在其他设备建立，稍后自动刷新合并");
      return { outcome: "retry", errorCode: POSTGRES_UNIQUE_VIOLATION, pendingEntry: pendingEntry ?? undefined };
    }
  }

  private async rollbackUniqueConflictPending(
    link: ExternalSourceLink, pending: PendingExternalSourceLink, token: AuthIdentityFence,
  ): Promise<PushLinkResult> {
    await this.cache.replacePendingLinkForRetry(
      link.id, pending.operationId, link, token.ownerId,
    ).catch(() => null);
    return { outcome: "stale-owner" };
  }

  private async persistUniqueConflictTombstone(
    tombstone: ExternalSourceLink,
    token: AuthIdentityFence,
  ): Promise<boolean> {
    if (!this.isAuthIdentityFenceCurrent(token)) return false;
    const links = this.mergeLocalLink(tombstone);
    await this.cache.saveLinks(links, token.ownerId);
    if (!this.isAuthIdentityFenceCurrent(token)) return false;
    this.store.replaceAll(links);
    if (!this.isAuthIdentityFenceCurrent(token)) return false;
    await this.cache.deletePreviewsForLink(tombstone.id);
    return this.isAuthIdentityFenceCurrent(token);
  }

  private async refreshAfterUniqueConflict(token: AuthIdentityFence): Promise<boolean> {
    if (!this.isAuthIdentityFenceCurrent(token)) return false;
    const remotePull = await this.pullRemoteLinks(token.ownerId, token);
    if (!this.isAuthIdentityFenceCurrent(token)) return false;
    if (remotePull.deferredBySuspension || remotePull.failed)
      throw new Error("remote pull unavailable after unique conflict");
    this.lastPullAt = Date.now();
    const localLinks = await this.cache.loadLinks(token.ownerId);
    if (!this.isAuthIdentityFenceCurrent(token)) return false;
    const merged = mergeExternalSourceLinks(localLinks, remotePull.links);
    if (!this.isAuthIdentityFenceCurrent(token)) return false;
    this.store.replaceAll(merged);
    await this.cache.saveLinks(merged, token.ownerId);
    return this.isAuthIdentityFenceCurrent(token);
  }

  private async keepUniqueConflictTombstonePending(
    link: ExternalSourceLink,
    tombstone: ExternalSourceLink,
    token: AuthIdentityFence,
  ): Promise<boolean> {
    try {
      if (!this.isAuthIdentityFenceCurrent(token)) return false;
      return await this.persistUniqueConflictTombstone(tombstone, token);
    } catch (localError) {
      if (!this.isAuthIdentityFenceCurrent(token)) return false;
      this.logger.warn("思源锚点唯一冲突本地墓碑保留失败", {
        linkId: safeExternalSourceId(link.id),
        message: localError instanceof Error ? localError.message : "unknown",
      });
      return true;
    }
  }

  private async getClient(): Promise<ExternalSourceSupabaseClient | null> {
    return this.remoteWriter.getClient();
  }

  private currentUserId(): string {
    return this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private captureAuthIdentityFence(): AuthIdentityFence {
    return { ownerId: this.currentUserId(), authFence: this.auth.captureAuthIdentityFence() };
  }

  private sameAuthIdentityFence(left: AuthIdentityFence, right: AuthIdentityFence): boolean {
    return left.ownerId === right.ownerId && left.authFence === right.authFence;
  }

  private isAuthIdentityFenceCurrent(token: AuthIdentityFence): boolean {
    return !this.destroyed && this.sameAuthIdentityFence(token, this.captureAuthIdentityFence());
  }

  private assertImportOwner(ownerId: string): void {
    if (this.currentUserId() !== ownerId) throw new Error("External source link import owner changed");
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
    this.resumeSyncTimer = scheduleExternalSourceLinkResumeSyncTimer(
      (callback, timeoutMs) => window.setTimeout(callback, timeoutMs),
      () => {
        if (this.destroyed || generation !== this.resumeSyncGeneration) {
          return;
        }
        const shouldForceRefresh = this.resumeSyncForceRefresh;
        this.resumeSyncForceRefresh = false;
        this.resumeSyncTimer = null;
        this.runInBackground(this.refreshIfStale(shouldForceRefresh), "resume refresh");
        this.runInBackground(this.flushPendingLinks(), "resume flush");
      },
      delayMs,
      this.logger,
    );
  }

  private clearResumeSyncTimer(): void {
    const resumeSyncTimer = this.resumeSyncTimer;
    this.resumeSyncTimer = null;
    clearExternalSourceLinkResumeSyncTimer(
      resumeSyncTimer,
      (timer) => clearTimeout(timer),
      this.logger,
    );
    this.resumeSyncForceRefresh = false;
  }

  private runInBackground(operation: Promise<void>, label: string): void {
    void operation.catch(error => {
      try {
        this.logger.warn("思源锚点后台操作失败", {
          operation: label,
          message: error instanceof Error ? error.message : "unknown",
        });
      } catch {
        // Background error reporting must not create another unhandled rejection.
      }
    });
  }
}
