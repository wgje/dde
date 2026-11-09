/**
 * 状态管理服务
 *
 * 按照 agents.md 极简架构要求：
 * - 使用 Angular Signals 进行细粒度更新
 * - projects signal: 存储元数据
 * - tasksMap signal: Map<string, Task> 用于 O(1) 查找
 * - 避免深层嵌套对象的 Signal，保持扁平化
 *
 * 性能优化：Map/Set 类型 signal 使用 { equal: () => false }
 * 允许原地修改后触发变更通知，避免每次更新都 O(n) 全量克隆
 *
 * 【2026-02-15 修复】在 bulk 操作中增加脏检查，避免数据未变化时
 * 触发级联 computed/effect 风暴导致页面卡死
 *
 * 【2026-04-16 T1-1 PR-B】判等权威从手写字段清单改为 `updatedAt`+`deletedAt`：
 * - 历史代码用 isTaskEqual/isProjectEqual/isConnectionEqual 枚举 14/4/4 个业务字段，
 *   新增字段（例如 A3.2 parkingMeta 子字段、parking_meta.reminder.snoozeCount 等）
 *   若忘记同步进判等函数，脏检查会静默吞除该字段变更 → 数据回档类故障。
 * - 按 Hard Rule：updatedAt 是 LWW 的权威，任何业务字段变更都应同步 bump updatedAt；
 *   deletedAt 变化代表软删除/恢复，也是变更信号。
 * - 此次重构用 `a.updatedAt === b.updatedAt && a.deletedAt === b.deletedAt` 作为
 *   "完全相同可跳过" 的信号。若 updatedAt 未变而其它字段变了，说明调用方未遵守
 *   LWW 约定——那是调用方的 bug，不应由 store 层兜底放行。
 */

import { Injectable, signal, computed } from '@angular/core';
import { Project, Task, Connection } from '../../../models';
import { assertUniqueEntityIds, cloneSetIndex, detachEntityFromPreviousProject, isSameRevision, type ConnectionStoreStateSnapshot, type ProjectStoreStateSnapshot, type TaskStoreStateSnapshot } from './store-data-safety.helpers';

/**
 * 任务状态 Store
 * 使用 Map 结构实现 O(1) 查找
 */
@Injectable({
  providedIn: 'root'
})
export class TaskStore {
  /** 任务 Map - O(1) 查找，equal: () => false 允许原地修改 */
  readonly tasksMap = signal<Map<string, Task>>(new Map(), { equal: () => false });

  /** 任务列表（从 Map 派生） */
  readonly tasks = computed(() => Array.from(this.tasksMap().values()));

  /** 按项目 ID 索引的任务 */
  private readonly tasksByProject = signal<Map<string, Set<string>>>(new Map(), { equal: () => false });

  /** 任务所属项目索引（A3.4.4） */
  private readonly taskProjectMap = signal<Map<string, string>>(new Map(), { equal: () => false });

  /**
   * 停泊任务 ID 二级索引（A3.4.4）
   * 包含所有 parkingMeta 非 null 的任务 ID，O(1) 查找
   * 实际 Task 对象通过 tasksMap.get(id) 获取，不产生数据冗余
   */
  readonly parkedTaskIds = signal<Set<string>>(new Set(), { equal: () => false });

  captureState(): TaskStoreStateSnapshot {
    return {
      tasksMap: new Map(this.tasksMap()),
      tasksByProject: cloneSetIndex(this.tasksByProject()),
      taskProjectMap: new Map(this.taskProjectMap()),
      parkedTaskIds: new Set(this.parkedTaskIds()),
    };
  }

  restoreState(snapshot: TaskStoreStateSnapshot): void {
    this.tasksMap.set(new Map(snapshot.tasksMap));
    this.tasksByProject.set(cloneSetIndex(snapshot.tasksByProject));
    this.taskProjectMap.set(new Map(snapshot.taskProjectMap));
    this.parkedTaskIds.set(new Set(snapshot.parkedTaskIds));
  }

  /**
   * 停泊任务列表（派生）——按 parkedAt 降序排列
   */
  readonly parkedTasks = computed(() => {
    const ids = this.parkedTaskIds();
    const map = this.tasksMap();
    const tasks: Task[] = [];
    ids.forEach(id => {
      const task = map.get(id);
      if (task?.parkingMeta) tasks.push(task);
    });
    // 按 parkedAt 降序（最近停泊在上）
    tasks.sort((a, b) => {
      const aTime = a.parkingMeta?.parkedAt ?? '';
      const bTime = b.parkingMeta?.parkedAt ?? '';
      return bTime.localeCompare(aTime);
    });
    return tasks;
  });
  
