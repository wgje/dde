/**
 * DockSnapshotPersistenceService
 * 快照的序列化/反序列化、normalize、本地 IDB 持久化。
 * 从 DockEngineService 中提取，解耦数据持久化与业务状态逻辑。
 */
import { Injectable, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';

import {
  CognitiveLoad,
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
import { get, set } from 'idb-keyval';

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

@Injectable({
  providedIn: 'root',
})
export class DockSnapshotPersistenceService {
  private readonly logger = inject(LoggerService).category('DockSnapshotPersistence');
  private localPersistTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Local IDB Persistence ───────────────────

  scheduleLocalPersist(
    snapshotFn: () => DockSnapshot,
    userId: string | null,
    getNonCriticalHoldDelay: () => number,
  ): void {
    if (this.localPersistTimer) clearTimeout(this.localPersistTimer);
    const runPersist = () => {
      const holdDelay = getNonCriticalHoldDelay();
      if (holdDelay > 0) {
        this.localPersistTimer = setTimeout(runPersist, holdDelay);
        return;
      }
      this.localPersistTimer = null;
      const resolved = snapshotFn();
      void set(this.localCacheKey(userId), resolved).catch(() => {
        // Ignore IndexedDB failures.
      });
    };
    this.localPersistTimer = setTimeout(runPersist, LOCAL_PERSIST_DEBOUNCE_MS);
  }

  async restoreLocalSnapshot(
    userId: string | null,
    ctx: SnapshotNormalizeContext,
  ): Promise<DockSnapshot | null> {
    try {
      const raw = await get(this.localCacheKey(userId));
      const normalized = this.normalizeSnapshot(raw, ctx);
      if (normalized) return normalized;

      // Legacy one-time local import path (localStorage v2/v3/v4).
      if (typeof localStorage !== 'undefined') {
        const legacyRaw = localStorage.getItem(this.legacyLocalStorageKey(userId));
        if (legacyRaw) {
          const parsed = JSON.parse(legacyRaw) as DockSnapshot;
          return this.normalizeSnapshot(parsed, ctx);
        }
      }
      return null;
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- IDB 读取失败时安全降级为空状态
      return null;
    }
  }

  cancelPendingPersist(): void {
    if (this.localPersistTimer) {
      clearTimeout(this.localPersistTimer);
      this.localPersistTimer = null;
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
        relationScore: 20,
        relationReason: 'manual:default-backup',
      };
      return migrated;
    });

    return changed ? next : entries;
  }

  // ─── Normalize Functions ───────────────────

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
    const session: DockSessionState = {
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
    const focusMode = source.focusMode === undefined ? session.focusBlurOn : Boolean(source.focusMode);

    return {
      version: 7,
      entries,
      focusMode,
      isDockExpanded: source.isDockExpanded === undefined ? true : Boolean(source.isDockExpanded),
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

  normalizeEntry(raw: unknown, ctx: SnapshotNormalizeContext): DockEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Partial<DockEntry>;
    if (!source.taskId || typeof source.taskId !== 'string') return null;

    const status = normalizeStatus(source.status);
    const rawLane = (source as { lane?: unknown; zone?: unknown }).lane ?? (source as { zone?: unknown }).zone;
    const lane: DockLane =
      rawLane === 'combo-select' || rawLane === 'strong'
        ? 'combo-select'
        : 'backup';
    const zoneSource: DockZoneSource = source.zoneSource === 'manual' ? 'manual' : 'auto';
    const load: CognitiveLoad = source.load === 'high' ? 'high' : 'low';
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: source.expectedMinutes,
      waitMinutes: source.waitMinutes,
      cognitiveLoad: load,
    });
    const sourceKind: DockEntry['sourceKind'] =
      source.sourceKind === 'dock-created'
        ? 'dock-created'
        : 'project-task';
    const normalizedInlineArchiveStatus: DockEntry['inlineArchiveStatus'] =
      source.inlineArchiveStatus === 'archiving' ||
      source.inlineArchiveStatus === 'archived' ||
      source.inlineArchiveStatus === 'failed' ||
      source.inlineArchiveStatus === 'pending'
        ? source.inlineArchiveStatus
        : sourceKind === 'dock-created'
          ? 'pending'
          : undefined;

    return {
      taskId: source.taskId,
      title: typeof source.title === 'string' ? source.title : 'Untitled task',
      sourceProjectId: typeof source.sourceProjectId === 'string' ? source.sourceProjectId : null,
      status,
      load: plannerFields.cognitiveLoad ?? load,
      expectedMinutes: plannerFields.expectedMinutes,
      waitMinutes: plannerFields.waitMinutes,
      waitStartedAt: typeof source.waitStartedAt === 'string' ? source.waitStartedAt : null,
      lane,
      zoneSource,
      isMain: Boolean(source.isMain),
      dockedOrder: Number.isFinite(source.dockedOrder) ? Number(source.dockedOrder) : 0,
      manualOrder: normalizeNullableNumber(source.manualOrder) ?? undefined,
      detail: typeof source.detail === 'string' ? source.detail : '',
      sourceKind,
      sourceBlackBoxEntryId:
        typeof source.sourceBlackBoxEntryId === 'string' && source.sourceBlackBoxEntryId
          ? source.sourceBlackBoxEntryId
          : null,
      inlineArchiveStatus: normalizedInlineArchiveStatus,
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

    const legacyCandidates = Array.isArray(source.candidateTaskIds)
      ? source.candidateTaskIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    const candidateGroups = normalizedGroups.length > 0
      ? normalizedGroups
      : legacyCandidates.length > 0
        ? [{ type: 'homologous-advancement' as RecommendationGroupType, taskIds: legacyCandidates }]
        : [];

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

  private static readonly VALID_DECISION_TYPES: ReadonlySet<DockRuleDecisionType> = new Set([
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
    const source = raw && typeof raw === 'object'
      ? (raw as Partial<DockSessionState> & {
          strongZoneIds?: string[];
          weakZoneIds?: string[];
          hasFirstBatchSelected?: boolean;
        })
      : null;

    const fallbackMainTaskId =
      entries.find(entry => entry.status === 'focusing')?.taskId ??
      entries.find(entry => entry.isMain && entry.status !== 'completed')?.taskId ??
      null;
    const fallbackComboSelectIds = entries
      .filter(entry => entry.status !== 'completed' && !entry.isMain && entry.lane === 'combo-select')
      .map(entry => entry.taskId);
    const fallbackBackupIds = entries
      .filter(entry => entry.status !== 'completed' && !entry.isMain && entry.lane === 'backup')
      .map(entry => entry.taskId);

    const toIdList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    const comboIds = toIdList(source?.comboSelectIds);
    const backupIds = toIdList(source?.backupIds);
    const legacyStrongIds = toIdList(source?.strongZoneIds);
    const legacyWeakIds = toIdList(source?.weakZoneIds);
    const resolvedComboIds = comboIds.length > 0 ? comboIds : legacyStrongIds;
    const resolvedBackupIds = backupIds.length > 0 ? backupIds : legacyWeakIds;
    const normalizedHighLoadCounter = normalizeHighLoadCounter(source?.highLoadCounter);
    const normalizedBurnoutAt =
      source?.burnoutTriggeredAt == null
        ? null
        : Number.isFinite(source.burnoutTriggeredAt)
          ? Number(source.burnoutTriggeredAt)
          : null;
    const normalizedSessionId =
      typeof source?.focusSessionId === 'string' && source.focusSessionId
        ? source.focusSessionId
        : undefined;
    const normalizedSessionStartedAt =
      Number.isFinite(source?.focusSessionStartedAt)
        ? Number(source?.focusSessionStartedAt)
        : undefined;
    const normalizedOverflowMeta =
      source?.overflowMeta && typeof source.overflowMeta === 'object'
        ? {
            comboSelectOverflow: Math.max(
              0,
              Number((source.overflowMeta as { comboSelectOverflow?: unknown }).comboSelectOverflow ?? 0) || 0,
            ),
            backupOverflow: Math.max(
              0,
              Number((source.overflowMeta as { backupOverflow?: unknown }).backupOverflow ?? 0) || 0,
            ),
          }
        : ctx.buildOverflowMeta(entries.filter(entry => entry.status !== 'completed'));

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
          : fallbackMainTaskId,
      comboSelectIds: resolvedComboIds.length > 0 ? resolvedComboIds : fallbackComboSelectIds,
      backupIds: resolvedBackupIds.length > 0 ? resolvedBackupIds : fallbackBackupIds,
      highLoadCounter: normalizedHighLoadCounter,
      burnoutTriggeredAt: normalizedBurnoutAt,
      focusSessionId: normalizedSessionId,
      focusSessionStartedAt: normalizedSessionStartedAt,
      overflowMeta: normalizedOverflowMeta,
    };
  }
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
