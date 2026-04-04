import { Injectable, inject } from '@angular/core';
import { LoggerService } from './logger.service';
import { Task } from '../models';

/**
 * 单个任务的自动解决建议
 */
export interface TaskResolutionRecommendation {
  /** 任务 ID */
  taskId: string;
  /** 任务标题 */
  title: string;
  /** 系统推荐选择 */
  recommendation: 'local' | 'remote';
  /** 置信度：auto（系统可直接决定）| suggest（建议用户确认）| manual（需要用户手动选择） */
  confidence: 'auto' | 'suggest' | 'manual';
  /** 人类可读的推荐理由 */
  reason: string;
  /** 详细的推理过程（供用户展开查看） */
  reasoning: string[];
  /** 本地版本编辑时间 */
  localTime?: string;
  /** 远程版本编辑时间 */
  remoteTime?: string;
  /** 冲突字段列表 */
  conflictedFields: string[];
}

/**
 * 项目级自动解决报告
 */
export interface AutoResolutionReport {
  /** 项目 ID */
  projectId: string;
  /** 所有任务的解决建议 */
  recommendations: TaskResolutionRecommendation[];
  /** 可自动解决的数量 */
  autoCount: number;
  /** 需要用户确认的数量 */
  suggestCount: number;
  /** 需要手动选择的数量 */
  manualCount: number;
  /** 生成时间 */
  generatedAt: string;
  /** 总体策略建议 */
  overallSuggestion: string;
}

type ComparableRecord = Record<string, unknown>;

/** 字段名到中文标签的映射 */
const FIELD_LABELS: Record<string, string> = {
  title: '标题', content: '内容', status: '状态', priority: '优先级',
  dueDate: '截止日期', tags: '标签', expected_minutes: '预估耗时',
  cognitive_load: '认知负荷', wait_minutes: '等待时间', attachments: '附件',
  stage: '阶段', order: '排序', parentId: '父任务', rank: '层级排序',
  x: 'X坐标', y: 'Y坐标', parkingMeta: '停泊状态',
};

/**
 * 冲突自动解决服务
 *
 * 分析本地与远程任务的差异，基于时间戳、编辑内容量、字段重要性
 * 为每个冲突任务生成人性化的解决建议和可读的推理说明。
 *
 * 策略原则：
 * - 内容编辑量大的优先保留（用户花了更多心血）
 * - 时间较新的一般优先（Last-Write-Wins 兜底）
 * - 仅位置/排序变化自动接受远端（低影响）
 * - 内容/标题同时修改标记为需手动选择（高风险）
 */
