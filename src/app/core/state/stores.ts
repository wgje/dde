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

/**
 * 判断两个实体在同步意义上是否"完全相同"。
 *
 * 权威字段：`updatedAt`（LWW 单调时间戳）+ `deletedAt`（软删除/恢复标记）。
 * 任何业务字段变更都必须伴随 `updatedAt` 更新，这是 Hard Rule；否则云端也无法
 * 通过增量同步 `updated_at > last_sync_time` 感知变化。因此在 Store 层用这两个
 * 字段作为判等权威是充分的。
 *
 * 【2026-04-16 T1-1 PR-B】替代历史 `isTaskEqual` 14 字段枚举清单。
 */
function isSameRevision(
  a: { updatedAt?: string; deletedAt?: string | null } | undefined,
  b: { updatedAt?: string; deletedAt?: string | null } | undefined,
): boolean {
  if (!a || !b) return false;
  return a.updatedAt === b.updatedAt && a.deletedAt === b.deletedAt;
}

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
    // 脏检查：数据未变化时跳过 signal 通知
    if (existing && isSameRevision(existing, task)) return;
    const previousProjectId = this.taskProjectMap().get(task.id);
    this.tasksMap.update(map => { map.set(task.id, task); return map; });
    this.tasksByProject.update(map => {
      if (previousProjectId && previousProjectId !== projectId) {
        map.get(previousProjectId)?.delete(task.id);
      }
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
    // 【P2-02 修复】先清除该项目的旧任务，再添加新任务，与 bulkSetTasks 语义明确区分
    this.tasksMap.update(map => {
      // 移除该项目的旧任务
      const oldIds = this.tasksByProject().get(projectId);
      if (oldIds) {
        for (const id of oldIds) {
          map.delete(id);
          // 清理停泊索引
          this.parkedTaskIds().delete(id);
          this.taskProjectMap().delete(id);
        }
      }
      // 添加新任务
      tasks.forEach(t => {
        map.set(t.id, t);
        this.taskProjectMap().set(t.id, projectId);
      });
      return map;
    });
    this.tasksByProject.update(map => {
      map.set(projectId, new Set(tasks.map(t => t.id)));
      return map;
    });
    this.taskProjectMap.update(m => m);
    // 重建停泊索引
    for (const t of tasks) this.updateParkedIndex(t);
    this.parkedTaskIds.update(s => s);
  }

  /** 删除任务 - O(1) */
  removeTask(id: string, projectId: string): void {
    this.tasksMap.update(map => { map.delete(id); return map; });
    this.tasksByProject.update(map => { map.get(projectId)?.delete(id); return map; });
    this.taskProjectMap.update(map => { map.delete(id); return map; });
    // 移除停泊索引
    if (this.parkedTaskIds().has(id)) {
      this.parkedTaskIds.update(s => { s.delete(id); return s; });
    }
  }

  /** 批量更新任务 - 含脏检查（仅在有变化时触发 signal 更新） */
  bulkSetTasks(tasks: Task[], projectId: string): void {
    const map = this.tasksMap();
    let hasChange = false;
    for (const t of tasks) {
      const existing = map.get(t.id);
      if (!existing || !isSameRevision(existing, t)) {
        map.set(t.id, t);
        this.taskProjectMap().set(t.id, projectId);
        hasChange = true;
      }
    }
    // 仅在有实际变化时才触发 signal 通知，避免级联风暴
    if (hasChange) {
      this.tasksMap.update(m => m);
      this.taskProjectMap.update(m => m);
      // 维护停泊索引
      for (const t of tasks) this.updateParkedIndex(t);
      this.parkedTaskIds.update(s => s);
    }
    this.tasksByProject.update(indexMap => {
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
    this.tasksMap.update(map => { for (const id of taskIds) map.delete(id); return map; });
    this.tasksByProject.update(map => {
      const existing = map.get(projectId);
      if (existing) for (const id of taskIds) existing.delete(id);
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
  setTasksForMultipleProjects(entries: { tasks: Task[]; projectId: string }[]): void {
    this.tasksMap.update(map => {
      for (const { tasks, projectId } of entries) {
        for (const t of tasks) {
          map.set(t.id, t);
          this.taskProjectMap().set(t.id, projectId);
        }
      }
      return map;
    });
    this.tasksByProject.update(map => {
      for (const { tasks, projectId } of entries) map.set(projectId, new Set(tasks.map(t => t.id)));
      return map;
    });
    this.taskProjectMap.update(m => m);
    // 维护停泊索引——批量加载时同步更新 parkedTaskIds
    for (const { tasks } of entries) {
      for (const t of tasks) this.updateParkedIndex(t);
    }
    this.parkedTaskIds.update(s => s);
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
  
  /** 设置连接 - 原地修改，O(1)，含脏检查 */
  setConnection(connection: Connection, projectId: string): void {
    const existing = this.connectionsMap().get(connection.id);
    if (existing && isSameRevision(existing, connection)) return;
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

  /** 批量更新连接 - 含脏检查 */
  bulkSetConnections(connections: Connection[], projectId: string): void {
    const map = this.connectionsMap();
    let hasChange = false;
    for (const c of connections) {
      const existing = map.get(c.id);
      if (!existing || !isSameRevision(existing, c)) {
        map.set(c.id, c);
        hasChange = true;
      }
    }
    if (hasChange) {
      this.connectionsMap.update(m => m);
    }
    this.connectionsByProject.update(indexMap => {
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
