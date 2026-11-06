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
const externalSourceLinkFingerprint = (link: ExternalSourceLink): string => JSON.stringify([link.id, link.taskId, link.sourceType, link.targetId, link.uri, link.label, link.hpath, link.role, link.sortOrder, link.deletedAt, link.createdAt, link.updatedAt]);

@Injectable({ providedIn: "root" })
export class ExternalSourceCacheService {
  private readonly auth = inject(AuthService);
  private readonly previewGenerations = new Map<string, number>();

  ownerId(): string {
    return this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private linksKey(userId = this.ownerId()): string {
    return `external-source-links:${userId}`;
  }

  previewKey(linkId: string, blockId: string, userId = this.ownerId()): string {
    return `siyuan-preview-cache:${userId}:${linkId}:${blockId}`;
  }

  previewGeneration(linkId: string, userId = this.ownerId()): number {
    return this.previewGenerations.get(this.previewGenerationKey(linkId, userId)) ?? 0;
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

  async loadPendingLinks(userId = this.ownerId()): Promise<PendingExternalSourceLink[]> {
    let indexedPending: PendingExternalSourceLink[] = [];
    try {
      indexedPending = this.normalizePendingEntries(
        await get<PendingExternalSourceLink[]>(this.pendingLinksKey(userId)),
      );
    } catch {
      indexedPending = [];
    }

    return this.mergePendingEntries(indexedPending, this.readPendingMirror(userId))
      .filter((entry) => entry.syncState !== "dead_letter");
  }

  async replacePendingLinksForOwner(
    entries: PendingExternalSourceLink[],
    userId: string,
  ): Promise<void> {
    const normalized = this.normalizePendingEntries(entries)
      .filter(entry => entry.syncState !== "dead_letter");
    try {
      await set(this.pendingLinksKey(userId), normalized);
      if (!this.writePendingMirror(userId, normalized)) {
        throw new Error("external source pending-link mirror write failed");
      }
    } catch (error) {
      if (!this.writePendingMirror(userId, normalized)) {
        throw error;
      }
    }
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
    userId = this.ownerId(),
  ): Promise<PendingExternalSourceLink> {
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

  async removePendingLink(
    linkId: string,
    operationId: string,
    userId = this.ownerId(),
  ): Promise<boolean> {
    return this.settlePendingOperation(linkId, operationId, undefined, userId);
  }

  async restorePendingLinkSnapshot(
    linkId: string,
    operationId: string,
    previous: PendingExternalSourceLink | undefined,
    userId = this.ownerId(),
  ): Promise<boolean> {
    return this.settlePendingOperation(linkId, operationId, previous, userId);
  }

  private async settlePendingOperation(
    linkId: string,
    operationId: string,
    previous?: PendingExternalSourceLink,
    userId = this.ownerId(),
  ): Promise<boolean> {
    const mirrorCurrent = this.readPendingMirror(userId);
    const mirrorOutcome = this.replacePendingSnapshot(mirrorCurrent, linkId, operationId, previous);
    let rollbackMirror = mirrorCurrent;

    try {
      let outcome = mirrorOutcome;
      await update<PendingExternalSourceLink[]>(this.pendingLinksKey(userId), current => {
        rollbackMirror = this.mergePendingEntries(
          this.normalizePendingEntries(current),
          mirrorCurrent,
        );
        outcome = this.replacePendingSnapshot(rollbackMirror, linkId, operationId, previous);
        this.writePendingMirror(userId, outcome.nextPendingLinks);
        return outcome.nextPendingLinks;
      });
      this.writePendingMirror(userId, outcome.nextPendingLinks);
      return outcome.matched;
    } catch (error) {
      this.writePendingMirror(userId, rollbackMirror);
      throw error;
    }
  }

  async replacePendingLinkForRetry(
    linkId: string,
    operationId: string,
    retryLink: ExternalSourceLink,
    userId = this.ownerId(),
  ): Promise<PendingExternalSourceLink | null> {
    const mirrorCurrent = this.readPendingMirror(userId);
    const mirrorOutcome = this.replacePendingOperation(mirrorCurrent, linkId, operationId, retryLink);
    try {
      let outcome = mirrorOutcome;
      await update<PendingExternalSourceLink[]>(this.pendingLinksKey(userId), current => {
        outcome = this.replacePendingOperation(this.mergePendingEntries(
          this.normalizePendingEntries(current),
          mirrorCurrent,
        ), linkId, operationId, retryLink);
        this.writePendingMirror(userId, outcome.nextPendingLinks);
        return outcome.nextPendingLinks;
      });
      this.writePendingMirror(userId, outcome.nextPendingLinks);
      return outcome.entry;
    } catch (error) {
      if (this.writePendingMirror(userId, mirrorOutcome.nextPendingLinks)) return mirrorOutcome.entry;
      throw error;
    }
  }

  /**
   * 标记一次推送失败，递增 retryCount。超过 PENDING_MAX_RETRIES 则迁出到死信表。
   */
  async recordPendingFailure(
    linkId: string,
    operationId: string,
    errorCode: string,
  ): Promise<"retry_scheduled" | "dead_letter" | "stale"> {
    const userId = this.ownerId();
    const mirrorCurrent = this.readPendingMirror(userId);
    const mirrorOutcome = this.applyPendingFailureMutation(mirrorCurrent, linkId, operationId, errorCode);
    let rollbackMirror = mirrorCurrent;

    try {
      let outcome = mirrorOutcome;
      await update<PendingExternalSourceLink[]>(this.pendingLinksKey(userId), current => {
        rollbackMirror = this.mergePendingEntries(
          this.normalizePendingEntries(current),
          mirrorCurrent,
        );
        outcome = this.applyPendingFailureMutation(rollbackMirror, linkId, operationId, errorCode);
        this.writePendingMirror(userId, outcome.nextPendingLinks);
        return outcome.nextPendingLinks;
      });
      this.writePendingMirror(userId, outcome.nextPendingLinks);
      if (outcome.movedToDeadLetter) await this.appendDeadLetter(outcome.movedToDeadLetter, userId);
      return outcome.status;
    } catch (error) {
      this.writePendingMirror(userId, rollbackMirror);
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
    userId = this.ownerId(),
  ): Promise<LocalSiyuanPreviewCache | null> {
    const previewGeneration = this.previewGeneration(linkId, userId);
    const value = await get<LocalSiyuanPreviewCache>(
      this.previewKey(linkId, blockId, userId),
    );
    if (this.previewGeneration(linkId, userId) !== previewGeneration) return null;
    if (value?.linkId === linkId && value.blockId === blockId) return value;

    if (userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return null;
    }

    const legacy = await get<LocalSiyuanPreviewCache>(
      this.legacyPreviewKey(linkId, blockId),
    );
    if (this.previewGeneration(linkId, userId) !== previewGeneration) return null;
    if (!legacy || legacy.linkId !== linkId || legacy.blockId !== blockId)
      return null;
    if (!(await this.savePreview(legacy, userId, previewGeneration))) return null;
    await del(this.legacyPreviewKey(linkId, blockId));
    return legacy;
  }

  async savePreview(
    cache: LocalSiyuanPreviewCache,
    userId = this.ownerId(),
    expectedGeneration = this.previewGeneration(cache.linkId, userId),
  ): Promise<boolean> {
    const key = this.previewKey(cache.linkId, cache.blockId, userId);
    if (this.previewGeneration(cache.linkId, userId) !== expectedGeneration) return false;
    await set(key, cache);
    if (this.previewGeneration(cache.linkId, userId) !== expectedGeneration) {
      await del(key);
      return false;
    }
    await this.prunePreviewCache(userId);
    if (this.previewGeneration(cache.linkId, userId) !== expectedGeneration) {
      await del(key);
      return false;
    }
    return true;
  }

  async deletePreview(linkId: string, blockId: string, userId = this.ownerId()): Promise<void> {
    const deletions = [del(this.previewKey(linkId, blockId, userId))];
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      deletions.push(del(this.legacyPreviewKey(linkId, blockId)));
    }
    await Promise.all(deletions);
  }

  async deletePreviewsForLink(linkId: string, ownerUserId = this.ownerId()): Promise<void> {
    this.invalidatePreviewGeneration(linkId, ownerUserId);
    const allKeys = await keys();
    const prefix = `siyuan-preview-cache:${ownerUserId}:${linkId}:`;
    const legacyPrefix = `siyuan-preview-cache:${linkId}:`;
    await Promise.all(
      allKeys
        .filter(
          (key) =>
            typeof key === "string" &&
            (key.startsWith(prefix)
              || (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID && key.startsWith(legacyPrefix))),
        )
        .map((key) => del(key)),
    );
  }

  async clearPreviewCache(): Promise<void> {
    const ownerUserId = this.ownerId();
    const allKeys = await keys();
    const prefix = `siyuan-preview-cache:${ownerUserId}:`;
    await Promise.all(
      allKeys
        .filter((key) => typeof key === "string" && key.startsWith(prefix))
        .map((key) => del(key)),
    );
  }

  async loadConfig(userId = this.ownerId()): Promise<SiyuanLocalConfig> {
    const value = await get<SiyuanLocalConfig>(this.configKey(userId));
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

  private async prunePreviewCache(userId = this.ownerId()): Promise<void> {
    const prefix = `siyuan-preview-cache:${userId}:`;
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

  private invalidatePreviewGeneration(linkId: string, userId: string): void {
    const key = this.previewGenerationKey(linkId, userId);
    this.previewGenerations.set(key, (this.previewGenerations.get(key) ?? 0) + 1);
  }

  private previewGenerationKey(linkId: string, userId: string): string {
    return JSON.stringify([userId, linkId]);
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
    const exactRetry = previous !== undefined
      && externalSourceLinkFingerprint(previous.link) === externalSourceLinkFingerprint(link);
    const retained = exactRetry ? previous : undefined;
    next.set(link.id, this.normalizePendingEntry({
      ...retained,
      link,
      localCommittedAt: exactRetry
        ? previous.localCommittedAt
        : Math.max(Date.now(), (previous?.localCommittedAt ?? 0) + 1),
      retryCount: options.resetRetryCount ? 0 : retained?.retryCount ?? 0,
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
    operationId: string,
    errorCode: string,
  ): {
    nextPendingLinks: PendingExternalSourceLink[];
    movedToDeadLetter: PendingExternalSourceLink | null;
    status: "retry_scheduled" | "dead_letter" | "stale";
  } {
    const nextPendingLinks: PendingExternalSourceLink[] = [];
    let movedToDeadLetter: PendingExternalSourceLink | null = null;
    let status: "retry_scheduled" | "dead_letter" | "stale" = "stale";

    for (const entry of list) {
      if (entry.link.id !== linkId || entry.operationId !== operationId) {
        nextPendingLinks.push(this.normalizePendingEntry(entry, entry.syncState));
        continue;
      }

      const retryCount = (entry.retryCount ?? 0) + 1;
      const syncState: PendingExternalSourceLinkSyncState = retryCount > SIYUAN_CONFIG.PENDING_MAX_RETRIES
        ? "dead_letter"
        : "retry_scheduled";
      status = syncState;
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

    return { nextPendingLinks, movedToDeadLetter, status };
  }

  private replacePendingSnapshot(
    list: PendingExternalSourceLink[],
    linkId: string,
    operationId: string,
    previous?: PendingExternalSourceLink,
  ): { nextPendingLinks: PendingExternalSourceLink[]; matched: boolean } {
    const index = list.findIndex(entry => entry.link.id === linkId && entry.operationId === operationId);
    if (index < 0) return { nextPendingLinks: list, matched: false };
    const nextPendingLinks = [...list];
    if (previous) nextPendingLinks.splice(index, 1, this.normalizePendingEntry(previous, previous.syncState));
    else nextPendingLinks.splice(index, 1);
    return {
      nextPendingLinks,
      matched: true,
    };
  }

  private replacePendingOperation(
    list: PendingExternalSourceLink[],
    linkId: string,
    operationId: string,
    retryLink: ExternalSourceLink,
  ): { nextPendingLinks: PendingExternalSourceLink[]; entry: PendingExternalSourceLink | null } {
    const current = this.findPendingEntry(list, linkId);
    if (retryLink.id !== linkId || current?.operationId !== operationId) {
      return { nextPendingLinks: list, entry: null };
    }
    const nextPendingLinks = this.upsertPendingLinkIntoList(list, retryLink, { resetRetryCount: false });
    return { nextPendingLinks, entry: this.findPendingEntry(nextPendingLinks, linkId) ?? null };
  }

  private timeValue(value?: string): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

}