@Injectable({ providedIn: 'root' })
export class ConflictAutoResolverService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConflictAutoResolver');

  /**
   * 为一组冲突任务生成自动解决报告
   */
  analyze(
    projectId: string,
    localTasks: Task[],
    remoteTasks: Task[]
  ): AutoResolutionReport {
    const localMap = new Map(localTasks.map(t => [t.id, t]));
    const remoteMap = new Map(remoteTasks.map(t => [t.id, t]));
    const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);

    const recommendations: TaskResolutionRecommendation[] = [];

    for (const id of allIds) {
      const local = localMap.get(id);
      const remote = remoteMap.get(id);

      if (local && remote) {
        // 双方都有 — 需要分析冲突
        const recommendation = this.analyzeConflictingTask(local, remote);
        if (recommendation.conflictedFields.length > 0) {
          recommendations.push(recommendation);
        }
      } else if (local && !remote) {
        // 仅本地有 — 可能是本地新建或远程已删除
        recommendations.push({
          taskId: id,
          title: local.title || '未命名任务',
          recommendation: 'local',
          confidence: 'auto',
          reason: '此任务仅存在于本地（可能是离线时新建的），自动保留',
          reasoning: ['任务仅存在于本地', '判断为离线期间新建的任务', '自动保留以防数据丢失'],
          localTime: local.updatedAt,
          conflictedFields: [],
        });
      } else if (!local && remote) {
        // 仅远程有 — 可能是其他设备新建
        recommendations.push({
          taskId: id,
          title: remote.title || '未命名任务',
          recommendation: 'remote',
          confidence: 'auto',
          reason: '此任务仅存在于云端（来自其他设备），自动接收',
          reasoning: ['任务仅存在于云端', '判断为其他设备新建的任务', '自动接收以保持多端同步'],
          remoteTime: remote.updatedAt,
          conflictedFields: [],
        });
      }
    }

    const autoCount = recommendations.filter(r => r.confidence === 'auto').length;
    const suggestCount = recommendations.filter(r => r.confidence === 'suggest').length;
    const manualCount = recommendations.filter(r => r.confidence === 'manual').length;

    // 排序：manual > suggest > auto（需要注意的排前面）
    const order = { manual: 0, suggest: 1, auto: 2 };
    recommendations.sort((a, b) => order[a.confidence] - order[b.confidence]);

    const overallSuggestion = this.generateOverallSuggestion(autoCount, suggestCount, manualCount);

    this.logger.info('自动解决分析完成', { projectId, autoCount, suggestCount, manualCount });

    return {
      projectId,
      recommendations,
      autoCount,
      suggestCount,
      manualCount,
      generatedAt: new Date().toISOString(),
      overallSuggestion,
    };
  }

  /**
   * 分析两个版本都存在的冲突任务
   */
  private analyzeConflictingTask(local: Task, remote: Task): TaskResolutionRecommendation {
    const localTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    const reasoning: string[] = [];
    const conflictedFields: string[] = [];

    // 找出所有不同的字段
    const contentFields = this.getContentDiffFields(local, remote);
    const layoutFields = this.getLayoutDiffFields(local, remote);
    conflictedFields.push(...contentFields, ...layoutFields);

    // 没有差异 — 自动跳过
    if (conflictedFields.length === 0) {
      return {
        taskId: local.id,
        title: local.title || remote.title || '未命名任务',
        recommendation: 'local',
        confidence: 'auto',
        reason: '两端内容一致，无需处理',
        reasoning: ['本地版本与云端版本完全一致', '无需任何操作'],
        localTime: local.updatedAt,
        remoteTime: remote.updatedAt,
        conflictedFields: [],
      };
    }

    // 只有布局/排序差异 — 自动接受远端
    if (contentFields.length === 0 && layoutFields.length > 0) {
      const fieldLabels = layoutFields.map(f => FIELD_LABELS[f] || f).join('、');
      reasoning.push(`差异仅涉及布局字段（${fieldLabels}）`);
      reasoning.push('布局变化对内容无影响，自动使用较新的版本');
      const newerSide = remoteTime >= localTime ? 'remote' : 'local';
      reasoning.push(`${newerSide === 'remote' ? '云端' : '本地'}版本更新，选择该版本`);

      return {
        taskId: local.id,
        title: local.title || remote.title || '未命名任务',
        recommendation: newerSide,
        confidence: 'auto',
        reason: `仅${fieldLabels}有变化，自动使用较新版本`,
        reasoning,
        localTime: local.updatedAt,
        remoteTime: remote.updatedAt,
        conflictedFields,
      };
    }

    // 内容字段有差异 — 深度分析
    const hasContentDiff = contentFields.includes('content');
    const hasTitleDiff = contentFields.includes('title');
    const hasStatusDiff = contentFields.includes('status');

    // 评估编辑量
    const localContentLen = (local.content || '').length;
    const remoteContentLen = (remote.content || '').length;
    const contentLenDiff = Math.abs(localContentLen - remoteContentLen);
    const contentLenRatio = Math.max(localContentLen, remoteContentLen) > 0
      ? contentLenDiff / Math.max(localContentLen, remoteContentLen)
      : 0;

    // 时间差分析
    const timeDiffMs = Math.abs(localTime - remoteTime);
    const timeDiffMinutes = timeDiffMs / 60000;
    const newerSide = remoteTime > localTime ? 'remote' : 'local';
    const newerLabel = newerSide === 'remote' ? '云端' : '本地';
    const olderLabel = newerSide === 'remote' ? '本地' : '云端';

    reasoning.push(`冲突字段：${contentFields.map(f => FIELD_LABELS[f] || f).join('、')}`);

    if (timeDiffMinutes > 0) {
      if (timeDiffMinutes < 1) {
        reasoning.push(`两端编辑时间相差不足 1 分钟（几乎同时编辑）`);
      } else if (timeDiffMinutes < 60) {
        reasoning.push(`${newerLabel}版本比${olderLabel}版本新 ${Math.round(timeDiffMinutes)} 分钟`);
      } else {
        const hours = Math.round(timeDiffMinutes / 60);
        reasoning.push(`${newerLabel}版本比${olderLabel}版本新 ${hours} 小时`);
      }
    }

    // 场景1：标题和内容同时被双方修改 — 高风险，需手动
    if (hasTitleDiff && hasContentDiff) {
      reasoning.push('标题和内容同时存在差异，建议人工审阅');
      return {
        taskId: local.id,
        title: local.title || remote.title || '未命名任务',
        recommendation: newerSide,
        confidence: 'manual',
        reason: '标题和内容同时修改，需要您确认保留哪个版本',
        reasoning,
        localTime: local.updatedAt,
        remoteTime: remote.updatedAt,
        conflictedFields,
      };
    }

    // 场景2：仅内容修改，编辑量差异大 — 保留编辑量多的
    if (hasContentDiff && contentLenRatio > 0.3) {
      const moreSide = localContentLen > remoteContentLen ? 'local' : 'remote';
      const moreLabel = moreSide === 'local' ? '本地' : '云端';
      reasoning.push(`${moreLabel}版本内容更丰富（${moreSide === 'local' ? localContentLen : remoteContentLen} 字 vs ${moreSide === 'local' ? remoteContentLen : localContentLen} 字）`);
      reasoning.push('建议保留内容更完整的版本');

      return {
        taskId: local.id,
        title: local.title || remote.title || '未命名任务',
        recommendation: moreSide,
        confidence: 'suggest',
        reason: `${moreLabel}版本内容更丰富，建议保留`,
        reasoning,
        localTime: local.updatedAt,
        remoteTime: remote.updatedAt,
        conflictedFields,
      };
    }

    // 场景3：内容修改但编辑量相近 — 适度风险，建议确认
    if (hasContentDiff) {
      reasoning.push('双方内容有差异但编辑量相近');
      reasoning.push(`系统默认推荐较新的${newerLabel}版本`);

      return {
        taskId: local.id,
        title: local.title || remote.title || '未命名任务',
        recommendation: newerSide,
        confidence: 'suggest',
        reason: `内容有差异，推荐使用较新的${newerLabel}版本`,
        reasoning,
        localTime: local.updatedAt,
        remoteTime: remote.updatedAt,
        conflictedFields,
      };
    }

    // 场景4：附件存在差异但正文未改动 — 建议确认，避免静默覆盖素材
    if (contentFields.includes('attachments')) {
      reasoning.push('附件列表发生变化，但正文没有直接改动');
      reasoning.push(`系统默认推荐较新的${newerLabel}版本，但建议您确认素材保留方案`);

      return {
        taskId: local.id,
        title: local.title || remote.title || '未命名任务',
        recommendation: newerSide,
        confidence: 'suggest',
        reason: `附件有差异，推荐先确认后再采用${newerLabel}版本`,
        reasoning,
        localTime: local.updatedAt,
        remoteTime: remote.updatedAt,
        conflictedFields,
      };
    }

    // 场景5：仅状态/优先级/截止日期等元数据字段变化 — 使用较新的
    if (hasStatusDiff) {
      reasoning.push(`任务状态变化：本地「${local.status}」vs 云端「${remote.status}」`);
    }
    reasoning.push(`自动使用较新的${newerLabel}版本`);

    return {
      taskId: local.id,
      title: local.title || remote.title || '未命名任务',
      recommendation: newerSide,
      confidence: 'auto',
      reason: `元数据变化，自动使用较新的${newerLabel}版本`,
      reasoning,
      localTime: local.updatedAt,
      remoteTime: remote.updatedAt,
      conflictedFields,
    };
  }

  /**
   * 获取内容相关的差异字段（标题、内容、状态、优先级、截止日期等）
   */
  private getContentDiffFields(local: Task, remote: Task): string[] {
    const fields: (keyof Task)[] = [
      'title', 'content', 'status', 'priority', 'dueDate', 'tags', 'expected_minutes',
      'cognitive_load', 'wait_minutes', 'attachments', 'parkingMeta',
    ];
    return fields.filter(f => !this.fieldEqual(local[f], remote[f]));
  }

  /**
   * 获取布局相关的差异字段（坐标、排序、阶段等）
   */
  private getLayoutDiffFields(local: Task, remote: Task): string[] {
    const fields: (keyof Task)[] = ['x', 'y', 'order', 'stage', 'parentId', 'rank'];
    return fields.filter(f => !this.fieldEqual(local[f], remote[f]));
  }

  private fieldEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (a == null && b == null) return true;
    if ((a == null && Array.isArray(b) && b.length === 0) || (b == null && Array.isArray(a) && a.length === 0)) {
      return true;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((value, index) => this.fieldEqual(value, b[index]));
    }

    if (this.isComparableRecord(a) && this.isComparableRecord(b)) {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      return aKeys.length === bKeys.length
        && aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && this.fieldEqual(a[key], b[key]));
    }

    return false;
  }

  private isComparableRecord(value: unknown): value is ComparableRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * 生成总体建议文案
   */
  private generateOverallSuggestion(auto: number, suggest: number, manual: number): string {
    const total = auto + suggest + manual;
    if (total === 0) return '没有需要处理的冲突';
    if (manual === 0 && suggest === 0) return `${auto} 个冲突可以自动解决，点击"应用系统建议"一键处理`;
    if (manual === 0) return `${auto} 个可自动解决，${suggest} 个建议您确认后应用`;
    if (suggest === 0) return `${auto} 个可自动解决，${manual} 个需要您手动选择`;
    return `${auto} 个可自动解决，${suggest} 个建议确认，${manual} 个需要手动选择`;
  }
}
