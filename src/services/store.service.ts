import { Injectable, signal, computed, inject, DestroyRef } from '@angular/core';
import { AuthService } from './auth.service';
import { SyncService } from './sync.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { UiStateService } from './ui-state.service';
import { ActionQueueService } from './action-queue.service';
import { 
  Task, Project, Connection, UnfinishedItem, ThemeType 
} from '../models';
import { 
  LAYOUT_CONFIG, SYNC_CONFIG, CACHE_CONFIG, LETTERS, SUPERSCRIPT_DIGITS 
} from '../config/constants';
import { 
  validateProject, sanitizeProject, detectCycles, detectOrphans 
} from '../utils/validation';
import {
  Result, OperationError, ErrorCodes, success, failure, getErrorMessage
} from '../utils/result';

/** 回收站自动清理配置 */
const TRASH_CONFIG = {
  /** 自动清理天数 */
  AUTO_CLEANUP_DAYS: 30,
  /** 清理检查间隔（毫秒） */
  CLEANUP_INTERVAL: 60 * 60 * 1000 // 1小时
} as const;

@Injectable({
  providedIn: 'root'
})
export class StoreService {
  private authService = inject(AuthService);
  private syncService = inject(SyncService);
  private undoService = inject(UndoService);
  private toastService = inject(ToastService);
  private layoutService = inject(LayoutService);
  private uiState = inject(UiStateService);
  private actionQueue = inject(ActionQueueService);
  private destroyRef = inject(DestroyRef);
  
  // ========== 代理访问其他服务的状态 ==========
  
  /** 当前用户 ID */
  readonly currentUserId = this.authService.currentUserId;
  
  /** 是否正在同步 */
  readonly isSyncing = computed(() => this.syncService.syncState().isSyncing);
  
  /** 是否在线 */
  readonly isOnline = computed(() => this.syncService.syncState().isOnline);
  
  /** 离线模式 */
  readonly offlineMode = computed(() => this.syncService.syncState().offlineMode);
  
  /** 会话是否过期 */
  readonly sessionExpired = computed(() => this.syncService.syncState().sessionExpired);
  
