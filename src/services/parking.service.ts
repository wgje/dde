/**
 * ParkingService 鈥?鍋滄硦鍔熻兘鏍稿績鏈嶅姟
 *
 * 绛栧垝妗?A5.1 瀵瑰濂戠害
 * 鑱岃矗锛氬仠娉?鍙栨秷鍋滄硦銆佽“鑰佹竻鐞嗐€佸彲鎾ゅ洖銆乁ndo 闆嗘垚
 *
 * 渚濊禆娉ㄥ叆瑙勫垯锛? * - 绂佹 inject(StoreService)锛岀洿鎺ユ敞鍏?TaskStore
 * - 涓嶆毚闇?switchFocus() 缁?UI 灞傜洿鎺ヨ皟鐢? */

import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { TaskStore, ProjectStore } from './stores';
import {
  Task,
  TaskParkingMeta,
  EvictionToken,
  EvictionTokenMap,
  ParkingNotice,
  ParkingNoticeEvictionItem,
  ParkingSnapshot,
  Project,
} from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import { ToastService } from './toast.service';
import { UndoService } from './undo.service';
import { LoggerService } from './logger.service';
import { BeforeUnloadManagerService } from './before-unload-manager.service';
import { StartupTierOrchestratorService } from './startup-tier-orchestrator.service';
import { GateService } from './gate.service';
import { ContextRestoreService } from './context-restore.service';
import { spotlightMode } from '../state/focus-stores';
import { ProjectDataService } from '../core-bridge';

interface SnapshotDraft {
  taskId: string;
  contentHash: string;
  cursorPosition: { line: number; column: number } | null;
  structuralAnchor: ParkingSnapshot['structuralAnchor'];
  savedAt: string;
}

@Injectable({
  providedIn: 'root'
})
export class ParkingService {
  // 鈹€鈹€鈹€ 渚濊禆娉ㄥ叆 鈹€鈹€鈹€
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly toastService = inject(ToastService);
  private readonly undoService = inject(UndoService);
  private readonly logger = inject(LoggerService);
  private readonly beforeUnloadManager = inject(BeforeUnloadManagerService);
  private readonly startupOrchestrator = inject(StartupTierOrchestratorService);
  private readonly gateService = inject(GateService);
  private readonly contextRestoreService = inject(ContextRestoreService);
  private readonly projectDataService = inject(ProjectDataService);

  // 鈹€鈹€鈹€ 鍐呴儴鐘舵€?鈹€鈹€鈹€
  /** 琛拌€佹竻鐞?token Map锛堜粎鍐呭瓨锛屼笉鎸佷箙鍖栵級 */
  private readonly evictionTokens: EvictionTokenMap = new Map();

  /** 閫氱煡闃熷垪锛圙ate 婵€娲绘椂鏆傚瓨锛?*/
  private readonly _pendingNotices = signal<ParkingNotice[]>([]);

  /** 瀵瑰鍙鐨勯€氱煡闃熷垪 */
  readonly pendingNotices = this._pendingNotices.asReadonly();

  /** 褰撳墠棰勮涓殑浠诲姟 ID */
  readonly previewingTaskId = signal<string | null>(null);

  /** 琛拌€佹竻鐞嗘槸鍚﹀凡鍒濆鍖?*/
  private evictionInitialized = false;
  /** 鍋滄硦杞婚噺鏁版嵁鏄惁宸插垵濮嬪寲 */
  private parkedLightweightInitialized = false;
  /** 琛拌€佹鏌ヨ疆璇㈠畾鏃跺櫒 */
  private evictionIntervalTimer: ReturnType<typeof setInterval> | null = null;
  /** 鍋滄硦杞婚噺澧為噺鎷夊彇瀹氭椂鍣?*/
  private parkedDeltaTimer: ReturnType<typeof setInterval> | null = null;
  /** 鍚姩寤惰繜鎵ц timer */
  private startupEvictionTimer: ReturnType<typeof setTimeout> | null = null;
  /** 鍦ㄧ嚎浜嬩欢鐩戝惉鍣?*/
  private onlineListener: (() => void) | null = null;
  /** 棣栨浜や簰鐩戝惉鍣?*/
  private firstInteractionHandler: (() => void) | null = null;
  /** 鍋滄硦杞婚噺鍚屾娓告爣 */
  private parkedCursor: string | null = null;
  /** 琛拌€佹竻鐞嗗浐瀹氬贰妫€鍛ㄦ湡 */
  private static readonly EVICTION_CHECK_INTERVAL_MS = 60_000;