  /**
   * 获取单个任务 - O(1)
   */
  getTask(id: string): Task | undefined {
    return this.tasksMap().get(id);
  }

  /**
   * O(1) 获取任务所属项目 ID（A3.4.4）
   */
  getTaskProjectId(taskId: string): string | null {
    return this.taskProjectMap().get(taskId) ?? null;
  }
  
  /**
   * 获取项目的所有任务
   */
  getTasksByProject(projectId: string): Task[] {
    const taskIds = this.tasksByProject().get(projectId);
    if (!taskIds) return [];
    
    const map = this.tasksMap();
    return Array.from(taskIds)
      .map(id => map.get(id))
      .filter((t): t is Task => !!t);
  }
  
  /** 设置任务（单个）- 原地修改，O(1)，含脏检查 */
  setTask(task: Task, projectId: string): void {
    const existing = this.tasksMap().get(task.id);
    const previousProjectId = this.taskProjectMap().get(task.id);
    // 脏检查：数据未变化时跳过 signal 通知
    if (existing && previousProjectId === projectId && isSameRevision(existing, task)) return;
    this.tasksMap.update(map => { map.set(task.id, task); return map; });
    this.tasksByProject.update(map => {
      detachEntityFromPreviousProject(map, task.id, previousProjectId, projectId);
      if (!map.has(projectId)) map.set(projectId, new Set());
      map.get(projectId)!.add(task.id);
      return map;
    });
    this.taskProjectMap.update(map => {
      map.set(task.id, projectId);
      return map;
    });
    // 维护停泊索引并触发 signal 通知
    this.updateParkedIndex(task);
    this.parkedTaskIds.update(s => s);
  }

  /** 批量设置任务（替换指定项目的全部任务） */
  setTasks(tasks: Task[], projectId: string): void {
    const previousIds = new Set(this.tasksByProject().get(projectId) ?? []);
    const incomingIds = new Set(tasks.map(task => task.id));
    const previousProjectByTaskId = new Map(
      tasks.map(task => [task.id, this.taskProjectMap().get(task.id)]),
    );
    const ownershipSnapshot = new Map(this.taskProjectMap());

    this.tasksMap.update(map => {
      for (const id of previousIds) {
        if (!incomingIds.has(id) && ownershipSnapshot.get(id) === projectId) map.delete(id);
      }
      tasks.forEach(task => map.set(task.id, task));
      return map;
    });
    this.tasksByProject.update(map => {
      for (const task of tasks) {
        detachEntityFromPreviousProject(map, task.id, previousProjectByTaskId.get(task.id), projectId);
      }
      map.set(projectId, incomingIds);
      return map;
    });
    this.taskProjectMap.update(map => {
      for (const id of previousIds) {
        if (!incomingIds.has(id) && map.get(id) === projectId) map.delete(id);
      }
      for (const task of tasks) map.set(task.id, projectId);
      return map;
    });
    this.parkedTaskIds.update(ids => {
      for (const id of previousIds) {
        if (ownershipSnapshot.get(id) === projectId) ids.delete(id);
      }
      for (const task of tasks) {
        if (task.parkingMeta) ids.add(task.id);
        else ids.delete(task.id);
      }
      return ids;
    });
  }

  /** 删除任务 - O(1) */
  removeTask(id: string, projectId: string): void {
    const ownerProjectId = this.taskProjectMap().get(id) ?? projectId;
    this.tasksMap.update(map => { map.delete(id); return map; });
    this.tasksByProject.update(map => {
      map.get(ownerProjectId)?.delete(id);
      if (ownerProjectId !== projectId) map.get(projectId)?.delete(id);
      return map;
    });
    this.taskProjectMap.update(map => { map.delete(id); return map; });
    // 移除停泊索引
    if (this.parkedTaskIds().has(id)) {
      this.parkedTaskIds.update(s => { s.delete(id); return s; });
    }
  }

