import { Injectable, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  AffinityZone,
  CognitiveLoad,
  DailySlotEntry,
  DockEntry,
  DockPendingDecision,
  DockPendingDecisionEntry,
  DockSessionState,
  DockSourceSection,
  DockSnapshot,
  DockTaskStatus,
  DockZoneSource,
  StatusMachineEntry,
} from '../models/parking-dock';
import { SimpleSyncService, TaskStore } from '../core-bridge';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { PreferenceService } from './preference.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';

const CLOUD_PUSH_DEBOUNCE_MS = 1500;
const CLOUD_PULL_DEBOUNCE_MS = 250;
const CLOUD_PULL_MIN_INTERVAL_MS = 5000;
const LOCAL_PERSIST_DEBOUNCE_MS = 120;

@Injectable({
  providedIn: 'root',
})
export class DockEngineService implements OnDestroy {
  private readonly taskStore = inject(TaskStore);
  private readonly auth = inject(AuthService);
  private readonly logger = inject(LoggerService).category('DockEngine');
  private readonly preferenceService = inject(PreferenceService);
  private readonly syncService = inject(SimpleSyncService);
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);

  readonly entries = signal<DockEntry[]>([]);
  readonly focusMode = signal(false);
  readonly dockExpanded = signal(true);
  readonly muteWaitTone = signal(false);
  readonly dailySlots = signal<DailySlotEntry[]>([]);
  readonly highlightedIds = signal<Set<string>>(new Set(), { equal: () => false });
  readonly pendingDecision = signal<DockPendingDecision | null>(null);
  readonly tick = signal(0);
  readonly dailyResetDate = signal(this.todayDateKey());

  private readonly firstDragIntervened = signal(false);
  private readonly suspendRecommendationLocked = signal(false);
  private readonly suspendChainRootTaskId = signal<string | null>(null);

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private localPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudPushTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudPullTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCloudPullAt = 0;
  private audioCtx: AudioContext | null = null;

  private currentSnapshotUserId: string | null = null;
  private isRestoringSnapshot = false;
  private waitEndNotifiedIds = new Set<string>();
  private visibilityListener: (() => void) | null = null;

  readonly dockedEntries = computed(() => this.entries().filter(entry => entry.status !== 'completed'));
  readonly dockedCount = computed(() => this.dockedEntries().length);
  readonly consoleEntries = computed(() => this.entries().filter(entry => entry.isMain && entry.status !== 'completed'));
  readonly focusingEntry = computed(() => this.consoleEntries().find(entry => entry.status === 'focusing') ?? null);
  readonly suspendedEntries = computed(() =>
    this.consoleEntries().filter(entry => this.isWaitingLike(entry.status)),
  );
  readonly strongZoneEntries = computed(() =>
    this.entries().filter(entry => !entry.isMain && entry.zone === 'strong' && entry.status !== 'completed'),
  );
  readonly weakZoneEntries = computed(() =>
    this.entries().filter(entry => !entry.isMain && entry.zone === 'weak' && entry.status !== 'completed'),
  );
  readonly isFragmentPhase = computed(() => {
    const docked = this.dockedEntries();
    return docked.length > 0 && docked.every(entry => this.isWaitingLike(entry.status));
  });
  readonly availableDailySlots = computed(() =>
    this.dailySlots().filter(slot => slot.todayCompletedCount < slot.maxDailyCount),
  );
  readonly statusMachineEntries = computed<StatusMachineEntry[]>(() => {
    this.tick();
    return this.dockedEntries()
      .filter(
        entry =>
          entry.isMain ||
          entry.status === 'focusing' ||
          entry.status === 'suspended_waiting' ||
          entry.status === 'wait_finished',
      )
      .map(entry => this.toStatusMachineEntry(entry));
  });
  readonly pendingDecisionEntries = computed<DockPendingDecisionEntry[]>(() => {
    const pending = this.pendingDecision();
    if (!pending) return [];

    const entryMap = new Map(this.entries().map(entry => [entry.taskId, entry]));
    return pending.candidateTaskIds
      .map(taskId => entryMap.get(taskId))
      .filter((entry): entry is DockEntry => !!entry)
      .map(entry => ({
        taskId: entry.taskId,
        title: entry.title,
        zone: entry.zone,
        load: entry.load,
        expectedMinutes: entry.expectedMinutes,
        recommendedScore: entry.recommendedScore,
      }));
  });

  constructor() {
    this.tickTimer = setInterval(() => this.tick.update(value => value + 1), 1000);

    effect(() => {
      this.tick();
      this.checkWaitExpiry();
      this.checkPendingDecisionExpiry();
      this.resetDailySlotsIfNeeded();
    });

    this.currentSnapshotUserId = this.auth.currentUserId();
    this.isRestoringSnapshot = true;
    this.restoreLocalSnapshot(this.currentSnapshotUserId);
    this.isRestoringSnapshot = false;

    effect(() => {
      const userId = this.auth.currentUserId();
      if (userId === this.currentSnapshotUserId) return;
      this.currentSnapshotUserId = userId;
      this.isRestoringSnapshot = true;
      this.restoreLocalSnapshot(userId);
      this.isRestoringSnapshot = false;
      if (userId) this.scheduleCloudPull(userId, true);
    });

    effect(() => {
      this.entries();
      this.focusMode();
      this.dockExpanded();
      this.muteWaitTone();
      this.firstDragIntervened();
      this.dailySlots();
      this.suspendChainRootTaskId();
      this.suspendRecommendationLocked();
      this.pendingDecision();
      this.dailyResetDate();
      if (this.isRestoringSnapshot) return;

      const snapshot = this.exportSnapshot();
      this.scheduleLocalPersist(snapshot, this.currentSnapshotUserId);
      if (this.currentSnapshotUserId) {
        this.scheduleCloudPush(this.currentSnapshotUserId, snapshot);
      }
    });

    if (typeof document !== 'undefined') {
      this.visibilityListener = () => {
        if (document.visibilityState !== 'visible') return;
        if (!this.currentSnapshotUserId) return;
        this.scheduleCloudPull(this.currentSnapshotUserId, false);
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }

    if (this.currentSnapshotUserId) {
      this.scheduleCloudPull(this.currentSnapshotUserId, true);
    }
  }

  ngOnDestroy(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.localPersistTimer) {
      clearTimeout(this.localPersistTimer);
      this.localPersistTimer = null;
    }
    if (this.cloudPushTimer) {
      clearTimeout(this.cloudPushTimer);
      this.cloudPushTimer = null;
    }
    if (this.cloudPullTimer) {
      clearTimeout(this.cloudPullTimer);
      this.cloudPullTimer = null;
    }
    if (this.visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
  }

  // Public API
  dockTask(
    taskId: string,
    zone?: AffinityZone,
    options?: {
      sourceKind?: DockEntry['sourceKind'];
      sourceSection?: DockSourceSection;
      load?: CognitiveLoad;
      expectedMinutes?: number | null;
      waitMinutes?: number | null;
      detail?: string;
      zoneSource?: DockZoneSource;
    },
  ): void {
    if (this.entries().some(entry => entry.taskId === taskId)) return;

    const task = this.taskStore.getTask(taskId);
    if (!task || task.status !== 'active') {
      this.logger.warn(`Task ${taskId} is missing or not active; reject docking.`);
      return;
    }

    const sourceProjectId = this.taskStore.getTaskProjectId(taskId);
    const zoneSource: DockZoneSource = options?.zoneSource ?? (zone ? 'manual' : 'auto');
    const normalizedZone = zone ?? this.pickAutoZoneForNextEntry();
    const entry: DockEntry = {
      taskId,
      title: task.title || 'Untitled task',
      sourceProjectId,
      status: 'pending_start',
      load: options?.load ?? 'low',
      expectedMinutes: options?.expectedMinutes ?? null,
      waitMinutes: options?.waitMinutes ?? null,
      waitStartedAt: null,
      zone: normalizedZone,
      zoneSource,
      isMain: false,
      dockedOrder: this.entries().length,
      detail: options?.detail ?? task.content ?? '',
      sourceKind: options?.sourceKind ?? 'project-task',
      systemSelected: false,
      recommendedScore: null,
      sourceSection: options?.sourceSection,
      manualMainSelected: false,
      recommendationLocked: false,
      snoozeRingMuted: this.muteWaitTone(),
    };

    this.entries.update(prev => [...prev, entry]);
    this.rebalanceAutoZones();

    if (!this.firstDragIntervened()) {
      this.setMainTask(taskId);
      this.firstDragIntervened.set(true);
    }
  }

  createInDock(
    title: string,
    zone: AffinityZone,
    load: CognitiveLoad = 'low',
    options?: { expectedMinutes?: number | null; waitMinutes?: number | null; detail?: string },
  ): string {
    const taskId = crypto.randomUUID();
    const entry: DockEntry = {
      taskId,
      title: title.trim() || 'Untitled task',
      sourceProjectId: this.projectState.activeProjectId(),
      status: 'pending_start',
      load,
      expectedMinutes: options?.expectedMinutes ?? null,
      waitMinutes: options?.waitMinutes ?? null,
      waitStartedAt: null,
      zone,
      zoneSource: 'manual',
      isMain: false,
      dockedOrder: this.entries().length,
      detail: options?.detail ?? '',
      sourceKind: 'dock-created',
      systemSelected: false,
      recommendedScore: null,
      sourceSection: 'dock-create',
      manualMainSelected: false,
      recommendationLocked: false,
      snoozeRingMuted: this.muteWaitTone(),
    };
    this.entries.update(prev => [...prev, entry]);
    if (!this.firstDragIntervened()) {
      this.setMainTask(taskId);
      this.firstDragIntervened.set(true);
    }
    return taskId;
  }

  setMainTask(taskId: string): void {
    if (this.focusMode()) {
      this.switchToTask(taskId);
      return;
    }

    this.entries.update(prev =>
      prev.map(entry =>
        entry.taskId === taskId
          ? { ...entry, isMain: true, systemSelected: false, manualMainSelected: true }
          : entry,
      ),
    );
    this.clearPendingDecisionIfMatched(taskId);
  }

  setDockExpanded(expanded: boolean): void {
    this.dockExpanded.set(expanded);
  }

  toggleMuteWaitTone(): void {
    const next = !this.muteWaitTone();
    this.muteWaitTone.set(next);
    this.entries.update(prev => prev.map(entry => ({ ...entry, snoozeRingMuted: next })));
  }

  toggleLoad(taskId: string, direction: 'up' | 'down'): void {
    const nextLoad: CognitiveLoad = direction === 'up' ? 'high' : 'low';
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, load: nextLoad } : entry)),
    );
  }

  setExpectedTime(taskId: string, minutes: number | null): void {
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, expectedMinutes: minutes } : entry)),
    );
  }

  setWaitTime(taskId: string, minutes: number | null): void {
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, waitMinutes: minutes } : entry)),
    );
  }

  setDetail(taskId: string, detail: string): void {
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, detail } : entry)),
    );

    const task = this.taskStore.getTask(taskId);
    if (!task) return;
    const projectId = this.taskStore.getTaskProjectId(taskId);
    if (!projectId) return;

    const activeProjectId = this.projectState.activeProjectId();
    if (activeProjectId === projectId) {
      this.taskOps.updateTaskContent(taskId, detail);
      return;
    }

    const updatedTask = { ...task, content: detail, updatedAt: new Date().toISOString() };
    this.taskStore.setTask(updatedTask, projectId);
    this.projectState.updateProjects(projects =>
      projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(item => (item.id === taskId ? updatedTask : item)),
            }
          : project,
      ),
    );
  }

  setZone(taskId: string, zone: AffinityZone, zoneSource: DockZoneSource = 'manual'): void {
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, zone, zoneSource } : entry)),
    );
    if (zoneSource === 'auto') {
      this.rebalanceAutoZones();
    }
  }

  toggleFocusMode(): void {
    const next = !this.focusMode();
    this.focusMode.set(next);

    if (next) {
      const focused = this.focusingEntry();
      if (!focused) {
        const candidate = this.consoleEntries().find(entry => this.isRunnableStatus(entry.status));
        if (candidate) this.promoteCandidate(candidate.taskId);
      }
      return;
    }

    this.firstDragIntervened.set(false);
    this.suspendRecommendationLocked.set(false);
    this.suspendChainRootTaskId.set(null);
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
  }

  completeTask(taskId: string): void {
    const entry = this.entries().find(item => item.taskId === taskId);
    if (!entry) return;

    this.entries.update(prev =>
      prev.map(item =>
        item.taskId === taskId
          ? {
              ...item,
              status: 'completed' as DockTaskStatus,
              isMain: false,
              systemSelected: false,
              recommendedScore: null,
            }
          : item,
      ),
    );

    const task = this.taskStore.getTask(taskId);
    const projectId = this.taskStore.getTaskProjectId(taskId);
    if (task && projectId) {
      this.taskStore.setTask({ ...task, status: 'completed', updatedAt: new Date().toISOString() }, projectId);
    }

    this.resolveAfterCompletion(taskId);
    this.rebalanceAutoZones();
    this.refreshSuspendRecommendationLock();
    this.waitEndNotifiedIds.delete(taskId);
  }

  suspendTask(taskId: string, waitMinutes: number): void {
    const normalizedWait = Math.max(1, Math.floor(waitMinutes));
    const firstSuspendInChain = !this.suspendRecommendationLocked();

    this.entries.update(prev =>
      prev.map(entry =>
        entry.taskId === taskId
          ? {
              ...entry,
              status: 'suspended_waiting' as DockTaskStatus,
              waitMinutes: normalizedWait,
              waitStartedAt: new Date().toISOString(),
              isMain: true,
              systemSelected: false,
            }
          : entry,
      ),
    );

    if (firstSuspendInChain) {
      this.suspendChainRootTaskId.set(taskId);
      this.suspendRecommendationLocked.set(true);
      this.scheduleFirstSuspendRecommendation(taskId, normalizedWait);
      return;
    }

    this.promoteNext();
  }

  switchToTask(taskId: string): void {
    const target = this.entries().find(entry => entry.taskId === taskId && entry.status !== 'completed');
    if (!target) return;

    const current = this.focusingEntry();
    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === taskId) {
          return {
            ...entry,
            isMain: true,
            status: 'focusing' as DockTaskStatus,
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
            manualMainSelected: true,
          };
        }
        if (current && entry.taskId === current.taskId) {
          return {
            ...entry,
            status: this.deriveBackgroundStatus(entry),
          };
        }
        return entry;
      }),
    );

    this.clearPendingDecisionIfMatched(taskId);
    this.refreshSuspendRecommendationLock();
  }

  choosePendingDecisionCandidate(taskId: string): void {
    const pending = this.pendingDecision();
    if (!pending || !pending.candidateTaskIds.includes(taskId)) return;

    const selectedId = taskId;
    const rejectedIds = pending.candidateTaskIds.filter(id => id !== selectedId);
    this.promoteCandidate(selectedId, false);
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());

    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === selectedId) {
          return {
            ...entry,
            isMain: true,
            systemSelected: false,
            recommendationLocked: false,
            manualMainSelected: true,
            recommendedScore: null,
          };
        }
        if (rejectedIds.includes(entry.taskId)) {
          return {
            ...entry,
            isMain: false,
            systemSelected: false,
            recommendationLocked: false,
            recommendedScore: null,
          };
        }
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
          recommendedScore: entry.systemSelected ? null : entry.recommendedScore,
        };
      }),
    );
  }

  removeFromDock(taskId: string): void {
    this.entries.update(prev => prev.filter(entry => entry.taskId !== taskId));
    this.rebalanceAutoZones();
    this.waitEndNotifiedIds.delete(taskId);
    if (this.entries().length === 0) {
      this.firstDragIntervened.set(false);
      this.pendingDecision.set(null);
      this.highlightedIds.set(new Set());
    }
    this.refreshSuspendRecommendationLock();
  }

  addDailySlot(title: string, maxDailyCount = 1): string {
    const id = crypto.randomUUID();
    const slot: DailySlotEntry = {
      id,
      title: title.trim() || 'Untitled daily task',
      maxDailyCount: Math.max(1, Math.floor(maxDailyCount)),
      todayCompletedCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.dailySlots.update(prev => [...prev, slot]);
    return id;
  }

  completeDailySlot(id: string): void {
    this.dailySlots.update(prev =>
      prev.map(slot =>
        slot.id === id
          ? { ...slot, todayCompletedCount: Math.min(slot.maxDailyCount, slot.todayCompletedCount + 1) }
          : slot,
      ),
    );
  }

  removeDailySlot(id: string): void {
    this.dailySlots.update(prev => prev.filter(slot => slot.id !== id));
  }

  getWaitRemainingSeconds(entry: DockEntry): number | null {
    if (!entry.waitStartedAt || !entry.waitMinutes) return null;
    const elapsed = Date.now() - new Date(entry.waitStartedAt).getTime();
    const total = entry.waitMinutes * 60_000;
    return Math.max(0, Math.ceil((total - elapsed) / 1000));
  }

  isWaitExpired(entry: DockEntry): boolean {
    const remaining = this.getWaitRemainingSeconds(entry);
    return remaining !== null && remaining <= 0;
  }

  exportSnapshot(): DockSnapshot {
    const session = this.buildSessionState();
    return {
      version: 3,
      entries: this.entries(),
      focusMode: this.focusMode(),
      isDockExpanded: this.dockExpanded(),
      muteWaitTone: this.muteWaitTone(),
      session,
      firstDragDone: this.firstDragIntervened(),
      dailySlots: this.dailySlots(),
      suspendChainRootTaskId: this.suspendChainRootTaskId(),
      suspendRecommendationLocked: this.suspendRecommendationLocked(),
      pendingDecision: this.pendingDecision(),
      dailyResetDate: this.dailyResetDate(),
      savedAt: new Date().toISOString(),
    };
  }

  restoreSnapshot(snapshot: DockSnapshot): void {
    const normalized = this.normalizeSnapshot(snapshot);
    if (!normalized) return;
    const hydratedEntries = this.applySessionToEntries(normalized.entries, normalized.session);

    this.isRestoringSnapshot = true;
    this.entries.set(hydratedEntries);
    this.focusMode.set(normalized.focusMode);
    this.dockExpanded.set(normalized.isDockExpanded);
    this.muteWaitTone.set(normalized.muteWaitTone);
    this.firstDragIntervened.set(normalized.session.firstDragIntervened);
    this.dailySlots.set(normalized.dailySlots);
    this.suspendChainRootTaskId.set(normalized.suspendChainRootTaskId);
    this.suspendRecommendationLocked.set(normalized.suspendRecommendationLocked);
    this.pendingDecision.set(normalized.pendingDecision);
    this.dailyResetDate.set(normalized.dailyResetDate);
    this.rebalanceAutoZones();
    this.isRestoringSnapshot = false;
    this.refreshSuspendRecommendationLock();
  }

  reset(): void {
    this.entries.set([]);
    this.focusMode.set(false);
    this.dockExpanded.set(true);
    this.muteWaitTone.set(false);
    this.firstDragIntervened.set(false);
    this.dailySlots.set([]);
    this.suspendChainRootTaskId.set(null);
    this.suspendRecommendationLocked.set(false);
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.dailyResetDate.set(this.todayDateKey());
    this.waitEndNotifiedIds.clear();
  }

  private pickAutoZoneForNextEntry(): AffinityZone {
    const autoEntries = this.entries()
      .filter(entry => entry.status !== 'completed' && entry.zoneSource === 'auto');
    const strongCount = autoEntries.filter(entry => entry.zone === 'strong').length;
    const weakCount = autoEntries.length - strongCount;
    return strongCount <= weakCount ? 'strong' : 'weak';
  }

  private rebalanceAutoZones(): void {
    this.entries.update(prev => {
      const activeAuto = prev
        .filter(entry => entry.status !== 'completed' && entry.zoneSource === 'auto')
        .sort((a, b) => a.dockedOrder - b.dockedOrder);

      if (activeAuto.length === 0) return prev;

      const splitIndex = Math.ceil(activeAuto.length / 2);
      const zoneMap = new Map<string, AffinityZone>();
      activeAuto.forEach((entry, index) => {
        zoneMap.set(entry.taskId, index < splitIndex ? 'strong' : 'weak');
      });

      let changed = false;
      const next = prev.map(entry => {
        const nextZone = zoneMap.get(entry.taskId);
        if (!nextZone || entry.zoneSource !== 'auto' || entry.zone === nextZone) return entry;
        changed = true;
        return { ...entry, zone: nextZone };
      });

      return changed ? next : prev;
    });
  }

  // Internal helpers
  private resolveAfterCompletion(completedTaskId: string): void {
    const rootTaskId = this.suspendChainRootTaskId();
    const rootEntry = rootTaskId ? this.entries().find(entry => entry.taskId === rootTaskId) ?? null : null;
    const rootRemainingSeconds = rootEntry ? this.getWaitRemainingSeconds(rootEntry) : null;

    if (rootRemainingSeconds !== null && rootRemainingSeconds > 0) {
      const rootRemainingMinutes = rootRemainingSeconds / 60;
      if (rootRemainingMinutes <= PARKING_CONFIG.SCHEDULE_TIGHT_THRESHOLD_MINUTES) {
        return;
      }

      const candidateC = this.pickPrimaryCandidate([completedTaskId]);
      if (candidateC && candidateC.expectedMinutes !== null && rootRemainingMinutes > 0) {
        const ratio = candidateC.expectedMinutes / rootRemainingMinutes;
        if (
          ratio > PARKING_CONFIG.SCHEDULE_CANDIDATE_C_TOO_LONG_RATIO ||
          ratio < PARKING_CONFIG.SCHEDULE_CANDIDATE_C_TOO_SHORT_RATIO
        ) {
          const candidateD = this.pickBestCandidate(rootRemainingMinutes, [
            completedTaskId,
            candidateC.taskId,
            rootTaskId ?? '',
          ]);
          if (candidateD) {
            const reason =
              ratio > PARKING_CONFIG.SCHEDULE_CANDIDATE_C_TOO_LONG_RATIO
                ? '候选 C 预计时长严重超出主任务剩余等待窗口'
                : '候选 C 预计时长远小于主任务剩余等待窗口';
            this.setPendingDecision(
              rootTaskId ?? candidateC.taskId,
              rootRemainingMinutes,
              candidateC,
              candidateD,
              reason,
            );
            this.promoteCandidate(candidateC.taskId, false);
            return;
          }
        }
      }
    }

    this.pendingDecision.set(null);
    this.promoteNext();
  }

  private pickPrimaryCandidate(excludedIds: string[]): DockEntry | null {
    const excluded = new Set(excludedIds.filter(Boolean));
    const mainIdle = this.entries()
      .filter(entry => entry.isMain && this.isRunnableStatus(entry.status) && !excluded.has(entry.taskId))
      .sort((a, b) => a.dockedOrder - b.dockedOrder);
    if (mainIdle.length > 0) return mainIdle[0];

    const radarIdle = this.entries()
      .filter(entry => !entry.isMain && this.isRunnableStatus(entry.status) && !excluded.has(entry.taskId))
      .sort((a, b) => {
        if (a.zone !== b.zone) return a.zone === 'strong' ? -1 : 1;
        if (a.load !== b.load) return a.load === 'low' ? -1 : 1;
        return a.dockedOrder - b.dockedOrder;
      });
    return radarIdle[0] ?? null;
  }

  private pickBestCandidate(remainingMinutes: number, excludedIds: string[]): DockEntry | null {
    const excluded = new Set(excludedIds.filter(Boolean));
    const candidates = this.entries()
      .filter(entry => this.isRunnableStatus(entry.status) && !excluded.has(entry.taskId))
      .map(entry => ({ entry, score: this.scoreCandidate(entry, remainingMinutes) }))
      .sort((a, b) => b.score - a.score);
    return candidates[0]?.entry ?? null;
  }

  private scoreCandidate(entry: DockEntry, waitMinutes: number): number {
    const relation = entry.zone === 'strong' ? 1 : 0.4;
    const timeFit = this.computeTimeFit(entry.expectedMinutes, waitMinutes);
    const loadFit = entry.load === 'low' ? 1 : 0.5;
    const score = relation * 0.45 + timeFit * 0.35 + loadFit * 0.2;
    return Number(score.toFixed(4));
  }

  private computeTimeFit(expectedMinutes: number | null, waitMinutes: number): number {
    if (waitMinutes <= 0) return 0.5;
    if (expectedMinutes === null || expectedMinutes <= 0) return 0.5;
    const ratio = expectedMinutes / waitMinutes;
    const fit = 1 - Math.min(Math.abs(1 - ratio), 1);
    return Number(Math.max(0, Math.min(1, fit)).toFixed(4));
  }

  private setPendingDecision(
    rootTaskId: string,
    rootRemainingMinutes: number,
    candidateC: DockEntry,
    candidateD: DockEntry,
    reason: string,
  ): void {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    this.pendingDecision.set({
      rootTaskId,
      rootRemainingMinutes,
      candidateTaskIds: [candidateC.taskId, candidateD.taskId],
      reason,
      expiresAt: new Date(nowDate.getTime() + PARKING_CONFIG.PENDING_DECISION_TTL_MS).toISOString(),
      createdAt: now,
    });

    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === candidateC.taskId || entry.taskId === candidateD.taskId) {
          return {
            ...entry,
            isMain: true,
            systemSelected: true,
            recommendationLocked: true,
            recommendedScore: this.scoreCandidate(entry, rootRemainingMinutes),
          };
        }
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
        };
      }),
    );

    this.highlightedIds.set(new Set([candidateC.taskId, candidateD.taskId]));
  }

  private clearPendingDecisionIfMatched(taskId: string): void {
    const pending = this.pendingDecision();
    if (!pending || !pending.candidateTaskIds.includes(taskId)) return;
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.entries.update(prev =>
      prev.map(entry => ({
        ...entry,
        systemSelected: false,
        recommendationLocked: false,
      })),
    );
  }

  private scheduleFirstSuspendRecommendation(suspendedTaskId: string, waitMinutes: number): void {
    const candidates = this.entries()
      .filter(entry => this.isRunnableStatus(entry.status) && entry.taskId !== suspendedTaskId)
      .map(entry => ({ entry, score: this.scoreCandidate(entry, waitMinutes) }))
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      this.promoteNext();
      return;
    }

    const primary = candidates[0];
    const secondary = candidates[1] ?? null;
    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === suspendedTaskId) {
          return {
            ...entry,
            isMain: true,
            status: 'suspended_waiting',
            systemSelected: false,
            recommendationLocked: false,
            recommendedScore: null,
          };
        }
        if (entry.taskId === primary.entry.taskId) {
          return {
            ...entry,
            isMain: true,
            status: this.focusMode() ? ('focusing' as DockTaskStatus) : ('pending_start' as DockTaskStatus),
            systemSelected: true,
            recommendationLocked: true,
            recommendedScore: primary.score,
          };
        }
        if (secondary && entry.taskId === secondary.entry.taskId) {
          return {
            ...entry,
            isMain: true,
            status: 'pending_start',
            systemSelected: true,
            recommendationLocked: true,
            recommendedScore: secondary.score,
          };
        }
        const scored = candidates.find(item => item.entry.taskId === entry.taskId);
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
          recommendedScore: scored ? scored.score : null,
        };
      }),
    );

    this.highlightedIds.set(new Set([primary.entry.taskId, ...(secondary ? [secondary.entry.taskId] : [])]));
    setTimeout(() => {
      if (this.pendingDecision()) return;
      this.highlightedIds.set(new Set());
    }, 3000);
  }

  private promoteNext(): void {
    const mainIdle = this.entries()
      .filter(entry => entry.isMain && this.isRunnableStatus(entry.status))
      .sort((a, b) => a.dockedOrder - b.dockedOrder)[0];
    if (mainIdle) {
      this.promoteCandidate(mainIdle.taskId);
      return;
    }

    const radarCandidate = this.entries()
      .filter(entry => !entry.isMain && this.isRunnableStatus(entry.status))
      .sort((a, b) => {
        if (a.zone !== b.zone) return a.zone === 'strong' ? -1 : 1;
        if (a.load !== b.load) return a.load === 'low' ? -1 : 1;
        return a.dockedOrder - b.dockedOrder;
      })[0];
    if (radarCandidate) {
      this.promoteCandidate(radarCandidate.taskId);
      this.highlightedIds.set(new Set([radarCandidate.taskId]));
      setTimeout(() => {
        if (this.pendingDecision()) return;
        this.highlightedIds.set(new Set());
      }, 2000);
      return;
    }

    const expiredSuspended = this.entries()
      .filter(entry => entry.status === 'wait_finished' || (entry.status === 'suspended_waiting' && this.isWaitExpired(entry)))
      .sort((a, b) => a.dockedOrder - b.dockedOrder)[0];
    if (expiredSuspended) this.promoteCandidate(expiredSuspended.taskId);
  }

  private promoteCandidate(taskId: string, clearDecision: boolean = true): void {
    if (!this.focusMode()) {
      this.entries.update(prev =>
        prev.map(entry =>
          entry.taskId === taskId
            ? {
                ...entry,
                isMain: true,
                status: 'pending_start',
                systemSelected: false,
                recommendationLocked: false,
              }
            : entry,
        ),
      );
      return;
    }

    const currentFocusId = this.focusingEntry()?.taskId ?? null;
    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === taskId) {
          return {
            ...entry,
            isMain: true,
            status: 'focusing' as DockTaskStatus,
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
          };
        }
        if (currentFocusId && entry.taskId === currentFocusId) {
          return {
            ...entry,
            status: this.deriveBackgroundStatus(entry),
          };
        }
        return entry;
      }),
    );
    if (clearDecision) {
      this.clearPendingDecisionIfMatched(taskId);
    }
  }

  private hasActiveWaitTimer(entry: DockEntry): boolean {
    if (!entry.waitStartedAt || !entry.waitMinutes) return false;
    return !this.isWaitExpired(entry);
  }

  private isWaitingLike(status: DockTaskStatus): boolean {
    return status === 'suspended_waiting' || status === 'wait_finished';
  }

  private isRunnableStatus(status: DockTaskStatus): boolean {
    return status === 'pending_start' || status === 'wait_finished';
  }

  private deriveBackgroundStatus(entry: DockEntry): DockTaskStatus {
    if (this.hasActiveWaitTimer(entry)) {
      return 'suspended_waiting';
    }
    if (entry.waitStartedAt && entry.waitMinutes) {
      return 'wait_finished';
    }
    return 'pending_start';
  }

  private buildSessionState(entries: DockEntry[] = this.entries()): DockSessionState {
    const activeEntries = entries.filter(entry => entry.status !== 'completed');
    const mainCandidate =
      activeEntries.find(entry => entry.status === 'focusing') ??
      activeEntries.find(entry => entry.isMain) ??
      null;
    return {
      firstDragIntervened: this.firstDragIntervened(),
      focusBlurOn: this.focusMode(),
      mainTaskId: mainCandidate?.taskId ?? null,
      strongZoneIds: activeEntries
        .filter(entry => !entry.isMain && entry.zone === 'strong')
        .map(entry => entry.taskId),
      weakZoneIds: activeEntries
        .filter(entry => !entry.isMain && entry.zone === 'weak')
        .map(entry => entry.taskId),
    };
  }

  private applySessionToEntries(entries: DockEntry[], session: DockSessionState): DockEntry[] {
    const strongSet = new Set(session.strongZoneIds);
    const weakSet = new Set(session.weakZoneIds);
    const hasZoneHints = strongSet.size > 0 || weakSet.size > 0;
    if (!session.mainTaskId) {
      if (!hasZoneHints) return entries;
      return entries.map(entry => {
        if (entry.status === 'completed' || entry.isMain) return entry;
        if (strongSet.has(entry.taskId)) return { ...entry, zone: 'strong' };
        if (weakSet.has(entry.taskId)) return { ...entry, zone: 'weak' };
        return entry;
      });
    }
    const hasMain = entries.some(entry => entry.isMain && entry.status !== 'completed');
    if (hasMain || !entries.some(entry => entry.taskId === session.mainTaskId)) {
      if (!hasZoneHints) return entries;
      return entries.map(entry => {
        if (entry.status === 'completed' || entry.isMain) return entry;
        if (strongSet.has(entry.taskId)) return { ...entry, zone: 'strong' };
        if (weakSet.has(entry.taskId)) return { ...entry, zone: 'weak' };
        return entry;
      });
    }
    return entries.map(entry =>
      entry.status === 'completed'
        ? entry
        : entry.taskId === session.mainTaskId
          ? { ...entry, isMain: true }
          : hasZoneHints && !entry.isMain
            ? strongSet.has(entry.taskId)
              ? { ...entry, zone: 'strong' }
              : weakSet.has(entry.taskId)
                ? { ...entry, zone: 'weak' }
                : entry
            : entry,
    );
  }

  private refreshSuspendRecommendationLock(): void {
    const hasSuspended = this.entries().some(entry => this.isWaitingLike(entry.status));
    if (hasSuspended) return;

    this.suspendRecommendationLocked.set(false);
    this.suspendChainRootTaskId.set(null);
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.entries.update(prev =>
      prev.map(entry => ({
        ...entry,
        systemSelected: false,
        recommendationLocked: false,
        recommendedScore: null,
      })),
    );
  }

  private checkWaitExpiry(): void {
    let shouldPlaySound = false;
    this.entries.update(prev => {
      let changed = false;
      const next = [...prev];
      for (let index = 0; index < prev.length; index += 1) {
        const entry = prev[index];
        if (entry.status !== 'suspended_waiting' || !entry.waitStartedAt || !entry.waitMinutes) continue;
        if (!this.isWaitExpired(entry)) continue;
        changed = true;
        if (!this.waitEndNotifiedIds.has(entry.taskId)) {
          this.waitEndNotifiedIds.add(entry.taskId);
          shouldPlaySound = true;
        }
        next[index] = { ...entry, status: 'wait_finished' as DockTaskStatus };
      }
      return changed ? next : prev;
    });
    if (shouldPlaySound) {
      this.playWaitEndSound();
    }
  }

  private checkPendingDecisionExpiry(): void {
    const pending = this.pendingDecision();
    if (!pending?.expiresAt) return;
    const expiresAt = Date.parse(pending.expiresAt);
    if (Number.isNaN(expiresAt)) return;
    if (Date.now() < expiresAt) return;
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.entries.update(prev =>
      prev.map(entry => ({
        ...entry,
        systemSelected: false,
        recommendationLocked: false,
      })),
    );
  }

  private playWaitEndSound(): void {
    if (this.muteWaitTone()) return;
    try {
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        this.audioCtx = new AudioContext();
      }
      const audio = this.audioCtx;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.frequency.value = PARKING_CONFIG.STATUS_MACHINE_NOTIFICATION_TONE_HZ;
      gain.gain.value = 0.08;
      oscillator.start();
      setTimeout(() => {
        oscillator.stop();
      }, PARKING_CONFIG.STATUS_MACHINE_NOTIFICATION_DURATION_MS + 20);
    } catch {
      // Ignore audio failures.
    }
  }

  private toStatusMachineEntry(entry: DockEntry): StatusMachineEntry {
    const remainingSec = this.getWaitRemainingSeconds(entry);
    const totalSec = entry.waitMinutes ? entry.waitMinutes * 60 : null;
    let label: StatusMachineEntry['label'];

    if (entry.status === 'focusing') {
      label = '专注中';
    } else if (entry.status === 'wait_finished') {
      label = '等待结束';
    } else if (entry.status === 'suspended_waiting') {
      label = '挂起等待';
    } else {
      label = '待启动';
    }

    return {
      taskId: entry.taskId,
      title: entry.title,
      status: entry.status,
      label,
      waitRemainingSeconds: remainingSec,
      waitTotalSeconds: totalSec,
    };
  }

  private resetDailySlotsIfNeeded(): void {
    const today = this.todayDateKey();
    if (today === this.dailyResetDate()) return;
    this.dailyResetDate.set(today);
    this.dailySlots.update(prev => prev.map(slot => ({ ...slot, todayCompletedCount: 0 })));
  }

  private todayDateKey(now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private scheduleLocalPersist(snapshot: DockSnapshot, userId: string | null): void {
    if (typeof localStorage === 'undefined') return;
    if (this.localPersistTimer) clearTimeout(this.localPersistTimer);
    this.localPersistTimer = setTimeout(() => {
      try {
        localStorage.setItem(this.localStorageKey(userId), JSON.stringify(snapshot));
      } catch {
        // Ignore localStorage failures.
      }
    }, LOCAL_PERSIST_DEBOUNCE_MS);
  }

  private restoreLocalSnapshot(userId: string | null): void {
    if (typeof localStorage === 'undefined') {
      this.reset();
      return;
    }
    try {
      const raw = localStorage.getItem(this.localStorageKey(userId));
      if (!raw) {
        this.reset();
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      const normalized = this.normalizeSnapshot(parsed);
      if (!normalized) {
        this.reset();
        return;
      }
      this.restoreSnapshot(normalized);
    } catch {
      this.reset();
    }
  }

  private localStorageKey(userId: string | null): string {
    const scope = userId || 'anonymous';
    return `${PARKING_CONFIG.DOCK_SNAPSHOT_STORAGE_KEY}.${scope}`;
  }

  private scheduleCloudPush(userId: string, snapshot: DockSnapshot): void {
    if (this.cloudPushTimer) clearTimeout(this.cloudPushTimer);
    this.cloudPushTimer = setTimeout(() => {
      void this.preferenceService.saveUserPreferences(userId, { dockSnapshot: snapshot });
    }, CLOUD_PUSH_DEBOUNCE_MS);
  }

  private scheduleCloudPull(userId: string, force: boolean): void {
    if (!force && Date.now() - this.lastCloudPullAt < CLOUD_PULL_MIN_INTERVAL_MS) return;
    if (this.cloudPullTimer) clearTimeout(this.cloudPullTimer);
    this.cloudPullTimer = setTimeout(() => {
      void this.pullCloudSnapshot(userId);
    }, CLOUD_PULL_DEBOUNCE_MS);
  }

  private async pullCloudSnapshot(userId: string): Promise<void> {
    this.lastCloudPullAt = Date.now();
    try {
      const preferences = await this.syncService.loadUserPreferences(userId);
      const remoteRaw = preferences?.dockSnapshot;
      if (!remoteRaw) return;

      const remote = this.normalizeSnapshot(remoteRaw);
      if (!remote) return;
      const local = this.exportSnapshot();
      if (!this.isSnapshotNewer(remote, local)) return;

      this.restoreSnapshot(remote);
    } catch (error) {
      this.logger.warn('Failed to pull dock_snapshot from cloud', error);
    }
  }

  private isSnapshotNewer(incoming: DockSnapshot, current: DockSnapshot): boolean {
    const incomingAt = Date.parse(incoming.savedAt);
    const currentAt = Date.parse(current.savedAt);
    if (Number.isNaN(incomingAt)) return false;
    if (Number.isNaN(currentAt)) return true;
    return incomingAt > currentAt;
  }

  private normalizeSnapshot(raw: unknown): DockSnapshot | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Omit<Partial<DockSnapshot>, 'version'> & { version?: unknown };
    const version = source.version;
    if (version !== 2 && version !== 3) return null;

    const entries = Array.isArray(source.entries)
      ? source.entries.map(entry => this.normalizeEntry(entry)).filter((entry): entry is DockEntry => !!entry)
      : [];
    const dailySlots = Array.isArray(source.dailySlots)
      ? source.dailySlots.map(slot => this.normalizeDailySlot(slot)).filter((slot): slot is DailySlotEntry => !!slot)
      : [];
    const legacyFirstDragDone = Boolean(source.firstDragDone);
    const fallbackFocusMode = Boolean(source.focusMode);
    const session = this.normalizeSessionState(source.session, entries, fallbackFocusMode, legacyFirstDragDone);
    const focusMode = session.focusBlurOn;

    return {
      version: 3,
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
      dailyResetDate:
        typeof source.dailyResetDate === 'string' && source.dailyResetDate
          ? source.dailyResetDate
          : this.todayDateKey(),
      savedAt: typeof source.savedAt === 'string' && source.savedAt ? source.savedAt : new Date().toISOString(),
    };
  }

  private normalizeEntry(raw: unknown): DockEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Partial<DockEntry>;
    if (!source.taskId || typeof source.taskId !== 'string') return null;

    const status = this.normalizeStatus(source.status);
    const zone: AffinityZone = source.zone === 'weak' ? 'weak' : 'strong';
    const zoneSource: DockZoneSource = source.zoneSource === 'manual' ? 'manual' : 'auto';
    const load: CognitiveLoad = source.load === 'high' ? 'high' : 'low';

    return {
      taskId: source.taskId,
      title: typeof source.title === 'string' ? source.title : 'Untitled task',
      sourceProjectId: typeof source.sourceProjectId === 'string' ? source.sourceProjectId : null,
      status,
      load,
      expectedMinutes: this.normalizeNullableNumber(source.expectedMinutes),
      waitMinutes: this.normalizeNullableNumber(source.waitMinutes),
      waitStartedAt: typeof source.waitStartedAt === 'string' ? source.waitStartedAt : null,
      zone,
      zoneSource,
      isMain: Boolean(source.isMain),
      dockedOrder: Number.isFinite(source.dockedOrder) ? Number(source.dockedOrder) : 0,
      detail: typeof source.detail === 'string' ? source.detail : '',
      sourceKind: source.sourceKind === 'dock-created' ? 'dock-created' : 'project-task',
      systemSelected: Boolean(source.systemSelected),
      recommendedScore: this.normalizeNullableNumber(source.recommendedScore),
      sourceSection: this.normalizeSourceSection(source.sourceSection),
      manualMainSelected: Boolean(source.manualMainSelected),
      recommendationLocked: Boolean(source.recommendationLocked),
      snoozeRingMuted: source.snoozeRingMuted === undefined ? this.muteWaitTone() : Boolean(source.snoozeRingMuted),
    };
  }

  private normalizeDailySlot(raw: unknown): DailySlotEntry | null {
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
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
    };
  }

  private normalizePendingDecision(raw: unknown): DockPendingDecision | null {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw as Partial<DockPendingDecision>;
    if (!source.rootTaskId || typeof source.rootTaskId !== 'string') return null;
    if (!Array.isArray(source.candidateTaskIds)) return null;
    const candidateTaskIds = source.candidateTaskIds.filter((item): item is string => typeof item === 'string');
    if (candidateTaskIds.length < 2) return null;
    return {
      rootTaskId: source.rootTaskId,
      rootRemainingMinutes: Number.isFinite(source.rootRemainingMinutes) ? Number(source.rootRemainingMinutes) : 0,
      candidateTaskIds,
      reason: typeof source.reason === 'string' && source.reason ? source.reason : '候选任务时长匹配异常',
      expiresAt: typeof source.expiresAt === 'string' ? source.expiresAt : undefined,
      createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
    };
  }

  private normalizeSessionState(
    raw: unknown,
    entries: DockEntry[],
    fallbackFocusMode: boolean,
    legacyFirstDragDone: boolean,
  ): DockSessionState {
    const source = raw && typeof raw === 'object' ? (raw as Partial<DockSessionState>) : null;

    const fallbackMainTaskId =
      entries.find(entry => entry.status === 'focusing')?.taskId ??
      entries.find(entry => entry.isMain && entry.status !== 'completed')?.taskId ??
      null;
    const fallbackStrongZoneIds = entries
      .filter(entry => entry.status !== 'completed' && !entry.isMain && entry.zone === 'strong')
      .map(entry => entry.taskId);
    const fallbackWeakZoneIds = entries
      .filter(entry => entry.status !== 'completed' && !entry.isMain && entry.zone === 'weak')
      .map(entry => entry.taskId);

    const toIdList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    const strongIds = toIdList(source?.strongZoneIds);
    const weakIds = toIdList(source?.weakZoneIds);

    return {
      firstDragIntervened: source?.firstDragIntervened ?? legacyFirstDragDone,
      focusBlurOn: source?.focusBlurOn ?? fallbackFocusMode,
      mainTaskId:
        typeof source?.mainTaskId === 'string' && source.mainTaskId
          ? source.mainTaskId
          : fallbackMainTaskId,
      strongZoneIds: strongIds.length > 0 ? strongIds : fallbackStrongZoneIds,
      weakZoneIds: weakIds.length > 0 ? weakIds : fallbackWeakZoneIds,
    };
  }

  private normalizeStatus(status: DockEntry['status'] | undefined): DockTaskStatus {
    if (
      status === 'focusing' ||
      status === 'suspended_waiting' ||
      status === 'wait_finished' ||
      status === 'completed'
    ) {
      return status;
    }
    return 'pending_start';
  }

  private normalizeNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric;
  }

  private normalizeSourceSection(value: unknown): DockSourceSection | undefined {
    if (value === 'text' || value === 'flow' || value === 'dock-create') {
      return value;
    }
    return undefined;
  }
}


