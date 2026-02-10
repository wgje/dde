import { Injectable, inject, computed } from '@angular/core';
import { SimpleSyncService } from '../core-bridge';
import { LayoutService } from './layout.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ConflictDetectionService } from './conflict-detection.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { Project, Task } from '../models';
import {
  Result, OperationError, ErrorCodes, success, failure
} from '../utils/result';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import {
  ConflictResolutionStrategy,
  MergeResult,
} from './conflict-resolution.types';

// 重新导出类型以保持向后兼容
export type {
  ConflictResolutionStrategy,
  ConflictData,
  MergeResult,
  TombstoneQueryResult,
  RecoveredTaskInfo,
  MergeStats
} from './conflict-resolution.types';

/**
 * 冲突解决服务（LWW 简化版）
 * 
 * 采用 Last-Write-Wins 策略：
 * - 默认使用本地版本（用户刚刚编辑的内容）
 * - 用户可选择使用远程版本
 * - 支持简单的智能合并（保留双方新增的任务）
 * 
 * 职责：
 * - 冲突检测
 * - LWW 策略执行
 * - 离线数据重连合并
 */
@Injectable({
  providedIn: 'root'
})
export class ConflictResolutionService {
  private readonly conflictDetection = inject(ConflictDetectionService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private syncService = inject(SimpleSyncService);
  private layoutService = inject(LayoutService);
  private toast = inject(ToastService);
  private readonly loggerService = inject(LoggerService);
  private logger = this.loggerService.category('ConflictResolution');

  // ========== 冲突状态 ==========
  
  /** 是否有冲突 */
  readonly hasConflict = computed(() => this.syncService.syncState().hasConflict);
  
  /** 冲突数据 */
  readonly conflictData = computed(() => this.syncService.syncState().conflictData);

  // ========== 公共方法 ==========

  /**
   * 解决冲突（LWW 简化版）
   * @param projectId 项目 ID
   * @param strategy 解决策略: local（本地优先）, remote（远程优先）, merge（智能合并）
   * @param localProject 本地项目
   * @param remoteProject 远程项目
   * @returns 解决后的项目
   */
  async resolveConflict(
    projectId: string,
    strategy: ConflictResolutionStrategy,
    localProject: Project,
    remoteProject?: Project
  ): Promise<Result<Project, OperationError>> {
    this.logger.info('[LWW] 解决冲突', { projectId, strategy });
    
    let resolvedProject: Project;
    
    switch (strategy) {
      case 'local':
        // LWW：使用本地版本（用户刚编辑的内容），递增版本号
        resolvedProject = {
          ...localProject,
          version: Math.max(localProject.version ?? 0, remoteProject?.version ?? 0) + 1
        };
        this.syncService.resolveConflict(projectId, resolvedProject, 'local');
        this.toast.success('已使用本地版本', '您的编辑已保留');
        break;
        
      case 'remote':
        // 使用远程版本
        if (!remoteProject) {
          return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
        }
        resolvedProject = this.validateAndRebalance(remoteProject);
        this.syncService.resolveConflict(projectId, resolvedProject, 'remote');
        this.toast.success('已使用远程版本', '已同步其他设备的内容');
        break;
        
      case 'merge':
        // 智能合并：保留双方新增的任务，冲突时本地优先
        if (!remoteProject) {
          return failure(ErrorCodes.DATA_NOT_FOUND, '远程项目数据不存在');
        }
        // 【v5.9 关键修复】获取 tombstoneIds 防止已删除任务在合并时复活
        // 使用带状态的方法，以便在查询失败时保守处理
        const tombstoneResult = await this.syncService.getTombstoneIdsWithStatus(projectId);
        const mergeResult = this.smartMerge(
          localProject, 
          remoteProject, 
          tombstoneResult.ids,
          tombstoneResult.localCacheOnly // 传入查询状态用于保守处理
        );
        resolvedProject = mergeResult.project;
        
        if (mergeResult.issues.length > 0) {
          this.toast.info('智能合并完成', `已自动修复 ${mergeResult.issues.length} 个数据问题`);
        }
        if (mergeResult.conflictCount > 0) {
          this.toast.warning('合并提示', `${mergeResult.conflictCount} 个任务存在修改冲突，已使用本地版本`);
        }
        
        // 【v5.9】如果 tombstone 查询失败，警告用户
        if (tombstoneResult.localCacheOnly && tombstoneResult.ids.size === 0) {
          this.toast.warning('合并提示', '无法确认远程删除状态，已保守处理');
        }
        
        this.syncService.resolveConflict(projectId, resolvedProject, 'local');
        break;
      
      default:
        // 未知策略，默认使用本地
        this.logger.warn('[LWW] 未知策略，默认使用本地', { strategy });
        resolvedProject = {
          ...localProject,
          version: Math.max(localProject.version ?? 0, remoteProject?.version ?? 0) + 1
        };
        this.syncService.resolveConflict(projectId, resolvedProject, 'local');
    }
    
    return success(resolvedProject);
  }

  /**
   * 保留两者策略 - 简化版合并
   * 
   * 策略：
   * 1. 使用远程版本作为"有效"记录
   * 2. 将本地版本中仅存在于本地的任务保留
   * 3. 对于冲突的任务（双方都有但不同），创建副本
   * 
   * 这比复杂的智能合并更简单、更安全，适合个人应用场景。
   * 
   * @param projectId 项目 ID
   * @param localProject 本地项目
   * @param remoteProject 远程项目（可选）
   * @returns 解决后的项目
   */
  async resolveKeepBoth(
    projectId: string,
    localProject: Project,
    remoteProject?: Project
  ): Promise<Result<Project, OperationError>> {
    this.logger.info('[KeepBoth] 保留两者', { projectId });
    
    if (!remoteProject) {
      // 没有远程版本，直接使用本地
      return this.resolveConflict(projectId, 'local', localProject);
    }
    
    const localTasks = Array.isArray(localProject.tasks) ? localProject.tasks : [];
    const remoteTasks = Array.isArray(remoteProject.tasks) ? remoteProject.tasks : [];
    
    const remoteTaskMap = new Map(remoteTasks.map(t => [t.id, t]));
    const mergedTasks: Task[] = [...remoteTasks]; // 从远程任务开始
    let copiedCount = 0;
    
    for (const localTask of localTasks) {
      const remoteTask = remoteTaskMap.get(localTask.id);
      
      if (!remoteTask) {
        // 本地独有的任务，保留
        mergedTasks.push(localTask);
      } else {
        // 双方都有的任务，检查是否有冲突
        const isSame = localTask.title === remoteTask.title && 
                       localTask.content === remoteTask.content &&
                       localTask.status === remoteTask.status;
        
        if (!isSame) {
          // 有冲突，创建本地版本的副本
          const copyTask: Task = {
            ...localTask,
            id: crypto.randomUUID(), // 新 ID
            title: `${localTask.title} (副本)`,
            displayId: '', // 将由布局服务重新计算
            shortId: this.conflictDetection.generateShortId(), // 生成新的永久短 ID
            updatedAt: new Date().toISOString()
          };
          mergedTasks.push(copyTask);
          copiedCount++;
        }
        // 如果相同，远程版本已经在 mergedTasks 中了
      }
    }
    
    // 合并 connections（简单去重）
    const localConnections = Array.isArray(localProject.connections) ? localProject.connections : [];
    const remoteConnections = Array.isArray(remoteProject.connections) ? remoteProject.connections : [];
    const connectionMap = new Map(remoteConnections.map(c => [c.id, c]));
    for (const localConn of localConnections) {
      if (!connectionMap.has(localConn.id)) {
        connectionMap.set(localConn.id, localConn);
      }
    }
    
    // 构建合并后的项目
    let resolvedProject: Project = {
      ...remoteProject, // 使用远程项目元数据
      tasks: mergedTasks,
      connections: Array.from(connectionMap.values()),
      updatedAt: new Date().toISOString(),
      version: Math.max(localProject.version ?? 0, remoteProject.version ?? 0) + 1
    };
    
    // 执行完整性检查和布局修复
    const { project: validatedProject, issues } = this.layoutService.validateAndFixTree(resolvedProject);
    resolvedProject = validatedProject;
    
    if (issues.length > 0) {
      this.logger.info('[KeepBoth] 修复了数据问题', { count: issues.length });
    }
    
    this.syncService.resolveConflict(projectId, resolvedProject, 'local');
    
    if (copiedCount > 0) {
      this.toast.success('已保留两者', `创建了 ${copiedCount} 个副本任务`);
    } else {
      this.toast.success('已保留两者', '本地独有的任务已保留');
    }
    
    return success(resolvedProject);
  }

  /**
   * 智能合并两个项目（LWW 二路合并）
   * 策略：
   * 1. 新增任务：双方都保留
   * 2. 删除任务：双方都执行
   * 3. 修改冲突：字段级合并 - 选择每个字段较新的版本
   * 4. 合并后执行完整性检查
   * 
   * 【关键修复】正确处理已删除任务：
   * - 本地存在但远程不存在 + 在 tombstones 中 = 远程已删除，不保留
   * - 本地存在但远程不存在 + 不在 tombstones 中 = 本地新增，保留
   * 
   * 【v5.9 保守处理】当 tombstone 查询失败时：
   * - 如果本地任务不在远程中，且本地缓存为空，则保守地不添加（防止复活）
   * - 记录警告日志和 Sentry 事件
   * 
   * @param local 本地项目
   * @param remote 远程项目
   * @param tombstoneIds 已永久删除的任务 ID 集合（必需参数，用于防止已删除任务复活）
   * @param tombstoneQueryFailed 是否 tombstone 查询失败（仅使用本地缓存）
   */
  smartMerge(
    local: Project, 
    remote: Project, 
    tombstoneIds: Set<string>,
    tombstoneQueryFailed: boolean = false
  ): MergeResult {
    const issues: string[] = [];
    let conflictCount = 0;
    
    // 防御性检查：确保 tasks 数组存在
    const localTasks = Array.isArray(local.tasks) ? local.tasks : [];
    const remoteTasks = Array.isArray(remote.tasks) ? remote.tasks : [];
    const localConnections = Array.isArray(local.connections) ? local.connections : [];
    const remoteConnections = Array.isArray(remote.connections) ? remote.connections : [];
    
    if (!Array.isArray(local.tasks)) {
      this.logger.warn('smartMerge: local.tasks 不是数组，使用空数组', { projectId: local.id });
      issues.push('本地项目 tasks 数据异常，已使用空数组');
    }
    if (!Array.isArray(remote.tasks)) {
      this.logger.warn('smartMerge: remote.tasks 不是数组，使用空数组', { projectId: remote.id });
      issues.push('远程项目 tasks 数据异常，已使用空数组');
    }
    
    // 【v5.9】tombstone 查询失败时的保守处理标记
    if (tombstoneQueryFailed && tombstoneIds.size === 0) {
      this.logger.warn('smartMerge: tombstone 查询失败且本地缓存为空，启用保守模式', { 
        projectId: local.id 
      });
      this.sentryLazyLoader.captureMessage('smartMerge 启用保守模式', {
        level: 'warning',
        tags: { operation: 'smartMerge', projectId: local.id },
        extra: { reason: 'tombstone 查询失败且本地缓存为空' }
      });
      issues.push('无法确认远程删除状态，已启用保守合并模式');
    }
    
    // 创建任务映射
    const _localTaskMap = new Map(localTasks.map(t => [t.id, t]));
    const remoteTaskMap = new Map(remoteTasks.map(t => [t.id, t]));
    
    const mergedTasks: Task[] = [];
    const processedIds = new Set<string>();
    let skippedTombstoneCount = 0;
    let preservedSoftDeleteCount = 0;
    let conservativeSkipCount = 0; // v5.9: 保守跳过计数
    
    // 处理本地任务
    for (const localTask of localTasks) {
      processedIds.add(localTask.id);
      
      // 【关键修复】检查是否已被永久删除（在 tombstones 中）
      if (tombstoneIds.has(localTask.id)) {
        this.logger.info('smartMerge: 跳过 tombstone 任务', { taskId: localTask.id });
        skippedTombstoneCount++;
        continue; // 不保留已永久删除的任务
      }
      
      const remoteTask = remoteTaskMap.get(localTask.id);
      
      // 【v5.9 保守处理】tombstone 查询失败时的特殊处理
      // 【P0-08 修复】不再丢弃用户数据 —— 保留所有本地任务，宁可让已删除任务复活也不丢失用户编辑
      // 在无法确认 tombstone 状态时，保守地保留本地任务
      if (!remoteTask && tombstoneQueryFailed && tombstoneIds.size === 0) {
        this.logger.warn('smartMerge: tombstone 不可用，保守保留本地任务', { 
          taskId: localTask.id
        });
        mergedTasks.push(localTask);
        conservativeSkipCount++;
        continue;
      }
      
      // 【BUG 修复】软删除任务的处理
      // 情况 1: 本地软删除，远程不存在 → 保留本地软删除状态
      // 情况 2: 本地软删除，远程存在 → 执行字段合并（保留删除状态）
      if (localTask.deletedAt) {
        if (!remoteTask) {
          // 远程不存在该任务，保留本地的软删除任务
          this.logger.debug('smartMerge: 保留软删除任务（远程不存在）', { taskId: localTask.id });
          mergedTasks.push(localTask);
          preservedSoftDeleteCount++;
          continue;
        }
        // 远程存在，继续执行字段合并，让 mergeTaskFields 处理 deletedAt
      }
      
      if (!remoteTask) {
        // 本地存在但远程不存在
        // 由于已经过滤了 tombstones，这里是真正的本地新增任务
        mergedTasks.push(localTask);
        continue;
      }
      
      // 双方都有的任务，执行字段级合并（传入 projectId 用于字段锁检查）
      const { mergedTask, hasConflict, contentConflictCopy } = this.conflictDetection.mergeTaskFields(localTask, remoteTask, local.id);
      
      if (hasConflict) {
        conflictCount++;
        this.logger.debug('任务存在字段冲突，已合并', { taskId: localTask.id });
      }
      
      mergedTasks.push(mergedTask);
      
      // 【LWW 缺陷修复】如果 content 存在真正冲突，创建冲突副本
      // 而不是尝试自动合并 - 让用户手动处理
      if (contentConflictCopy) {
        mergedTasks.push(contentConflictCopy);
        this.logger.info('smartMerge: 创建 content 冲突副本', { 
          originalId: localTask.id,
          copyId: contentConflictCopy.id,
          copyTitle: contentConflictCopy.title
        });
        issues.push(`任务 "${localTask.title || localTask.displayId}" 存在内容冲突，已创建副本`);
      }
    }
    
    // 处理远程新增的任务
    for (const remoteTask of remoteTasks) {
      if (!processedIds.has(remoteTask.id)) {
        // 远程任务不在 tombstones 中才添加（loadFullProject 已经过滤了）
        // 但本地也可能有软删除状态
        if (!remoteTask.deletedAt) {
          mergedTasks.push(remoteTask);
        }
      }
    }
    
    if (skippedTombstoneCount > 0) {
      this.logger.info('smartMerge: 已过滤 tombstone 任务', { 
        count: skippedTombstoneCount, 
        projectId: local.id 
      });
      issues.push(`已过滤 ${skippedTombstoneCount} 个已删除的任务`);
    }
    
    if (preservedSoftDeleteCount > 0) {
      this.logger.info('smartMerge: 保留软删除任务', { 
        count: preservedSoftDeleteCount, 
        projectId: local.id 
      });
    }
    
    // 【v5.9】记录保守跳过的任务
    if (conservativeSkipCount > 0) {
      this.logger.warn('smartMerge: 保守模式跳过任务', { 
        count: conservativeSkipCount, 
        projectId: local.id 
      });
      issues.push(`保守模式跳过 ${conservativeSkipCount} 个可能已删除的任务`);
      this.sentryLazyLoader.captureMessage('smartMerge 保守跳过任务', {
        level: 'warning',
        tags: { operation: 'smartMerge', projectId: local.id },
        extra: { conservativeSkipCount }
      });
    }
    
    // 合并 connections
    const mergedConnections = this.conflictDetection.mergeConnections(localConnections, remoteConnections);
    
    // 构建合并后的项目
    let mergedProject: Project = {
      ...local,
      tasks: mergedTasks,
      connections: mergedConnections,
      updatedAt: new Date().toISOString(),
      // 使用较大的版本号 + 1
      version: Math.max(local.version ?? 0, remote.version ?? 0) + 1
    };
    
    // 合并后执行完整性检查
    const { project: validatedProject, issues: validationIssues } = 
      this.layoutService.validateAndFixTree(mergedProject);
    
    issues.push(...validationIssues);
    mergedProject = validatedProject;
    
    return {
      project: mergedProject,
      issues,
      conflictCount
    };
  }

  /**
   * 在重新连接时合并离线数据
   * 比较离线缓存和云端数据，将离线期间的修改同步到云端
   */
  async mergeOfflineDataOnReconnect(
    cloudProjects: Project[],
    offlineProjects: Project[],
    userId: string
  ): Promise<{ projects: Project[]; syncedCount: number; conflictProjects: Project[] }> {
    const cloudMap = new Map(cloudProjects.map(p => [p.id, p]));
    const mergedProjects: Project[] = [...cloudProjects];
    const conflictProjects: Project[] = [];
    let syncedCount = 0;
    
    for (const offlineProject of offlineProjects) {
      // 【P0-07 修复】不再过滤软删除任务 —— 软删除状态需要同步到服务器
      // 否则离线删除的任务在下次拉取时会复活
      const cleanedOfflineProject = offlineProject;
      
      const cloudProject = cloudMap.get(cleanedOfflineProject.id);
      
      if (!cloudProject) {
        // 离线创建的新项目，需要上传到云端
        const result = await this.syncService.saveProjectToCloud(cleanedOfflineProject, userId);
        if (result.success) {
          mergedProjects.push(cleanedOfflineProject);
          syncedCount++;
          this.logger.info('离线新建项目已同步', { projectName: cleanedOfflineProject.name });
        }
        continue;
      }
      
      // 比较版本号
      const offlineVersion = cleanedOfflineProject.version ?? 0;
      const cloudVersion = cloudProject.version ?? 0;
      
      if (offlineVersion > cloudVersion) {
        // 离线版本更新，需要同步到云端
        const projectToSync = {
          ...cleanedOfflineProject,
          version: Math.max(offlineVersion, cloudVersion) + 1
        };
        
        const result = await this.syncService.saveProjectToCloud(projectToSync, userId);
        if (result.success) {
          const idx = mergedProjects.findIndex(p => p.id === cleanedOfflineProject.id);
          if (idx !== -1) {
            mergedProjects[idx] = projectToSync;
          }
          syncedCount++;
          this.logger.info('离线修改已同步', { projectName: cleanedOfflineProject.name });
        } else if (result.conflict) {
          // 存在冲突
          conflictProjects.push(cleanedOfflineProject);
          this.logger.warn('离线数据存在冲突', { projectName: cleanedOfflineProject.name });
        }
      }
    }
    
    return { projects: mergedProjects, syncedCount, conflictProjects };
  }

  /**
   * 同步黑匣子数据（重连时调用）
   * 确保离线期间的黑匣子条目在重连时同步到服务器
   */
  async syncBlackBoxOnReconnect(): Promise<void> {
    try {
      await this.blackBoxSync.forceSync();
      this.logger.info('黑匣子数据重连同步完成');
    } catch (e) {
      this.logger.error('黑匣子数据重连同步失败', e);
    }
  }

  // ========== 私有方法 ==========

  /**
   * 验证并重平衡项目
   */
  private validateAndRebalance(project: Project): Project {
    const { project: validatedProject } = this.layoutService.validateAndFixTree(project);
    return this.layoutService.rebalance(validatedProject);
  }
}
