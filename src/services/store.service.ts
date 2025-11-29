import { Injectable, signal, computed, inject, DestroyRef } from '@angular/core';
import { AuthService } from './auth.service';
import { SyncService } from './sync.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { 
  Task, Project, Connection, UnfinishedItem, ThemeType 
} from '../models';
import { 
  LAYOUT_CONFIG, SYNC_CONFIG, CACHE_CONFIG, LETTERS, SUPERSCRIPT_DIGITS 
} from '../config/constants';

@Injectable({
  providedIn: 'root'
})
export class StoreService {
  private authService = inject(AuthService);
  private syncService = inject(SyncService);
  private undoService = inject(UndoService);
  private toastService = inject(ToastService);
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
  
  // ========== UI 状态 ==========
  
  readonly isMobile = signal(false);
  readonly searchQuery = signal<string>('');
  
  // ========== 核心数据状态 ==========
  
  readonly projects = signal<Project[]>([]);
  readonly activeProjectId = signal<string | null>(null);
  readonly activeView = signal<'text' | 'flow' | null>('text');
  readonly filterMode = signal<'all' | string>('all');
  readonly stageViewRootFilter = signal<'all' | string>('all');
  readonly stageFilter = signal<'all' | number>('all');
  
  // ========== UI 状态 (Text Column) ==========
  
  readonly isTextUnfinishedOpen = signal(true);
  readonly isTextUnassignedOpen = signal(true);
  
  // ========== UI 状态 (Flow Column) ==========
  
  readonly isFlowUnfinishedOpen = signal(true);
  readonly isFlowUnassignedOpen = signal(true);
  readonly isFlowDetailOpen = signal(false);
  
  // ========== 布局尺寸 ==========
  
  readonly sidebarWidth = signal(280);
  readonly textColumnRatio = signal(50);
  
  // ========== 设置 ==========
  
  readonly layoutDirection = signal<'ltr' | 'rtl'>('ltr');
  readonly floatingWindowPref = signal<'auto' | 'fixed'>('auto');
  readonly theme = signal<ThemeType>('default');
  
  // ========== 私有状态 ==========
  
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private hasPendingLocalChanges = false;
  private lastPersistAt = 0;
  private isEditing = false;
  private editingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateType: 'content' | 'structure' | 'position' = 'structure';
  
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
    return this.tasks().filter(t => t.stage === null);
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

    const regex = /- \[ \]\s*(.+)/g;

