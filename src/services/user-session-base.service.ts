// eslint-disable-next-line no-restricted-imports -- RetryQueueService 尚未迁移到 src/services/，会话切换需直接清理重试队列
import { RetryQueueService } from '../app/core/services/sync/retry-queue.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { Project } from '../models';
import type { LaunchSnapshot, LaunchSnapshotProject } from '../models/launch-shell';
import { pushStartupTrace } from '../utils/startup-trace';
import { ActionQueueService } from './action-queue.service';
import type { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { ChangeTrackerService } from './change-tracker.service';
import { ConflictStorageService } from './conflict-storage.service';
import { DockSnapshotPersistenceService } from './dock-snapshot-persistence.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { StartupPlaceholderStateService } from './startup-placeholder-state.service';
import { SupabaseClientService } from './supabase-client.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { UserSessionAttachmentLazyLoader } from './user-session-attachment-lazy-loader';
import { StorePersistenceService } from '../app/core/state/store-persistence.service';
import type { SessionGuardContext, StartupProjectCatalogStage } from './user-session-base.types';
import { UndoService } from './undo.service';
import { buildHintScopedPlaceholderProjects as buildHintScopedPlaceholderProjectsPure, buildPrehydrateProjects as buildPrehydrateProjectsPure, cloneOfflineProjectsForPrehydrate as cloneOfflineProjectsForPrehydratePure } from './user-session-snapshot-projection';
import { DestroyRef, inject, Injector, OnDestroy, signal } from '@angular/core';

export {
  DOCK_SNAPSHOT_DB_NAME,
  FULL_WIPE_INDEXED_DB_NAMES,
  FULL_WIPE_LOCAL_STORAGE_KEYS,
  FULL_WIPE_LOCAL_STORAGE_PREFIXES,
  GUEST_DATA_STORAGE_KEY,
} from './user-session-base.types';
export type {
  BackgroundActiveHydrationResult,
  BackgroundActiveProjectPreflightResult,
  BackgroundCurrentProjectSyncResult,
  BackgroundSyncPipelineResult,
  BackgroundSyncProbeStageResult,
  BackgroundWatermarkProbeResult,
  LocalProjectRestorePlan,
  OwnerChangePreparation,
  ProjectHydrationLoadResult,
  ProjectListMetadataPrimeManifestResult,
  ProjectListMetadataQueryResult,
  ProjectListMetadataRow,
  ProjectListMetadataUpdateResult,
  SessionGuardContext,
  SetCurrentUserContext,
  SetCurrentUserOptions,
  StartupProjectCatalogStage,
  StartupSnapshotResult,
} from './user-session-base.types';

export abstract class UserSessionBase implements OnDestroy {
  protected readonly IDLE_TASK_FALLBACK_MS = 1500;
  protected isDestroyed = false;
  protected readonly idleFallbackTimers = new Set<ReturnType<typeof setTimeout>>();
  protected readonly idleCallbackHandles = new Set<number>();

  protected readonly loggerService = inject(LoggerService);

  protected readonly logger = this.loggerService.category('UserSession');

  protected authService = inject(AuthService);

  protected syncCoordinator = inject(SyncCoordinatorService);

  protected storePersistence = inject(StorePersistenceService);

  protected actionQueue = inject(ActionQueueService);

  protected retryQueue = inject(RetryQueueService);

  protected conflictStorage = inject(ConflictStorageService);

  protected undoService = inject(UndoService);

  protected uiState = inject(UiStateService);

  protected projectState = inject(ProjectStateService);

  protected changeTracker = inject(ChangeTrackerService);

  protected startupPlaceholderState = inject(StartupPlaceholderStateService, { optional: true });

  protected injector = inject(Injector);

  protected layoutService = inject(LayoutService);

  protected toastService = inject(ToastService);

  protected supabase = inject(SupabaseClientService);

  protected dockSnapshotPersistence = inject(DockSnapshotPersistenceService);

  protected destroyRef = inject(DestroyRef);

  private readonly attachmentLazyLoader = new UserSessionAttachmentLazyLoader({
    injector: this.injector,
    isDestroyed: () => this.isDestroyed,
    warn: (message, error) => this.logger.warn(message, error),
  });

  protected prehydratedSnapshotApplied = false;

  protected prehydratedSnapshotOwnerId: string | null = null;

  protected sessionRequestGeneration = 0;

  protected readonly lastProjectListMetadataSyncSucceededState = signal(false);

  protected readonly lastProjectListMetadataSyncDurableState = signal(false);

  protected readonly authoritativelyAccessibleProjectIdsState = signal<ReadonlySet<string>>(new Set());

  protected readonly startupProjectCatalogStageState = signal<StartupProjectCatalogStage>('unresolved');

  protected readonly trustedPrehydratedSnapshotState = signal(false);

  /** 已从云端完整加载过内容的项目 ID 集合，防止重复加载 */
  protected readonly hydratedProjectIds = new Set<string>();

  /** 正在加载中的项目 ID，防止并发重复请求 */
  protected readonly hydrationInFlight = new Map<string, Promise<void>>();

  /** 当前启动轮次中的项目列表元数据同步 Promise，避免重复查询 */
  protected projectListMetadataSyncInFlight: Promise<Set<string>> | null = null;

  protected projectListMetadataSyncScopeKey: string | null = null;

  protected projectListMetadataSyncLastCompletedScopeKey: string | null = null;

  protected projectListMetadataSyncLastResult: ReadonlySet<string> | null = null;

  readonly startupProjectCatalogStage = this.startupProjectCatalogStageState.asReadonly();

  readonly trustedPrehydratedSnapshotVisible = this.trustedPrehydratedSnapshotState.asReadonly();

  /** 当前用户 ID (代理 AuthService) */
  readonly currentUserId = this.authService.currentUserId;


  constructor() {
    this.destroyRef.onDestroy(() => this.ngOnDestroy());

    if (!FEATURE_FLAGS.USER_SESSION_ATTACHMENT_ON_DEMAND_V1) {
      void this.getAttachmentServiceLazy();
    }
  }

  ngOnDestroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    this.idleFallbackTimers.forEach(timer => clearTimeout(timer));
    this.idleFallbackTimers.clear();
    if (typeof window !== 'undefined') {
      const cancelIdleCallback = (window as Window & {
        cancelIdleCallback?: (handle: number) => void;
      }).cancelIdleCallback;
      if (typeof cancelIdleCallback === 'function') {
        this.idleCallbackHandles.forEach(handle => cancelIdleCallback(handle));
      }
    }
    this.idleCallbackHandles.clear();

    this.attachmentLazyLoader.destroy();
  }


  async getAttachmentServiceLazy(): Promise<AttachmentService | null> {
    return this.attachmentLazyLoader.get();
  }

  protected clearMonitoredAttachmentsLazy(): void {
    this.attachmentLazyLoader.clearLoadedMonitoring();
  }


  canAuthoritativelyRejectProjectRoute(): boolean {
    const currentUserId = this.currentUserId();
    if (!currentUserId || currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return this.startupProjectCatalogStage() === 'resolved';
    }

    return this.lastProjectListMetadataSyncSucceededState();
  }


  protected setProjectAuthoritativeAccessibility(projectId: string, accessible: boolean): void {
    const nextAccessibleProjectIds = new Set(this.authoritativelyAccessibleProjectIdsState());
    if (accessible) {
      nextAccessibleProjectIds.add(projectId);
    } else {
      nextAccessibleProjectIds.delete(projectId);
    }
    this.authoritativelyAccessibleProjectIdsState.set(nextAccessibleProjectIds);
  }


  isHintOnlyStartupPlaceholderVisible(): boolean {
    return this.startupPlaceholderState?.isHintOnlyActive() ?? false;
  }


  getLaunchSnapshotPersistOwnerDuringAuthSettle(): string | null {
    if (!this.prehydratedSnapshotApplied || this.isHintOnlyStartupPlaceholderVisible()) {
      return null;
    }

    return this.prehydratedSnapshotOwnerId;
  }


  protected applyPrehydrateProjects(
    snapshot: LaunchSnapshot,
    projects: Project[],
    trustedSnapshotOwnerId: string,
  ): void {
    this.projectState.setProjects(projects);
    this.projectState.setActiveProjectId(snapshot.activeProjectId ?? projects[0]?.id ?? null);
    this.startupPlaceholderState?.clear();
    this.prehydratedSnapshotApplied = true;
    this.prehydratedSnapshotOwnerId = trustedSnapshotOwnerId;
    this.trustedPrehydratedSnapshotState.set(true);
    this.startupProjectCatalogStageState.set('partial');

    if (trustedSnapshotOwnerId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.authService.setProvisionalCurrentUserId(trustedSnapshotOwnerId);
    }

    pushStartupTrace('user_session.snapshot_prehydrate', {
      projectCount: projects.length,
      activeProjectId: snapshot.activeProjectId,
      snapshotUserId: this.prehydratedSnapshotOwnerId,
    });
    this.logger.debug('快照预填充完成', { projectCount: projects.length });
  }


  protected clearStartupProjectCatalogState(): void {
    this.startupPlaceholderState?.clear();
    this.prehydratedSnapshotApplied = false;
    this.prehydratedSnapshotOwnerId = null;
    this.trustedPrehydratedSnapshotState.set(false);
    this.startupProjectCatalogStageState.set('unresolved');
  }


  protected markStartupProjectCatalogResolved(): void {
    this.startupPlaceholderState?.clear();
    this.trustedPrehydratedSnapshotState.set(false);
    this.startupProjectCatalogStageState.set('resolved');
  }


  protected markStartupProjectCatalogAwaitingRemoteResolution(options?: { retainHintPlaceholder?: boolean }): void {
    if (!options?.retainHintPlaceholder) {
      this.startupPlaceholderState?.clear();
    }
    this.trustedPrehydratedSnapshotState.set(false);
    this.startupProjectCatalogStageState.set('partial');
  }


  protected syncStartupProjectCatalogStageAfterLocalRestore(userId: string | null): void {
    if (userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.markStartupProjectCatalogAwaitingRemoteResolution();
      return;
    }

    this.markStartupProjectCatalogResolved();
  }


  protected resolveStartupTargetUserId(explicitUserId?: string | null): string | null {
    if (explicitUserId) {
      return explicitUserId;
    }

    const currentUserId = this.authService.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    return this.authService.peekPersistedSessionIdentity()?.userId
      ?? this.authService.peekPersistedOwnerHint()
      ?? null;
  }


  protected isAuthenticatedStartupTarget(userId: string | null): boolean {
    return !!userId && userId !== AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }


  protected resolvePrehydrateOwnerUserId(): string {
    const currentUserId = this.currentUserId();
    if (currentUserId) {
      return currentUserId;
    }

    if (!this.authService.isConfigured) {
      return AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    return this.authService.peekPersistedSessionIdentity()?.userId
      ?? this.authService.peekPersistedOwnerHint()
      ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }


  protected hasConfirmedPrehydrateOwner(ownerUserId: string): boolean {
    if (ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return true;
    }

    if (!this.authService.isConfigured) {
      return true;
    }

    const currentUserId = this.currentUserId();
    if (currentUserId === ownerUserId) {
      return true;
    }

    if (this.authService.peekPersistedSessionIdentity()?.userId === ownerUserId) {
      return true;
    }

    // PWA 数据为设备本地存储，owner hint 表示用户曾在此设备登录过。
    // access token 过期但 refresh token 仍可恢复时，信任本地数据归属，
    // 避免冷启动出现"正在确认会话"只读遮罩阻塞用户操作。
    return this.authService.peekPersistedOwnerHint() === ownerUserId;
  }


  protected cloneOfflineProjectsForPrehydrate(projects: Project[]): Project[] {
    return cloneOfflineProjectsForPrehydratePure(projects);
  }


  protected buildHintScopedPlaceholderProjects(projects: Project[]): Project[] {
    return buildHintScopedPlaceholderProjectsPure(projects);
  }


  protected prehydrateFromOfflineSnapshot(snapshot: LaunchSnapshot | null): boolean {
    const offlineProjects = this.syncCoordinator.loadOfflineSnapshot({ allowOwnerHint: true });
    if (!offlineProjects?.length) {
      return false;
    }

    const ownerUserId = this.resolvePrehydrateOwnerUserId();
    const ownerConfirmed = this.hasConfirmedPrehydrateOwner(ownerUserId);
    const projects = ownerConfirmed
      ? this.cloneOfflineProjectsForPrehydrate(offlineProjects)
      : this.buildHintScopedPlaceholderProjects(offlineProjects);
    const preferredProjectId = snapshot?.activeProjectId ?? null;
    const activeProjectId = preferredProjectId && projects.some((project) => project.id === preferredProjectId)
      ? preferredProjectId
      : projects[0]?.id ?? null;

    this.projectState.setProjects(projects);
    this.projectState.setActiveProjectId(activeProjectId);
    if (ownerConfirmed) {
      this.startupPlaceholderState?.clear();
      // 【P1 秒开优化 2026-03-31】离线快照 owner 已确认时也预设 userId，
      // 使 coreDataLoaded 提前生效，消除等待 auth 的 UI 空档。
      if (ownerUserId !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        this.authService.setProvisionalCurrentUserId(ownerUserId);
      }
    } else {
      this.startupPlaceholderState?.activate(ownerUserId);
    }
    this.prehydratedSnapshotApplied = true;
    this.prehydratedSnapshotOwnerId = ownerUserId;
    if (ownerConfirmed) {
      this.syncStartupProjectCatalogStageAfterLocalRestore(ownerUserId);
    } else {
      this.markStartupProjectCatalogAwaitingRemoteResolution({ retainHintPlaceholder: true });
    }

    pushStartupTrace('user_session.offline_snapshot_prehydrate', {
      projectCount: projects.length,
      activeProjectId,
      ownerUserId,
      ownerConfirmed,
    });
    this.logger.debug('离线快照预填充完成', {
      projectCount: projects.length,
      ownerUserId,
      ownerConfirmed,
    });
    return true;
  }


  protected resolveTrustedSnapshotOwnerId(snapshot: LaunchSnapshot): string | null {
    const snapshotUserId = typeof snapshot.userId === 'string' && snapshot.userId.length > 0
      ? snapshot.userId
      : null;

    const persistedSessionUserId = this.authService.peekPersistedSessionIdentity()?.userId ?? null;
    const persistedOwnerHint = this.authService.peekPersistedOwnerHint()
      ?? persistedSessionUserId
      ?? null;

    const currentUserId = this.currentUserId();
    const runtimeOwnerHint = currentUserId ?? persistedOwnerHint;

    if (snapshotUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      if (this.authService.isConfigured
        && typeof runtimeOwnerHint === 'string'
        && runtimeOwnerHint.length > 0
        && runtimeOwnerHint !== AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        return null;
      }

      return snapshotUserId;
    }

    if (!this.authService.isConfigured) {
      return snapshotUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    }

    if (!snapshotUserId) {
      return null;
    }

    if (currentUserId === snapshotUserId) {
      return snapshotUserId;
    }

    return persistedSessionUserId === snapshotUserId
      ? snapshotUserId
      : null;
  }


  protected shouldPreservePrehydratedSelection(userId: string | null): boolean {
    return !!userId
      && this.prehydratedSnapshotApplied
      && this.prehydratedSnapshotOwnerId !== null
      && this.prehydratedSnapshotOwnerId === userId;
  }


  /** 读取全局或 localStorage 中的启动快照 */
  protected readSnapshotForPrehydrate(): LaunchSnapshot | null {
    if (typeof window === 'undefined') return null;

    // 优先读取 index.html 内联脚本已注入的全局快照
    const globalSnap = (
      window as Window & { __NANOFLOW_LAUNCH_SNAPSHOT__?: unknown }
    ).__NANOFLOW_LAUNCH_SNAPSHOT__;
    if (globalSnap && typeof globalSnap === 'object' && 'projects' in globalSnap) {
      return globalSnap as LaunchSnapshot;
    }

    // 回退读取 localStorage
    try {
      const raw = localStorage.getItem('nanoflow.launch-snapshot.v2');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && 'projects' in parsed) {
        return parsed as LaunchSnapshot;
      }
    } catch {
      // 损坏的 localStorage 数据，静默忽略
    }

    return null;
  }


  /** 从快照 projects 构建轻量 Project 对象供 Store 预填充 */
  protected buildPrehydrateProjects(snapshotProjects: LaunchSnapshotProject[]): Project[] {
    return buildPrehydrateProjectsPure(snapshotProjects);
  }


  protected applyTrustedPrehydrateSnapshot(snapshot: LaunchSnapshot, trustedSnapshotOwnerId: string): boolean {
    try {
      const projects = this.buildPrehydrateProjects(snapshot.projects);
      if (projects.length === 0) return false;
      this.applyPrehydrateProjects(snapshot, projects, trustedSnapshotOwnerId);
      return true;
    } catch (error) {
      this.logger.warn('快照预填充失败，静默回退到离线快照', error);
      return false;
    }
  }


  /**
   * 从启动快照预填充 Store（使 handoff 不再等待 auth + 数据加载）
   *
   * 【P0 新增 2026-03-27】
   * 冷启动时从 localStorage 中已有的 launch-snapshot 构建轻量 Project 列表，
   * 使 ProjectStore.projects().length > 0 立即成立，
   * 从而解除 handoff 对 auth 完成的阻塞依赖。
   *
   * 仅在 Store 为空时填充（避免覆盖已有真实数据）。
   * 后续 loadUserData() 完成后会用完整数据替换。
   *
   * @returns 是否成功预填充
   */
  prehydrateFromSnapshot(): boolean {
    // Store 已有数据，无需预填充
    if (this.projectState.projects().length > 0) {
      this.markStartupProjectCatalogResolved();
      return true;
    }

    const snapshot = this.readSnapshotForPrehydrate();
    if (snapshot?.projects?.length) {
      const trustedSnapshotOwnerId = this.resolveTrustedSnapshotOwnerId(snapshot);
      if (trustedSnapshotOwnerId) {
        if (this.applyTrustedPrehydrateSnapshot(snapshot, trustedSnapshotOwnerId)) return true;
      } else {
        this.logger.debug('跳过未验证 owner 的启动快照预填充', {
          snapshotUserId: snapshot.userId ?? null,
        });
      }
    }

    if (this.prehydrateFromOfflineSnapshot(snapshot)) {
      return true;
    }

    this.clearStartupProjectCatalogState();
    return false;
  }


  protected createSessionGuard(userId: string | null): SessionGuardContext {
    return {
      userId,
      generation: ++this.sessionRequestGeneration,
    };
  }


  protected captureCurrentSessionGuard(): SessionGuardContext {
    return {
      userId: this.currentUserId(),
      generation: this.sessionRequestGeneration,
    };
  }


  protected invalidateSessionRequestGeneration(reason: string): void {
    this.sessionRequestGeneration += 1;
    this.logger.debug('会话请求代际已失效', {
      reason,
      generation: this.sessionRequestGeneration,
    });
  }


  protected resetProjectHydrationCache(): void {
    this.hydratedProjectIds.clear();
    this.hydrationInFlight.clear();
  }


  protected isSessionGuardCurrent(guard: SessionGuardContext): boolean {
    return this.sessionRequestGeneration === guard.generation
      && this.currentUserId() === guard.userId;
  }


  protected shouldAbortStaleSession(guard: SessionGuardContext | undefined, stage: string): boolean {
    if (!guard) {
      return false;
    }

    if (this.isSessionGuardCurrent(guard)) {
      return false;
    }

    this.logger.debug('忽略过期的会话加载结果', {
      stage,
      expectedUserId: guard.userId,
      currentUserId: this.currentUserId(),
      generation: guard.generation,
      currentGeneration: this.sessionRequestGeneration,
    });
    return true;
  }


  protected shouldAbortStaleSessionGeneration(guard: SessionGuardContext | undefined, stage: string): boolean {
    if (!guard) {
      return false;
    }

    if (this.sessionRequestGeneration === guard.generation) {
      return false;
    }

    this.logger.debug('忽略过期的会话预处理结果', {
      stage,
      expectedUserId: guard.userId,
      currentUserId: this.currentUserId(),
      generation: guard.generation,
      currentGeneration: this.sessionRequestGeneration,
    });
    return true;
  }


  protected redactUserId(userId: string | null): string | null {
    return userId ? userId.substring(0, 8) : null;
  }


  protected formatUnknownError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') {
        return message;
      }
    }

    return String(error);
  }


  protected async isSupabaseSessionCurrentForUser(userId: string, stage: string): Promise<boolean> {
    if (!userId || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      return true;
    }

    try {
      const { data, error } = await this.supabase.getSession();
      if (error) {
        this.logger.warn('Supabase session 未就绪，跳过本轮权威项目访问判定', {
          stage,
          expectedUserId: this.redactUserId(userId),
          error: error.message,
        });
        return false;
      }

      const sessionUserId = data.session?.user?.id ?? null;
      if (sessionUserId !== userId) {
        this.logger.warn('Supabase session 与当前用户不一致，跳过本轮权威项目访问判定', {
          stage,
          expectedUserId: this.redactUserId(userId),
          sessionUserId: this.redactUserId(sessionUserId),
        });
        return false;
      }

      return true;
    } catch (error: unknown) {
      this.logger.warn('读取 Supabase session 失败，跳过本轮权威项目访问判定', {
        stage,
        expectedUserId: this.redactUserId(userId),
        error: this.formatUnknownError(error),
      });
      return false;
    }
  }


  getCurrentSessionGeneration(): number {
    return this.sessionRequestGeneration;
  }


  isSessionContextCurrent(sessionGeneration: number, userId: string | null): boolean {
    return this.sessionRequestGeneration === sessionGeneration
      && this.currentUserId() === userId;
  }


  protected canUseLegacySnapshotOwnerHint(
    hasSnapshotProjects: boolean,
    persistedOwnerHint: string | null,
    expectedOwnerUserId: string,
  ): boolean {
    return this.authService.isConfigured
      && hasSnapshotProjects
      && !!persistedOwnerHint
      && persistedOwnerHint === expectedOwnerUserId;
  }


  protected getOwnerlessSnapshotProjectsForSession(
    snapshot: { projects: Project[] },
    expectedOwnerUserId: string,
    stage: string,
  ): { projects: Project[]; ownerMatched: boolean } {
    const persistedOwnerHint = this.authService.peekPersistedOwnerHint() ?? null;
    if (this.canUseLegacySnapshotOwnerHint(snapshot.projects.length > 0, persistedOwnerHint, expectedOwnerUserId)) {
      this.logger.debug('缺少 owner 元数据的快照通过 persisted hint 匹配，允许恢复', {
        stage,
        expectedOwnerUserId,
        persistedOwnerHint,
        projectCount: snapshot.projects.length,
      });
      return { projects: snapshot.projects, ownerMatched: true };
    }

    if (snapshot.projects.length > 0) {
      this.logger.warn('检测到缺少 owner 元数据的离线快照，已忽略本次恢复', {
        stage,
        expectedOwnerUserId,
      });
    }

    return { projects: [], ownerMatched: false };
  }


  protected canUsePersistedSnapshotOwnerHint(snapshotOwnerUserId: string, persistedOwnerHint: string | null): boolean {
    // 降级会话场景：Supabase 已配置但会话过期/网络不可达时，
    // expectedUserId 为 null → 'local-user'，而快照 owner 是真实用户 ID。
    // 通过 persisted owner hint 匹配，避免同一设备用户看到空工作区。
    return this.authService.isConfigured
      && !!persistedOwnerHint
      && snapshotOwnerUserId === persistedOwnerHint;
  }


  protected getMismatchedOwnerSnapshotProjectsForSession(
    snapshot: { ownerUserId: string; projects: Project[] },
    expectedOwnerUserId: string,
    stage: string,
  ): { projects: Project[]; ownerMatched: boolean } {
    const persistedOwnerHint = this.authService.peekPersistedOwnerHint() ?? null;
    if (this.canUsePersistedSnapshotOwnerHint(snapshot.ownerUserId, persistedOwnerHint)) {
      this.logger.debug('owner 通过 persisted hint 匹配，允许恢复离线快照', {
        stage,
        snapshotOwnerUserId: snapshot.ownerUserId,
        persistedOwnerHint,
      });
      return { projects: snapshot.projects, ownerMatched: true };
    }

    if (snapshot.projects.length > 0) {
      this.logger.warn('检测到 owner 不匹配的离线快照，已忽略本次恢复', {
        stage,
        snapshotOwnerUserId: snapshot.ownerUserId,
        expectedOwnerUserId,
      });
    }

    return { projects: [], ownerMatched: false };
  }
}