  /** 批量更新任务 - 含脏检查（仅在有变化时触发 signal 更新） */
  bulkSetTasks(tasks: Task[], projectId: string): void {
    const map = this.tasksMap();
    const previousProjectByTaskId = new Map(
      tasks.map(task => [task.id, this.taskProjectMap().get(task.id)]),
    );
    let hasEntityChange = false;
    let hasOwnershipChange = false;
    for (const t of tasks) {
      const existing = map.get(t.id);
      if (!existing || !isSameRevision(existing, t)) {
        map.set(t.id, t);
        hasEntityChange = true;
      }
      if (previousProjectByTaskId.get(t.id) !== projectId) {
        this.taskProjectMap().set(t.id, projectId);
        hasOwnershipChange = true;
      }
    }
    // 仅在有实际变化时才触发 signal 通知，避免级联风暴
    if (hasEntityChange) {
      this.tasksMap.update(m => m);
      // 维护停泊索引
      for (const t of tasks) this.updateParkedIndex(t);
      this.parkedTaskIds.update(s => s);
    }
    if (hasOwnershipChange) {
      this.taskProjectMap.update(m => m);
    }
    this.tasksByProject.update(indexMap => {
      for (const task of tasks) {
        detachEntityFromPreviousProject(indexMap, task.id, previousProjectByTaskId.get(task.id), projectId);
      }
      const existing = indexMap.get(projectId) ?? new Set<string>();
      const prevSize = existing.size;
      for (const t of tasks) existing.add(t.id);
      // 只有索引变化时才触发
      if (existing.size !== prevSize) {
        indexMap.set(projectId, existing);
      }
      return indexMap;
    });
  }

  /** 批量删除任务 */
  bulkRemoveTasks(taskIds: string[], projectId: string): void {
    const ownerProjectByTaskId = new Map(taskIds.map(id => [id, this.taskProjectMap().get(id) ?? projectId]));
    this.tasksMap.update(map => { for (const id of taskIds) map.delete(id); return map; });
    this.tasksByProject.update(map => {
      for (const id of taskIds) {
        const ownerProjectId = ownerProjectByTaskId.get(id) ?? projectId;
        map.get(ownerProjectId)?.delete(id);
        if (ownerProjectId !== projectId) map.get(projectId)?.delete(id);
      }
      return map;
    });
    this.taskProjectMap.update(map => {
      for (const id of taskIds) map.delete(id);
      return map;
    });
    // 移除停泊索引
    this.parkedTaskIds.update(s => {
      for (const id of taskIds) s.delete(id);
      return s;
    });
  }

  /** 批量设置多个项目的任务（用于 setProjects 场景） */
  setTasksForMultipleProjects(entries: { tasks: Task[]; projectId: string }[]): void { assertUniqueEntityIds(entries, entry => entry.tasks, 'task');
    const previousIdsByProject = new Map(
      entries.map(({ projectId }) => [
        projectId,
        new Set(this.tasksByProject().get(projectId) ?? []),
      ]),
    );
    const incomingProjectByTaskId = new Map<string, string>();
    for (const { tasks, projectId } of entries) {
      for (const task of tasks) incomingProjectByTaskId.set(task.id, projectId);
    }
    const previousProjectByIncomingTaskId = new Map(
      Array.from(incomingProjectByTaskId.keys(), taskId => [taskId, this.taskProjectMap().get(taskId)]),
    );

    this.replaceTaskEntitiesForMultipleProjects(entries, previousIdsByProject, incomingProjectByTaskId);
    this.replaceTaskOwnershipForMultipleProjects(previousIdsByProject, incomingProjectByTaskId);
    this.replaceTaskProjectIndexes(entries, incomingProjectByTaskId, previousProjectByIncomingTaskId);
    this.replaceParkedTaskIndex(entries, previousIdsByProject);
  }

  private replaceTaskEntitiesForMultipleProjects(
    entries: { tasks: Task[]; projectId: string }[],
    previousIdsByProject: Map<string, Set<string>>,
    incomingProjectByTaskId: Map<string, string>,
  ): void {
    this.tasksMap.update(map => {
      for (const previousIds of previousIdsByProject.values()) {
        for (const id of previousIds) {
          if (!incomingProjectByTaskId.has(id)) map.delete(id);
        }
      }
      for (const { tasks } of entries) {
        for (const t of tasks) {
          map.set(t.id, t);
        }
      }
      return map;
    });
  }

