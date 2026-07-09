import { Injectable, inject } from "@angular/core";
import { del, get, keys, set, update } from "idb-keyval";
import { AuthService } from "../../../services/auth.service";
import { AUTH_CONFIG } from "../../../config/auth.config";
import { SIYUAN_CONFIG } from "../../../config/siyuan.config";
import { createSyncOperationId, isSyncOperationId } from "../../../utils/sync-operation-id";
import type {
  ExternalSourceLink,
  LocalSiyuanPreviewCache,
  PendingExternalSourceLink,
  PendingExternalSourceLinkSyncState,
  SiyuanLocalConfig,
} from "./external-source.model";

const LOCAL_STORAGE_LINKS_PREFIX = "nanoflow.externalSource.links.";
const LOCAL_STORAGE_PENDING_PREFIX = "nanoflow.externalSource.pending.";
const LOCAL_STORAGE_DEAD_LETTERS_PREFIX = "nanoflow.externalSource.deadLetters.";

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

  async loadLinks(userId = this.ownerId()): Promise<ExternalSourceLink[]> {
    let indexedLinks: ExternalSourceLink[] = [];
    try {
      indexedLinks = this.normalizeLinks(await get<ExternalSourceLink[]>(this.linksKey(userId)));
    } catch {
      indexedLinks = [];
    }

    return this.mergeLinks(indexedLinks, this.readLinksMirror(userId));
  }

  async saveLinks(links: ExternalSourceLink[], userId = this.ownerId()): Promise<void> {
    try {
      await set(this.linksKey(userId), links);
      this.writeLinksMirror(userId, links);
    } catch (error) {
      if (!this.writeLinksMirror(userId, links)) {
        throw error;
      }
    }
  }

  async loadPendingLinks(): Promise<PendingExternalSourceLink[]> {
    let indexedPending: PendingExternalSourceLink[] = [];
    try {
      indexedPending = this.normalizePendingEntries(
        await get<PendingExternalSourceLink[]>(this.pendingLinksKey()),
      );
    } catch {
      indexedPending = [];
    }

    return this.mergePendingEntries(indexedPending, this.readPendingMirror())
      .filter((entry) => entry.syncState !== "dead_letter");
  }

  private normalizePendingEntry(
    entry: Partial<PendingExternalSourceLink> & { link: ExternalSourceLink },
    syncState: PendingExternalSourceLinkSyncState = entry.syncState ?? "pending_sync",
  ): PendingExternalSourceLink {
    const now = Date.now();
    return {
      link: entry.link,
      operationId: isSyncOperationId(entry.operationId)
        ? entry.operationId
        : createSyncOperationId(),
      localCommittedAt: typeof entry.localCommittedAt === "number" ? entry.localCommittedAt : now,
      syncState,
      retryCount: entry.retryCount ?? 0,
      lastTriedAt: entry.lastTriedAt,
      lastErrorCode: entry.lastErrorCode,
    };
  }

  /**
   * 原子化 upsert：使用 idb-keyval.update 在同一 IDB readwrite 事务内完成
   * read-modify-write，避免与 flushPendingLinks 并发时丢写。
   */
  async upsertPendingLink(
    link: ExternalSourceLink,
    options: { resetRetryCount?: boolean } = {},
  ): Promise<PendingExternalSourceLink> {
    const userId = this.ownerId();
    const mirrorNext = this.upsertPendingLinkIntoList(
      this.readPendingMirror(userId),
      link,
      options,
    );
    const mirrorEntry = this.findPendingEntry(mirrorNext, link.id);
    if (!mirrorEntry) {
      throw new Error(`Pending external source link ${link.id} was not enqueued`);
    }

    try {
      let persistedNext = mirrorNext;
      let persistedEntry = mirrorEntry;
      await update<PendingExternalSourceLink[]>(this.pendingLinksKey(userId), current => {
        const indexedNext = this.mergePendingEntries(
          this.normalizePendingEntries(current),
          mirrorNext,
        );
        persistedNext = indexedNext;
        persistedEntry = this.findPendingEntry(indexedNext, link.id) ?? persistedEntry;
        this.writePendingMirror(userId, indexedNext);
        return indexedNext;
      });
      this.writePendingMirror(userId, persistedNext);
      return persistedEntry;
    } catch (error) {
      if (this.writePendingMirror(userId, mirrorNext)) {
        return mirrorEntry;
      }
      throw error;
    }
  }

  async removePendingLink(linkId: string): Promise<void> {
    const userId = this.ownerId();
    const mirrorNext = this.readPendingMirror(userId).filter(entry => entry.link.id !== linkId);

    try {
      let persistedNext = mirrorNext;
      await update<PendingExternalSourceLink[]>(this.pendingLinksKey(userId), current => {
        const indexedNext = this.mergePendingEntries(
          this.normalizePendingEntries(current),
          mirrorNext,
        ).filter(entry => entry.link.id !== linkId);
        persistedNext = indexedNext;
        this.writePendingMirror(userId, indexedNext);
        return indexedNext;
      });
      this.writePendingMirror(userId, persistedNext);
    } catch (error) {
      if (this.writePendingMirror(userId, mirrorNext)) {
        return;
      }
      throw error;
    }
  }

  /**
   * 标记一次推送失败，递增 retryCount。超过 PENDING_MAX_RETRIES 则迁出到死信表。
   */
  async recordPendingFailure(linkId: string, errorCode: string): Promise<void> {
    const userId = this.ownerId();
    const mirrorCurrent = this.readPendingMirror(userId);
    const outcome = this.applyPendingFailureMutation(mirrorCurrent, linkId, errorCode);
    const mirrorNext = outcome.nextPendingLinks;
    const movedToDeadLetter = outcome.movedToDeadLetter;

    try {
      let persistedNext = mirrorNext;
      let indexedMovedToDeadLetter: PendingExternalSourceLink | null = null;
      await update<PendingExternalSourceLink[]>(this.pendingLinksKey(userId), current => {
        const indexedOutcome = this.applyPendingFailureMutation(
          this.normalizePendingEntries(current),
          linkId,
          errorCode,
        );
        const indexedNext = this.mergePendingEntries(
          indexedOutcome.nextPendingLinks,
          mirrorNext,
        );
        persistedNext = indexedNext;
        indexedMovedToDeadLetter = indexedOutcome.movedToDeadLetter;
        this.writePendingMirror(userId, indexedNext);
        return indexedNext;
      });
      this.writePendingMirror(userId, persistedNext);
      const deadLetter = movedToDeadLetter ?? indexedMovedToDeadLetter;
      if (deadLetter) {
        await this.appendDeadLetter(deadLetter, userId);
      }
    } catch (error) {
      if (this.writePendingMirror(userId, mirrorNext)) {
        if (movedToDeadLetter) {
          await this.appendDeadLetter(movedToDeadLetter, userId);
        }
        return;
      }
      throw error;
    }
  }

  async loadDeadLetters(): Promise<PendingExternalSourceLink[]> {
    const userId = this.ownerId();
    let indexedDeadLetters: PendingExternalSourceLink[] = [];
    try {
      indexedDeadLetters = this.normalizePendingEntries(
        await get<PendingExternalSourceLink[]>(this.deadLettersKey(userId)),
        "dead_letter",
      );
    } catch {
      indexedDeadLetters = [];
    }

    return this.mergePendingEntries(indexedDeadLetters, this.readDeadLetterMirror(userId), "dead_letter")
      .filter(entry => entry.syncState === "dead_letter");
  }

  private async appendDeadLetter(entry: PendingExternalSourceLink, userId = this.ownerId()): Promise<void> {
    const mirrorNext = this.mergePendingEntries(
      this.readDeadLetterMirror(userId),
      [entry],
      "dead_letter",
    );

    try {
      await update<PendingExternalSourceLink[]>(this.deadLettersKey(userId), current => {
        const indexedNext = this.mergePendingEntries(
          this.normalizePendingEntries(current, "dead_letter"),
          mirrorNext,
          "dead_letter",
        );
        this.writeDeadLetterMirror(userId, indexedNext);
        return indexedNext;
      });
      this.writeDeadLetterMirror(userId, mirrorNext);
    } catch (error) {
      if (this.writeDeadLetterMirror(userId, mirrorNext)) {
        return;
      }
      throw error;
    }
  }

  async getPreview(
    linkId: string,
    blockId: string,
  ): Promise<LocalSiyuanPreviewCache | null> {
    const value = await get<LocalSiyuanPreviewCache>(
      this.previewKey(linkId, blockId),
    );
    if (value?.linkId === linkId && value.blockId === blockId) return value;

    if (this.ownerId() !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return null;
    }

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

  private normalizeLinks(
    links: ExternalSourceLink[] | null | undefined,
  ): ExternalSourceLink[] {
    return Array.isArray(links)
      ? links.filter((link): link is ExternalSourceLink => this.isExternalSourceLink(link))
      : [];
  }

  private readLinksMirror(userId = this.ownerId()): ExternalSourceLink[] {
    return this.readLocalStorageArray<ExternalSourceLink>(this.linksMirrorKey(userId))
      .filter((link): link is ExternalSourceLink => this.isExternalSourceLink(link));
  }

  private writeLinksMirror(userId = this.ownerId(), links: ExternalSourceLink[]): boolean {
    return this.writeLocalStorageArray(this.linksMirrorKey(userId), this.normalizeLinks(links));
  }

  private mergeLinks(
    indexedLinks: ExternalSourceLink[],
    mirroredLinks: ExternalSourceLink[],
  ): ExternalSourceLink[] {
    const next = new Map<string, ExternalSourceLink>();
    for (const link of [...mirroredLinks, ...indexedLinks]) {
      if (!link?.id) continue;
      const current = next.get(link.id);
      if (!current) {
        next.set(link.id, link);
        continue;
      }

      const currentTime = new Date(current.updatedAt).getTime();
      const nextTime = new Date(link.updatedAt).getTime();
      if (Number.isFinite(nextTime) && (!Number.isFinite(currentTime) || nextTime >= currentTime)) {
        next.set(link.id, link);
      }
    }

    return [...next.values()];
  }

  private normalizePendingEntries(
    entries: Array<PendingExternalSourceLink | (Partial<PendingExternalSourceLink> & { link?: ExternalSourceLink })> | null | undefined,
    defaultSyncState: PendingExternalSourceLinkSyncState = "pending_sync",
  ): PendingExternalSourceLink[] {
    return Array.isArray(entries)
      ? entries
        .filter((entry): entry is Partial<PendingExternalSourceLink> & { link: ExternalSourceLink } =>
          this.isPendingExternalSourceLink(entry))
        .map(entry => this.normalizePendingEntry({
          ...entry,
          link: entry.link,
        }, entry.syncState ?? defaultSyncState))
      : [];
  }

  private readPendingMirror(userId = this.ownerId()): PendingExternalSourceLink[] {
    return this.normalizePendingEntries(
      this.readLocalStorageArray<PendingExternalSourceLink>(this.pendingMirrorKey(userId)),
    );
  }

  private writePendingMirror(userId: string, entries: PendingExternalSourceLink[]): boolean {
    return this.writeLocalStorageArray(this.pendingMirrorKey(userId), entries);
  }

  private mergePendingEntries(
    indexedPending: PendingExternalSourceLink[],
    mirroredPending: PendingExternalSourceLink[],
    defaultSyncState: PendingExternalSourceLinkSyncState = "pending_sync",
  ): PendingExternalSourceLink[] {
    const next = new Map<string, PendingExternalSourceLink>();
    for (const entry of [...mirroredPending, ...indexedPending]) {
      if (!entry?.link?.id) continue;
      const normalized = this.normalizePendingEntry(
        { ...entry, link: entry.link },
        entry.syncState ?? defaultSyncState,
      );
      const current = next.get(normalized.link.id);
      if (!current || this.shouldPreferPendingEntry(normalized, current)) {
        next.set(normalized.link.id, normalized);
      }
    }

    return [...next.values()];
  }

  private shouldPreferPendingEntry(
    candidate: PendingExternalSourceLink,
    current: PendingExternalSourceLink,
  ): boolean {
    const candidateCommittedAt = candidate.localCommittedAt ?? 0;
    const currentCommittedAt = current.localCommittedAt ?? 0;
    if (candidateCommittedAt !== currentCommittedAt) {
      return candidateCommittedAt > currentCommittedAt;
    }

    const candidateRetryCount = candidate.retryCount ?? 0;
    const currentRetryCount = current.retryCount ?? 0;
    if (candidateRetryCount !== currentRetryCount) {
      return candidateRetryCount > currentRetryCount;
    }

    const candidateTriedAt = this.timeValue(candidate.lastTriedAt);
    const currentTriedAt = this.timeValue(current.lastTriedAt);
    if (candidateTriedAt !== currentTriedAt) {
      return candidateTriedAt > currentTriedAt;
    }

    return candidate.syncState === "dead_letter" && current.syncState !== "dead_letter";
  }

  private readDeadLetterMirror(userId = this.ownerId()): PendingExternalSourceLink[] {
    return this.normalizePendingEntries(
      this.readLocalStorageArray<PendingExternalSourceLink>(this.deadLettersMirrorKey(userId)),
      "dead_letter",
    );
  }

  private writeDeadLetterMirror(userId: string, entries: PendingExternalSourceLink[]): boolean {
    return this.writeLocalStorageArray(this.deadLettersMirrorKey(userId), entries);
  }

  private isPendingExternalSourceLink(
    value: unknown,
  ): value is Partial<PendingExternalSourceLink> & { link: ExternalSourceLink } {
    if (!value || typeof value !== "object") {
      return false;
    }

    const entry = value as Partial<PendingExternalSourceLink> & { link?: ExternalSourceLink };
    return !!entry.link && this.isExternalSourceLink(entry.link);
  }

  private isExternalSourceLink(value: unknown): value is ExternalSourceLink {
    if (!value || typeof value !== "object") {
      return false;
    }

    const link = value as Partial<ExternalSourceLink>;
    return typeof link.id === "string"
      && link.id.length > 0
      && typeof link.taskId === "string"
      && link.taskId.length > 0
      && typeof link.sourceType === "string"
      && typeof link.targetId === "string"
      && typeof link.uri === "string"
      && typeof link.sortOrder === "number"
      && typeof link.createdAt === "string"
      && typeof link.updatedAt === "string";
  }

  private readLocalStorageArray<T>(key: string): T[] {
    if (typeof localStorage === "undefined") {
      return [];
    }

    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      localStorage.removeItem(key);
      return [];
    }
  }

  private writeLocalStorageArray<T>(key: string, entries: T[]): boolean {
    if (typeof localStorage === "undefined") {
      return false;
    }

    try {
      localStorage.setItem(key, JSON.stringify(entries));
      return true;
    } catch {
      return false;
    }
  }

  private linksMirrorKey(userId: string): string {
    return `${LOCAL_STORAGE_LINKS_PREFIX}${userId}`;
  }

  private pendingMirrorKey(userId: string): string {
    return `${LOCAL_STORAGE_PENDING_PREFIX}${userId}`;
  }

  private deadLettersMirrorKey(userId: string): string {
    return `${LOCAL_STORAGE_DEAD_LETTERS_PREFIX}${userId}`;
  }

  private upsertPendingLinkIntoList(
    list: PendingExternalSourceLink[],
    link: ExternalSourceLink,
    options: { resetRetryCount?: boolean },
  ): PendingExternalSourceLink[] {
    const next = new Map(list.map((entry) => [entry.link.id, entry]));
    const previous = next.get(link.id);
    next.set(link.id, this.normalizePendingEntry({
      ...previous,
      link,
      retryCount: options.resetRetryCount ? 0 : previous?.retryCount ?? 0,
    }, "pending_sync"));
    return Array.from(next.values());
  }

  private findPendingEntry(
    list: PendingExternalSourceLink[],
    linkId: string,
  ): PendingExternalSourceLink | undefined {
    return list.find(entry => entry.link.id === linkId);
  }

  private applyPendingFailureMutation(
    list: PendingExternalSourceLink[],
    linkId: string,
    errorCode: string,
  ): {
    nextPendingLinks: PendingExternalSourceLink[];
    movedToDeadLetter: PendingExternalSourceLink | null;
  } {
    const nextPendingLinks: PendingExternalSourceLink[] = [];
    let movedToDeadLetter: PendingExternalSourceLink | null = null;

    for (const entry of list) {
      if (entry.link.id !== linkId) {
        nextPendingLinks.push(this.normalizePendingEntry(entry, entry.syncState));
        continue;
      }

      const retryCount = (entry.retryCount ?? 0) + 1;
      const syncState: PendingExternalSourceLinkSyncState = retryCount > SIYUAN_CONFIG.PENDING_MAX_RETRIES
        ? "dead_letter"
        : "retry_scheduled";
      const updated = this.normalizePendingEntry({
        ...entry,
        retryCount,
        lastTriedAt: new Date().toISOString(),
        lastErrorCode: errorCode,
      }, syncState);
      if (syncState === "dead_letter") {
        movedToDeadLetter = updated;
      } else {
        nextPendingLinks.push(updated);
      }
    }

    return { nextPendingLinks, movedToDeadLetter };
  }

  private timeValue(value?: string): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

}
