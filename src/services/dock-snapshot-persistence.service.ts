/**
 * DockSnapshotPersistenceService
 * 快照的序列化/反序列化、normalize、本地 IDB 持久化。
 * 从 DockEngineService 中提取，解耦数据持久化与业务状态逻辑。
 */
import { Injectable, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import { ErrorCodes } from '../utils/result';

import {
  CognitiveLoad,
  CURRENT_DOCK_SNAPSHOT_VERSION,
  DailySlotEntry,
  DockLane,
  DockEntry,
  DockPendingDecision,
  DockRuleDecision,
  DockRuleDecisionType,
  DockSessionState,
  DockSnapshot,
  DockSourceSection,
  DockTaskStatus,
  DockZoneSource,
  HighLoadCounter,
  RecommendationGroupType,
  fromLegacySessionState,
  type LegacyFocusSessionState,
} from '../models/parking-dock';
import { sanitizePlannerFields } from '../utils/planner-fields';
import { LoggerService } from './logger.service';
import { del, get, set } from 'idb-keyval';
import { TimerHandle } from '../utils/timer-handle';

export const DOCK_SNAPSHOT_IDB_DB_NAME = 'keyval-store';
const LOCAL_IDB_KEY_PREFIX = 'nanoflow.focus-session.v5';
// 持久化防抖 500ms（原 120ms 太激进，动画期间信号频繁变化导致
// JSON.stringify 阻塞动画帧；500ms 覆盖大多数连续动画周期）
const LOCAL_PERSIST_DEBOUNCE_MS = 500;

/** normalize 函数运行时所需的上下文（由 DockEngine 提供） */
export interface SnapshotNormalizeContext {
  muteWaitTone: boolean;
  todayDateKey: string;
  buildOverflowMeta: (entries: DockEntry[]) => { comboSelectOverflow: number; backupOverflow: number };
}

interface PersistedSnapshotCandidate {
  snapshot: DockSnapshot;
  source: 'idb-current' | 'idb-anonymous' | 'legacy-current' | 'legacy-anonymous';
}

@Injectable({
  providedIn: 'root',
})
export class DockSnapshotPersistenceService {
  private readonly logger = inject(LoggerService).category('DockSnapshotPersistence');
  private readonly localPersistTimer = new TimerHandle();
  /** 序列化 IDB 写入：上一次写入完成后才启动下一次 */
  private persistChain: Promise<void> = Promise.resolve();
  /** 待执行的本地持久化任务，用于卸载前同步写入影子快照 */
  private pendingLocalPersist: {
    snapshotFn: () => DockSnapshot;
    userId: string | null;
  } | null = null;

  // ─── Local IDB Persistence ───────────────────

  scheduleLocalPersist(
    snapshotFn: () => DockSnapshot,
    userId: string | null,
    getNonCriticalHoldDelay: () => number,
  ): void {
    this.pendingLocalPersist = { snapshotFn, userId };
    // M-3 fix: 持久化最大延迟上限，防止动画持续 hold 导致无限延迟
    const deadline = Date.now() + 10_000;
    const runPersist = () => {
      const holdDelay = getNonCriticalHoldDelay();
      if (holdDelay > 0 && Date.now() < deadline) {
        this.localPersistTimer.schedule(runPersist, holdDelay);
        return;
      }
      const resolved = snapshotFn();
      this.pendingLocalPersist = null;
      // structuredClone 深拷贝快照，避免后续异步 IDB 写入时引用被外部修改
      const cloned = structuredClone(resolved);
      // 串行化写入：前一次未完成时，本次写入排队等待
      // 链上附加 .catch 防止单次 IDB 写入失败导致整条链断裂（后续所有持久化静默丢失）
      const key = this.localCacheKey(userId);
      this.persistChain = this.persistChain.then(
        () => this.persistToIdb(key, cloned),
      ).catch(err => {
        this.logger.error('persistChain: IDB write failed, chain recovered', err);
      });
    };
    this.localPersistTimer.schedule(runPersist, LOCAL_PERSIST_DEBOUNCE_MS);
  }

  async restoreLocalSnapshot(
    userId: string | null,
    ctx: SnapshotNormalizeContext,
  ): Promise<DockSnapshot | null> {
    const currentIdbKey = this.localCacheKey(userId);
    const anonymousIdbKey = userId === null ? null : this.localCacheKey(null);
    const currentLegacyKey = this.legacyLocalStorageKey(userId);
    const anonymousLegacyKey = userId === null ? null : this.legacyLocalStorageKey(null);

    const [currentIdbSnapshot, anonymousIdbSnapshot] = await Promise.all([
      this.readNormalizedIdbSnapshot(currentIdbKey, ctx),
      anonymousIdbKey ? this.readNormalizedIdbSnapshot(anonymousIdbKey, ctx) : Promise.resolve(null),
    ]);

    const currentLegacySnapshot = this.readNormalizedLegacySnapshot(currentLegacyKey, ctx);
    const anonymousLegacySnapshot = anonymousLegacyKey
      ? this.readNormalizedLegacySnapshot(anonymousLegacyKey, ctx)
      : null;

    const candidates: PersistedSnapshotCandidate[] = [];
    if (currentIdbSnapshot) {
      candidates.push({ snapshot: currentIdbSnapshot, source: 'idb-current' });
    }
    if (anonymousIdbSnapshot) {
      candidates.push({ snapshot: anonymousIdbSnapshot, source: 'idb-anonymous' });
    }
    if (currentLegacySnapshot) {
      candidates.push({ snapshot: currentLegacySnapshot, source: 'legacy-current' });
    }
    if (anonymousLegacySnapshot) {
      candidates.push({ snapshot: anonymousLegacySnapshot, source: 'legacy-anonymous' });
    }

    const winner = candidates.reduce<PersistedSnapshotCandidate | null>(
      (best, candidate) => this.pickNewerPersistedSnapshot(best, candidate),
      null,
    );

    if (!winner) return null;

    if (winner.source !== 'idb-current') {
      try {
        await set(currentIdbKey, winner.snapshot);
      } catch (err) {
        this.logger.warn('IDB restore failed', {
          code: ErrorCodes.DOCK_IDB_RESTORE_FAILED,
          error: err,
        });
      }
    }

    if (typeof localStorage !== 'undefined') {
      if (winner.source === 'idb-anonymous' || winner.source === 'legacy-anonymous') {
        this.persistShadowToLocalStorage(winner.snapshot, userId);
      } else if (currentLegacySnapshot) {
        localStorage.removeItem(currentLegacyKey);
      }

      if (anonymousLegacyKey) {
        localStorage.removeItem(anonymousLegacyKey);
      }
    }

    if (anonymousIdbKey) {
      try {
        await del(anonymousIdbKey);
      } catch (err) {
        this.logger.warn('IDB fallback cleanup failed', {
          code: ErrorCodes.DOCK_IDB_RESTORE_FAILED,
          error: err,
        });
      }
    }

    return winner.snapshot;
  }

  cancelPendingPersist(): void {
    if (this.pendingLocalPersist) {
      const { snapshotFn, userId } = this.pendingLocalPersist;
      this.pendingLocalPersist = null;
      this.persistShadowToLocalStorage(snapshotFn(), userId);
    }
    this.localPersistTimer.cancel();
  }

  async discardPendingPersist(): Promise<void> {
    this.pendingLocalPersist = null;
    this.localPersistTimer.cancel();

    try {
      await this.persistChain;
    } catch {
      // persistChain 内部已自行恢复，这里只负责等待当前串行写入收敛。
    }

    this.persistChain = Promise.resolve();
  }

  private persistShadowToLocalStorage(snapshot: DockSnapshot, userId: string | null): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.legacyLocalStorageKey(userId), JSON.stringify(snapshot));
    } catch (err) {
      this.logger.warn('Legacy localStorage shadow persist failed', {
        code: ErrorCodes.DOCK_IDB_PERSIST_FAILED,
        error: err,
      });
    }
  }

  /** IDB 写入（含 1 次重试），失败不阻塞业务流 */
  private async persistToIdb(key: string, value: DockSnapshot): Promise<void> {
    // 配额预检：移动端 Safari 等环境 IDB 配额有限，静默降级避免数据丢失
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        if (usage != null && quota != null && quota - usage < 1024 * 1024) {
          this.logger.warn('IDB storage near quota limit, skipping persist', {
            code: ErrorCodes.DOCK_IDB_PERSIST_FAILED,
            usage,
            quota,
            key,
          });
          return;
        }
      } catch {
        // estimate() 不可用时静默跳过检查，继续尝试写入
      }
    }
    const maxRetries = 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await set(key, value);
        return;
      } catch (err) {
        if (attempt < maxRetries) continue;
        this.logger.warn('IDB persist failed after retry', {
          code: ErrorCodes.DOCK_IDB_PERSIST_FAILED,
          key,
          error: err,
        });
      }
    }
  }

  localCacheKey(userId: string | null): string {
    const scope = userId || 'anonymous';
    return `${LOCAL_IDB_KEY_PREFIX}.${scope}`;
  }

  legacyLocalStorageKey(userId: string | null): string {
    const scope = userId || 'anonymous';
    return `${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.${scope}`;
  }

  // ─── Snapshot Comparison ───────────────────

  isSnapshotNewer(incoming: DockSnapshot, current: DockSnapshot): boolean {
    const incomingAt = Date.parse(incoming.savedAt);
    const currentAt = Date.parse(current.savedAt);
    if (Number.isNaN(incomingAt)) return false;
    if (Number.isNaN(currentAt)) return true;
    return incomingAt > currentAt;
  }

  // ─── Legacy Recovery ───────────────────────

  recoverLegacyExternalDragDefaultBackup(entries: DockEntry[]): DockEntry[] {
    let changed = false;
    const next = entries.map(entry => {
      const isExternalDragSource =
        entry.sourceSection === 'text' || entry.sourceSection === 'flow';
      const isLegacyManualCombo =
        entry.sourceKind === 'project-task'
        && entry.zoneSource === 'manual'
        && entry.lane === 'combo-select'
        && isExternalDragSource
        && (
          !entry.relationReason
          || entry.relationReason === 'manual:combo-select'
        );

      if (!isLegacyManualCombo) return entry;

      changed = true;
      const migrated: DockEntry = {
        ...entry,
        lane: 'backup',
        relationScore: PARKING_CONFIG.ZONE_MANUAL_BACKUP_SCORE,
        relationReason: 'manual:default-backup',
      };
      return migrated;
    });

    return changed ? next : entries;
  }

  // ─── Normalize Functions ───────────────────

  /**
   * 快照反序列化与版本归一化。
   * 将 v2~v7 的原始快照统一转换为当前版本（v7）格式。
   *
   * 版本迁移路径：
   *   v2 → 初始版本，包含基础 entries 和 focusMode
   *   v3 → 新增 dailySlots 数组
   *   v4 → 新增 session.focusScrimOn / firstDragIntervened
   *   v5 → 新增 session.highLoadCounter / burnoutTriggeredAt
   *   v6 → 新增 session.focusSessionId / focusSessionStartedAt；弃用 focusSessionState
   *   v7 → 当前版本；新增 dailyResetDate / suspendRecommendationLocked
   *
   * 所有版本共用同一归一化代码路径，因为：
   *   1. 每个字段都有独立的 fallback 默认值（在 normalizeEntry/normalizeSessionState 中处理）
   *   2. 老版本快照中缺失的字段会自动填充默认值
   *   3. 无需逐版本递增迁移——直接从任意旧版本映射到 v7
   *
   * 当新增 v8 时的维护步骤：
   *   1. 将 8 加入 SUPPORTED_VERSIONS
   *   2. 在 normalizeEntry/normalizeSessionState 中为新字段添加 fallback
   *   3. 更新 exportSnapshot 输出 version: 8
   *   4. 更新此文档块
   */
  normalizeSnapshot(raw: unknown, ctx: SnapshotNormalizeContext): DockSnapshot | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Omit<Partial<DockSnapshot>, 'version'> & { version?: unknown };
    const version = source.version;
    const SUPPORTED_VERSIONS = new Set([2, 3, 4, 5, 6, 7]);
    if (!SUPPORTED_VERSIONS.has(version as number)) return null;

    const entries = Array.isArray(source.entries)
      ? source.entries.map(entry => this.normalizeEntry(entry, ctx)).filter((entry): entry is DockEntry => !!entry)
      : [];
    const dailySlots = Array.isArray(source.dailySlots)
      ? source.dailySlots.map(slot => this.normalizeDailySlot(slot)).filter((slot): slot is DailySlotEntry => !!slot)
      : [];
    const session = this.mergeSessionWithLegacy(source, entries, ctx);
    const focusMode = source.focusMode === undefined ? session.focusBlurOn : Boolean(source.focusMode);

    return {
      version: CURRENT_DOCK_SNAPSHOT_VERSION,
      entries,
      focusMode,
      isDockExpanded: source.isDockExpanded === undefined ? false : Boolean(source.isDockExpanded),
      muteWaitTone: Boolean(source.muteWaitTone),
      session,
      firstDragDone: session.firstDragIntervened,
      dailySlots,
      suspendChainRootTaskId:
        typeof source.suspendChainRootTaskId === 'string' && source.suspendChainRootTaskId
          ? source.suspendChainRootTaskId
          : null,
      suspendRecommendationLocked: Boolean(source.suspendRecommendationLocked),
      pendingDecision: this.normalizePendingDecision(source.pendingDecision),
      lastRuleDecision: this.normalizeRuleDecision(source.lastRuleDecision),
      dailyResetDate:
        typeof source.dailyResetDate === 'string' && source.dailyResetDate
          ? source.dailyResetDate
          : ctx.todayDateKey,
      savedAt: typeof source.savedAt === 'string' && source.savedAt ? source.savedAt : new Date().toISOString(),
    };
  }

  private async readNormalizedIdbSnapshot(key: string, ctx: SnapshotNormalizeContext): Promise<DockSnapshot | null> {
    try {
      const raw = await get(key);
      return this.normalizeSnapshot(raw, ctx);
    } catch (err) {
      this.logger.warn('IDB restore failed', {
        code: ErrorCodes.DOCK_IDB_RESTORE_FAILED,
        error: err,
      });
      return null;
    }
  }

  private readNormalizedLegacySnapshot(key: string, ctx: SnapshotNormalizeContext): DockSnapshot | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const legacyRaw = localStorage.getItem(key);
      if (!legacyRaw) return null;
      const parsed = JSON.parse(legacyRaw) as unknown;
      return this.normalizeSnapshot(parsed, ctx);
    } catch (err) {
      this.logger.warn('Legacy localStorage restore failed', {
        code: ErrorCodes.DOCK_IDB_RESTORE_FAILED,
        error: err,
      });
      return null;
    }
  }

  private pickNewerPersistedSnapshot(
    current: PersistedSnapshotCandidate | null,
    incoming: PersistedSnapshotCandidate | null,
  ): PersistedSnapshotCandidate | null {
    if (!current) return incoming;
    if (!incoming) return current;
    return this.isSnapshotNewer(incoming.snapshot, current.snapshot) ? incoming : current;
  }

  /** 合并 normalizedSession 与 legacyFocusSessionState（v2-v5 兼容） */
  private mergeSessionWithLegacy(
    source: Omit<Partial<DockSnapshot>, 'version'> & { version?: unknown },
    entries: DockEntry[],
    ctx: SnapshotNormalizeContext,
  ): DockSessionState {
    const legacyFirstDragDone = Boolean(source.firstDragDone);
    const fallbackFocusMode = Boolean(source.focusMode);
    const normalizedSession = this.normalizeSessionState(source.session, entries, fallbackFocusMode, legacyFirstDragDone, ctx);
    const legacyFocusState =
      source.focusSessionState && typeof source.focusSessionState === 'object'
        ? fromLegacySessionState(source.focusSessionState as LegacyFocusSessionState, {
            sessionId: normalizedSession.focusSessionId ?? crypto.randomUUID(),
            sessionStartedAt: normalizedSession.focusSessionStartedAt ?? Date.now(),
            isFocusOverlayOn: normalizedSession.focusScrimOn,
            highLoadCounter: normalizedSession.highLoadCounter ?? { count: 0, windowStartAt: 0 },
            burnoutTriggeredAt: normalizedSession.burnoutTriggeredAt ?? null,
          })
        : null;
    return {
      ...normalizedSession,
      focusScrimOn: legacyFocusState?.isFocusOverlayOn ?? normalizedSession.focusScrimOn,
      firstDragIntervened:
        legacyFocusState?.hasFirstBatchSelected ??
        normalizedSession.firstDragIntervened,
      highLoadCounter: legacyFocusState?.highLoadCounter ?? normalizedSession.highLoadCounter,
      burnoutTriggeredAt: legacyFocusState?.burnoutTriggeredAt ?? normalizedSession.burnoutTriggeredAt,
      focusSessionId: normalizedSession.focusSessionId ?? legacyFocusState?.sessionId,
      focusSessionStartedAt:
        normalizedSession.focusSessionStartedAt ??
        legacyFocusState?.sessionStartedAt,
    };
  }

  normalizeEntry(raw: unknown, ctx: SnapshotNormalizeContext): DockEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Partial<DockEntry>;
    // H-3 fix: 验证 taskId 为非空字符串。对不符合 UUID 格式的 taskId 记录警告
    // 但不拒绝（测试环境使用短 ID），仅拒绝空值和非字符串类型。
    if (!source.taskId || typeof source.taskId !== 'string' || !source.taskId.trim()) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source.taskId)) {
      this.logger.warn('normalizeEntry: taskId is not a valid UUID', { taskId: source.taskId });
    }

    const enumFields = this.normalizeEntryEnumFields(source);
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: source.expectedMinutes,
      waitMinutes: source.waitMinutes,
      cognitiveLoad: enumFields.load,
    });

    return {
      taskId: source.taskId,
      title: typeof source.title === 'string' ? source.title.slice(0, PARKING_CONFIG.MAX_ENTRY_TITLE_LENGTH) : 'Untitled task',
      sourceProjectId: typeof source.sourceProjectId === 'string' ? source.sourceProjectId : null,
      status: enumFields.status,
      load: plannerFields.cognitiveLoad ?? enumFields.load,
      expectedMinutes: plannerFields.expectedMinutes,
      waitMinutes: plannerFields.waitMinutes,
      waitStartedAt: typeof source.waitStartedAt === 'string' && !isNaN(Date.parse(source.waitStartedAt))
        ? source.waitStartedAt
        : null,
      lane: enumFields.lane,
      zoneSource: enumFields.zoneSource,
      isMain: Boolean(source.isMain),
      dockedOrder: Number.isFinite(source.dockedOrder) ? Number(source.dockedOrder) : 0,
      manualOrder: normalizeNullableNumber(source.manualOrder) ?? undefined,
      detail: typeof source.detail === 'string' ? source.detail.slice(0, PARKING_CONFIG.MAX_ENTRY_DETAIL_LENGTH) : '',
      sourceKind: enumFields.sourceKind,
      sourceBlackBoxEntryId:
        typeof source.sourceBlackBoxEntryId === 'string' && source.sourceBlackBoxEntryId
          ? source.sourceBlackBoxEntryId
          : null,
      inlineArchiveStatus: enumFields.inlineArchiveStatus,
      inlineArchivedTaskId:
        typeof source.inlineArchivedTaskId === 'string' && source.inlineArchivedTaskId
          ? source.inlineArchivedTaskId
          : null,
      systemSelected: Boolean(source.systemSelected),
      recommendedScore: normalizeNullableNumber(source.recommendedScore),
      sourceSection: normalizeSourceSection(source.sourceSection),
      manualMainSelected: Boolean(source.manualMainSelected),
      recommendationLocked: Boolean(source.recommendationLocked),
      snoozeRingMuted: source.snoozeRingMuted === undefined ? ctx.muteWaitTone : Boolean(source.snoozeRingMuted),
      relationScore: normalizeNullableNumber(source.relationScore),
      relationReason:
        typeof source.relationReason === 'string' && source.relationReason
          ? source.relationReason
          : null,
    };
  }

  /** 枚举类字段归一化：status、lane、load、sourceKind、inlineArchiveStatus */
  private normalizeEntryEnumFields(source: Partial<DockEntry>): {
    status: DockEntry['status'];
    lane: DockLane;
    zoneSource: DockZoneSource;
    load: CognitiveLoad;
    sourceKind: DockEntry['sourceKind'];
    inlineArchiveStatus: DockEntry['inlineArchiveStatus'];
  } {
    const status = normalizeStatus(source.status);
    const rawLane = (source as { lane?: unknown; zone?: unknown }).lane ?? (source as { zone?: unknown }).zone;
    const lane: DockLane =
      rawLane === 'combo-select' || rawLane === 'strong'
        ? 'combo-select'
        : 'backup';
    const zoneSource: DockZoneSource = source.zoneSource === 'manual' ? 'manual' : 'auto';
    const load: CognitiveLoad = source.load === 'high' ? 'high' : 'low';
    const sourceKind: DockEntry['sourceKind'] =
      source.sourceKind === 'dock-created'
        ? 'dock-created'
        : 'project-task';
    const inlineArchiveStatus: DockEntry['inlineArchiveStatus'] =
      source.inlineArchiveStatus === 'archiving' ||
      source.inlineArchiveStatus === 'archived' ||
      source.inlineArchiveStatus === 'failed' ||
      source.inlineArchiveStatus === 'pending'
        ? source.inlineArchiveStatus
        : sourceKind === 'dock-created'
          ? 'pending'
          : undefined;
    return { status, lane, zoneSource, load, sourceKind, inlineArchiveStatus };
  }

  normalizeDailySlot(raw: unknown): DailySlotEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Partial<DailySlotEntry>;
    if (!source.id || typeof source.id !== 'string') return null;
    return {
      id: source.id,
      title: typeof source.title === 'string' ? source.title : 'Untitled daily task',
      maxDailyCount: Number.isFinite(source.maxDailyCount) ? Math.max(1, Math.floor(Number(source.maxDailyCount))) : 1,
      todayCompletedCount: Number.isFinite(source.todayCompletedCount)
        ? Math.max(0, Math.floor(Number(source.todayCompletedCount)))
        : 0,
      isEnabled: source.isEnabled !== false,
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
    };
  }

  normalizePendingDecision(raw: unknown): DockPendingDecision | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Partial<DockPendingDecision> & { candidateTaskIds?: unknown };
    if (!source.rootTaskId || typeof source.rootTaskId !== 'string') return null;

    const candidateGroups = this.normalizeCandidateGroups(source);
    if (candidateGroups.length === 0 && !(typeof source.reason === 'string' && source.reason.includes('tight-blank'))) {
      return null;
    }

    return {
      rootTaskId: source.rootTaskId,
      rootRemainingMinutes: Number.isFinite(source.rootRemainingMinutes) ? Number(source.rootRemainingMinutes) : 0,
      candidateGroups,
      reason: typeof source.reason === 'string' && source.reason ? source.reason : '候选任务时长匹配异常',
      expiresAt: typeof source.expiresAt === 'string' ? source.expiresAt : undefined,
      autoPromoteAfterMs: Number.isFinite(source.autoPromoteAfterMs)
        ? Number(source.autoPromoteAfterMs)
        : undefined,
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
    };
  }

  /** 候选组归一化：支持新 candidateGroups 格式和 legacy candidateTaskIds */
  private normalizeCandidateGroups(
    source: Partial<DockPendingDecision> & { candidateTaskIds?: unknown },
  ): Array<{ type: RecommendationGroupType; taskIds: string[] }> {
    const normalizedGroups = Array.isArray(source.candidateGroups)
      ? source.candidateGroups
        .map(group => {
          if (!group || typeof group !== 'object') return null;
          const typed = group as { type?: unknown; taskIds?: unknown };
          if (
            typed.type !== 'homologous-advancement' &&
            typed.type !== 'cognitive-downgrade' &&
            typed.type !== 'asynchronous-boot'
          ) {
            return null;
          }
          const taskIds = Array.isArray(typed.taskIds)
            ? typed.taskIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
            : [];
          if (taskIds.length === 0) return null;
          return { type: typed.type, taskIds };
        })
        .filter((group): group is { type: RecommendationGroupType; taskIds: string[] } => !!group)
      : [];

    if (normalizedGroups.length > 0) return normalizedGroups;

    const legacyCandidates = Array.isArray(source.candidateTaskIds)
      ? source.candidateTaskIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    return legacyCandidates.length > 0
      ? [{ type: 'homologous-advancement' as RecommendationGroupType, taskIds: legacyCandidates }]
      : [];
  }

  private static readonly VALID_DECISION_TYPES: ReadonlySet<DockRuleDecisionType> = new Set<DockRuleDecisionType>([
    'first_suspend_recommendation',
    'completion_followup',
    'pending_decision',
    'fragment_phase',
    'idle_promote',
  ]);

  normalizeRuleDecision(raw: unknown): DockRuleDecision | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Partial<DockRuleDecision>;
    if (!source.type || typeof source.type !== 'string') return null;
    if (!DockSnapshotPersistenceService.VALID_DECISION_TYPES.has(source.type as DockRuleDecisionType)) return null;
    const reason =
      typeof source.reason === 'string' && source.reason
        ? source.reason
        : '规则引擎已完成调度';
    const recommendedTaskIds = Array.isArray(source.recommendedTaskIds)
      ? source.recommendedTaskIds.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      type: source.type as DockRuleDecisionType,
      reason,
      rootTaskId: typeof source.rootTaskId === 'string' ? source.rootTaskId : undefined,
      recommendedTaskIds,
      remainingMinutes: normalizeNullableNumber(source.remainingMinutes) ?? undefined,
      ratio: normalizeNullableNumber(source.ratio),
      createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : new Date().toISOString(),
    };
  }

  normalizeSessionState(
    raw: unknown,
    entries: DockEntry[],
    fallbackFocusMode: boolean,
    legacyFirstDragDone: boolean,
    ctx: SnapshotNormalizeContext,
  ): DockSessionState {
    const source = parseSessionSource(raw);
    const fallbacks = buildSessionFallbacks(entries);
    const idLists = resolveSessionIdLists(source, fallbacks);
    const fields = normalizeSessionFields(source, entries, ctx);

    return {
      firstDragIntervened:
        source?.firstDragIntervened ??
        source?.hasFirstBatchSelected ??
        legacyFirstDragDone,
      focusBlurOn: source?.focusBlurOn ?? fallbackFocusMode,
      focusScrimOn: source?.focusScrimOn ?? true,
      schedulerPhase: source?.schedulerPhase === 'paused' ? 'paused' : 'active',
      mainTaskId:
        typeof source?.mainTaskId === 'string' && source.mainTaskId
          ? source.mainTaskId
          : fallbacks.mainTaskId,
      comboSelectIds: idLists.comboSelectIds,
      backupIds: idLists.backupIds,
      ...fields,
    };
  }
}

