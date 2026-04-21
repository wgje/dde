/**
 * 流程图「项目脉络」导出服务
 *
 * 单一职责：把当前项目导出为一份 Markdown 大纲，用于自我审阅 / 存档 / 分享 / 粘给 AI 做战略分析。
 *
 * 设计要点：
 *   - 权威源是 ProjectStateService.activeProject()，不读 GoJS 运行时模型
 *   - 核心算法在纯函数模块 src/utils/flow-strategic-review.ts，便于独立测试
 *   - 本服务只负责 DI、日志、Toast、下载落盘
 *   - 失败统一返回 Result Pattern，UI 可决定是否展示
 */

import { Injectable, inject } from '@angular/core';

import { ProjectStateService } from '../../../../services/project-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { ErrorCodes, failure, success, type Result, type OperationError } from '../../../../utils/result';
import {
  buildStrategicReviewMarkdown,
  type StrategicReviewOptions,
  type StrategicReviewResult,
} from '../../../../utils/flow-strategic-review';

@Injectable({ providedIn: 'root' })
export class FlowLogicExportService {
  private readonly projectState = inject(ProjectStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLogicExport');
  private readonly toast = inject(ToastService);

  /**
   * 导出「项目脉络」Markdown：
   * 以主任务为核心，保留标题、内容摘要、父子层级与关联块的语义，
   * 忽略客观/技术属性。文末附带可选的 AI 战略顾问 system prompt，
   * 便于需要时粘给 AI 做主观思路层面的建议与批判。
   */
  exportStrategicReview(
    options?: StrategicReviewOptions,
  ): Result<StrategicReviewResult, OperationError> {
    const project = this.projectState.activeProject();
    if (!project) {
      const err = failure<StrategicReviewResult, OperationError>(
        ErrorCodes.DATA_NOT_FOUND,
        '当前没有活动项目',
      );
      this.toast.error('导出失败', err.error.message);
      return err;
    }
    try {
      const result = buildStrategicReviewMarkdown(project, options ?? {});
      if (!result.markdown) {
        const err = failure<StrategicReviewResult, OperationError>(
          ErrorCodes.OPERATION_FAILED,
          '项目脉络内容为空',
        );
        this.toast.error('导出失败', err.error.message);
        return err;
      }
      this.downloadText(
        result.markdown,
        `${this.baseFileName()}.outline.md`,
        'text/markdown;charset=utf-8',
      );
      const summary = `任务 ${result.stats.totalTasks} · 关联 ${result.stats.totalConnections} · 主任务「${result.stats.mainTaskTitle}」`;
      if (result.warnings.length > 0) {
        this.toast.info('项目脉络已导出（含提示）', summary);
      } else {
        this.toast.success('项目脉络已导出', summary);
      }
      this.logger.info('[project-outline] done', {
        stats: result.stats,
        warnings: result.warnings,
      });
      return success(result);
    } catch (error) {
      this.logger.error('生成项目脉络失败', error);
      const err = failure<StrategicReviewResult, OperationError>(
        ErrorCodes.OPERATION_FAILED,
        '生成项目脉络失败',
        { cause: (error as Error)?.message },
      );
      this.toast.error('导出失败', err.error.message);
      return err;
    }
  }

  private baseFileName(): string {
    const project = this.projectState.activeProject();
    const name = project?.name?.trim() || '未命名项目';
    const safe = name.replace(/[\\/:*?"<>|]/g, '_');
    const date = new Date().toISOString().slice(0, 10);
    return `${safe}_${date}`;
  }

  private downloadText(text: string, filename: string, mime: string): void {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
