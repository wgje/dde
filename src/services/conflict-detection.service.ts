import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { Task, Project } from '../models';

/**
 * 冲突检测服务
 *
 * 负责字段级冲突检测与合并工具方法：
 * - 任务字段级合并（LWW + 字段锁）
 * - 内容冲突检测与相似度计算
 * - 文本 / 行级合并
 * - 连接合并（Tombstone Wins）
 * - 标签智能合并
 *
 * 从 ConflictResolutionService 拆分而来，保持单一职责。
 */
@Injectable({
  providedIn: 'root'
})
export class ConflictDetectionService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConflictDetection');

  // ========== 短 ID 生成 ==========

  /**
   * 生成永久短 ID（如 "NF-A1B2"）
   */
  generateShortId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = 'NF-';
    for (let i = 0; i < 4; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // ========== 任务字段级合并 ==========

  /**
   * 字段级任务合并
   * 对每个字段单独判断，使用更新时间更晚的版本
   * 如果两个版本的更新时间相同，优先使用本地版本
   *
   * 【关键修复】字段锁检查
   * 如果某个字段被锁定（用户正在编辑），则始终使用本地版本
   * 这防止了在状态切换后同步导致的状态回滚问题
   *
   * 【LWW 缺陷修复】content 冲突处理
   * 对于 content 字段的真正冲突（双方都有有意义的不同修改），
   * 不再尝试自动合并，而是：
   * - 使用远程版本作为主版本
   * - 创建本地版本的冲突副本供用户手动合并
   *
   * @param local 本地任务
   * @param remote 远程任务
   * @param projectId 项目 ID（用于字段锁检查）
   * @returns mergedTask: 合并后的任务, hasConflict: 是否存在冲突,
   *          contentConflictCopy: 如果 content 存在真正冲突则创建的副本
   */
  mergeTaskFields(local: Task, remote: Task, projectId: string): {
    mergedTask: Task;
    hasConflict: boolean;
    contentConflictCopy?: Task
  } {
    const localTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;

    // 确定基础版本（使用更新时间较新的）
    const baseTask = remoteTime > localTime ? remote : local;

    let hasConflict = false;
    let contentConflictCopy: Task | undefined = undefined;

    // 字段级合并：检查每个可编辑字段
    const mergedTask: Task = { ...baseTask };

    // 【关键】检查字段锁：获取当前被锁定的字段
    const lockedFields = this.changeTracker.getLockedFields(local.id, projectId);
    const isFieldLocked = (field: string) => lockedFields.includes(field);

    // 标题：如果不同，检测是否是有意义的编辑
    if (local.title !== remote.title) {
      hasConflict = true;
      // 【字段锁检查】如果 title 被锁定，始终使用本地版本
      if (isFieldLocked('title')) {
        mergedTask.title = local.title;
        this.logger.debug('mergeTaskFields: title 被锁定，使用本地版本', { taskId: local.id });
      } else {
        mergedTask.title = remoteTime > localTime ? remote.title : local.title;
      }
    }

    // 内容：如果不同，检测是否需要创建冲突副本
    if (local.content !== remote.content) {
      hasConflict = true;
      // 【字段锁检查】如果 content 被锁定，始终使用本地版本
      if (isFieldLocked('content')) {
        mergedTask.content = local.content;
        this.logger.debug('mergeTaskFields: content 被锁定，使用本地版本', { taskId: local.id });
      } else {
        // 【LWW 缺陷修复】检测是否是真正的冲突
        // 真正冲突的定义：双方内容都有实质性修改，且不是简单的扩展关系
        const isRealConflict = this.isRealContentConflict(local.content, remote.content);

        if (isRealConflict) {
          // 真正冲突：使用远程版本，创建本地版本的副本
          mergedTask.content = remote.content;

          // 创建冲突副本 - 包含本地的 content
          contentConflictCopy = {
            ...local,
            id: crypto.randomUUID(),
            title: `${local.title || '未命名任务'} (冲突副本)`,
            displayId: '', // 将由布局服务重新计算
            shortId: this.generateShortId(),
            content: local.content, // 保留本地内容
            updatedAt: new Date().toISOString(),
            // 将副本放在原任务附近
            x: local.x + 50,
            y: local.y + 50,
          };

          this.logger.warn('mergeTaskFields: content 真正冲突，创建副本', {
            taskId: local.id,
            localContentLength: local.content?.length,
            remoteContentLength: remote.content?.length
          });

          // 发送 Sentry 事件
          this.sentryLazyLoader.captureMessage('Content conflict detected, created copy', {
            level: 'info',
            tags: { operation: 'mergeTaskFields', taskId: local.id },
            extra: {
              localContentLength: local.content?.length,
              remoteContentLength: remote.content?.length,
              copyId: contentConflictCopy.id
            }
          });
        } else {
          // 非真正冲突：尝试智能合并（如果两边都有添加）
          const mergedContent = this.mergeTextContent(local.content, remote.content, localTime, remoteTime);
          mergedTask.content = mergedContent;
        }
      }
    }

    // 状态：如果不同，使用更新时间较新的
    if (local.status !== remote.status) {
      hasConflict = true;
      // 【字段锁检查】如果 status 被锁定，始终使用本地版本
      // 这是防止状态回滚的关键修复
      if (isFieldLocked('status')) {
        mergedTask.status = local.status;
        this.logger.debug('mergeTaskFields: status 被锁定，使用本地版本', {
          taskId: local.id,
          localStatus: local.status,
          remoteStatus: remote.status
        });
      } else {
        mergedTask.status = remoteTime > localTime ? remote.status : local.status;
      }
    }

    // 优先级：如果不同，使用更新时间较新的
    if (local.priority !== remote.priority) {
      hasConflict = true;
      // 【字段锁检查】
      if (isFieldLocked('priority')) {
        mergedTask.priority = local.priority;
      } else {
        mergedTask.priority = remoteTime > localTime ? remote.priority : local.priority;
      }
    }

    // 截止日期：如果不同，使用更新时间较新的
    if (local.dueDate !== remote.dueDate) {
      hasConflict = true;
      // 【字段锁检查】
      if (isFieldLocked('dueDate')) {
        mergedTask.dueDate = local.dueDate;
      } else {
        mergedTask.dueDate = remoteTime > localTime ? remote.dueDate : local.dueDate;
      }
    }

    // 标签：智能合并两边的标签
    if (local.tags || remote.tags) {
      const localTags = local.tags || [];
      const remoteTags = remote.tags || [];
      const mergedTags = this.mergeTagsWithIntent(localTags, remoteTags, localTime, remoteTime);
      mergedTask.tags = mergedTags.length > 0 ? mergedTags : undefined;
      // 标签变化也算冲突
      if (local.tags?.length !== remote.tags?.length ||
          !localTags.every(t => remoteTags.includes(t))) {
        hasConflict = true;
      }
    }

    // 附件：合并两边的附件（按 ID 去重）
    if (local.attachments || remote.attachments) {
      const localAttachments = local.attachments || [];
      const remoteAttachments = remote.attachments || [];
      const attachmentMap = new Map<string, typeof localAttachments[0]>();

      // 先添加本地附件
      localAttachments.forEach(a => attachmentMap.set(a.id, a));
      // 远程附件覆盖（如果存在）
      remoteAttachments.forEach(a => {
        if (!attachmentMap.has(a.id) || remoteTime > localTime) {
          attachmentMap.set(a.id, a);
        }
      });

      mergedTask.attachments = Array.from(attachmentMap.values());
    }

    // 位置信息：保留本地位置（避免拖拽位置被覆盖）
    mergedTask.x = local.x;
    mergedTask.y = local.y;

    // 阶段、父级、排序：使用较新版本的结构信息
    if (local.stage !== remote.stage || local.parentId !== remote.parentId || local.order !== remote.order) {
      if (remoteTime > localTime) {
        mergedTask.stage = remote.stage;
        mergedTask.parentId = remote.parentId;
        mergedTask.order = remote.order;
        mergedTask.rank = remote.rank;
      }
    }

    // 删除标记：任一方删除则删除（删除优先）
    // 这样确保在任何一个标签页删除的任务，在合并时都会保持删除状态
    if (local.deletedAt || remote.deletedAt) {
      hasConflict = true;
      // 使用最早的删除时间，或者如果只有一方删除，使用那个删除时间
      if (local.deletedAt && remote.deletedAt) {
        const localDeleteTime = new Date(local.deletedAt).getTime();
        const remoteDeleteTime = new Date(remote.deletedAt).getTime();
        mergedTask.deletedAt = localDeleteTime < remoteDeleteTime ? local.deletedAt : remote.deletedAt;
      } else {
        mergedTask.deletedAt = local.deletedAt || remote.deletedAt;
      }
    }

    // 更新合并时间戳
    mergedTask.updatedAt = new Date().toISOString();

    return { mergedTask, hasConflict, contentConflictCopy };
  }

  // ========== 内容冲突检测 ==========

  /**
   * 检测是否是真正的 content 冲突
   *
   * 真正冲突的定义：
   * - 双方内容都有实质性的、不同的修改
   * - 内容不是简单的扩展关系（一方是另一方的前缀/后缀）
   * - 内容长度都足够长（避免对空内容创建副本）
   *
   * 非真正冲突（可自动合并）：
   * - 一方是空的，另一方有内容
   * - 一方是另一方的扩展
   * - 内容很短（可能是误操作）
   *
   * @param localContent 本地内容
   * @param remoteContent 远程内容
   * @returns 是否是真正的冲突
   */
  isRealContentConflict(localContent: string, remoteContent: string): boolean {
    const local = localContent || '';
    const remote = remoteContent || '';

    // 1. 如果任一方为空或很短，不是真正冲突
    const MIN_CONTENT_LENGTH = 20; // 至少 20 个字符才算实质内容
    if (local.length < MIN_CONTENT_LENGTH || remote.length < MIN_CONTENT_LENGTH) {
      return false;
    }

    // 2. 如果一方是另一方的前缀/后缀，不是真正冲突
    if (local.startsWith(remote) || remote.startsWith(local)) {
      return false;
    }
    if (local.endsWith(remote) || remote.endsWith(local)) {
      return false;
    }

    // 3. 计算相似度 - 如果相似度太高说明改动很小，不是真正冲突
    const similarity = this.calculateSimilarity(local, remote);
    if (similarity > 0.9) { // 90% 相似度以上
      return false;
    }

    // 4. 如果差异太大，但仍有共同基础，说明是真正的冲突
    // 共同基础：至少有 30% 的内容相同
    if (similarity < 0.3) {
      // 差异太大，可能是完全不同的内容，按 LWW 处理
      return false;
    }

    // 5. 中等相似度（30%-90%）：这是真正的冲突场景
    // 用户在两个设备上都进行了有意义的编辑
    return true;
  }

  /**
   * 计算两个字符串的相似度（0-1）
   * 使用简单的字符匹配算法
   */
  calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) {
      return 1.0;
    }

    // 计算共同字符数（简化的 LCS 近似）
    const shorterSet = new Set(shorter.split(''));
    let commonChars = 0;
    for (const char of longer) {
      if (shorterSet.has(char)) {
        commonChars++;
      }
    }

    return commonChars / longer.length;
  }

  // ========== 文本合并 ==========

  /**
   * 智能合并文本内容
   * 尝试保留双方的添加
   */
  mergeTextContent(localContent: string, remoteContent: string, localTime: number, remoteTime: number): string {
    // 简单策略：如果一方的内容是另一方的前缀/后缀，则合并
    // 否则使用更新时间较新的版本

    // 检查是否一方是另一方的扩展
    if (remoteContent.startsWith(localContent)) {
      // 远程内容是本地内容的扩展，使用远程
      return remoteContent;
    }
    if (localContent.startsWith(remoteContent)) {
      // 本地内容是远程内容的扩展，使用本地
      return localContent;
    }
    if (remoteContent.endsWith(localContent)) {
      // 远程内容以本地内容结尾
      return remoteContent;
    }
    if (localContent.endsWith(remoteContent)) {
      // 本地内容以远程内容结尾
      return localContent;
    }

    // 尝试行级合并（适用于待办列表场景）
    const localLines = localContent.split('\n');
    const remoteLines = remoteContent.split('\n');

    // 如果行数差异不大，尝试合并
    if (Math.abs(localLines.length - remoteLines.length) <= 5) {
      const mergedLines = this.mergeLines(localLines, remoteLines);
      if (mergedLines) {
        return mergedLines.join('\n');
      }
    }

    // 默认：使用更新时间较新的版本
    return remoteTime > localTime ? remoteContent : localContent;
  }

  /**
   * 行级合并
   * 尝试保留双方新增的行
   */
  mergeLines(localLines: string[], remoteLines: string[]): string[] | null {
    const localSet = new Set(localLines);
    const remoteSet = new Set(remoteLines);

    // 找出双方共有的行
    const commonLines = localLines.filter(line => remoteSet.has(line));

    // 如果共有行太少，说明内容差异太大，无法行级合并
    if (commonLines.length < Math.min(localLines.length, remoteLines.length) * 0.5) {
      return null;
    }

    // 找出各自新增的行
    const localOnlyLines = localLines.filter(line => !remoteSet.has(line));
    const remoteOnlyLines = remoteLines.filter(line => !localSet.has(line));

    // 合并：保留所有共有行 + 本地新增 + 远程新增
    // 保持原有顺序：以较长的版本为基础，在合适位置插入新增行
    const baselines = localLines.length >= remoteLines.length ? localLines : remoteLines;
    const additionalLines = localLines.length >= remoteLines.length ? remoteOnlyLines : localOnlyLines;

    // 简单策略：将新增行追加到末尾
    return [...baselines, ...additionalLines.filter(line => !new Set(baselines).has(line))];
  }

  // ========== 连接合并 ==========

  /**
   * 合并连接
   *
   * 软删除策略：删除优先 (Tombstone Wins)
   * - 如果任一方软删除了连接，最终结果保持软删除状态
   * - 这确保删除操作可以正确同步到所有设备
   * - 恢复操作需要显式清除 deletedAt 字段
   *
   * 【Week 2 修复】使用 id 作为唯一键而非 source→target
   * 原因：同一 source→target 可能有多个连接（用户意图不同）
   */
  mergeConnections(
    local: Project['connections'],
    remote: Project['connections']
  ): Project['connections'] {
    // 【修复】使用 id 作为唯一键，而非 source→target
    const connMap = new Map<string, typeof local[0]>();

    // 先添加本地连接
    for (const conn of local) {
      // 使用 id 作为唯一键（如果没有 id，降级到 source→target）
      const key = conn.id || `${conn.source}->${conn.target}`;
      connMap.set(key, conn);
    }

    // 合并远程连接
    for (const conn of remote) {
      const key = conn.id || `${conn.source}->${conn.target}`;
      const existing = connMap.get(key);

      if (!existing) {
        // 远程新增的连接（或本地没有）
        connMap.set(key, conn);
      } else {
        // 两边都有同一连接，处理软删除状态
        // 策略：删除优先 (Tombstone Wins)

        if (existing.deletedAt && conn.deletedAt) {
          // 两边都删除了，使用更早的删除时间（保留删除状态）
          const existingTime = new Date(existing.deletedAt).getTime();
          const remoteTime = new Date(conn.deletedAt).getTime();
          connMap.set(key, existingTime < remoteTime ? existing : conn);
        } else if (existing.deletedAt) {
          // 本地删除了，远程没删除 —— 保持删除状态
          // 这确保本地删除可以同步到其他设备
          // 不做任何操作，保持 existing（已删除）
        } else if (conn.deletedAt) {
          // 远程删除了，本地没删除 —— 采用远程删除状态
          connMap.set(key, conn);
        } else {
          // 两边都未删除，合并描述
          if (conn.description !== existing.description) {
            // 使用较长的描述，或远程描述（如果本地为空）
            const mergedDesc = !existing.description ? conn.description
              : !conn.description ? existing.description
              : (conn.description.length > existing.description.length ? conn.description : existing.description);
            connMap.set(key, { ...existing, description: mergedDesc });
          }
        }
      }
    }

    return Array.from(connMap.values());
  }

  // ========== 标签合并 ==========

  /**
   * 智能合并标签，考虑用户意图
   *
   * 策略：
   * 1. 两边都有的标签：保留
   * 2. 只在一边新增的标签：保留（用户添加了新标签）
   * 3. 标签在一边被删除：
   *    - 如果删除方的更新时间更新，则删除该标签
   *    - 否则保留该标签
   *
   * 这样可以正确处理：
   * - 用户 A 添加标签 X，用户 B 添加标签 Y → 结果：X, Y
   * - 用户 A 删除标签 X（最后操作），用户 B 未改动 → 结果：无 X
   * - 用户 A 保留标签 X，用户 B 删除标签 X（最后操作） → 结果：无 X
   */
  mergeTagsWithIntent(
    localTags: string[],
    remoteTags: string[],
    localTime: number,
    remoteTime: number
  ): string[] {
    const localSet = new Set(localTags);
    const remoteSet = new Set(remoteTags);
    const resultSet = new Set<string>();

    // 两边都有的标签：保留
    for (const tag of localTags) {
      if (remoteSet.has(tag)) {
        resultSet.add(tag);
      }
    }

    // 只在本地有的标签：
    // - 如果本地更新时间 >= 远程，说明是本地新增或保留的，保留
    // - 如果远程更新时间更新，说明远程可能删除了这个标签，不保留
    for (const tag of localTags) {
      if (!remoteSet.has(tag)) {
        if (localTime >= remoteTime) {
          // 本地较新，保留本地新增的标签
          resultSet.add(tag);
        }
        // 否则：远程较新，远程可能是有意删除了这个标签，不保留
      }
    }

    // 只在远程有的标签：
    // - 如果远程更新时间 >= 本地，说明是远程新增的，保留
    // - 如果本地更新时间更新，说明本地可能删除了这个标签，不保留
    for (const tag of remoteTags) {
      if (!localSet.has(tag)) {
        if (remoteTime >= localTime) {
          // 远程较新，保留远程新增的标签
          resultSet.add(tag);
        }
        // 否则：本地较新，本地可能是有意删除了这个标签，不保留
      }
    }

    return Array.from(resultSet);
  }
}