// ─── normalizeSessionState 拆分辅助函数 ───

type SessionSource = Partial<DockSessionState> & {
  strongZoneIds?: string[];
  weakZoneIds?: string[];
  hasFirstBatchSelected?: boolean;
} | null;

function parseSessionSource(raw: unknown): SessionSource {
  return raw && typeof raw === 'object'
    ? (raw as NonNullable<SessionSource>)
    : null;
}

function buildSessionFallbacks(entries: DockEntry[]): {
  mainTaskId: string | null;
  comboSelectIds: string[];
  backupIds: string[];
} {
  const mainTaskId =
    entries.find(e => e.status === 'focusing')?.taskId ??
    entries.find(e => e.isMain && e.status !== 'completed')?.taskId ??
    null;
  const active = entries.filter(e => e.status !== 'completed' && !e.isMain);
  return {
    mainTaskId,
    comboSelectIds: active.filter(e => e.lane === 'combo-select').map(e => e.taskId),
    backupIds: active.filter(e => e.lane === 'backup').map(e => e.taskId),
  };
}

function toIdList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function resolveSessionIdLists(
  source: SessionSource,
  fallbacks: ReturnType<typeof buildSessionFallbacks>,
): { comboSelectIds: string[]; backupIds: string[] } {
  const combo = toIdList(source?.comboSelectIds);
  const backup = toIdList(source?.backupIds);
  const legacyCombo = toIdList(source?.strongZoneIds);
  const legacyBackup = toIdList(source?.weakZoneIds);
  const resolved = combo.length > 0 ? combo : legacyCombo;
  const resolvedBackup = backup.length > 0 ? backup : legacyBackup;
  return {
    comboSelectIds: resolved.length > 0 ? resolved : fallbacks.comboSelectIds,
    backupIds: resolvedBackup.length > 0 ? resolvedBackup : fallbacks.backupIds,
  };
}

