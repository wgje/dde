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
 */

import { Injectable, signal, computed } from '@angular/core';
import { Project, Task, Connection } from '../../../models';

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
  
  /**
   * 获取单个任务 - O(1)
   */
  getTask(id: string): Task | undefined {
    return this.tasksMap().get(id);
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
  
  /** 设置任务（单个）- 原地修改，O(1) */
  setTask(task: Task, projectId: string): void {
    this.tasksMap.update(map => { map.set(task.id, task); return map; });
    this.tasksByProject.update(map => {
      if (!map.has(projectId)) map.set(projectId, new Set());
      map.get(projectId)!.add(task.id);
      return map;
    });
  }

  /** 批量设置任务 */
  setTasks(tasks: Task[], projectId: string): void {
    this.tasksMap.update(map => { tasks.forEach(t => map.set(t.id, t)); return map; });
    this.tasksByProject.update(map => {
      map.set(projectId, new Set(tasks.map(t => t.id)));
      return map;
    });
  }

  /** 删除任务 - O(1) */
  removeTask(id: string, projectId: string): void {
    this.tasksMap.update(map => { map.delete(id); return map; });
    this.tasksByProject.update(map => { map.get(projectId)?.delete(id); return map; });
  }

  /** 批量更新任务 */
  bulkSetTasks(tasks: Task[], projectId: string): void {
    this.tasksMap.update(map => { for (const t of tasks) map.set(t.id, t); return map; });
    this.tasksByProject.update(map => {
      const existing = map.get(projectId) ?? new Set<string>();
      for (const t of tasks) existing.add(t.id);
      map.set(projectId, existing);
      return map;
    });
  }

  /** 批量删除任务 */
  bulkRemoveTasks(taskIds: string[], projectId: string): void {
    this.tasksMap.update(map => { for (const id of taskIds) map.delete(id); return map; });
    this.tasksByProject.update(map => {
      const existing = map.get(projectId);
      if (existing) for (const id of taskIds) existing.delete(id);
      return map;
    });
  }

  /** 批量设置多个项目的任务（用于 setProjects 场景） */
  setTasksForMultipleProjects(entries: { tasks: Task[]; projectId: string }[]): void {
    this.tasksMap.update(map => {
      for (const { tasks } of entries) for (const t of tasks) map.set(t.id, t);
      return map;
    });
    this.tasksByProject.update(map => {
      for (const { tasks, projectId } of entries) map.set(projectId, new Set(tasks.map(t => t.id)));
      return map;
    });
  }

  /** 清除项目的所有任务 */
  clearProject(projectId: string): void {
    const taskIds = this.tasksByProject().get(projectId);
    if (!taskIds) return;
    this.tasksMap.update(map => { taskIds.forEach(id => map.delete(id)); return map; });
    this.tasksByProject.update(map => { map.delete(projectId); return map; });
  }
  
  /**
   * 清除所有任务
   */
  clear(): void {
    this.tasksMap.set(new Map());
    this.tasksByProject.set(new Map());
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
  
  /** 设置项目 - 原地修改，O(1) */
  setProject(project: Project): void {
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

  /** 批量更新项目 */
  bulkSetProjects(projects: Project[]): void {
    this.projectsMap.update(map => { for (const p of projects) map.set(p.id, p); return map; });
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

  /** 连接列表 */
  readonly connections = computed(() => Array.from(this.connectionsMap().values()));
  
  /**
   * 获取单个连接 - O(1)
   */
  getConnection(id: string): Connection | undefined {
    return this.connectionsMap().get(id);
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
  
  /** 设置连接 - 原地修改，O(1) */
  setConnection(connection: Connection, projectId: string): void {
    this.connectionsMap.update(map => { map.set(connection.id, connection); return map; });
    this.connectionsByProject.update(map => {
      if (!map.has(projectId)) map.set(projectId, new Set());
      map.get(projectId)!.add(connection.id);
      return map;
    });
  }

  /** 批量设置连接 */
  setConnections(connections: Connection[], projectId: string): void {
    this.connectionsMap.update(map => { connections.forEach(c => map.set(c.id, c)); return map; });
    this.connectionsByProject.update(map => {
      map.set(projectId, new Set(connections.map(c => c.id)));
      return map;
    });
  }

  /** 删除连接 */
  removeConnection(id: string, projectId: string): void {
    this.connectionsMap.update(map => { map.delete(id); return map; });
    this.connectionsByProject.update(map => { map.get(projectId)?.delete(id); return map; });
  }

  /** 批量更新连接 */
  bulkSetConnections(connections: Connection[], projectId: string): void {
    this.connectionsMap.update(map => { for (const c of connections) map.set(c.id, c); return map; });
    this.connectionsByProject.update(map => {
      const existing = map.get(projectId) ?? new Set<string>();
      for (const c of connections) existing.add(c.id);
      map.set(projectId, existing);
      return map;
    });
  }

  /** 批量删除连接 */
  bulkRemoveConnections(connectionIds: string[], projectId: string): void {
    this.connectionsMap.update(map => { for (const id of connectionIds) map.delete(id); return map; });
    this.connectionsByProject.update(map => {
      const existing = map.get(projectId);
      if (existing) for (const id of connectionIds) existing.delete(id);
      return map;
    });
  }

  /** 批量设置多个项目的连接（用于 setProjects 场景） */
  setConnectionsForMultipleProjects(entries: { connections: Connection[]; projectId: string }[]): void {
    this.connectionsMap.update(map => {
      for (const { connections } of entries) for (const c of connections) map.set(c.id, c);
      return map;
    });
    this.connectionsByProject.update(map => {
      for (const { connections, projectId } of entries) map.set(projectId, new Set(connections.map(c => c.id)));
      return map;
    });
  }

  /** 清除项目的所有连接 */
  clearProject(projectId: string): void {
    const ids = this.connectionsByProject().get(projectId);
    if (!ids) return;
    this.connectionsMap.update(map => { ids.forEach(id => map.delete(id)); return map; });
    this.connectionsByProject.update(map => { map.delete(projectId); return map; });
  }
  
  /**
   * 清除所有连接
   */
  clear(): void {
    this.connectionsMap.set(new Map());
    this.connectionsByProject.set(new Map());
  }
}
