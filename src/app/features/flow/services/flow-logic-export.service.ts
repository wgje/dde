/**
 * 流程图「逻辑网」导出服务
 *
 * 对应需求：一键导出当前流程图为 Mermaid（骨架审查）+ YAML（数据流审查），
 * 作为 AI 审阅逻辑漏洞的权威输入。
 *
 * 设计要点：
 *   - 权威源是 ProjectStateService.activeProject()，不读 GoJS 运行时模型
 *   - 所有核心算法在纯函数模块 src/utils/flow-logic-export.ts，便于独立测试
 *   - 本服务只负责 DI、日志、Toast、下载落盘
 *   - 失败统一返回 Result Pattern，UI 可决定是否展示
 */

import { Injectable, inject } from '@angular/core';

import { ProjectStateService } from '../../../../services/project-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { ErrorCodes, failure, success, type Result, type OperationError } from '../../../../utils/result';
import {
  exportProjectLogic,
  type LogicExportOptions,
  type LogicExportResult,
} from '../../../../utils/flow-logic-export';

@Injectable({ providedIn: 'root' })
export class FlowLogicExportService {
  private readonly projectState = inject(ProjectStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('FlowLogicExport');
  private readonly toast = inject(ToastService);

  /**
   * 计算导出结果（不下载）。主要用于测试与将来在面板中预览。
   */
  compute(options: LogicExportOptions): Result<LogicExportResult, OperationError> {
    const project = this.projectState.activeProject();
    if (!project) {
      return failure(ErrorCodes.DATA_NOT_FOUND, '当前没有活动项目');
    }
    try {
      const result = exportProjectLogic(project, options);
      return success(result);
    } catch (error) {
      this.logger.error('生成逻辑网导出失败', error);
      return failure(
        ErrorCodes.OPERATION_FAILED,
        '生成逻辑网导出失败',
        { cause: (error as Error)?.message },
      );
    }
  }

  /**
   * 导出 Mermaid 并下载 .mmd 文件。
   */
  exportMermaid(options?: Partial<LogicExportOptions>): Result<LogicExportResult, OperationError> {
    const opt: LogicExportOptions = {
      format: 'mermaid',
      mode: options?.mode ?? 'full',
      includeCompleted: options?.includeCompleted ?? true,
      includeParking: options?.includeParking ?? true,
      includePlanning: options?.includePlanning ?? true,
      redactPII: options?.redactPII ?? false,
      stageFilter: options?.stageFilter,
      maxDepth: options?.maxDepth,
    };
    const outcome = this.compute(opt);
    if (!outcome.ok) {
      this.toast.error('导出失败', outcome.error.message);
      return outcome;
    }
    const text = outcome.value.mermaid;
    if (!text) {
      this.toast.error('导出失败', 'Mermaid 内容为空');
      return failure(ErrorCodes.OPERATION_FAILED, 'Mermaid 内容为空');
    }
    this.downloadText(text, `${this.baseFileName()}.logic.mmd`, 'text/plain;charset=utf-8');
    this.announceDone('Mermaid', outcome.value);
    return outcome;
  }

  /**
   * 导出 YAML 并下载 .yaml 文件。
   */
  exportYaml(options?: Partial<LogicExportOptions>): Result<LogicExportResult, OperationError> {
    const opt: LogicExportOptions = {
      format: 'yaml',
      mode: options?.mode ?? 'full',
      includeCompleted: options?.includeCompleted ?? true,
      includeParking: options?.includeParking ?? true,
      includePlanning: options?.includePlanning ?? true,
      redactPII: options?.redactPII ?? false,
      stageFilter: options?.stageFilter,
      maxDepth: options?.maxDepth,
    };
    const outcome = this.compute(opt);
    if (!outcome.ok) {
      this.toast.error('导出失败', outcome.error.message);
      return outcome;
    }
    const text = outcome.value.yaml;
    if (!text) {
      this.toast.error('导出失败', 'YAML 内容为空');
      return failure(ErrorCodes.OPERATION_FAILED, 'YAML 内容为空');
    }
    this.downloadText(text, `${this.baseFileName()}.logic.yaml`, 'text/yaml;charset=utf-8');
    this.announceDone('YAML', outcome.value);
    return outcome;
  }

  /**
   * 导出 Mermaid + YAML + 审查清单为一个合并 Markdown 文件（便于直接贴给 AI）。
   * 不引入 zip 依赖。
   */
  exportLogicPack(options?: Partial<LogicExportOptions>): Result<LogicExportResult, OperationError> {
    const opt: LogicExportOptions = {
      format: 'both',
      mode: options?.mode ?? 'full',
      includeCompleted: options?.includeCompleted ?? true,
      includeParking: options?.includeParking ?? true,
      includePlanning: options?.includePlanning ?? true,
      redactPII: options?.redactPII ?? false,
      stageFilter: options?.stageFilter,
      maxDepth: options?.maxDepth,
    };
    const outcome = this.compute(opt);
    if (!outcome.ok) {
      this.toast.error('导出失败', outcome.error.message);
      return outcome;
    }
    const v = outcome.value;
    const md = this.renderLogicPackMarkdown(v);
    this.downloadText(md, `${this.baseFileName()}.logic-pack.md`, 'text/markdown;charset=utf-8');
    this.announceDone('逻辑审查包', v);
    return outcome;
  }

  // ============================================================
  // 私有
  // ============================================================

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

  private announceDone(label: string, result: LogicExportResult): void {
    const errorCount = result.invariants.filter(i => i.severity === 'error').length;
    const warningCount = result.invariants.filter(i => i.severity === 'warning').length;
    const summary = `任务 ${result.stats.totalTasks} · 连接 ${result.stats.totalConnections} · 错误 ${errorCount} · 警告 ${warningCount}`;
    if (errorCount > 0) {
      this.toast.error(`${label} 已导出（含违规）`, summary);
    } else if (warningCount > 0 || result.warnings.length > 0) {
      this.toast.info(`${label} 已导出（含提示）`, summary);
    } else {
      this.toast.success(`${label} 已导出`, summary);
    }
    this.logger.info('[logic-export] done', {
      stats: result.stats,
      invariantCount: result.invariants.length,
      warnings: result.warnings,
    });
  }

  private renderLogicPackMarkdown(r: LogicExportResult): string {
    const parts: string[] = [];
    parts.push('# NanoFlow 逻辑网审查包');
    parts.push('');
    parts.push(`- 任务: ${r.stats.totalTasks}`);
    parts.push(`- 连接: ${r.stats.totalConnections}`);
    parts.push(`- 根节点: ${r.stats.roots}`);
    parts.push(`- 浮动根: ${r.stats.floatingRoots}`);
    parts.push(`- 最大树深: ${r.stats.maxTreeDepth}`);
    parts.push('');

    if (r.warnings.length > 0) {
      parts.push('## 导出时的规模/数据警告');
      for (const w of r.warnings) parts.push(`- ${w}`);
      parts.push('');
    }

    if (r.invariants.length > 0) {
      parts.push('## 自动不变式检查');
      parts.push('');
      parts.push('| 严重 | 代码 | 信息 | 违规数 |');
      parts.push('| --- | --- | --- | --- |');
      for (const v of r.invariants) {
        parts.push(`| ${v.severity} | ${v.code} | ${v.message} | ${v.offenders.length} |`);
      }
      parts.push('');
    } else {
      parts.push('## 自动不变式检查');
      parts.push('');
      parts.push('未发现违规。');
      parts.push('');
    }

    if (r.mermaid) {
      parts.push('## Mermaid 骨架图');
      parts.push('');
      parts.push('```mermaid');
      parts.push(r.mermaid.trimEnd());
      parts.push('```');
      parts.push('');
    }

    if (r.yaml) {
      parts.push('## YAML 数据流');
      parts.push('');
      parts.push('```yaml');
      parts.push(r.yaml.trimEnd());
      parts.push('```');
      parts.push('');
    }

    parts.push('## 审查提示');
    parts.push('');
    parts.push('请基于以上数据核查：');
    parts.push('- stage 是否严格递增（parent.stage + 1 == child.stage 或同为 null）');
    parts.push('- 是否存在孤儿连接、自环、跨树环');
    parts.push('- 是否有 parkingMeta 与 status 不一致的条目');
    parts.push('- 是否存在与 parentId 重复的历史连接');
    parts.push('- Dock planning 字段（expected_minutes / cognitive_load / wait_minutes）是否协调一致');
    parts.push('');
    return parts.join('\n');
  }
}