function normalizeSessionFields(
  source: SessionSource,
  entries: DockEntry[],
  ctx: SnapshotNormalizeContext,
): Pick<DockSessionState, 'highLoadCounter' | 'burnoutTriggeredAt' | 'focusSessionId' | 'focusSessionStartedAt' | 'overflowMeta'> {
  const burnoutAt = source?.burnoutTriggeredAt;
  return {
    highLoadCounter: normalizeHighLoadCounter(source?.highLoadCounter),
    burnoutTriggeredAt: burnoutAt == null ? null : Number.isFinite(burnoutAt) ? Number(burnoutAt) : null,
    focusSessionId: typeof source?.focusSessionId === 'string' && source.focusSessionId ? source.focusSessionId : undefined,
    focusSessionStartedAt: Number.isFinite(source?.focusSessionStartedAt) ? Number(source?.focusSessionStartedAt) : undefined,
    overflowMeta: source?.overflowMeta && typeof source.overflowMeta === 'object'
      ? {
          comboSelectOverflow: Math.max(0, Number((source.overflowMeta as { comboSelectOverflow?: unknown }).comboSelectOverflow ?? 0) || 0),
          backupOverflow: Math.max(0, Number((source.overflowMeta as { backupOverflow?: unknown }).backupOverflow ?? 0) || 0),
        }
      : ctx.buildOverflowMeta(entries.filter(e => e.status !== 'completed')),
  };
}

// ─── Standalone normalize helpers (re-exported for DockEngine backward compat) ───

export function normalizeStatus(status: DockEntry['status'] | undefined): DockTaskStatus {
  if (
    status === 'focusing' ||
    status === 'suspended_waiting' ||
    status === 'wait_finished' ||
    status === 'stalled' ||
    status === 'completed'
  ) {
    return status;
  }
  return 'pending_start';
}

export function normalizeNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

export function normalizeHighLoadCounter(value: unknown): HighLoadCounter {
  if (!value || typeof value !== 'object') {
    return { count: 0, windowStartAt: 0 };
  }
  const source = value as Partial<HighLoadCounter>;
  const count = Number.isFinite(source.count) ? Math.max(0, Math.floor(Number(source.count))) : 0;
  const windowStartAt = Number.isFinite(source.windowStartAt) ? Number(source.windowStartAt) : 0;
  return { count, windowStartAt };
}

export function normalizeSourceSection(value: unknown): DockSourceSection | undefined {
  if (value === 'text' || value === 'flow' || value === 'dock-create') {
    return value;
  }
  return undefined;
}