  private replaceTaskOwnershipForMultipleProjects(
    previousIdsByProject: Map<string, Set<string>>,
    incomingProjectByTaskId: Map<string, string>,
  ): void {
    this.taskProjectMap.update(map => {
      for (const previousIds of previousIdsByProject.values()) {
        for (const id of previousIds) {
          if (!incomingProjectByTaskId.has(id)) map.delete(id);
        }
      }
      for (const [taskId, projectId] of incomingProjectByTaskId) map.set(taskId, projectId);
      return map;
    });
  }

  private replaceTaskProjectIndexes(
    entries: { tasks: Task[]; projectId: string }[],
    incomingProjectByTaskId: Map<string, string>,
    previousProjectByIncomingTaskId: Map<string, string | undefined>,
  ): void {
    this.tasksByProject.update(map => {
      for (const [taskId, projectId] of incomingProjectByTaskId) {
        detachEntityFromPreviousProject(map, taskId, previousProjectByIncomingTaskId.get(taskId), projectId);
      }
      for (const { tasks, projectId } of entries) map.set(projectId, new Set(tasks.map(t => t.id)));
      return map;
    });
  }

  private replaceParkedTaskIndex(
    entries: { tasks: Task[]; projectId: string }[],
    previousIdsByProject: Map<string, Set<string>>,
  ): void {
    this.parkedTaskIds.update(ids => {
      for (const previousIds of previousIdsByProject.values()) {
        for (const id of previousIds) ids.delete(id);
      }
      for (const { tasks } of entries) {
        for (const task of tasks) {
          if (task.parkingMeta) ids.add(task.id);
          else ids.delete(task.id);
        }
      }
      return ids;
    });
  }

  /** 清除项目的所有任务 */
  clearProject(projectId: string): void {
    const taskIds = this.tasksByProject().get(projectId);
    if (!taskIds) return;
    this.tasksMap.update(map => { taskIds.forEach(id => map.delete(id)); return map; });
    this.tasksByProject.update(map => { map.delete(projectId); return map; });
    this.taskProjectMap.update(map => {
      for (const id of taskIds) map.delete(id);
      return map;
    });
    // 清理停泊索引——移除该项目中的停泊任务 ID
    this.parkedTaskIds.update(s => {
      for (const id of taskIds) s.delete(id);
      return s;
    });
  }

  /** 清除不在权威项目集合中的任务及全部二级索引 */
  clearProjectsExcept(projectIds: ReadonlySet<string>): void {
    for (const projectId of Array.from(this.tasksByProject().keys())) {
      if (!projectIds.has(projectId)) this.clearProject(projectId);
    }
  }
  
  /**
   * 清除所有任务
   */
  clear(): void {
    this.tasksMap.set(new Map());
    this.tasksByProject.set(new Map());
    this.taskProjectMap.set(new Map());
    this.parkedTaskIds.set(new Set());
  }

  // ─── 停泊索引维护 ───

  /**
   * 更新停泊任务二级索引
   * 内部方法，由 setTask / bulkSetTasks 等调用
   */
  private updateParkedIndex(task: Task): void {
    if (task.parkingMeta) {
      this.parkedTaskIds().add(task.id);
    } else {
      this.parkedTaskIds().delete(task.id);
    }
  }
}

/**
 * 项目状态 Store
 */
@Injectable({
  providedIn: 'root'
})
export class ProjectStore {
  /** 项目 Map - O(1) 查找，equal: () => false 允许原地修改 */
  readonly projectsMap = signal<Map<string, Project>>(new Map(), { equal: () => false });

  /** 项目列表（从 Map 派生） */
  readonly projects = computed(() => Array.from(this.projectsMap().values()));
  
  /**
   * 当前活动项目 ID
   */
  readonly activeProjectId = signal<string | null>(null);

  captureState(): ProjectStoreStateSnapshot { return { projectsMap: new Map(this.projectsMap()), activeProjectId: this.activeProjectId() }; }

  restoreState(snapshot: ProjectStoreStateSnapshot): void { this.projectsMap.set(new Map(snapshot.projectsMap)); this.activeProjectId.set(snapshot.activeProjectId); }
  
  /**
   * 当前活动项目
   */
  readonly activeProject = computed(() => {
    const id = this.activeProjectId();
    return id ? this.projectsMap().get(id) || null : null;
  });
  
  /**
   * 获取单个项目 - O(1)
   */
  getProject(id: string): Project | undefined {
    return this.projectsMap().get(id);
  }
  