    tasks.forEach(t => {
      if (rootDisplayId) {
        const isDescendant = t.displayId === rootDisplayId || t.displayId.startsWith(rootDisplayId + ',');
        if (!isDescendant) return;
      }

      const r = new RegExp(regex);
      let match;
      while ((match = r.exec(t.content)) !== null) {
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
    
    // 设置远程变更回调
    this.syncService.setRemoteChangeCallback(async () => {
      if (this.isEditing || this.hasPendingLocalChanges || Date.now() - this.lastPersistAt < 800) {
        return;
      }
      await this.loadProjects();
    });
    
    // 清理
    this.destroyRef.onDestroy(() => {
      if (this.persistTimer) clearTimeout(this.persistTimer);
      if (this.editingTimer) clearTimeout(this.editingTimer);
      this.syncService.destroy();
    });
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
   */
  undo() {
    const action = this.undoService.undo();
    if (!action) return;
    
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
      const rebalanced = projects.map(p => this.rebalance(p));
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
   */
  resolveConflict(projectId: string, choice: 'local' | 'remote' | 'merge') {
    const conflictData = this.conflictData();
    if (!conflictData || conflictData.projectId !== projectId) return;
    
    if (choice === 'local') {
      // 使用本地版本，强制推送到云端
      const project = this.projects().find(p => p.id === projectId);
      if (project) {
        this.syncService.resolveConflict(projectId, project, 'local');
        void this.persistActiveProject();
      }
    } else if (choice === 'remote') {
      // 使用远程版本，更新本地数据
      const remoteProject = conflictData.remoteData as Project;
      if (remoteProject) {
        this.projects.update(ps => ps.map(p => 
          p.id === projectId ? { ...remoteProject, id: projectId } : p
        ));
        this.syncService.resolveConflict(projectId, remoteProject, 'remote');
      }
    } else if (choice === 'merge') {
      // 智能合并：保留双方的新增内容，冲突时使用较新的版本
      const localProject = this.projects().find(p => p.id === projectId);
      const remoteProject = conflictData.remoteData as Project;
      
      if (localProject && remoteProject) {
        const mergedProject = this.mergeProjects(localProject, remoteProject);
        this.projects.update(ps => ps.map(p => 
          p.id === projectId ? mergedProject : p
        ));
        this.syncService.resolveConflict(projectId, mergedProject, 'local');
        void this.persistActiveProject();
      }
    }
  }
  
  /**
   * 智能合并两个项目
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
        // 双方都有的任务，比较创建时间（作为最后修改时间的近似）
        // 如果内容不同，优先使用本地版本（因为本地是最新编辑的）
        const localTime = new Date(localTask.createdDate || 0).getTime();
        const remoteTime = new Date(remoteTask.createdDate || 0).getTime();
        
        // 比较任务内容是否有差异
        const hasContentDiff = localTask.title !== remoteTask.title || 
                               localTask.content !== remoteTask.content ||
                               localTask.status !== remoteTask.status;
        
        if (hasContentDiff) {
          // 有内容差异时，使用较新创建的或本地版本
          mergedTasks.push(localTime >= remoteTime ? localTask : remoteTask);
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
    
    // 返回合并后的项目
    return {
      ...local,
      tasks: mergedTasks,
      connections: mergedConnections,
      updatedAt: new Date().toISOString()
    };
  }

  // ========== 项目操作 ==========

  addProject(project: Project) {
    const balanced = this.rebalance(project);
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
      await this.syncService.deleteProjectFromCloud(projectId, userId);
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

  // ========== 任务操作 ==========

  updateTaskContent(taskId: string, newContent: string) {
    this.markEditing();
    this.lastUpdateType = 'content';
    this.recordAndUpdate(p => this.rebalance({
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
    this.recordAndUpdate(p => this.rebalance({
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
  
  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.lastUpdateType;
  }

  updateTaskStatus(taskId: string, status: Task['status']) {
    this.recordAndUpdate(p => this.rebalance({
      ...p,
      tasks: p.tasks.map(t => t.id === taskId ? { ...t, status } : t)
    }));
  }

  deleteTask(taskId: string) {
    const activeP = this.activeProject();
    if (!activeP) return;
    
    const idsToDelete = new Set<string>();
    const collectDescendants = (id: string) => {
      idsToDelete.add(id);
      activeP.tasks.filter(t => t.parentId === id).forEach(child => collectDescendants(child.id));
    };
    collectDescendants(taskId);
    
    this.recordAndUpdate(p => this.rebalance({
      ...p,
      tasks: p.tasks.filter(t => !idsToDelete.has(t.id)),
      connections: p.connections.filter(c => !idsToDelete.has(c.source) && !idsToDelete.has(c.target))
    }));
  }

  addTask(
    title: string, 
    content: string, 
    targetStage: number | null, 
    parentId: string | null, 
    isSibling: boolean
  ): string | null {
    const activeP = this.activeProject();
    if (!activeP) return null;

    const stageTasks = activeP.tasks.filter(t => t.stage === targetStage);
    const newOrder = stageTasks.length + 1;
    const pos = targetStage !== null 
      ? this.gridPosition(targetStage, newOrder - 1) 
      : { x: 80 + Math.random() * 120, y: 80 + Math.random() * 120 };
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
    if (!placed.ok) return null;
    newTask.rank = placed.rank;

    if (targetStage === null) {
      this.recordAndUpdate(p => ({
        ...p,
        tasks: [...p.tasks, newTask]
      }));
    } else {
      this.recordAndUpdate(p => this.rebalance({
        ...p,
        tasks: [...p.tasks, newTask],
        connections: parentId ? [...p.connections, { source: parentId, target: newTask.id }] : [...p.connections]
      }));
    }
    
    return newTaskId;
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
  
  moveTaskToStage(taskId: string, newStage: number | null, beforeTaskId?: string | null, newParentId?: string | null) {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      const target = tasks.find(t => t.id === taskId);
      if (!target) return p;
      
      if (newParentId && this.detectCycle(taskId, newParentId, tasks)) {
        console.warn('检测到循环依赖，操作已阻止', { taskId, newParentId });
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
        if (!placed.ok) return p;
        target.rank = placed.rank;
      } else {
        const unassignedCount = tasks.filter(t => t.stage === null && t.id !== target.id).length;
        const candidate = LAYOUT_CONFIG.RANK_ROOT_BASE + unassignedCount * LAYOUT_CONFIG.RANK_STEP;
        const placed = this.applyRefusalStrategy(target, candidate, parentRank, minChildRank);
        if (!placed.ok) return p;
        target.rank = placed.rank;
        target.parentId = null;
      }

      return this.rebalance({ ...p, tasks });
    });
  }

  reorderStage(stage: number, orderedIds: string[]) {
    this.recordAndUpdate(p => {
      const tasks = p.tasks.map(t => ({ ...t }));
      let cursorRank = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank)[0]?.rank ?? this.stageBase(stage);
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
      return this.rebalance({ ...p, tasks });
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

      return this.rebalance({ ...p, tasks });
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
      
      return this.rebalance({ ...p, tasks: filteredTasks, connections: filteredConnections });
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
    this.theme.set(theme);
    this.applyThemeToDOM(theme);
    const userId = this.currentUserId();
    if (userId) {
      await this.syncService.saveUserPreferences(userId, { theme });
    } else {
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, theme);
    }
  }

  private applyThemeToDOM(theme: string) {
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
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
      this.rebalance({
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
    
    return this.rebalance(migrated);
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
    
    // 执行更新
    let afterProject: Project | null = null;
    this.projects.update(projects => projects.map(p => {
      if (p.id === this.activeProjectId()) {
        afterProject = mutator(p);
        return afterProject;
      }
      return p;
    }));
    
    // 记录操作后的快照
    if (afterProject && !this.undoService.isProcessing) {
      const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
      this.undoService.recordAction({
        type: 'task-update',
        projectId: project.id,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
    }
    
    this.hasPendingLocalChanges = true;
    this.schedulePersist();
  }

  private applyProjectSnapshot(projectId: string, snapshot: Partial<Project>) {
    this.projects.update(projects => projects.map(p => {
      if (p.id === projectId) {
        return this.rebalance({
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
    return {
      x: (stage - 1) * LAYOUT_CONFIG.STAGE_SPACING + 120,
      y: 100 + index * LAYOUT_CONFIG.ROW_SPACING
    };
  }

  private detectIncomplete(content: string) {
    return /- \[ \]/.test(content || '');
  }

  /**
   * 生成永久短 ID
   * 格式: NF-XXXX (X 为大写字母或数字)
   * 确保在当前项目中唯一
   */
  private generateShortId(existingTasks: Task[]): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除易混淆字符 I, O, 0, 1
    const existingIds = new Set(existingTasks.map(t => t.shortId).filter(Boolean));
    
    let attempts = 0;
    const maxAttempts = 100;
    
    while (attempts < maxAttempts) {
      let id = 'NF-';
      for (let i = 0; i < 4; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      
      if (!existingIds.has(id)) {
        return id;
      }
      attempts++;
    }
    
    // 如果随机生成失败，使用时间戳后缀
    return `NF-${Date.now().toString(36).toUpperCase().slice(-4)}`;
  }

  private stageBase(stage: number) {
    return LAYOUT_CONFIG.RANK_ROOT_BASE + (stage - 1) * LAYOUT_CONFIG.RANK_ROOT_BASE;
  }

  /**
   * 计算插入位置的 rank 值
   * 当检测到 rank 间隔过小时，返回需要重平衡的标记
   */
  private computeInsertRank(stage: number, siblings: Task[], beforeId?: string | null, parentRank?: number | null): number {
    const sorted = siblings.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank);
    const base = parentRank !== null && parentRank !== undefined 
      ? parentRank + LAYOUT_CONFIG.RANK_STEP 
      : this.stageBase(stage);
    let prev: Task | null = null;
    let next: Task | null = null;
    if (beforeId) {
      const idx = sorted.findIndex(t => t.id === beforeId);
      if (idx >= 0) {
        next = sorted[idx];
        prev = idx > 0 ? sorted[idx - 1] : null;
      }
    }
    if (!beforeId || !next) {
      prev = sorted[sorted.length - 1] || null;
      next = null;
    }

    let rank: number;
    if (prev && next) {
      rank = (prev.rank + next.rank) / 2;
      // 检测间隔是否过小，如果小于最小间隔，触发重平衡
      const gap = next.rank - prev.rank;
      if (gap < LAYOUT_CONFIG.RANK_MIN_GAP) {
        this.markStageForRebalance(stage);
      }
    } else if (prev && !next) {
      rank = prev.rank + LAYOUT_CONFIG.RANK_STEP;
    } else if (!prev && next) {
      rank = next.rank - LAYOUT_CONFIG.RANK_STEP;
    } else {
      rank = base;
    }

    return rank;
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
   */
  private performStageRebalance() {
    const activeP = this.activeProject();
    if (!activeP || this.stagesNeedingRebalance.size === 0) return;
    
    const stages = [...this.stagesNeedingRebalance];
    this.stagesNeedingRebalance.clear();
    
    console.log('执行 rank 重平衡，阶段:', stages);
    
    const tasks = [...activeP.tasks];
    let modified = false;
    
    for (const stage of stages) {
      const stageTasks = tasks.filter(t => t.stage === stage).sort((a, b) => a.rank - b.rank);
      if (stageTasks.length < 2) continue;
      
      const base = this.stageBase(stage);
      stageTasks.forEach((t, idx) => {
        const newRank = base + (idx + 1) * LAYOUT_CONFIG.RANK_STEP;
        const taskInArray = tasks.find(task => task.id === t.id);
        if (taskInArray && taskInArray.rank !== newRank) {
          taskInArray.rank = newRank;
          modified = true;
        }
      });
    }
    
    if (modified) {
      // 应用变更但不记录撤销历史（这是维护性更新）
      const updated = this.rebalance({ ...activeP, tasks });
      this.projects.update(ps => ps.map(p => p.id === updated.id ? updated : p));
    }
  }

  private maxParentRank(task: Task | null, tasks: Task[]) {
    if (!task?.parentId) return null;
    const parent = tasks.find(t => t.id === task.parentId);
    return parent ? parent.rank : null;
  }

  private minChildRank(taskId: string, tasks: Task[]) {
    const children = tasks.filter(t => t.parentId === taskId);
    if (children.length === 0) return Infinity;
    return Math.min(...children.map(c => c.rank));
  }

  private applyRefusalStrategy(target: Task, candidateRank: number, parentRank: number | null, minChildRank: number) {
    let nextRank = candidateRank;
    if (parentRank !== null && nextRank <= parentRank) {
      nextRank = parentRank + LAYOUT_CONFIG.RANK_STEP;
    }
    if (Number.isFinite(minChildRank) && nextRank >= minChildRank) {
      nextRank = minChildRank - LAYOUT_CONFIG.RANK_STEP;
    }
    const violatesParent = parentRank !== null && nextRank <= parentRank;
    const violatesChild = Number.isFinite(minChildRank) && nextRank >= minChildRank;
    if (violatesParent || violatesChild) {
      console.warn('Refused ordering: violates parent/child constraints', {
        taskId: target.id,
        parentRank,
        minChildRank,
        requested: candidateRank
      });
      return { ok: false, rank: candidateRank };
    }
    return { ok: true, rank: nextRank };
  }

  private detectCycle(taskId: string, newParentId: string | null, tasks: Task[]): boolean {
    if (!newParentId) return false;
    if (taskId === newParentId) return true;
    
    const visited = new Set<string>();
    let current = newParentId;
    
    while (current) {
      if (visited.has(current)) return true;
      if (current === taskId) return true;
      visited.add(current);
      
      const parentTask = tasks.find(t => t.id === current);
      current = parentTask?.parentId || null;
    }
    
    return false;
  }

  private rebalance(project: Project): Project {
    const tasks = project.tasks.map(t => ({ ...t }));
    const byId = new Map<string, Task>();
    tasks.forEach(t => byId.set(t.id, t));

    // 为没有 shortId 的任务生成短 ID
    tasks.forEach(t => {
      if (!t.shortId) {
        t.shortId = this.generateShortId(tasks);
      }
    });

    tasks.forEach(t => {
      if (t.rank === undefined || t.rank === null) {
        const base = t.stage ? this.stageBase(t.stage) : LAYOUT_CONFIG.RANK_ROOT_BASE;
        t.rank = base + (t.order || 0) * LAYOUT_CONFIG.RANK_STEP;
      }
      t.hasIncompleteTask = this.detectIncomplete(t.content);
    });

    tasks.forEach(t => {
      if (t.parentId) {
        const parent = byId.get(t.parentId);
        if (parent && parent.stage !== null) {
          if (t.stage === null || t.stage <= parent.stage) {
            t.stage = parent.stage + 1;
          }
          if (t.rank <= parent.rank) {
            t.rank = parent.rank + LAYOUT_CONFIG.RANK_STEP;
          }
        }
      }
    });

    const grouped = new Map<number, Task[]>();
    tasks.forEach(t => {
      if (t.stage !== null) {
        if (!grouped.has(t.stage)) grouped.set(t.stage, []);
        grouped.get(t.stage)!.push(t);
      }
    });

    grouped.forEach((list, stage) => {
      list.sort((a, b) => a.rank - b.rank || a.order - b.order);
      list.forEach((t, idx) => {
        t.order = idx + 1;
        if (t.x === undefined || t.y === undefined) {
          const pos = this.gridPosition(stage, idx);
          t.x = pos.x;
          t.y = pos.y;
        }
      });
    });

    const unassigned = tasks.filter(t => t.stage === null).sort((a, b) => a.rank - b.rank || a.order - b.order);
    unassigned.forEach((t, idx) => {
      t.order = idx + 1;
      t.displayId = '?';
    });

    tasks.forEach(t => byId.set(t.id, t));

    const stage1Roots = tasks
      .filter(t => t.stage === 1 && !t.parentId)
      .sort((a, b) => a.rank - b.rank);

    stage1Roots.forEach((t, idx) => {
      t.displayId = `${idx + 1}`;
    });

    const children = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId) {
        if (!children.has(t.parentId)) children.set(t.parentId, []);
        children.get(t.parentId)!.push(t);
      }
    });

    const assignChildren = (parentId: string) => {
      const parent = byId.get(parentId);
      if (!parent) return;
      const list = (children.get(parentId) || []).sort((a, b) => a.rank - b.rank);
      list.forEach((child, idx) => {
        if (parent.stage !== null && (child.stage === null || child.stage <= parent.stage)) {
          child.stage = parent.stage + 1;
        }
        const letter = LETTERS[idx % LETTERS.length];
        child.displayId = `${parent.displayId},${letter}`;
        assignChildren(child.id);
      });
    };

    stage1Roots.forEach(t => assignChildren(t.id));

    tasks.forEach(t => {
      if (!t.displayId) t.displayId = '?';
      if (t.stage === null) {
        t.parentId = null;
        t.displayId = '?';
      }
    });

    const childrenMap = new Map<string, Task[]>();
    tasks.forEach(t => {
      if (t.parentId) {
        if (!childrenMap.has(t.parentId)) childrenMap.set(t.parentId, []);
        childrenMap.get(t.parentId)!.push(t);
      }
    });

    const cascade = (node: Task, depth = 0) => {
      if (depth > 100) {
        console.warn('Task tree depth exceeded limit, possible circular reference', { nodeId: node.id });
        return;
      }
      const kids = (childrenMap.get(node.id) || []).sort((a, b) => a.rank - b.rank);
      let floor = node.rank;
      kids.forEach(child => {
        if (child.rank <= floor) {
          child.rank = floor + LAYOUT_CONFIG.RANK_STEP;
        }
        floor = child.rank;
        cascade(child, depth + 1);
      });
    };

    stage1Roots.forEach(root => cascade(root));

    tasks
      .filter(t => t.stage !== null)
      .sort((a, b) => a.stage! - b.stage! || a.rank - b.rank)
      .forEach((t, idx, arr) => {
        const sameStage = arr.filter(s => s.stage === t.stage);
        const position = sameStage.findIndex(s => s.id === t.id);
        t.order = position + 1;
      });

    return { ...project, tasks };
  }
}
