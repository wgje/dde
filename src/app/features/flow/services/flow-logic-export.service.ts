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
    const projectName = this.projectState.activeProject()?.name?.trim() || '未命名项目';
    const errorCount = r.invariants.filter(i => i.severity === 'error').length;
    const warningCount = r.invariants.filter(i => i.severity === 'warning').length;

    parts.push('# NanoFlow 逻辑网审查包');
    parts.push('');
    parts.push('> 目的：把流程图抽象成「节点 + 关系」两张视图交给 AI，');
    parts.push('> 用于检查阶段递增、跨树关联、停泊状态等不变式是否被违反。');
    parts.push('> 审查重点是 **关系** 而不是单个节点的客观/规划属性。');
    parts.push('');

    // ---- 概览（一行搞定） ----
    parts.push('## 概览');
    parts.push('');
    parts.push(`- 项目：${projectName}`);
    parts.push(
      `- 任务：${r.stats.totalTasks}（根 ${r.stats.roots} · 浮动根 ${r.stats.floatingRoots} · 最大深度 ${r.stats.maxTreeDepth}）`,
    );
    parts.push(`- 跨树连接：${r.stats.totalConnections}`);
    parts.push(`- 不变式：错误 ${errorCount} · 警告 ${warningCount}`);
    parts.push('');

    // ---- 规模/数据警告（只在有东西时出现） ----
    if (r.warnings.length > 0) {
      parts.push('## 数据警告');
      parts.push('');
      for (const w of r.warnings) parts.push(`- ${w}`);
      parts.push('');
    }

    // ---- 不变式检查（未违反则一句话带过） ----
    if (r.invariants.length > 0) {
      parts.push('## 不变式违规');
      parts.push('');
      parts.push('| 严重 | 代码 | 违规数 | 信息 |');
      parts.push('| --- | --- | ---: | --- |');
      for (const v of r.invariants) {
        parts.push(
          `| ${v.severity} | \`${v.code}\` | ${v.offenders.length} | ${v.message} |`,
        );
      }
      parts.push('');
    } else {
      parts.push('## 不变式违规');
      parts.push('');
      parts.push('_未发现自动可查的违规。AI 审查仍需人工核对关系合理性。_');
      parts.push('');
    }

    // ---- 骨架图 ----
    if (r.mermaid) {
      parts.push('## 骨架图（Mermaid）');
      parts.push('');
      parts.push('```mermaid');
      parts.push(r.mermaid.trimEnd());
      parts.push('```');
      parts.push('');
    }

    // ---- 跨树关联表（核心）：把 connections 拍平成易读表格，AI 不必回查 YAML ----
    if (r.yaml) {
      const linksTable = this.renderCrossLinksTable(r.yaml);
      if (linksTable) {
        parts.push('## 跨树关联一览');
        parts.push('');
        parts.push(linksTable);
        parts.push('');
      }
    }

    // ---- YAML 清单 ----
    if (r.yaml) {
      parts.push('## 逻辑清单（YAML）');
      parts.push('');
      parts.push('```yaml');
      parts.push(r.yaml.trimEnd());
      parts.push('```');
      parts.push('');
    }

    // ---- 审查提示：围绕「关系合理性」，不复述客观/规划属性 ----
    parts.push('## 审查提示');
    parts.push('');
    parts.push('请聚焦 **关系是否合理**，忽略客观属性（优先级、到期、标签）与规划估算：');
    parts.push('');
    parts.push('1. **阶段递增**：每条父子边是否满足 `child.stage == parent.stage + 1`，');
    parts.push('   或两端同为 `null`（待分配树）。');
    parts.push('2. **跨树关联语义**：标签是否真实表达依赖/影响/参照；是否应改为父子关系。');
    parts.push('3. **重复边**：是否存在与 parentId 重复的历史连接（AI 可在 `invariants_violated`');
    parts.push('   中查 `DUPLICATE_PARENT_CHILD_EDGE`），建议整并。');
    parts.push('4. **孤立子树**：浮动根与已分配树之间是否缺少连接或归属错位。');
    parts.push('5. **停泊一致性**：`parked: true` 的任务 `status` 必须为 `active`。');
    parts.push('6. **环**：`cycles` 段若非空，跨树连接构成了依赖环，需要断环。');
    parts.push('');
    return parts.join('\n');
  }

  /**
   * 从 YAML 文本里抽取 `cross_links` 段落，拍成 Markdown 表格。
   * 做这个是为了：AI 不必在 YAML 的 from_displayId → tasks.displayId 之间回查，
   * 直接看到每条关系的双端 displayId + title。
   */
  private renderCrossLinksTable(yaml: string): string | null {
    const lines = yaml.split(/\r?\n/);
    const startIdx = lines.findIndex(l => l.startsWith('cross_links:'));
    if (startIdx < 0) return null;
    if (lines[startIdx].trim().endsWith('[]')) return null;

    // 收集 cross_links 段（直到下一个顶格 key 为止）
    const items: Array<{ label: string; from: string; to: string }> = [];
    let cur: { label?: string; fromId?: string; fromTitle?: string; toId?: string; toTitle?: string } | null = null;
    const flush = () => {
      if (!cur) return;
      const fromTitle = cur.fromTitle ? ` ${cur.fromTitle}` : '';
      const toTitle = cur.toTitle ? ` ${cur.toTitle}` : '';
      items.push({
        label: this.escapeMarkdownTableCell(cur.label || '(无标签)'),
        from: this.escapeMarkdownTableCell(`\`${cur.fromId || '?'}\`${fromTitle}`),
        to: this.escapeMarkdownTableCell(`\`${cur.toId || '?'}\`${toTitle}`),
      });
      cur = null;
    };
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^\S/.test(line)) break; // 顶格新 key，cross_links 段结束
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        flush();
        cur = {};
        const rest = trimmed.slice(2).trim();
        this.applyYamlField(cur, rest);
      } else if (cur && trimmed.length > 0) {
        this.applyYamlField(cur, trimmed);
      }
    }
    flush();
    if (items.length === 0) return null;

    const md: string[] = [];
    md.push('| 关系标签 | 源（displayId · title） | 目标（displayId · title） |');
    md.push('| --- | --- | --- |');
    for (const it of items) {
      md.push(`| ${it.label} | ${it.from} | ${it.to} |`);
    }
    return md.join('\n');
  }

  private applyYamlField(
    cur: { label?: string; fromId?: string; fromTitle?: string; toId?: string; toTitle?: string },
    text: string,
  ): void {
    const m = /^(\w+):\s*"([\s\S]*)"$/.exec(text);
    if (!m) return;
    const [, key, value] = m;
    const decodedValue = this.decodeQuotedScalar(value);
    switch (key) {
      case 'label':
        cur.label = decodedValue;
        break;
      case 'from_displayId':
        cur.fromId = decodedValue;
        break;
      case 'from_title':
        cur.fromTitle = decodedValue;
        break;
      case 'to_displayId':
        cur.toId = decodedValue;
        break;
      case 'to_title':
        cur.toTitle = decodedValue;
        break;
    }
  }

  private escapeMarkdownTableCell(value: string): string {
    return value
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br>');
  }

  private decodeQuotedScalar(value: string): string {
    try {
      return JSON.parse(`"${value}"`) as string;
    } catch {
      return value;
    }
  }
}