  /** 设置项目 - 原地修改，O(1)，含脏检查 */
  setProject(project: Project): void {
    const existing = this.projectsMap().get(project.id);
    if (existing && isSameRevision(existing, project)) return;
    this.projectsMap.update(map => { map.set(project.id, project); return map; });
  }

  /** 批量设置项目（替换全部） */
  setProjects(projects: Project[]): void {
    const newMap = new Map<string, Project>();
    projects.forEach(p => newMap.set(p.id, p));
    this.projectsMap.set(newMap);
  }

  /** 删除项目 */
  removeProject(id: string): void {
    this.projectsMap.update(map => { map.delete(id); return map; });
    if (this.activeProjectId() === id) this.activeProjectId.set(null);
  }
  
  // 【P2-03 修复】提供级联清理接口，删除项目时同时清理 Task/Connection Store
  removeProjectCascade(id: string, taskStore: TaskStore, connectionStore: ConnectionStore): void {
    taskStore.clearProject(id);
    connectionStore.clearProject(id);
    this.removeProject(id);
  }

  /** 批量更新项目 - 含脏检查 */
  bulkSetProjects(projects: Project[]): void {
    const map = this.projectsMap();
    let hasChange = false;
    for (const p of projects) {
      const existing = map.get(p.id);
      if (!existing || !isSameRevision(existing, p)) {
        map.set(p.id, p);
        hasChange = true;
      }
    }
    if (hasChange) {
      this.projectsMap.update(m => m);
    }
  }

  /** 批量删除项目 */
  bulkRemoveProjects(projectIds: string[]): void {
    this.projectsMap.update(map => { for (const id of projectIds) map.delete(id); return map; });
    const activeId = this.activeProjectId();
    if (activeId && projectIds.includes(activeId)) this.activeProjectId.set(null);
  }
  
  /**
   * 清除所有项目
   */
  clear(): void {
    this.projectsMap.set(new Map());
    this.activeProjectId.set(null);
  }
}

/**
 * 连接状态 Store
 */
@Injectable({
  providedIn: 'root'
})
export class ConnectionStore {
  /** 连接 Map - O(1) 查找，equal: () => false 允许原地修改 */
  readonly connectionsMap = signal<Map<string, Connection>>(new Map(), { equal: () => false });

  /** 按项目索引的连接 */
  private readonly connectionsByProject = signal<Map<string, Set<string>>>(new Map(), { equal: () => false });

  /** 连接所属项目反向索引 */
  private readonly connectionProjectMap = signal<Map<string, string>>(new Map(), { equal: () => false });

  captureState(): ConnectionStoreStateSnapshot {
    return {
      connectionsMap: new Map(this.connectionsMap()),
      connectionsByProject: cloneSetIndex(this.connectionsByProject()),
      connectionProjectMap: new Map(this.connectionProjectMap()),
    };
  }

  restoreState(snapshot: ConnectionStoreStateSnapshot): void {
    this.connectionsMap.set(new Map(snapshot.connectionsMap));
    this.connectionsByProject.set(cloneSetIndex(snapshot.connectionsByProject));
    this.connectionProjectMap.set(new Map(snapshot.connectionProjectMap));
  }

  /** 连接列表 */
  readonly connections = computed(() => Array.from(this.connectionsMap().values()));
  
  /**
   * 获取单个连接 - O(1)
   */
  getConnection(id: string): Connection | undefined {
    return this.connectionsMap().get(id);
  }

  /** O(1) 获取连接所属项目 ID */
  getConnectionProjectId(connectionId: string): string | null {
    return this.connectionProjectMap().get(connectionId) ?? null;
  }
  
  /**
   * 获取项目的所有连接
   */
  getConnectionsByProject(projectId: string): Connection[] {
    const ids = this.connectionsByProject().get(projectId);
    if (!ids) return [];
    
    const map = this.connectionsMap();
    return Array.from(ids)
      .map(id => map.get(id))
      .filter((c): c is Connection => !!c);
  }
  
  /** 设置连接 - 原地修改，O(1)，含脏检查 */
  setConnection(connection: Connection, projectId: string): void {
    const existing = this.connectionsMap().get(connection.id);
    const previousProjectId = this.connectionProjectMap().get(connection.id);
    if (existing && previousProjectId === projectId && isSameRevision(existing, connection)) return;
    this.connectionsMap.update(map => { map.set(connection.id, connection); return map; });
    this.connectionsByProject.update(map => {
      detachEntityFromPreviousProject(map, connection.id, previousProjectId, projectId);
      if (!map.has(projectId)) map.set(projectId, new Set());
      map.get(projectId)!.add(connection.id);
      return map;
    });
    this.connectionProjectMap.update(map => { map.set(connection.id, projectId); return map; });
  }