  /** 同步错误 */
  readonly syncError = computed(() => this.syncService.syncState().syncError);
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.syncService.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.syncService.syncState().conflictData);
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = this.syncService.isLoadingRemote;
  
  /** 是否可以撤销 */
  readonly canUndo = this.undoService.canUndo;
  
  /** 是否可以重做 */
  readonly canRedo = this.undoService.canRedo;
  
  /** 待处理的离线操作数量 */
  readonly pendingActionsCount = this.actionQueue.queueSize;
  
  // ========== UI 状态 (代理到 UiStateService) ==========
  
  readonly isMobile = this.uiState.isMobile;
  readonly sidebarWidth = this.uiState.sidebarWidth;
  readonly textColumnRatio = this.uiState.textColumnRatio;
  readonly layoutDirection = this.uiState.layoutDirection;
  readonly floatingWindowPref = this.uiState.floatingWindowPref;
  readonly theme = this.uiState.theme;
  readonly isTextUnfinishedOpen = this.uiState.isTextUnfinishedOpen;
  readonly isTextUnassignedOpen = this.uiState.isTextUnassignedOpen;
  readonly isFlowUnfinishedOpen = this.uiState.isFlowUnfinishedOpen;
  readonly isFlowUnassignedOpen = this.uiState.isFlowUnassignedOpen;
  readonly isFlowDetailOpen = this.uiState.isFlowDetailOpen;
  
  readonly searchQuery = signal<string>('');
  
  // ========== 核心数据状态 ==========
  
  readonly projects = signal<Project[]>([]);
  readonly activeProjectId = signal<string | null>(null);
  readonly activeView = signal<'text' | 'flow' | null>('text');
  readonly filterMode = signal<'all' | string>('all');
  readonly stageViewRootFilter = signal<'all' | string>('all');
  readonly stageFilter = signal<'all' | number>('all');
  
  // ========== 私有状态 ==========
  
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private hasPendingLocalChanges = false;
  private lastPersistAt = 0;
  private isEditing = false;
  private editingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateType: 'content' | 'structure' | 'position' = 'structure';
  
  /** 重平衡锁定的阶段 */
  private rebalancingStages = new Set<number>();
  
  /** 回收站清理定时器 */
  private trashCleanupTimer: ReturnType<typeof setInterval> | null = null;
  
  // ========== 冲突处理回调 ==========
  
  /** 冲突回调函数，由 AppComponent 设置 */
  onConflict: ((localProject: Project, remoteProject: any, projectId: string) => void) | null = null;

  // ========== 计算属性 ==========

  readonly activeProject = computed(() => 
    this.projects().find(p => p.id === this.activeProjectId()) || null
  );

  readonly tasks = computed(() => this.activeProject()?.tasks || []);

  readonly stages = computed(() => {
    const tasks = this.tasks();
    const assigned = tasks.filter(t => t.stage !== null);
    const stagesMap = new Map<number, Task[]>();
    assigned.forEach(t => {
      if (!stagesMap.has(t.stage!)) stagesMap.set(t.stage!, []);
      stagesMap.get(t.stage!)!.push(t);
    });
    
    for (const [, val] of stagesMap.entries()) {
      val.sort((a, b) => a.order - b.order);
    }
    
    const sortedKeys = Array.from(stagesMap.keys()).sort((a, b) => a - b);
    return sortedKeys.map(k => ({
      stageNumber: k,
      tasks: stagesMap.get(k)!
    }));
  });

  readonly unassignedTasks = computed(() => {
    return this.tasks().filter(t => t.stage === null && !t.deletedAt);
  });

  /** 已删除（回收站）中的任务 */
  readonly deletedTasks = computed(() => {
    return this.tasks().filter(t => t.deletedAt);
  });

  readonly unfinishedItems = computed<UnfinishedItem[]>(() => {
    const items: UnfinishedItem[] = [];
    const tasks = this.tasks();
    const filter = this.filterMode();
    
    let rootDisplayId = '';
    if (filter !== 'all') {
      const root = tasks.find(r => r.id === filter);
      if (root) rootDisplayId = root.displayId;
    }

    // 支持 - 和 * 作为列表标记
    const todoRegex = /[-*]\s*\[ \]\s*(.+)/g;
    // 用于移除代码块的正则
    const codeBlockRegex = /```[\s\S]*?```/g;

    tasks.forEach(t => {
      if (rootDisplayId) {
        const isDescendant = t.displayId === rootDisplayId || t.displayId.startsWith(rootDisplayId + ',');
        if (!isDescendant) return;
      }

      // 先移除代码块内容，避免误判
      const contentWithoutCodeBlocks = t.content.replace(codeBlockRegex, '');
      
      let match;
      while ((match = todoRegex.exec(contentWithoutCodeBlocks)) !== null) {
        items.push({
          taskId: t.id,
          taskDisplayId: t.displayId,
          text: match[1].trim()
        });
      }
    });
    return items;
  });
  
  readonly searchResults = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    if (!query) return [];
    
    return this.tasks().filter(t => 
      t.title.toLowerCase().includes(query) ||
      t.content.toLowerCase().includes(query) ||
      t.displayId.toLowerCase().includes(query)
    );
  });

  readonly rootTasks = computed(() => {
    const tasks = this.tasks();
    const regex = /- \[ \]/;
    const tasksWithUnfinished = tasks.filter(t => regex.test(t.content || ''));
    
    return tasks.filter(t => t.stage === 1).filter(root => {
      if (tasksWithUnfinished.some(u => u.id === root.id)) return true;
      return tasksWithUnfinished.some(u => u.displayId.startsWith(root.displayId + ','));
    });
  });

  readonly allStage1Tasks = computed(() => {
    return this.tasks().filter(t => t.stage === 1).sort((a, b) => a.rank - b.rank);
  });

  constructor() {
    this.loadFromCacheOrSeed();
    this.setupActionQueueProcessors();
    this.startTrashCleanupTimer();
    
    // 设置远程变更回调 - 使用增量更新而非全量重载
    this.syncService.setRemoteChangeCallback(async (payload?: any) => {
      if (this.isEditing || this.hasPendingLocalChanges || Date.now() - this.lastPersistAt < 800) {
        return;
      }
      
      // 尝试增量更新
      if (payload?.eventType && payload?.projectId) {
        await this.handleIncrementalUpdate(payload);
      } else {
        // 回退到全量加载
        await this.loadProjects();
      }
    });
    
    // 清理
    this.destroyRef.onDestroy(() => {
      if (this.persistTimer) clearTimeout(this.persistTimer);
      if (this.editingTimer) clearTimeout(this.editingTimer);
      if (this.rebalanceTimer) clearTimeout(this.rebalanceTimer);
      if (this.trashCleanupTimer) clearInterval(this.trashCleanupTimer);
      this.syncService.destroy();
    });
  }

  /**
   * 设置离线操作队列处理器
   */
  private setupActionQueueProcessors() {
    // 项目更新处理器
    this.actionQueue.registerProcessor('project:update', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      const project = action.payload as Project;
      const result = await this.syncService.saveProjectToCloud(project, userId);
      return result.success;
    });
    
    // 项目删除处理器
    this.actionQueue.registerProcessor('project:delete', async (action) => {
      const userId = this.currentUserId();
      if (!userId) return false;
      
      return await this.syncService.deleteProjectFromCloud(action.entityId, userId);
    });
  }

  /**
   * 启动回收站自动清理定时器
   */
  private startTrashCleanupTimer() {
    // 启动时立即执行一次清理
    this.cleanupOldTrashItems();
    
    // 定期检查
    this.trashCleanupTimer = setInterval(() => {
      this.cleanupOldTrashItems();
    }, TRASH_CONFIG.CLEANUP_INTERVAL);
  }

  /**
   * 清理超过保留期限的回收站项目
   */
  private cleanupOldTrashItems() {
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - TRASH_CONFIG.AUTO_CLEANUP_DAYS * 24 * 60 * 60 * 1000);
    
    let cleanedCount = 0;
    
    this.projects.update(projects => projects.map(project => {
      const tasksToKeep = project.tasks.filter(task => {
        if (!task.deletedAt) return true;
        
        const deletedDate = new Date(task.deletedAt);
        if (deletedDate < cutoffDate) {
          cleanedCount++;
          return false; // 移除超期的已删除任务
        }
        return true;
      });
      
      if (tasksToKeep.length !== project.tasks.length) {
        return { ...project, tasks: tasksToKeep };
      }
      return project;
    }));
    
    if (cleanedCount > 0) {
      console.log(`自动清理了 ${cleanedCount} 个超过 ${TRASH_CONFIG.AUTO_CLEANUP_DAYS} 天的回收站任务`);
      this.schedulePersist();
    }
  }

  /**
   * 检查指定阶段是否正在重平衡
   */
  isStageRebalancing(stage: number): boolean {
    return this.rebalancingStages.has(stage);
  }

  /**
   * 处理增量更新（而非全量重载）
   */
  private async handleIncrementalUpdate(payload: { eventType: string; projectId: string; data?: any }) {
    const { eventType, projectId, data } = payload;
    
    if (eventType === 'DELETE') {
      // 项目被删除
      this.projects.update(ps => ps.filter(p => p.id !== projectId));
      if (this.activeProjectId() === projectId) {
        const remaining = this.projects();
        this.activeProjectId.set(remaining[0]?.id ?? null);
      }
      return;
    }
    
    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      const userId = this.currentUserId();
      if (!userId) return;
      
      // 只加载变更的单个项目
      const remoteProject = await this.syncService.loadSingleProject(projectId, userId);
      if (!remoteProject) return;
      
      const localProject = this.projects().find(p => p.id === projectId);
      
      if (!localProject) {
        // 新项目，直接添加
        const validated = this.validateAndRebalance(remoteProject);
        this.projects.update(ps => [...ps, validated]);
      } else {
        // 更新现有项目 - 检查版本号
        const localVersion = localProject.version ?? 0;
        const remoteVersion = remoteProject.version ?? 0;
        
        if (remoteVersion > localVersion) {
          // 远程版本更新，合并或替换
          const merged = this.mergeProjects(localProject, remoteProject);
          const validated = this.validateAndRebalance(merged);
          this.projects.update(ps => ps.map(p => p.id === projectId ? validated : p));
        }
      }
    }
  }

  // ========== 公共方法 ==========

  /**
   * 压缩 displayId 显示
   */
  compressDisplayId(displayId: string): string {
    if (!displayId || displayId === '?') return displayId;
    
    const parts = displayId.split(',');
    const result: string[] = [];
    let i = 0;
    
    while (i < parts.length) {
      const current = parts[i];
      let count = 1;
      
      while (i + count < parts.length && parts[i + count] === current) {
        count++;
      }
      
      if (count >= 5) {
        const superscript = String(count).split('').map(d => SUPERSCRIPT_DIGITS[d]).join('');
        result.push(current + superscript);
      } else {
        for (let j = 0; j < count; j++) {
          result.push(current);
        }
      }
      
      i += count;
    }
    
    return result.join(',');
  }

  /**
   * 设置当前用户（登录/登出时调用）
   */
  async setCurrentUser(userId: string | null) {
    if (this.currentUserId() === userId) return;
    
    this.authService.currentUserId.set(userId);
    this.activeProjectId.set(null);
    this.projects.set([]);
    this.undoService.clearHistory();
    this.syncService.teardownRealtimeSubscription();
    
    if (userId && this.syncService) {
      await this.loadProjects();
      await this.loadUserPreferences();
      await this.syncService.initRealtimeSubscription(userId);
    } else {
      this.loadFromCacheOrSeed();
      this.loadLocalPreferences();
    }
  }

  /**
   * 执行撤销
   * 在撤销前检查版本号，处理远程更新冲突
   */
  undo() {
    const action = this.undoService.undo();
    if (!action) return;
    
    const project = this.projects().find(p => p.id === action.projectId);
    if (project) {
      const localVersion = project.version ?? 0;
      const snapshotVersion = (action.data.before as any)?.version ?? 0;
      
      // 如果当前版本已超过快照版本太多，可能已有远程更新
      // 仍然执行撤销，但记录日志
      if (localVersion > snapshotVersion + 1) {
        console.warn('Undo 可能覆盖远程更新', { localVersion, snapshotVersion });
        this.toastService.warning('注意', '撤销可能会覆盖其他设备的更新');
      }
    }
    
    // 应用撤销前的状态
    this.applyProjectSnapshot(action.projectId, action.data.before);
  }

  /**
   * 执行重做
   */
  redo() {
    const action = this.undoService.redo();
    if (!action) return;
    
    // 应用重做后的状态
    this.applyProjectSnapshot(action.projectId, action.data.after);
  }

  /**
   * 加载项目
   */
  async loadProjects() {
    const userId = this.currentUserId();
    if (!userId) {
      this.loadFromCacheOrSeed();
      return;
    }
    
    const previousActive = this.activeProjectId();
    const projects = await this.syncService.loadProjectsFromCloud(userId);
    
    if (projects.length > 0) {
      // 验证并重平衡每个项目
      const rebalanced = projects.map(p => this.validateAndRebalance(p));
      this.projects.set(rebalanced);
      
      if (previousActive && rebalanced.some(p => p.id === previousActive)) {
        this.activeProjectId.set(previousActive);
      } else {
        this.activeProjectId.set(rebalanced[0]?.id ?? null);
      }
      
      this.syncService.saveOfflineSnapshot(rebalanced);
    } else if (this.syncService.syncState().offlineMode) {
      this.loadFromCacheOrSeed();
      // 显示离线模式提示
      this.toastService.warning('离线模式', '网络不可用，数据仅保存在本地');
    }
    
    // 检查同步错误
    const syncError = this.syncService.syncState().syncError;
    if (syncError) {
      this.toastService.error('同步失败', syncError);
    }
  }

  /**
   * 验证并重平衡项目数据
   * 包括数据完整性检查、循环检测、孤儿修复
   */
  private validateAndRebalance(project: Project): Project {
    // 1. 数据验证
    const validation = validateProject(project);
    if (!validation.valid) {
      console.warn('项目数据验证失败', { projectId: project.id, errors: validation.errors });
      // 尝试清理数据
      project = sanitizeProject(project);
    }
    if (validation.warnings.length > 0) {
      console.warn('项目数据警告', { projectId: project.id, warnings: validation.warnings });
    }
    
    // 2. 使用 LayoutService 进行完整性检查和修复
    const { project: fixedProject, issues } = this.layoutService.validateAndFixTree(project);
    if (issues.length > 0) {
      console.log('已修复数据问题', { projectId: project.id, issues });
    }
    
    // 3. 重平衡
    return this.layoutService.rebalance(fixedProject);
  }

  /**
   * 清空本地数据
   */
  clearLocalData() {
    this.projects.set([]);
    this.activeProjectId.set(null);
    this.searchQuery.set('');
    this.filterMode.set('all');
    this.stageViewRootFilter.set('all');
    this.stageFilter.set('all');
    this.undoService.clearHistory();
    this.syncService.clearOfflineCache();
  }

  /**
   * 解决数据冲突
   * 解决后自动触发强制同步，确保数据一致性
   */
  async resolveConflict(projectId: string, choice: 'local' | 'remote' | 'merge') {
    const conflictData = this.conflictData();
    if (!conflictData || conflictData.projectId !== projectId) return;
    
    let projectToSync: Project | null = null;
    
    if (choice === 'local') {
      // 使用本地版本，强制推送到云端
      const project = this.projects().find(p => p.id === projectId);
      if (project) {
        // 递增版本号以覆盖远程版本
        const updatedProject = { ...project, version: (project.version ?? 0) + 1 };
        this.projects.update(ps => ps.map(p => 
          p.id === projectId ? updatedProject : p
        ));
        this.syncService.resolveConflict(projectId, updatedProject, 'local');
        projectToSync = updatedProject;
      }
    } else if (choice === 'remote') {
      // 使用远程版本，更新本地数据
      const remoteProject = conflictData.remoteData as Project;
      if (remoteProject) {
        const validated = this.validateAndRebalance(remoteProject);
        this.projects.update(ps => ps.map(p => 
          p.id === projectId ? { ...validated, id: projectId } : p
        ));
        this.syncService.resolveConflict(projectId, validated, 'remote');
        // 远程版本不需要再同步，但需要更新本地缓存
        this.syncService.saveOfflineSnapshot(this.projects());
      }
    } else if (choice === 'merge') {
      // 智能合并：保留双方的新增内容，冲突时使用较新的版本
      const localProject = this.projects().find(p => p.id === projectId);
      const remoteProject = conflictData.remoteData as Project;
      
      if (localProject && remoteProject) {
        const mergedProject = this.mergeProjects(localProject, remoteProject);
        // 使用更高的版本号确保合并结果能覆盖远程
        mergedProject.version = Math.max(localProject.version ?? 0, remoteProject.version ?? 0) + 1;
        this.projects.update(ps => ps.map(p => 
          p.id === projectId ? mergedProject : p
        ));
        this.syncService.resolveConflict(projectId, mergedProject, 'local');
        projectToSync = mergedProject;
      }
    }
    
    // 强制同步解决后的数据
    if (projectToSync) {
      const userId = this.currentUserId();
      if (userId) {
        try {
          const result = await this.syncService.saveProjectToCloud(projectToSync, userId);
          if (!result.success && !result.conflict) {
            // 同步失败，加入重试队列
            this.actionQueue.enqueue({
              type: 'update',
              entityType: 'project',
              entityId: projectId,
              payload: projectToSync
            });
            this.toastService.warning('同步待重试', '冲突已解决，但同步失败，稍后将自动重试');
          } else if (result.conflict) {
            // 又发生冲突，提示用户
            this.toastService.error('同步冲突', '解决冲突后又发生新冲突，请稍后重试');
          }
        } catch (e) {
          console.error('冲突解决后同步失败', e);
          this.actionQueue.enqueue({
            type: 'update',
            entityType: 'project',
            entityId: projectId,
            payload: projectToSync
          });
        }
      }
      this.syncService.saveOfflineSnapshot(this.projects());
    }
  }
  
  /**
   * 智能合并两个项目
   * 合并后执行完整性检查，修复潜在的循环依赖和孤儿节点
   * 
   * 冲突解决策略：
   * 1. 使用版本号（优先）判断优先级
   * 2. 对于相同版本的任务，使用 updatedAt 时间戳（服务端维护）
   * 3. 新增任务直接保留
   */
  private mergeProjects(local: Project, remote: Project): Project {
    // 创建任务映射
    const localTaskMap = new Map(local.tasks.map(t => [t.id, t]));
    const remoteTaskMap = new Map(remote.tasks.map(t => [t.id, t]));
    
    const mergedTasks: Task[] = [];
    const processedIds = new Set<string>();
    
    // 处理本地任务
    for (const localTask of local.tasks) {
      processedIds.add(localTask.id);
      const remoteTask = remoteTaskMap.get(localTask.id);
      
      if (!remoteTask) {
        // 本地新增的任务，保留
        mergedTasks.push(localTask);
      } else {
        // 双方都有的任务，比较内容是否有差异
        const hasContentDiff = localTask.title !== remoteTask.title || 
                               localTask.content !== remoteTask.content ||
                               localTask.status !== remoteTask.status;
        
        if (hasContentDiff) {
          // 有内容差异时，优先使用本地版本
          // 因为本地是用户最新编辑的，远程冲突已通过版本号检测
          // 如果远程版本号更高，这个方法不会被调用（会先提示冲突）
          mergedTasks.push(localTask);
        } else {
          // 无内容差异，保留本地版本（可能有位置等其他属性更新）
          mergedTasks.push(localTask);
        }
      }
    }
    
    // 处理远程新增的任务
    for (const remoteTask of remote.tasks) {
      if (!processedIds.has(remoteTask.id)) {
        mergedTasks.push(remoteTask);
      }
    }
    
    // 合并 connections
    const localConnSet = new Set(local.connections.map(c => `${c.source}->${c.target}`));
    const mergedConnections = [...local.connections];
    for (const conn of remote.connections) {
      const key = `${conn.source}->${conn.target}`;
      if (!localConnSet.has(key)) {
        mergedConnections.push(conn);
      }
    }
    
    // 构建合并后的项目
    const mergedProject: Project = {
      ...local,
      tasks: mergedTasks,
      connections: mergedConnections,
      updatedAt: new Date().toISOString(),
      // 使用较大的版本号
      version: Math.max(local.version ?? 0, remote.version ?? 0)
    };
    
    // 合并后执行完整性检查
    const { project: validatedProject, issues } = this.layoutService.validateAndFixTree(mergedProject);
    if (issues.length > 0) {
      console.log('合并后修复数据问题', { issues });
      this.toastService.info('数据同步', `已自动修复 ${issues.length} 个数据问题`);
    }
    
    return validatedProject;
  }

  // ========== 项目操作 ==========

  addProject(project: Project) {
    const balanced = this.layoutService.rebalance(project);
    this.projects.update(p => [...p, balanced]);
    this.activeProjectId.set(balanced.id);
    this.schedulePersist();
  }

  async deleteProject(projectId: string) {
    const userId = this.currentUserId();
    
    this.projects.update(p => p.filter(proj => proj.id !== projectId));
    
    if (this.activeProjectId() === projectId) {
      const remaining = this.projects();
      this.activeProjectId.set(remaining[0]?.id ?? null);
    }
    
    if (userId) {
      const success = await this.syncService.deleteProjectFromCloud(projectId, userId);
      
      // 如果删除失败（可能是网络问题），加入重试队列
      if (!success && !this.isOnline()) {
        this.actionQueue.enqueue({
          type: 'delete',
          entityType: 'project',
          entityId: projectId,
          payload: { projectId, userId }
        });
        this.toastService.info('离线删除', '项目将在网络恢复后同步删除');
      }
    }
    
    this.syncService.saveOfflineSnapshot(this.projects());
  }

  updateProjectMetadata(projectId: string, metadata: { description?: string; createdDate?: string }) {
    this.projects.update(projects => projects.map(p => p.id === projectId ? {
      ...p,
      description: metadata.description ?? p.description,
      createdDate: metadata.createdDate ?? p.createdDate
    } : p));
    if (this.activeProjectId() === projectId) {
      this.schedulePersist();
    }
  }

  /**
   * 更新项目的流程图视图状态（缩放、位置）
   */
  updateViewState(projectId: string, viewState: { scale?: number; positionX?: number; positionY?: number }) {
    this.projects.update(projects => projects.map(p => {
      if (p.id === projectId) {
        return {
          ...p,
          viewState: {
            scale: viewState.scale ?? p.viewState?.scale ?? 1,
            positionX: viewState.positionX ?? p.viewState?.positionX ?? 0,
            positionY: viewState.positionY ?? p.viewState?.positionY ?? 0
          }
        };
      }
      return p;
    }));
    // 视图状态更新不需要立即同步，使用延迟
    this.schedulePersist();
  }

  /**
   * 获取当前项目的视图状态
   */
  getViewState(): { scale: number; positionX: number; positionY: number } | null {
    const project = this.activeProject();
    if (!project?.viewState) return null;
    return project.viewState;
  }

  // ========== 任务操作 ==========

  updateTaskContent(taskId: string, newContent: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    // 使用防抖记录，避免每个字符都产生撤销记录
    this.recordAndUpdateDebounced(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, content: newContent } : t)
    }));
  }
  
  markEditing() {
    this.isEditing = true;
    this.hasPendingLocalChanges = true;
    
    if (this.editingTimer) {
      clearTimeout(this.editingTimer);
    }
    
    this.editingTimer = setTimeout(() => {
      this.isEditing = false;
      this.editingTimer = null;
    }, SYNC_CONFIG.EDITING_TIMEOUT);
  }
  
  get isUserEditing(): boolean {
    return this.isEditing || this.hasPendingLocalChanges;
  }

  addTodoItem(taskId: string, itemText: string) {
    const task = this.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const trimmedText = itemText.trim();
    if (!trimmedText) return;
    
    const todoLine = `- [ ] ${trimmedText}`;
    let newContent = task.content || '';
    
    if (newContent && !newContent.endsWith('\n')) {
      newContent += '\n';
    }
    newContent += todoLine;
    
    this.markEditing();
    this.updateTaskContent(taskId, newContent);
  }
  
  completeUnfinishedItem(taskId: string, itemText: string) {
    const task = this.tasks().find(t => t.id === taskId);
    if (!task) return;
    
    const escapedText = itemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`- \\[ \\]\\s*${escapedText}`);
    const newContent = task.content.replace(regex, `- [x] ${itemText}`);
    
    if (newContent !== task.content) {
      this.updateTaskContent(taskId, newContent);
    }
  }

  updateTaskTitle(taskId: string, title: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    // 使用防抖记录，避免每个字符都产生撤销记录
    this.recordAndUpdateDebounced(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, title } : t)
    }));
  }

  updateTaskPosition(taskId: string, x: number, y: number) {
    this.lastUpdateType = 'position';
    this.updateActiveProject(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y } : t)
    }));
  }
  
  /**
   * 更新任务位置并同步 Rank
   * 当用户在流程图中拖动节点时，根据 Y 坐标重新计算任务的 rank
   * 以保持文本视图和流程图的排序一致性
   */
  updateTaskPositionWithRankSync(taskId: string, x: number, y: number) {
    const project = this.activeProject();
    if (!project) return;
    
    const task = project.tasks.find(t => t.id === taskId);
    if (!task || task.stage === null) {
      // 未分配阶段的任务不需要 rank 同步
      this.updateTaskPosition(taskId, x, y);
      return;
    }
    
    // 获取同一阶段的所有任务（排除自身）
    const stageTasks = project.tasks
      .filter(t => t.stage === task.stage && t.id !== taskId && !t.deletedAt)
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    
    // 根据新的 Y 坐标计算新的 rank
    let newRank: number;
    const RANK_STEP = 500; // LAYOUT_CONFIG.RANK_STEP
    
    if (stageTasks.length === 0) {
      // 该阶段只有这一个任务
      newRank = task.rank;
    } else {
      // 找到应该插入的位置
      const insertIndex = stageTasks.findIndex(t => (t.y ?? 0) > y);
      
      if (insertIndex === -1) {
        // 在所有任务下方
        const lastTask = stageTasks[stageTasks.length - 1];
        newRank = lastTask.rank + RANK_STEP;
      } else if (insertIndex === 0) {
        // 在所有任务上方
        const firstTask = stageTasks[0];
        newRank = firstTask.rank - RANK_STEP;
      } else {
        // 在两个任务之间
        const prevTask = stageTasks[insertIndex - 1];
        const nextTask = stageTasks[insertIndex];
        newRank = (prevTask.rank + nextTask.rank) / 2;
        
        // 如果间隔太小，触发重平衡
        if (Math.abs(prevTask.rank - newRank) < 50) {
          this.lastUpdateType = 'structure';
          this.recordAndUpdate(p => this.layoutService.rebalance({
            ...p,
            tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
          }));
          return;
        }
      }
    }
    
    // 只更新位置和 rank，不触发完整的 rebalance
    this.lastUpdateType = 'position';
    this.updateActiveProject(p => ({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, x, y, rank: newRank } : t)
    }));
  }
  
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.lastUpdateType;
  }

  updateTaskStatus(taskId: string, status: Task['status']) {
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, status } : t)
    }));
  }

  /**
   * 软删除任务（移动到回收站）
   * 任务及其子任务都会被标记为已删除
   * 同时清理所有指向这些任务或从这些任务发出的连接
   */
  deleteTask(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const idsToDelete = new Set<string>();
    // 使用迭代而非递归收集所有后代
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToDelete.has(id)) continue;
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    const now = new Date().toISOString();
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => idsToDelete.has(t.id) ? { ...t, deletedAt: now, stage: null } : t),
      // 清理所有涉及被删除任务的连接（包括父子连接和跨树连接）
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
  }

  /**
   * 永久删除任务（从回收站中删除）
   * 同时清理所有指向这些任务或从这些任务发出的连接
   */
  permanentlyDeleteTask(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const idsToDelete = new Set<string>();
    // 使用迭代而非递归收集所有后代
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToDelete.has(id)) continue;
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      // 清理所有涉及被删除任务的连接
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
  }

  /**
   * 从回收站恢复任务
   * 同时恢复所有子任务
   */
  restoreTask(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    // 收集所有需要恢复的任务（包括子任务）
    const idsToRestore = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (idsToRestore.has(id)) continue;
      idsToRestore.add(id);
      // 查找所有子任务
      activeP.tasks.filter(t => t.parentId === id).forEach(child => stack.push(child.id));
    }
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.map(t => idsToRestore.has(t.id) ? { ...t, deletedAt: null } : t)
    }));
  }

  /**
   * 清空回收站
   */
  emptyTrash() {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const deletedIds = new Set(activeP.tasks.filter(t => t.deletedAt).map(t => t.id));
    
    this.recordAndUpdate(p => this.layoutService.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !t.deletedAt),
      connections: p.connections.filter(c => !deletedIds.has(c.source) && !deletedIds.has(c.target))
    }));
  }

  addTask(
    title: string, 
    content: string, 
    targetStage: number | null, 
    parentId: string | null, 
    isSibling: boolean
  ): Result<string, OperationError> {
    const activeP = this.activeProject();
    if (!activeP) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '没有活动项目');
    }
    
    // 检查目标阶段是否正在重平衡
    if (targetStage !== null && this.isStageRebalancing(targetStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }

    const stageTasks = activeP.tasks.filter(t => t.stage === targetStage);
    const newOrder = stageTasks.length + 1;
    const pos = targetStage !== null 
      ? this.gridPosition(targetStage, newOrder - 1) 
      : this.layoutService.getUnassignedPosition(activeP.tasks.filter(t => t.stage === null).length);
    const parent = parentId ? activeP.tasks.find(t => t.id === parentId) : null;
    const candidateRank = targetStage === null
      ? LAYOUT_CONFIG.RANK_ROOT_BASE + activeP.tasks.filter(t => t.stage === null).length * LAYOUT_CONFIG.RANK_STEP
      : this.computeInsertRank(targetStage, stageTasks, null, parent?.rank ?? null);

    const newTaskId = crypto.randomUUID();
    const newTask: Task = {
      id: newTaskId,
      title,
      content,
      stage: targetStage,
      parentId: targetStage === null ? null : parentId,
      order: newOrder,
      rank: candidateRank,
      status: 'active',
      x: pos.x, 
      y: pos.y,
      createdDate: new Date().toISOString(),
      displayId: '?',
      shortId: this.generateShortId(activeP.tasks), // 生成永久短 ID
      hasIncompleteTask: this.detectIncomplete(content)
    };

    const placed = this.applyRefusalStrategy(newTask, candidateRank, parent?.rank ?? null, Infinity);
    if (!placed.ok) {
      return failure(
        ErrorCodes.LAYOUT_NO_SPACE, 
        '无法在该位置放置任务，区域可能已满或存在冲突',
        { stage: targetStage, parentId }
      );
    }
    newTask.rank = placed.rank;

    if (targetStage === null) {
      this.recordAndUpdate(p => ({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    } else {
      this.recordAndUpdate(p => this.layoutService.rebalance({
        ...p,
        tasks: [...p.tasks, newTask],
        connections: parentId ? [...p.connections, { source: parentId, target: newTask.id }] : [...p.connections]
      }));
    }
    
    return success(newTaskId);
  }

  addCrossTreeConnection(sourceId: string, targetId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const exists = activeP.connections.some(
      c => c.source === sourceId && c.target === targetId
    );
    if (exists) return;
    
    const sourceTask = activeP.tasks.find(t => t.id === sourceId);
    const targetTask = activeP.tasks.find(t => t.id === targetId);
    if (!sourceTask || !targetTask) return;
    
    if (sourceId === targetId) return;
    
    this.recordAndUpdate(p => ({
      ...p,
      connections: [...p.connections, { source: sourceId, target: targetId }]
    }));
  }

  removeConnection(sourceId: string, targetId: string) {
    this.recordAndUpdate(p => ({
      ...p,
      connections: p.connections.filter(
        c => !(c.source === sourceId && c.target === targetId)
      )
    }));
  }

  updateConnectionDescription(sourceId: string, targetId: string, description: string) {
    this.markEditing();
    this.updateActiveProject(p => ({
      ...p,
      connections: p.connections.map(c => 
        (c.source === sourceId && c.target === targetId) 
          ? { ...c, description } 
          : c
      )
    }));
  }

  getTaskConnections(taskId: string): { 
    outgoing: { targetId: string; targetTask: Task | undefined; description?: string }[];
    incoming: { sourceId: string; sourceTask: Task | undefined; description?: string }[];
  } {
    const project = this.activeProject();
    if (!project) return { outgoing: [], incoming: [] };
    
    const tasks = project.tasks;
    const connections = project.connections;
    
    const parentChildPairs = new Set<string>();
    tasks.filter(t => t.parentId).forEach(t => {
      parentChildPairs.add(`${t.parentId}->${t.id}`);
    });
    
    const outgoing = connections
      .filter(c => c.source === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        targetId: c.target,
        targetTask: tasks.find(t => t.id === c.target),
        description: c.description
      }));
    
    const incoming = connections
      .filter(c => c.target === taskId && !parentChildPairs.has(`${c.source}->${c.target}`))
      .map(c => ({
        sourceId: c.source,
        sourceTask: tasks.find(t => t.id === c.source),
        description: c.description
      }));
    
    return { outgoing, incoming };
  }

  addFloatingTask(title: string, content: string, x: number, y: number) {
    const activeP = this.activeProject();
    if (!activeP) return;
    const count = activeP.tasks.filter(t => t.stage === null).length;
    const rank = LAYOUT_CONFIG.RANK_ROOT_BASE + count * LAYOUT_CONFIG.RANK_STEP;
    const newTask: Task = {
      id: crypto.randomUUID(),
      title,
      content,
      stage: null,
      parentId: null,
      order: count + 1,
      rank,
      status: 'active',
      x,
      y,
      createdDate: new Date().toISOString(),
      displayId: '?',
      hasIncompleteTask: this.detectIncomplete(content)
    };

    this.recordAndUpdate(p => ({
      ...p,
      tasks: [...p.tasks, newTask]
    }));
  }
  
  moveTaskToStage(
    taskId: string, 
    newStage: number | null, 
    beforeTaskId?: string | null, 
    newParentId?: string | null
  ): Result<void, OperationError> {
    // 检查目标阶段是否正在重平衡
    if (newStage !== null && this.isStageRebalancing(newStage)) {
      return failure(ErrorCodes.LAYOUT_RANK_CONFLICT, '该阶段正在重新排序，请稍后重试');
    }
    
    let operationResult: Result<void, OperationError> = success(undefined);
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) {
        operationResult = failure(ErrorCodes.DATA_NOT_FOUND, '任务不存在');
        return p;
      }
      
      if (newParentId && this.detectCycle(taskId, newParentId, tasks)) {
        console.warn('检测到循环依赖，操作已阻止', { taskId, newParentId });
        operationResult = failure(ErrorCodes.LAYOUT_CYCLE_DETECTED, '无法移动：会产生循环依赖');
        return p;
      }

      target.stage = newStage;
      target.parentId = newStage === null ? null : (newParentId !== undefined ? newParentId : target.parentId);

      const stageTasks = tasks.filter(t => t.stage === newStage && t.id !== taskId);
      const parent = target.parentId ? tasks.find(t => t.id === target.parentId) : null;
      const parentRank = this.maxParentRank(target, tasks);
      const minChildRank = this.minChildRank(target.id, tasks);
      if (newStage !== null) {
        const candidate = this.computeInsertRank(newStage, stageTasks, beforeTaskId || undefined, parent?.rank ?? null);
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) {
          operationResult = failure(
            ErrorCodes.LAYOUT_PARENT_CHILD_CONFLICT, 
            '无法移动：会破坏父子关系约束'
          );
          return p;
        }
        target.rank = placed.rank;
      } else {
        const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
        const candidate = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) {
          operationResult = failure(ErrorCodes.LAYOUT_NO_SPACE, '无法移动到未分配区域');
          return p;
        }
        target.rank = placed.rank;
        target.parentId = null;
      }

      return this.layoutService.rebalance({ ...p, tasks });
    });
    
    return operationResult;
  }

  reorderStage(stage: number, orderedIds: string[]) {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      let cursorRank = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank)[0]?.rank ?? this.layoutService.stageBase(stage);
      orderedIds.forEach(id => {
        const task = tasks.find(t => t.id === id && t.stage === stage);
        if (!task) return;
        const parentRank = this.maxParentRank(task, tasks);
        const minChildRank = this.minChildRank(task.id, tasks);
        const candidate = cursorRank;
        const placed = this.applyRefusalStrategy(task, candidate, parentRank, minChildRank);
        if (!placed.ok) return;
        task.rank = placed.rank;
        cursorRank = placed.rank + LAYOUT_CONFIG.RANK_STEP;
      });
      return this.layoutService.rebalance({ ...p, tasks });
    });
  }

  detachTask(taskId: string) {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) return p;

      const parentId = target.parentId;
      const parent = tasks.find(t => t.id === parentId);

      tasks.forEach(child => {
        if (child.parentId === target.id) {
          child.parentId = parentId;
          if (parent?.stage !== null) {
            child.stage = parent!.stage + 1;
          }
        }
      });

      target.stage = null;
      target.parentId = null;
      const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
      target.order = unassignedCount + 1;
      target.rank = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
      target.displayId = '?';

      return this.layoutService.rebalance({ ...p, tasks });
    });
  }
  
  deleteTaskKeepChildren(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const target = activeP.tasks.find(t => t.id === taskId);
    if (!target) return;
    
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const targetTask = tasks.find(t => t.id === taskId);
      if (!targetTask) return p;
      
      const parentId = targetTask.parentId;
      const parentTask = parentId ? tasks.find(t => t.id === parentId) : null;
      
      tasks.forEach(child => {
        if (child.parentId === taskId) {
          child.parentId = parentId;
          if (parentTask?.stage !== null && parentTask?.stage !== undefined) {
            child.stage = parentTask.stage + 1;
          } else if (parentId === null) {
            child.stage = 1;
          }
        }
      });
      
      const filteredTasks = tasks.filter(t => t.id !== taskId);
      
      const filteredConnections = p.connections.filter(
        c => c.source !== taskId && c.target !== taskId
      );
      
      return this.layoutService.rebalance({ ...p, tasks: filteredTasks, connections: filteredConnections });
    });
  }

  // ========== 视图控制 ==========

  toggleView(view: 'text' | 'flow') {
    const current = this.activeView();
    this.activeView.set(current === view ? null : view);
  }

  ensureView(view: 'text' | 'flow') {
    this.activeView.set(view);
  }

  setStageFilter(stage: number | 'all') {
    this.stageFilter.set(stage);
  }

  // ========== 主题设置 ==========
  
  async setTheme(theme: ThemeType) {
    this.uiState.setTheme(theme);
    const userId = this.currentUserId();
    if (userId) {
      await this.syncService.saveUserPreferences(userId, { theme });
    }
  }

  private applyThemeToDOM(theme: string) {
    // 委托给 UiStateService
    this.uiState.setTheme(theme as ThemeType);
  }

  private async loadUserPreferences() {
    const userId = this.currentUserId();
    if (!userId) return;
    
    const prefs = await this.syncService.loadUserPreferences(userId);
    if (prefs?.theme) {
      this.theme.set(prefs.theme);
      this.applyThemeToDOM(prefs.theme);
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, prefs.theme);
    }
  }
  
  private loadLocalPreferences() {
    const savedTheme = localStorage.getItem(CACHE_CONFIG.THEME_CACHE_KEY) as ThemeType | null;
    if (savedTheme) {
      this.theme.set(savedTheme);
      this.applyThemeToDOM(savedTheme);
    }
  }

  // ========== 私有辅助方法 ==========

  private seedProjects(): Project[] {
    const now = new Date().toISOString();
    return [
      this.layoutService.rebalance({
        id: 'proj-seed-1',
        name: 'Alpha Protocol',
        description: 'NanoFlow 核心引擎启动计划。',
        createdDate: now,
        tasks: [
          {
            id: 't1',
            title: '阶段 1: 环境搭建',
            content: '初始化项目环境。\n- [ ] 初始化 git 仓库\n- [ ] 安装 Node.js 依赖',
            stage: 1,
            parentId: null,
            order: 1,
            rank: 10000,
            status: 'active',
            x: 100,
            y: 100,
            createdDate: now,
            displayId: '1'
          },
          {
            id: 't2',
            title: '核心逻辑实现',
            content: '交付核心业务逻辑。\n- [ ] 编写单元测试',
            stage: 2,
            parentId: 't1',
            order: 1,
            rank: 10500,
            status: 'active',
            x: 300,
            y: 100,
            createdDate: now,
            displayId: '1,a'
          }
        ],
        connections: [
          { source: 't1', target: 't2' }
        ]
      })
    ];
  }

  private loadFromCacheOrSeed() {
    const cached = this.syncService.loadOfflineSnapshot();
    let projects: Project[] = [];
    
    if (cached && cached.length > 0) {
      projects = cached.map(p => this.migrateProject(p));
    } else {
      projects = this.seedProjects();
    }
    
    this.projects.set(projects);
    this.activeProjectId.set(projects[0]?.id ?? null);
    this.syncService.syncState.update(s => ({ ...s, offlineMode: true }));
  }
  
  private migrateProject(project: Project): Project {
    let migrated = { ...project };
    
    migrated.updatedAt = migrated.updatedAt || new Date().toISOString();
    migrated.version = CACHE_CONFIG.CACHE_VERSION;
    
    migrated.tasks = migrated.tasks.map(t => ({
      ...t,
      status: t.status || 'active',
      rank: t.rank ?? 10000,
      displayId: t.displayId || '?',
      hasIncompleteTask: t.hasIncompleteTask ?? false
    }));
    
    migrated.connections = migrated.connections || [];
    
    return this.layoutService.rebalance(migrated);
  }

  private updateActiveProject(mutator: (project: Project) => Project) {
    let updated = false;
    this.projects.update(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        updated = true;
        return mutator(p);
      }
      return p;
    }));
    if (updated) {
      this.hasPendingLocalChanges = true;
      this.schedulePersist();
    }
  }

  private recordAndUpdate(mutator: (project: Project) => Project) {
    const project = this.activeProject();
    if (!project) return;
    
    // 标记为结构性更新
    this.lastUpdateType = 'structure';
    
    // 记录操作前的快照
    const beforeSnapshot = this.undoService.createProjectSnapshot(project);
    const currentVersion = project.version ?? 0;
    
    // 执行更新
    let afterProject: Project | null = null;
    this.projects.update(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        afterProject = mutator(p);
        return afterProject;
      }
      return p;
    }));
    
    // 记录操作后的快照，包含版本号
    if (afterProject && !this.undoService.isProcessing) {
      const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
      this.undoService.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      }, currentVersion);
    }
    
    this.hasPendingLocalChanges = true;
    this.schedulePersist();
  }

  /**
   * 带防抖的记录和更新
   * 用于高频输入场景（标题、内容编辑），避免每个字符都产生撤销记录
   */
  private recordAndUpdateDebounced(mutator: (project: Project) => Project) {
    const project = this.activeProject();
    if (!project) return;
    
    // 标记为内容更新
    this.lastUpdateType = 'content';
    
    // 记录操作前的快照（仅在没有待处理的防抖操作时）
    const beforeSnapshot = this.undoService.createProjectSnapshot(project);
    const currentVersion = project.version ?? 0;
    
    // 执行更新
    let afterProject: Project | null = null;
    this.projects.update(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        afterProject = mutator(p);
        return afterProject;
      }
      return p;
    }));
    
    // 使用防抖记录，包含版本号
    if (afterProject && !this.undoService.isProcessing) {
      const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
      this.undoService.recordActionDebounced({
        type: 'task-update',
        projectId: project.id,
        projectVersion: currentVersion,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
    }
    
    this.hasPendingLocalChanges = true;
    this.schedulePersist();
  }

  private applyProjectSnapshot(projectId: string, snapshot: Partial<Project>) {
    this.projects.update(projects => projects.map(p => {
      if (p.id === projectId) {
        return this.layoutService.rebalance({
          ...p,
          tasks: snapshot.tasks ?? p.tasks,
          connections: snapshot.connections ?? p.connections
        });
      }
      return p;
    }));
    this.hasPendingLocalChanges = true;
    this.schedulePersist();
  }

  private schedulePersist() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistActiveProject();
    }, SYNC_CONFIG.DEBOUNCE_DELAY);
  }

  private async persistActiveProject() {
    const project = this.activeProject();
    this.syncService.saveOfflineSnapshot(this.projects());
    if (!project) {
      this.hasPendingLocalChanges = false;
      return;
    }

    const userId = this.currentUserId();
    if (!userId) {
      this.hasPendingLocalChanges = false;
      this.lastPersistAt = Date.now();
      return;
    }

    const now = new Date().toISOString();
    const result = await this.syncService.saveProjectToCloud(
      { ...project, updatedAt: now },
      userId
    );
    
    if (result.success) {
      this.projects.update(ps => ps.map(p => 
        p.id === project.id ? { ...p, updatedAt: now } : p
      ));
    }
    
    this.hasPendingLocalChanges = false;
    this.lastPersistAt = Date.now();
  }

  private gridPosition(stage: number, index: number) {
    return this.layoutService.gridPosition(stage, index);
  }

  private detectIncomplete(content: string) {
    return this.layoutService.detectIncomplete(content);
  }

  /**
   * 生成永久短 ID - 委托给 LayoutService
   */
  private generateShortId(existingTasks: Task[]): string {
    return this.layoutService.generateShortId(existingTasks);
  }

  /**
   * 计算插入位置的 rank 值
   * 当检测到 rank 间隔过小时，返回需要重平衡的标记
   */
  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null): number {
    const result = this.layoutService.computeInsertRank(stage, siblings, beforeId, parentRank);
    if (result.needsRebalance) {
      this.markStageForRebalance(stage);
    }
    return result.rank;
  }

  /**
   * 标记某阶段需要重平衡
   */
  private stagesNeedingRebalance = new Set<number>();
  private rebalanceTimer: ReturnType<typeof setTimeout> | null = null;
  
  private markStageForRebalance(stage: number) {
    this.stagesNeedingRebalance.add(stage);
    // 防抖执行重平衡
    if (this.rebalanceTimer) {
      clearTimeout(this.rebalanceTimer);
    }
    this.rebalanceTimer = setTimeout(() => {
      this.performStageRebalance();
      this.rebalanceTimer = null;
    }, 100);
  }
  
  /**
   * 执行阶段内的 rank 重平衡
   * 将阶段内的任务 rank 重新均匀分布
   * 在重平衡期间锁定相关阶段的拖拽操作
   */
  private performStageRebalance() {
    const activeP = this.activeProject();
    if (!activeP || this.stagesNeedingRebalance.size === 0) return;
    
    const stages = [...this.stagesNeedingRebalance];
    this.stagesNeedingRebalance.clear();
    
    // 锁定这些阶段
    stages.forEach(s => this.rebalancingStages.add(s));
    
    console.log('执行 rank 重平衡，阶段:', stages);
    
    try {
      // 使用 LayoutService 进行重平衡
      const rebalancedTasks = this.layoutService.rebalanceStageRanks(activeP.tasks, stages);
      
      if (rebalancedTasks !== activeP.tasks) {
        // 应用变更但不记录撤销历史（这是维护性更新）
        const updated = this.layoutService.rebalance({ ...activeP, tasks: rebalancedTasks });
        this.projects.update(ps => ps.map(p => p.id === updated.id ? updated : p));
      }
    } finally {
      // 解锁阶段
      stages.forEach(s => this.rebalancingStages.delete(s));
    }
  }

  private maxParentRank(task: Task | null, tasks: Task[]) {
    return this.layoutService.maxParentRank(task, tasks);
  }

  private minChildRank(taskId: string, tasks: Task[]) {
    return this.layoutService.minChildRank(taskId, tasks);
  }

  private applyRefusalStrategy(target: Task, candidateRank: number, parentRank: number | null, minChildRank: number) {
    return this.layoutService.applyRefusalStrategy(target, candidateRank, parentRank, minChildRank);
  }

  private detectCycle(taskId: string, newParentId: string | null, tasks: Task[]): boolean {
    return this.layoutService.detectCycle(taskId, newParentId, tasks);
  }
}
