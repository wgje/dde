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
type RecommendationBase = Pick<TaskResolutionRecommendation, 'taskId' | 'title' | 'localTime' | 'remoteTime' | 'conflictedFields'>;
type ConflictTiming = {
  localTime: number;
  remoteTime: number;
  newerSide: 'local' | 'remote';
  newerLabel: '本地' | '云端';
  olderLabel: '本地' | '云端';
  timeDiffMinutes: number;
};
type ContentRecommendationContext = {
  local: Task;
  remote: Task;
  base: RecommendationBase;
  contentFields: string[];
  timing: ConflictTiming;
};

/** 字段名到中文标签的映射 */
const FIELD_LABELS: Record<string, string> = {
  title: '标题', content: '内容', status: '状态', priority: '优先级',
  dueDate: '截止日期', tags: '标签', expected_minutes: '预估耗时',
  cognitive_load: '认知负荷', wait_minutes: '等待时间', attachments: '附件',
  attentionMeta: '任务僚机', stage: '阶段', order: '排序', parentId: '父任务', rank: '层级排序',
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
      const recommendation = this.analyzeTaskPresence(id, local, remote);

      if (recommendation && recommendation.conflictedFields.length > 0) {
        recommendations.push(recommendation);
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

  private analyzeTaskPresence(
    id: string,
    local: Task | undefined,
    remote: Task | undefined,
  ): TaskResolutionRecommendation | null {
    if (local && remote) {
      return this.analyzeConflictingTask(local, remote);
    }

    if (local) {
      return this.createRecommendation({
        taskId: id,
        title: local.title || '未命名任务',
        recommendation: 'local',
        confidence: 'auto',
        reason: '此任务仅存在于本地（可能是离线时新建的），自动保留',
        reasoning: ['任务仅存在于本地', '判断为离线期间新建的任务', '自动保留以防数据丢失'],
        localTime: local.updatedAt,
        conflictedFields: [],
      });
    }

    if (remote) {
      return this.createRecommendation({
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

    return null;
  }

  /**
   * 分析两个版本都存在的冲突任务
   */
  private analyzeConflictingTask(local: Task, remote: Task): TaskResolutionRecommendation {
    const contentFields = this.getContentDiffFields(local, remote);
    const layoutFields = this.getLayoutDiffFields(local, remote);
    const conflictedFields = [...contentFields, ...layoutFields];
    const base = this.createRecommendationBase(local, remote, conflictedFields);

    if (conflictedFields.length === 0) {
      return this.createRecommendation({
        ...base,
        recommendation: 'local',
        confidence: 'auto',
        reason: '两端内容一致，无需处理',
        reasoning: ['本地版本与云端版本完全一致', '无需任何操作'],
        conflictedFields: [],
      });
    }

    const timing = this.createConflictTiming(local, remote);
    if (contentFields.length === 0 && layoutFields.length > 0) {
      return this.createLayoutOnlyRecommendation(base, layoutFields, timing);
    }

    return this.createContentRecommendation({ local, remote, base, contentFields, timing });
  }

  private createContentRecommendation(context: ContentRecommendationContext): TaskResolutionRecommendation {
    const { local, remote, base, contentFields, timing } = context;
    const reasoning: string[] = [];
    const hasContentDiff = contentFields.includes('content');
    const hasTitleDiff = contentFields.includes('title');
    const hasStatusDiff = contentFields.includes('status');
    const localContentLen = (local.content || '').length;
    const remoteContentLen = (remote.content || '').length;
    const contentLenDiff = Math.abs(localContentLen - remoteContentLen);
    const contentLenRatio = Math.max(localContentLen, remoteContentLen) > 0
      ? contentLenDiff / Math.max(localContentLen, remoteContentLen)
      : 0;

    reasoning.push(`冲突字段：${contentFields.map(f => FIELD_LABELS[f] || f).join('、')}`);
    this.appendTimingReasoning(reasoning, timing);

    if (hasTitleDiff && hasContentDiff) {
      return this.createManualContentRecommendation(base, timing, reasoning);
    }

    if (hasContentDiff && contentLenRatio > 0.3) {
      return this.createRichContentRecommendation(base, localContentLen, remoteContentLen, reasoning);
    }

    if (hasContentDiff) {
      return this.createSimilarContentRecommendation(base, timing, reasoning);
    }

    if (contentFields.includes('attachments')) {
      return this.createAttachmentRecommendation(base, timing, reasoning);
    }

    return this.createMetadataRecommendation(base, timing, reasoning, hasStatusDiff, local, remote);
  }

  private createManualContentRecommendation(
    base: RecommendationBase,
    timing: ConflictTiming,
    reasoning: string[],
  ): TaskResolutionRecommendation {
    reasoning.push('标题和内容同时存在差异，建议人工审阅');
    return this.createRecommendation({
      ...base,
      recommendation: timing.newerSide,
      confidence: 'manual',
      reason: '标题和内容同时修改，需要您确认保留哪个版本',
      reasoning,
    });
  }

  private createRichContentRecommendation(
    base: RecommendationBase,
    localContentLen: number,
    remoteContentLen: number,
    reasoning: string[],
  ): TaskResolutionRecommendation {
    const moreSide = localContentLen > remoteContentLen ? 'local' : 'remote';
    const moreLabel = moreSide === 'local' ? '本地' : '云端';
    reasoning.push(`${moreLabel}版本内容更丰富（${moreSide === 'local' ? localContentLen : remoteContentLen} 字 vs ${moreSide === 'local' ? remoteContentLen : localContentLen} 字）`);
    reasoning.push('建议保留内容更完整的版本');
    return this.createRecommendation({
      ...base,
      recommendation: moreSide,
      confidence: 'suggest',
      reason: `${moreLabel}版本内容更丰富，建议保留`,
      reasoning,
    });
  }

  private createSimilarContentRecommendation(
    base: RecommendationBase,
    timing: ConflictTiming,
    reasoning: string[],
  ): TaskResolutionRecommendation {
    reasoning.push('双方内容有差异但编辑量相近');
    reasoning.push(`系统默认推荐较新的${timing.newerLabel}版本`);
    return this.createRecommendation({
      ...base,
      recommendation: timing.newerSide,
      confidence: 'suggest',
      reason: `内容有差异，推荐使用较新的${timing.newerLabel}版本`,
      reasoning,
    });
  }

  private createAttachmentRecommendation(
    base: RecommendationBase,
    timing: ConflictTiming,
    reasoning: string[],
  ): TaskResolutionRecommendation {
    reasoning.push('附件列表发生变化，但正文没有直接改动');
    reasoning.push(`系统默认推荐较新的${timing.newerLabel}版本，但建议您确认素材保留方案`);
    return this.createRecommendation({
      ...base,
      recommendation: timing.newerSide,
      confidence: 'suggest',
      reason: `附件有差异，推荐先确认后再采用${timing.newerLabel}版本`,
      reasoning,
    });
  }

  private createMetadataRecommendation(
    base: RecommendationBase,
    timing: ConflictTiming,
    reasoning: string[],
    hasStatusDiff: boolean,
    local: Task,
    remote: Task,
  ): TaskResolutionRecommendation {
    if (hasStatusDiff) {
      reasoning.push(`任务状态变化：本地「${local.status}」vs 云端「${remote.status}」`);
    }
    reasoning.push(`自动使用较新的${timing.newerLabel}版本`);
    return this.createRecommendation({
      ...base,
      recommendation: timing.newerSide,
      confidence: 'auto',
      reason: `元数据变化，自动使用较新的${timing.newerLabel}版本`,
      reasoning,
    });
  }

  private createRecommendationBase(
    local: Task,
    remote: Task,
    conflictedFields: string[],
  ): RecommendationBase {
    return {
      taskId: local.id,
      title: local.title || remote.title || '未命名任务',
      localTime: local.updatedAt,
      remoteTime: remote.updatedAt,
      conflictedFields,
    };
  }

  private createRecommendation(
    recommendation: RecommendationBase & Omit<TaskResolutionRecommendation, keyof RecommendationBase>,
  ): TaskResolutionRecommendation {
    return recommendation;
  }

  private createConflictTiming(local: Task, remote: Task): ConflictTiming {
    const localTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
    const remoteTime = remote.updatedAt ? new Date(remote.updatedAt).getTime() : 0;
    const newerSide = remoteTime > localTime ? 'remote' : 'local';
    return {
      localTime,
      remoteTime,
      newerSide,
      newerLabel: newerSide === 'remote' ? '云端' : '本地',
      olderLabel: newerSide === 'remote' ? '本地' : '云端',
      timeDiffMinutes: Math.abs(localTime - remoteTime) / 60000,
    };
  }

  private createLayoutOnlyRecommendation(
    base: RecommendationBase,
    layoutFields: string[],
    timing: ConflictTiming,
  ): TaskResolutionRecommendation {
    const fieldLabels = layoutFields.map(f => FIELD_LABELS[f] || f).join('、');
    const newerSide = timing.remoteTime >= timing.localTime ? 'remote' : 'local';
    const reasoning = [
      `差异仅涉及布局字段（${fieldLabels}）`,
      '布局变化对内容无影响，自动使用较新的版本',
      `${newerSide === 'remote' ? '云端' : '本地'}版本更新，选择该版本`,
    ];

    return this.createRecommendation({
      ...base,
      recommendation: newerSide,
      confidence: 'auto',
      reason: `仅${fieldLabels}有变化，自动使用较新版本`,
      reasoning,
    });
  }

  private appendTimingReasoning(reasoning: string[], timing: ConflictTiming): void {
    if (timing.timeDiffMinutes <= 0) {
      return;
    }

    if (timing.timeDiffMinutes < 1) {
      reasoning.push(`两端编辑时间相差不足 1 分钟（几乎同时编辑）`);
      return;
    }

    if (timing.timeDiffMinutes < 60) {
      reasoning.push(`${timing.newerLabel}版本比${timing.olderLabel}版本新 ${Math.round(timing.timeDiffMinutes)} 分钟`);
      return;
    }

    const hours = Math.round(timing.timeDiffMinutes / 60);
    reasoning.push(`${timing.newerLabel}版本比${timing.olderLabel}版本新 ${hours} 小时`);
  }

  /**
   * 获取内容相关的差异字段（标题、内容、状态、优先级、截止日期等）
   */
  private getContentDiffFields(local: Task, remote: Task): string[] {
    const fields: (keyof Task)[] = [
      'title', 'content', 'status', 'priority', 'dueDate', 'tags', 'expected_minutes',
      'cognitive_load', 'wait_minutes', 'attachments', 'parkingMeta', 'attentionMeta',
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