  /** 批量设置连接 */
  setConnections(connections: Connection[], projectId: string): void {
    const previousIds = new Set(this.connectionsByProject().get(projectId) ?? []);
    const incomingIds = new Set(connections.map(connection => connection.id));
    const previousProjectByConnectionId = new Map(
      connections.map(connection => [connection.id, this.connectionProjectMap().get(connection.id)]),
    );
    const ownershipSnapshot = new Map(this.connectionProjectMap());

    this.connectionsMap.update(map => {
      for (const id of previousIds) {
        if (!incomingIds.has(id) && ownershipSnapshot.get(id) === projectId) map.delete(id);
      }
      connections.forEach(connection => map.set(connection.id, connection));
      return map;
    });
    this.connectionsByProject.update(map => {
      for (const connection of connections) {
        detachEntityFromPreviousProject(map, connection.id, previousProjectByConnectionId.get(connection.id), projectId);
      }
      map.set(projectId, incomingIds);
      return map;
    });
    this.connectionProjectMap.update(map => {
      for (const id of previousIds) {
        if (!incomingIds.has(id) && map.get(id) === projectId) map.delete(id);
      }
      for (const connection of connections) map.set(connection.id, projectId);
      return map;
    });
  }

  /** 删除连接 */
  removeConnection(id: string, projectId: string): void {
    const ownerProjectId = this.connectionProjectMap().get(id) ?? projectId;
    this.connectionsMap.update(map => { map.delete(id); return map; });
    this.connectionsByProject.update(map => {
      map.get(ownerProjectId)?.delete(id);
      if (ownerProjectId !== projectId) map.get(projectId)?.delete(id);
      return map;
    });
    this.connectionProjectMap.update(map => { map.delete(id); return map; });
  }

  /** 批量更新连接 - 含脏检查 */
  bulkSetConnections(connections: Connection[], projectId: string): void {
    const map = this.connectionsMap();
    const previousProjectByConnectionId = new Map(
      connections.map(connection => [connection.id, this.connectionProjectMap().get(connection.id)]),
    );
    let hasEntityChange = false;
    let hasOwnershipChange = false;
    for (const c of connections) {
      const existing = map.get(c.id);
      if (!existing || !isSameRevision(existing, c)) {
        map.set(c.id, c);
        hasEntityChange = true;
      }
      if (previousProjectByConnectionId.get(c.id) !== projectId) {
        this.connectionProjectMap().set(c.id, projectId);
        hasOwnershipChange = true;
      }
    }
    if (hasEntityChange) {
      this.connectionsMap.update(m => m);
    }
    if (hasOwnershipChange) {
      this.connectionProjectMap.update(map => map);
    }
    this.connectionsByProject.update(indexMap => {
      for (const connection of connections) {
        detachEntityFromPreviousProject(indexMap, connection.id, previousProjectByConnectionId.get(connection.id), projectId);
      }
      const existing = indexMap.get(projectId) ?? new Set<string>();
      const prevSize = existing.size;
      for (const c of connections) existing.add(c.id);
      if (existing.size !== prevSize) {
        indexMap.set(projectId, existing);
      }
      return indexMap;
    });
  }

  /** 批量删除连接 */
  bulkRemoveConnections(connectionIds: string[], projectId: string): void {
    const ownerProjectByConnectionId = new Map(connectionIds.map(id => [id, this.connectionProjectMap().get(id) ?? projectId]));
    this.connectionsMap.update(map => { for (const id of connectionIds) map.delete(id); return map; });
    this.connectionsByProject.update(map => {
      for (const id of connectionIds) {
        const ownerProjectId = ownerProjectByConnectionId.get(id) ?? projectId;
        map.get(ownerProjectId)?.delete(id);
        if (ownerProjectId !== projectId) map.get(projectId)?.delete(id);
      }
      return map;
    });
    this.connectionProjectMap.update(map => {
      for (const id of connectionIds) map.delete(id);
      return map;
    });
  }