  /** 鎻愰啋娣″嚭璁℃暟锛圞ey: taskId锛?*/
  private readonly reminderFadeoutCounts = new Map<string, number>();

  /** 闇€瑕佹樉绀虹孩鐐圭殑浠诲姟 ID 闆嗗悎 */
  readonly badgedTaskIds = signal<Set<string>>(new Set(), { equal: () => false });

  // 鈹€鈹€鈹€ 娲剧敓鐘舵€?鈹€鈹€鈹€

  /** 褰撳墠 focused 浠诲姟锛堝悓涓€鏃跺埢鏈€澶?1 涓紝A4 涓嶅彉閲忥級 */
  readonly focusedTask = computed(() => {
    const parked = this.taskStore.parkedTasks();
    return parked.find(t => t.parkingMeta?.state === 'focused') ?? null;
  });

  /** 鍋滄硦浠诲姟鏁伴噺 */
  readonly parkedCount = computed(() => this.taskStore.parkedTaskIds().size);

  /** 鏄惁鏈夊嵆灏嗗埌鏈熺殑鎻愰啋锛? 1h锛?*/
  readonly hasUpcomingReminder = computed(() => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    return this.taskStore.parkedTasks().some(t => {
      const reminderAt = t.parkingMeta?.reminder?.reminderAt;
      if (!reminderAt) return false;
      const diff = new Date(reminderAt).getTime() - now;
      return diff > 0 && diff < oneHour;
    });
  });

  constructor() {
    // Register beforeunload snapshot save.
    this.beforeUnloadManager.register(
      'parking-snapshot',
      () => this.saveSnapshotToLocalStorage(),
      PARKING_CONFIG.BEFORE_UNLOAD_PRIORITY
    );

    // Save full snapshot into IndexedDB when page becomes hidden.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          void this.saveSnapshotToIndexedDB();
        }
      });
    }

    // Keep notices queued while gate is active.
    effect(() => {
      const gateActive = this.gateService.isActive();
      if (!gateActive && this._pendingNotices().length > 0) {
        // Notices remain in signal and will be consumed by ParkingNoticeComponent.
        // 涓嶉渶瑕侀澶栨搷浣滐紙閫氱煡宸插湪 signal 涓級
      }
    });

    // Start stale parked-task eviction flow.
    this.initEviction();

    // Start lightweight parked-task sync.
    void this.initParkedLightweightSync();
  }

  // 鈹€鈹€鈹€ 瀵瑰 API锛圓5.1 濂戠害锛?鈹€鈹€鈹€

  /**
   * 棰勮浠诲姟鈥斺€斾笉鍒囨崲 Focus锛屼粎鎵撳紑璇︽儏
   * 鍒锋柊 lastVisitedAt 闃叉琛拌€佹竻鐞嗭紙A6.1b.5锛?   */
  previewTask(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;

    // At any moment only one previewing task.
    this.previewingTaskId.set(taskId);

    // 鍒锋柊 lastVisitedAt
    this.updateParkingMeta(taskId, {
      ...task.parkingMeta,
      lastVisitedAt: new Date().toISOString(),
    });
  }

  /**
   * 鍒囨崲鍒扮洰鏍囦换鍔♀€斺€斾繚瀛樺綋鍓?鈫?鍒囨崲 鈫?鎭㈠涓婁笅鏂?   * 瀵瑰鍞竴鍒囨崲鍏ュ彛锛圓5.1.2锛?   */
  startWork(taskId: string): void {
    const targetTask = this.taskStore.getTask(taskId);
    if (!targetTask) {
      this.logger.warn('ParkingService', 'startWork: target task not found', { taskId });
      return;
    }

    // 鐩爣蹇呴』鏄?active 鐘舵€侊紙A4 涓嶅彉閲忥級
    if (targetTask.status !== 'active') {
      this.logger.warn('ParkingService', 'startWork: 鍙兘瀵?active 浠诲姟鎵ц', { taskId, status: targetTask.status });
      return;
    }

    // Block switches while spotlight mode is active.
    if (spotlightMode()) {
      this.toastService.info('请先退出 Spotlight 模式', '当前无法切换停泊任务');
      return;
    }

    const currentFocused = this.focusedTask();
    const undoSnapshots = this.captureParkUndoSnapshots([taskId, currentFocused?.id ?? null]);

    // 1) Snapshot current focused task then park it.
    if (currentFocused && currentFocused.id !== taskId) {
      this.contextRestoreService.saveSnapshot(currentFocused.id);

      // 褰撳墠 focused 鈫?parked
      this.updateParkingMeta(currentFocused.id, {
        ...currentFocused.parkingMeta!,
        state: 'parked',
        parkedAt: new Date().toISOString(),
        lastVisitedAt: new Date().toISOString(),
      });
    }

    // 2. 鐩爣浠诲姟 鈫?focused
    const now = new Date().toISOString();
    const newMeta: TaskParkingMeta = targetTask.parkingMeta
      ? { ...targetTask.parkingMeta, state: 'focused', lastVisitedAt: now }
      : {
        state: 'focused',
        parkedAt: null,
        lastVisitedAt: now,
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      };
    this.updateParkingMeta(taskId, newMeta);

    // 3) Restore context snapshot for target task when available.
    if (targetTask.parkingMeta?.contextSnapshot) {
      this.contextRestoreService.restore(taskId, targetTask.parkingMeta.contextSnapshot);
    }

    // 4. 鍏抽棴棰勮
    this.previewingTaskId.set(null);

    // 5) Record undo action.
    this.recordParkUndoAction(undoSnapshots);
  }

  /**
   * 浠庡仠娉婂垪琛ㄧЩ闄も€斺€旂Щ鍥炴櫘閫氫换鍔″垪琛?   * 5s 鍙挙鍥烇紙A6.2b锛?   */
  removeParkedTask(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;

    const previousMeta = { ...task.parkingMeta };

    // 娓呴櫎 parkingMeta
    this.clearParkingMeta(taskId);

    // Close preview if we were previewing this task.
    if (this.previewingTaskId() === taskId) {
      this.previewingTaskId.set(null);
    }

    // 5s 鍙挙鍥?Snackbar
    this.toastService.info(
      `銆?{task.title}銆嶅凡绉诲洖浠诲姟鍒楄〃`,
      undefined,
      {
        duration: PARKING_CONFIG.REMOVE_UNDO_TIMEOUT_MS,
        action: {
          label: '鎾ゅ洖',
          onClick: () => this.restoreParkingMeta(taskId, previousMeta),
        },
      }
    );
  }

  /**
   * 鎾ゅ洖琛拌€佹竻鐞嗭紙A5.1.4锛?   */
  undoEviction(tokenId: string): void {
    const evictionToken = this.evictionTokens.get(tokenId);
    if (!evictionToken) {
      this.logger.warn('ParkingService', 'undoEviction: token not found', { tokenId });
      return;
    }
    if (this.isEvictionTokenExpired(evictionToken)) {
      this.evictionTokens.delete(tokenId);
      this.logger.warn('ParkingService', 'undoEviction: token expired', {
        tokenId,
        expiresAt: evictionToken.expiresAt,
      });
      return;
    }
    if (evictionToken.usedAt !== null) {
      this.logger.warn('ParkingService', 'undoEviction: token already used', { tokenId });
      return;
    }

    evictionToken.usedAt = Date.now();
    this.evictionTokens.set(tokenId, evictionToken);
    this.restoreParkingMeta(evictionToken.taskId, evictionToken.previousParkingMeta);
  }

  /**
   * 鍋滄硦褰撳墠浠诲姟鈥斺€旂敤鎴蜂富鍔ㄥ皢浠诲姟鏀惧叆銆岀◢鍚庡鐞嗐€?   */
  parkTask(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task || task.status !== 'active') return;

    const now = new Date().toISOString();
    const meta: TaskParkingMeta = task.parkingMeta
      ? { ...task.parkingMeta, state: 'parked', parkedAt: now, lastVisitedAt: now }
      : {
        state: 'parked',
        parkedAt: now,
        lastVisitedAt: now,
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      };

    // 淇濆瓨蹇収鐒跺悗鍋滄硦
    this.contextRestoreService.saveSnapshot(taskId);
    this.updateParkingMeta(taskId, meta);

    // 鍏ㄥ眬缁熶竴瑙嗚鍙嶉
    this.toastService.success('已停泊', `「${task.title || '未命名任务'}」已移至稍后处理`);
  }

  /**
   * 鍒囨崲 pinned 鐘舵€侊紙A6.4.7锛?   */
  togglePinned(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;

    this.updateParkingMeta(taskId, {
      ...task.parkingMeta,
      pinned: !task.parkingMeta.pinned,
    });
  }

  /**
   * 蹇€熷洖鍒団€斺€斿垏鍥炴渶杩戝仠娉婁换鍔★紝璺宠繃棰勮锛圓6.1.4锛?   */
  quickSwitch(): void {
    const parked = this.taskStore.parkedTasks();
    const mostRecent = parked.find(t => t.parkingMeta?.state === 'parked');
    if (mostRecent) {
      this.startWork(mostRecent.id);
    }
  }

  // 鈹€鈹€鈹€ 鍋滄硦杞婚噺澧為噺鍚屾锛圓3.4锛?鈹€鈹€鈹€

  private async initParkedLightweightSync(): Promise<void> {
    if (this.parkedLightweightInitialized) return;
    this.parkedLightweightInitialized = true;

    // 1) 鍏堣缂撳瓨锛堝喎鍚姩蹇€熷彲瑙侊級
    const cached = await this.projectDataService.loadParkedTasksCache();
    this.parkedCursor = cached.cursor;
    for (const entry of cached.entries) {
      this.applyRemoteParkedEntry(entry.task, entry.projectId);
    }

    // 2) Pull one incremental delta in background.
    await this.syncParkedDelta();

    // 3) 鍚姩鎭㈠鏃讹細浼樺厛浣跨敤 IDB 宸叉仮澶嶅揩鐓э紝闄嶇骇璇诲彇鑽夌骞舵竻鐞嗚崏绋块敭
    this.restoreSnapshotDraftFromLocalStorage();

    // 4) Start periodic incremental refresh.
    this.parkedDeltaTimer = setInterval(() => {
      void this.syncParkedDelta();
    }, ParkingService.EVICTION_CHECK_INTERVAL_MS);
  }

  private async syncParkedDelta(): Promise<void> {
    const knownParkedTaskIds = Array.from(this.taskStore.parkedTaskIds());
    const delta = await this.projectDataService.pullParkedTasksDelta(this.parkedCursor, knownParkedTaskIds);

    if (delta.entries.length === 0 && delta.removedTaskIds.length === 0) {
      this.parkedCursor = delta.nextCursor ?? this.parkedCursor;
      return;
    }

    for (const entry of delta.entries) {
      this.applyRemoteParkedEntry(entry.task, entry.projectId);
    }

    for (const taskId of delta.removedTaskIds) {
      this.applyRemoteParkingRemoval(taskId);
    }

    this.parkedCursor = delta.nextCursor ?? this.parkedCursor;

    // 澧為噺缁撴灉鍥炲啓缂撳瓨锛堣鐩栧紡锛屾暟鎹噺灏忥級
    const entries = this.taskStore.parkedTasks()
      .map((task) => ({
        task,
        projectId: this.findProjectId(task.id),
      }))
      .filter((entry): entry is { task: Task; projectId: string } => !!entry.projectId);

    await this.projectDataService.saveParkedTasksCache({
      entries,
      cursor: this.parkedCursor,
    });
  }

  private applyRemoteParkedEntry(task: Task, projectId: string): void {
    const local = this.taskStore.getTask(task.id);
    const nextTask = local
      ? {
        ...local,
        ...task,
        // Keep local displayId maintained by layout logic.
        displayId: local.displayId || task.displayId,
      }
      : task;

    this.taskStore.setTask(nextTask, projectId);
  }

  private applyRemoteParkingRemoval(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;
    const projectId = this.findProjectId(taskId);
    if (!projectId) return;
    this.taskStore.setTask({ ...task, parkingMeta: undefined }, projectId);
  }

  // 鈹€鈹€鈹€ 琛拌€佹竻鐞嗭紙A6.4锛?鈹€鈹€鈹€

  /**
   * 鍒濆鍖栬“鑰佹竻鐞嗏€斺€斿欢杩熷埌 p1 灏辩华 + 棣栨浜や簰鍚?3s锛圓5.1.6 / A6.4.5锛?   */
  initEviction(): void {
    if (this.evictionInitialized) return;
    this.evictionInitialized = true;

    const maxReadyChecks = 120;
    let readyChecks = 0;

    const checkReady = () => {
      readyChecks += 1;
      const tierReady = this.startupOrchestrator.isTierReady('p1');
      if (tierReady || readyChecks >= maxReadyChecks) {
        this.armFirstInteractionForEviction();
      } else {
        setTimeout(checkReady, 500);
      }
    };
    checkReady();
  }
  private armFirstInteractionForEviction(): void {
    if (typeof document === 'undefined') return;
    if (this.firstInteractionHandler) return;

    this.firstInteractionHandler = () => {
      if (!this.firstInteractionHandler) return;
      document.removeEventListener('keydown', this.firstInteractionHandler);
      document.removeEventListener('click', this.firstInteractionHandler);
      document.removeEventListener('scroll', this.firstInteractionHandler);
      this.firstInteractionHandler = null;

      if (this.startupEvictionTimer) {
        clearTimeout(this.startupEvictionTimer);
      }
      this.startupEvictionTimer = setTimeout(() => {
        this.runEvictionCheck();
        // After startup, switch to fixed interval checks.
        if (!this.evictionIntervalTimer) {
          this.evictionIntervalTimer = setInterval(
            () => this.runEvictionCheck(),
            ParkingService.EVICTION_CHECK_INTERVAL_MS
          );
        }
      }, PARKING_CONFIG.EVICTION_STARTUP_DELAY_MS);
    };

    document.addEventListener('keydown', this.firstInteractionHandler);
    document.addEventListener('click', this.firstInteractionHandler);
    document.addEventListener('scroll', this.firstInteractionHandler);

    // Skip eviction while offline; re-check immediately when back online.
    if (typeof window !== 'undefined' && !this.onlineListener) {
      this.onlineListener = () => this.runEvictionCheck();
      window.addEventListener('online', this.onlineListener);
    }
  }

  /**
   * 鎵ц琛拌€佹竻鐞嗘鏌?   */
  private runEvictionCheck(): void {
    if (!this.canRunEvictionNow()) return;

    this.pruneExpiredEvictionTokens();

    const now = Date.now();
    const tasks = this.taskStore.parkedTasks();
    const evictedItems: ParkingNoticeEvictionItem[] = [];

    for (const task of tasks) {
      if (!task.parkingMeta || task.parkingMeta.state === 'focused') continue;
      if (task.parkingMeta.pinned) continue; // 璞佸厤

      const lastVisited = task.parkingMeta.lastVisitedAt
        ? new Date(task.parkingMeta.lastVisitedAt).getTime()
        : task.parkingMeta.parkedAt
          ? new Date(task.parkingMeta.parkedAt).getTime()
          : now;

      const elapsed = now - lastVisited;

      if (elapsed >= PARKING_CONFIG.PARKED_TASK_STALE_THRESHOLD) {
        const token = this.evictTask(task);
        if (token) {
          evictedItems.push({
            taskId: token.taskId,
            taskTitle: token.taskTitle,
            evictionTokenId: token.tokenId,
          });
        }
      }
    }

    if (evictedItems.length === 0) return;
    this.showNotice(this.createEvictionNotice(evictedItems));
  }

  private canRunEvictionNow(): boolean {
    if (typeof navigator === 'undefined') return true;
    return navigator.onLine;
  }

  private evictTask(task: Task): EvictionToken | null {
    if (!task.parkingMeta) return null;

    // Save token with id and expiry window.
    const now = Date.now();
    const tokenId = crypto.randomUUID();
    const token: EvictionToken = {
      tokenId,
      taskId: task.id,
      taskTitle: task.title,
      previousParkingMeta: { ...task.parkingMeta },
      createdAt: now,
      expiresAt: now + PARKING_CONFIG.EVICTION_UNDO_TIMEOUT_MS,
      usedAt: null,
    };
    this.evictionTokens.set(tokenId, token);

    // 娓呴櫎 parkingMeta
    this.clearParkingMeta(task.id);
    return token;
  }

  private pruneExpiredEvictionTokens(): void {
    if (this.evictionTokens.size === 0) return;
    const now = Date.now();
    for (const [tokenId, token] of this.evictionTokens.entries()) {
      if (token.expiresAt <= now || token.usedAt !== null) {
        this.evictionTokens.delete(tokenId);
      }
    }
  }

  private isEvictionTokenExpired(token: EvictionToken): boolean {
    return token.expiresAt <= Date.now();
  }

  /**
   * 鎵归噺娓呯悊閫氱煡锛氭眹鎬诲叆鍙?+ 閫愭潯鎾ゅ洖
   */
  private createEvictionNotice(items: ParkingNoticeEvictionItem[]): ParkingNotice {
    if (items.length === 1) {
      const item = items[0];
      return {
        id: crypto.randomUUID(),
        type: 'eviction',
        taskId: item.taskId,
        taskTitle: item.taskTitle,
        minVisibleMs: PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS,
        fallbackTimeoutMs: PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS,
        reason: '72 小时未访问，已自动移回任务列表。',
        evictionTokenId: item.evictionTokenId,
        actions: [
          { key: 'undo-eviction', label: '鎾ゅ洖' },
          { key: 'keep-parked', label: '鍏抽棴' },
        ],
      };
    }

    return {
      id: crypto.randomUUID(),
      type: 'eviction',
      taskId: items[0].taskId,
      taskTitle: `${items.length} 涓仠娉婁换鍔″凡绉诲洖浠诲姟鍒楄〃`,
      minVisibleMs: PARKING_CONFIG.NOTICE_MIN_VISIBLE_MS,
      fallbackTimeoutMs: PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS,
      reason: '72 小时未访问，已自动清理，可逐条撤回。',
      evictionItems: items,
      actions: [
        { key: 'keep-parked', label: '鍏抽棴' },
      ],
    };
  }

  /**
   * 鑾峰彇鍗曚釜娓呯悊 token锛堢敤浜庣粍浠跺垽鏂寜閽姸鎬侊級
   */
  getEvictionToken(tokenId: string): EvictionToken | null {
    const token = this.evictionTokens.get(tokenId) ?? null;
    if (!token) return null;
    if (this.isEvictionTokenExpired(token)) {
      this.evictionTokens.delete(tokenId);
      return null;
    }
    return token;
  }

  /**
   * Gate 婵€娲绘椂閫氱煡鍙帓闃燂紱鍏抽棴鍚庣敱缁勪欢娑堣垂灞曠ず
   */
  showNotice(notice: ParkingNotice): void {
    if (notice.type === 'eviction' && this.gateService.isActive()) {
      this._pendingNotices.update(list => [...list, notice]);
      return;
    }
    this._pendingNotices.update(list => [...list, notice]);
  }

  // 鈹€鈹€鈹€ 鍋滄硦浠诲姟琚蒋鍒犻櫎鑱斿姩锛圓5.1.5锛?鈹€鈹€鈹€

  /**
   * 澶勭悊浠诲姟琚蒋鍒犻櫎鈥斺€斾粠鍋滄硦鍒楄〃绉婚櫎
   * 鐢?TaskTrashService 鍦?deleteTask 鍐呰皟鐢?   */
  handleTaskSoftDelete(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (task?.parkingMeta) {
      this.clearParkingMeta(taskId);
      if (this.previewingTaskId() === taskId) {
        this.previewingTaskId.set(null);
      }
    }
  }

  /**
   * 澶勭悊浠诲姟鏍囪瀹屾垚/褰掓。鈥斺€旀竻闄?parkingMeta锛圓3.9锛?   */
  handleTaskStatusChange(taskId: string, newStatus: string): void {
    if (newStatus === 'completed' || newStatus === 'archived') {
      const task = this.taskStore.getTask(taskId);
      if (task?.parkingMeta) {
        this.clearParkingMeta(taskId);
      }
    }
  }

  // 鈹€鈹€鈹€ 鎻愰啋绾㈢偣锛圓5.3.5锛?鈹€鈹€鈹€

  /**
   * 璁板綍鎻愰啋閫氱煡琚厹搴曟贰鍑?   */
  recordReminderFadeout(taskId: string): void {
    const count = (this.reminderFadeoutCounts.get(taskId) || 0) + 1;
    this.reminderFadeoutCounts.set(taskId, count);
    if (count >= PARKING_CONFIG.REMINDER_BADGE_THRESHOLD) {
      this.badgedTaskIds.update(s => { s.add(taskId); return s; });
    }
  }

  /**
   * 娓呴櫎鎻愰啋绾㈢偣
   */
  clearBadge(taskId: string): void {
    this.reminderFadeoutCounts.delete(taskId);
    this.badgedTaskIds.update(s => { s.delete(taskId); return s; });
  }

  // 鈹€鈹€鈹€ 杞婚噺缂栬緫锛圓6.1b.3锛?鈹€鈹€鈹€

  /**
   * 鍦ㄩ瑙堢姸鎬佽拷鍔犲娉?   * 浠?"\n---\n> 澶囨敞锛堝仠娉婃椂锛? {content}" 鏍煎紡杩藉姞鍒?content 鏈熬
   */
  addNote(taskId: string, noteContent: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const separator = '\n---\n';
    const noteBlock = `> 澶囨敞锛堝仠娉婃椂锛? ${noteContent}`;
    const updatedContent = task.content + separator + noteBlock;

    // Resolve project id for target task.
    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    // Update content through normal debounced sync path.
    this.taskStore.setTask(
      { ...task, content: updatedContent, updatedAt: new Date().toISOString() },
      projectId
    );
  }

  // 鈹€鈹€鈹€ SOFT_LIMIT 璀﹀憡锛圓2.4 / P-21锛?鈹€鈹€鈹€

  /** 鏄惁瓒呰繃杞笂闄?*/
  readonly isOverSoftLimit = computed(() =>
    this.parkedCount() >= PARKING_CONFIG.PARKED_TASK_SOFT_LIMIT
  );

  // 鈹€鈹€鈹€ 鍐呴儴杈呭姪 鈹€鈹€鈹€

  private updateParkingMeta(taskId: string, meta: TaskParkingMeta): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    this.taskStore.setTask(
      { ...task, parkingMeta: meta, updatedAt: new Date().toISOString() },
      projectId
    );
  }

  private clearParkingMeta(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    this.taskStore.setTask(
      { ...task, parkingMeta: undefined, updatedAt: new Date().toISOString() },
      projectId
    );
  }

  private restoreParkingMeta(taskId: string, meta: TaskParkingMeta): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    this.taskStore.setTask(
      { ...task, parkingMeta: meta, updatedAt: new Date().toISOString() },
      projectId
    );
  }

  /**
   * 鏌ユ壘浠诲姟鎵€灞為」鐩?ID
   */
  private findProjectId(taskId: string): string | null {
    return this.taskStore.getTaskProjectId(taskId)
      ?? this.projectStore.activeProjectId()
      ?? null;
  }

  /**
   * 璁板綍 Undo 鎿嶄綔锛圓3.7锛?   */
  private captureParkUndoSnapshots(taskIds: Array<string | null>): Map<string, Partial<Project>> {
    const snapshots = new Map<string, Partial<Project>>();
    for (const taskId of taskIds) {
      if (!taskId) continue;
      const projectId = this.findProjectId(taskId);
      if (!projectId || snapshots.has(projectId)) continue;
      const project = this.projectStore.getProject(projectId);
      if (!project) continue;
      snapshots.set(projectId, this.undoService.createProjectSnapshot(project));
    }
    return snapshots;
  }

  private recordParkUndoAction(beforeSnapshots: Map<string, Partial<Project>>): void {
    for (const [projectId, before] of beforeSnapshots.entries()) {
      const project = this.projectStore.getProject(projectId);
      if (!project) continue;
      const after = this.undoService.createProjectSnapshot(project);
      if (!this.hasProjectSnapshotChanged(before, after)) continue;
      this.undoService.recordAction({
        type: 'task-park',
        projectId,
        data: { before, after },
      });
    }
  }

  private hasProjectSnapshotChanged(before: Partial<Project>, after: Partial<Project>): boolean {
    const beforeTasks = before.tasks ?? [];
    const afterTasks = after.tasks ?? [];
    if (beforeTasks.length !== afterTasks.length) return true;
    const beforeConnections = before.connections ?? [];
    const afterConnections = after.connections ?? [];
    if (beforeConnections.length !== afterConnections.length) return true;
    return JSON.stringify(beforeTasks) !== JSON.stringify(afterTasks)
      || JSON.stringify(beforeConnections) !== JSON.stringify(afterConnections);
  }

  /**
   * 娑堣垂骞剁Щ闄ら槦棣栭€氱煡
   */
  consumeNotice(noticeId: string): void {
    this._pendingNotices.update(list => list.filter(n => n.id !== noticeId));
  }

  /**
   * 淇濈暀鍋滄硦浠诲姟鈥斺€旈噸缃?lastVisitedAt锛屾竻闄ゅ嵆灏嗘竻鐞嗙姸鎬侊紙A6.4.2锛?   */
  keepParked(taskId: string): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;
    this.updateParkingMeta(taskId, {
      ...task.parkingMeta,
      lastVisitedAt: new Date().toISOString(),
    });
    this.toastService.info('已保留，不会被自动清理');
  }

  // 鈹€鈹€鈹€ BeforeUnload 蹇収锛圓3.12锛?鈹€鈹€鈹€

  /**
   * 鍚屾鍐欏叆 localStorage 绱ф€ュ揩鐓?   */
  private saveSnapshotToLocalStorage(): void {
    const focused = this.focusedTask();
    if (!focused?.parkingMeta?.contextSnapshot) return;

    try {
      const draft: SnapshotDraft = {
        taskId: focused.id,
        contentHash: focused.parkingMeta.contextSnapshot.contentHash,
        cursorPosition: focused.parkingMeta.contextSnapshot.cursorPosition,
        structuralAnchor: focused.parkingMeta.contextSnapshot.structuralAnchor,
        savedAt: new Date().toISOString(),
      };
      localStorage.setItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // localStorage 鍐欏叆澶辫触锛堝閲?闅愮妯″紡锛夛紝闈欓粯蹇界暐
    }
  }

  /**
   * 寮傛鍐欏叆 IndexedDB 瀹屾暣蹇収
   */
  private async saveSnapshotToIndexedDB(): Promise<void> {
    const focused = this.focusedTask();
    if (focused) {
      // 瑙﹀彂 ContextRestoreService 淇濆瓨瀹屾暣蹇収
      this.contextRestoreService.saveSnapshot(focused.id);
    }
    await this.persistParkedTasksToIndexedDB();
  }

  private async persistParkedTasksToIndexedDB(): Promise<void> {
    const entries = this.taskStore.parkedTasks()
      .map((task) => ({
        task,
        projectId: this.findProjectId(task.id),
      }))
      .filter((entry): entry is { task: Task; projectId: string } => !!entry.projectId);

    await this.projectDataService.saveParkedTasksCache({
      entries,
      cursor: this.parkedCursor,
    });
  }

  private restoreSnapshotDraftFromLocalStorage(): void {
    const draft = this.readSnapshotDraft();
    if (!draft) return;

    try {
      const task = this.taskStore.getTask(draft.taskId);
      if (!task?.parkingMeta) return;

      const idbSavedAt = this.parseSavedAt(task.parkingMeta.contextSnapshot?.savedAt);
      const draftSavedAt = this.parseSavedAt(draft.savedAt);
      if (draftSavedAt <= idbSavedAt) return;

      const existing = task.parkingMeta.contextSnapshot;
      const merged: ParkingSnapshot = {
        savedAt: draft.savedAt,
        contentHash: draft.contentHash || existing?.contentHash || '',
        viewMode: existing?.viewMode ?? 'text',
        cursorPosition: draft.cursorPosition ?? existing?.cursorPosition ?? null,
        scrollAnchor: existing?.scrollAnchor ?? null,
        structuralAnchor: draft.structuralAnchor ?? existing?.structuralAnchor ?? null,
        flowViewport: existing?.flowViewport ?? null,
      };

      this.updateParkingMeta(task.id, {
        ...task.parkingMeta,
        contextSnapshot: merged,
      });
    } finally {
      try {
        localStorage.removeItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY);
      } catch {
        // 蹇界暐 localStorage 娓呯悊澶辫触
      }
    }
  }

  private readSnapshotDraft(): SnapshotDraft | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SnapshotDraft>;
      if (
        typeof parsed?.taskId !== 'string'
        || typeof parsed?.savedAt !== 'string'
        || typeof parsed?.contentHash !== 'string'
      ) {
        return null;
      }
      return {
        taskId: parsed.taskId,
        contentHash: parsed.contentHash,
        cursorPosition: parsed.cursorPosition ?? null,
        structuralAnchor: parsed.structuralAnchor ?? null,
        savedAt: parsed.savedAt,
      };
    } catch {
      return null;
    }
  }

  private parseSavedAt(value: string | null | undefined): number {
    if (!value) return 0;
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? 0 : ts;
  }
}