  /** 批量设置多个项目的连接（用于 setProjects 场景） */
  setConnectionsForMultipleProjects(entries: { connections: Connection[]; projectId: string }[]): void { assertUniqueEntityIds(entries, entry => entry.connections, 'connection');
    const previousIdsByProject = new Map(
      entries.map(({ projectId }) => [
        projectId,
        new Set(this.connectionsByProject().get(projectId) ?? []),
      ]),
    );
    const incomingProjectByConnectionId = new Map<string, string>();
    for (const { connections, projectId } of entries) {
      for (const connection of connections) incomingProjectByConnectionId.set(connection.id, projectId);
    }
    const incomingConnectionIds = new Set(incomingProjectByConnectionId.keys());
    const previousProjectByIncomingConnectionId = new Map(
      Array.from(incomingConnectionIds, connectionId => [
        connectionId,
        this.connectionProjectMap().get(connectionId),
      ]),
    );
    const ownershipSnapshot = new Map(this.connectionProjectMap());

    this.replaceConnectionEntitiesForMultipleProjects(
      entries,
      previousIdsByProject,
      incomingConnectionIds,
      ownershipSnapshot,
    );
    this.replaceConnectionProjectIndexes(
      entries,
      incomingProjectByConnectionId,
      previousProjectByIncomingConnectionId,
    );
    this.replaceConnectionOwnershipForMultipleProjects(
      previousIdsByProject,
      incomingConnectionIds,
      incomingProjectByConnectionId,
    );
  }

  private replaceConnectionEntitiesForMultipleProjects(
    entries: { connections: Connection[]; projectId: string }[],
    previousIdsByProject: Map<string, Set<string>>,
    incomingConnectionIds: Set<string>,
    ownershipSnapshot: Map<string, string>,
  ): void {
    this.connectionsMap.update(map => {
      for (const [projectId, previousIds] of previousIdsByProject) {
        for (const id of previousIds) {
          if (
            !incomingConnectionIds.has(id)
            && (ownershipSnapshot.get(id) ?? projectId) === projectId
          ) {
            map.delete(id);
          }
        }
      }
      for (const { connections } of entries) for (const c of connections) map.set(c.id, c);
      return map;
    });
  }

  private replaceConnectionProjectIndexes(
    entries: { connections: Connection[]; projectId: string }[],
    incomingProjectByConnectionId: Map<string, string>,
    previousProjectByIncomingConnectionId: Map<string, string | undefined>,
  ): void {
    this.connectionsByProject.update(map => {
      for (const [connectionId, projectId] of incomingProjectByConnectionId) {
        detachEntityFromPreviousProject(map, connectionId, previousProjectByIncomingConnectionId.get(connectionId), projectId);
      }
      for (const { connections, projectId } of entries) map.set(projectId, new Set(connections.map(c => c.id)));
      return map;
    });
  }

  private replaceConnectionOwnershipForMultipleProjects(
    previousIdsByProject: Map<string, Set<string>>,
    incomingConnectionIds: Set<string>,
    incomingProjectByConnectionId: Map<string, string>,
  ): void {
    this.connectionProjectMap.update(map => {
      for (const [projectId, previousIds] of previousIdsByProject) {
        for (const id of previousIds) {
          if (!incomingConnectionIds.has(id) && (map.get(id) ?? projectId) === projectId) {
            map.delete(id);
          }
        }
      }
      for (const [connectionId, projectId] of incomingProjectByConnectionId) {
        map.set(connectionId, projectId);
      }
      return map;
    });
  }

  /** 清除项目的所有连接 */
  clearProject(projectId: string): void {
    const ids = this.connectionsByProject().get(projectId);
    if (!ids) return;
    this.connectionsMap.update(map => { ids.forEach(id => map.delete(id)); return map; });
    this.connectionsByProject.update(map => { map.delete(projectId); return map; });
    this.connectionProjectMap.update(map => {
      for (const id of ids) map.delete(id);
      return map;
    });
  }

  /** 清除不在权威项目集合中的连接及项目索引 */
  clearProjectsExcept(projectIds: ReadonlySet<string>): void {
    for (const projectId of Array.from(this.connectionsByProject().keys())) {
      if (!projectIds.has(projectId)) this.clearProject(projectId);
    }
  }
  
  /**
   * 清除所有连接
   */
  clear(): void {
    this.connectionsMap.set(new Map());
    this.connectionsByProject.set(new Map());
    this.connectionProjectMap.set(new Map());
  }
}
