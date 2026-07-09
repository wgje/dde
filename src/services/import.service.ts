/**
 * ImportService - 数据导入服务
 * 
 * 【Week 8 数据保护 - P1 手动导出/导入】
 * 职责：
 * - 从 JSON 文件导入项目数据
 * - 校验数据完整性和版本兼容性
 * - 支持多种导入策略（合并/覆盖/跳过）
 * - 冲突检测和处理
 * 
 * 设计理念：
 * - 安全第一：导入前充分验证
 * - 用户控制：让用户决定如何处理冲突
 * - 可恢复：导入失败可回滚
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { LayoutService } from './layout.service';
import { Project, Task, Connection } from '../models';
// 【P2-44 修复】导入 sanitizeProject 用于导入数据消毒
import { sanitizeProject } from '../utils/validation';
import {
  filterParentChildDuplicateConnections,
  softDeleteParentChildDuplicateConnections,
} from '../utils/parent-child-connection-integrity';
import {
  ExportData,
  ExportMetadata,
  ExportProject,
  ExportTask,
  ExportExternalSourceLink,
} from './export.service';
import { ExternalSourceLinkService } from '../app/core/external-sources/external-source-link.service';
import type { ExternalSourceLink } from '../app/core/external-sources/external-source.model';
import { parseSiyuanBlockLink } from '../app/core/external-sources/siyuan/siyuan-link-parser';
import {
  buildImportedProjectResult,
  buildConcurrentImportRejection,
  resolveImportProjectPlan,
  summarizeImportExecution,
} from './import-execution.helpers';
import { validateImportFilePreflight } from './import-file-validation.helpers';
import { buildImportProjectPreviews } from './import-preview.helpers';
import { convertExportTaskToTask } from './import-task-conversion.helpers';
import { verifyImportChecksum } from './import-checksum.helpers';
import {
  IMPORT_DATA_VERSION_LIMITS,
  validateImportDataStructure,
  validateImportVersion,
} from './import-data-validation.helpers';

// ============================================
// 导入配置
// ============================================

export const IMPORT_CONFIG = {
  /** 支持的最低格式版本 */
  MIN_SUPPORTED_VERSION: IMPORT_DATA_VERSION_LIMITS.MIN_SUPPORTED_VERSION,
  
  /** 支持的最高格式版本 */
  MAX_SUPPORTED_VERSION: IMPORT_DATA_VERSION_LIMITS.MAX_SUPPORTED_VERSION,
  
  /** 最大文件大小（字节）- 50MB */
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  
  /** 允许的文件类型 */
  ALLOWED_MIME_TYPES: ['application/json', 'text/plain'] as readonly string[],
  
  /** 校验和不匹配时是否允许继续 */
  ALLOW_CHECKSUM_MISMATCH: true,
  
  /** ID 冲突时的默认策略 */
  DEFAULT_CONFLICT_STRATEGY: 'skip' as ImportConflictStrategy,
} as const;

// ============================================
// 类型定义
// ============================================

/**
 * 导入冲突策略
 */
export type ImportConflictStrategy = 
  | 'skip'      // 跳过已存在的项目
  | 'overwrite' // 覆盖已存在的项目
  | 'merge'     // 合并任务和连接
  | 'rename';   // 创建为新项目（重命名）

/**
 * 导入选项
 */
export interface ImportOptions {
  /** 冲突处理策略 */
  conflictStrategy: ImportConflictStrategy;
  /** 是否跳过校验和验证 */
  skipChecksumValidation?: boolean;
  /** 是否生成新的 ID。
   * 默认保留导出文件中的客户端 UUID，仅在显式要求或 rename 导入时重生 ID。 */
  generateNewIds?: boolean;
}

/**
 * 文件验证结果
 */
export interface FileValidationResult {
  valid: boolean;
  error?: string;
  data?: ExportData;
}

/**
 * 导入预览
 */
export interface ImportPreview {
  /** 是否可导入 */
  canImport: boolean;
  /** 错误信息 */
  errors: string[];
  /** 警告信息 */
  warnings: string[];
  /** 导出元数据 */
  metadata: ExportMetadata;
  /** 项目预览 */
  projects: ImportProjectPreview[];
  /** 冲突项目 */
  conflicts: ImportConflict[];
}

/**
 * 项目预览
 */
export interface ImportProjectPreview {
  id: string;
  name: string;
  taskCount: number;
  connectionCount: number;
  attachmentCount: number;
  hasConflict: boolean;
}

/**
 * 导入冲突
 */
export interface ImportConflict {
  projectId: string;
  projectName: string;
  existingProjectId: string;
  existingProjectName: string;
  type: 'id' | 'name';
}

/**
 * 导入执行结果
 */
export interface ImportExecutionResult {
  success: boolean;
  error?: string;
  /** 成功导入的项目数 */
  importedCount: number;
  /** 跳过的项目数 */
  skippedCount: number;
  /** 失败的项目数 */
  failedCount: number;
  /** 详细结果 */
  details: ImportProjectResult[];
  /** 耗时（毫秒） */
  durationMs: number;
}

/**
 * 单个项目导入结果
 */
export interface ImportProjectResult {
  projectId: string;
  projectName: string;
  success: boolean;
  action: 'imported' | 'skipped' | 'merged' | 'overwritten' | 'failed';
  error?: string;
  taskCount?: number;
  connectionCount?: number;
}

/**
 * 导入进度
 */
export interface ImportProgress {
  stage: 'validating' | 'preparing' | 'importing' | 'complete';
  percentage: number;
  currentItem?: string;
}

// ============================================
// 服务实现
// ============================================

@Injectable({
  providedIn: 'root'
})
export class ImportService {
  private readonly logger = inject(LoggerService).category('Import');
  private readonly toast = inject(ToastService);
  private readonly layoutService = inject(LayoutService);
  private readonly externalSourceLinks = inject(ExternalSourceLinkService);
  
  // 状态信号
  private readonly _isImporting = signal(false);
  private readonly _progress = signal<ImportProgress>({
    stage: 'validating',
    percentage: 0,
  });
  
  // 公开的计算属性
  readonly isImporting = computed(() => this._isImporting());
  readonly progress = computed(() => this._progress());
  
  /**
   * 从文件读取并验证
   */
  async validateFile(file: File): Promise<FileValidationResult> {
    this.logger.info('验证导入文件', { 
      name: file.name, 
      size: file.size,
      type: file.type 
    });
    
    const preflightError = validateImportFilePreflight(file, {
      maxFileSize: IMPORT_CONFIG.MAX_FILE_SIZE,
      allowedMimeTypes: IMPORT_CONFIG.ALLOWED_MIME_TYPES,
    });
    if (preflightError) {
      return preflightError;
    }
    
    // 3. 读取文件内容
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      this.logger.debug('读取文件失败', { error: e, fileName: file.name });
      return {
        valid: false,
        error: '无法读取文件',
      };
    }
    
    // 4. 解析 JSON
    let data: ExportData;
    try {
      data = JSON.parse(text) as ExportData;
    } catch (e) {
      return {
        valid: false,
        error: `JSON 解析失败：${(e as Error).message}`,
      };
    }
    
    // 5. 验证数据结构（BackupData 格式会被自动转换为 ExportData）
    const structureValidation = validateImportDataStructure(data);
    if (!structureValidation.valid) {
      return structureValidation;
    }
    
    // 使用转换后的数据（BackupData 会被 validateDataStructure 转为 ExportData）
    const validatedData = structureValidation.data ?? data;
    
    // 6. 验证版本兼容性
    const versionValidation = validateImportVersion(validatedData.metadata.version);
    if (!versionValidation.valid) {
      return versionValidation;
    }
    
    return { valid: true, data: validatedData };
  }

  /**
   * 生成导入预览
   */
  async generatePreview(
    data: ExportData,
    existingProjects: Project[]
  ): Promise<ImportPreview> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const previewData = buildImportProjectPreviews(data.projects, existingProjects);
    
    // 验证校验和
    const checksumValid = await this.verifyChecksum(data);
    if (!checksumValid) {
      warnings.push('校验和不匹配，数据可能已被修改');
    }
    
    // 检查附件 URL 过期
    if (previewData.hasAttachments) {
      warnings.push('附件 URL 可能已过期，导入后需要重新上传附件');
    }
    
    return {
      canImport: errors.length === 0,
      errors,
      warnings,
      metadata: data.metadata,
      projects: previewData.projects,
      conflicts: previewData.conflicts,
    };
  }

  /**
   * 执行导入
   */
  async executeImport(
    data: ExportData,
    existingProjects: Project[],
    options: ImportOptions,
    onProjectImported?: (project: Project) => void | Promise<void>
  ): Promise<ImportExecutionResult> {
    if (this._isImporting()) {
      return buildConcurrentImportRejection();
    }
    
    const startTime = Date.now();
    this._isImporting.set(true);
    this.updateProgress('preparing', 0);
    
    let details: ImportProjectResult[] = [];
    
    try {
      this.logger.info('开始导入', { 
        projectCount: data.projects.length,
        conflictStrategy: options.conflictStrategy 
      });
      
      details = await this.importProjects(data, existingProjects, options, onProjectImported);
      
      this.updateProgress('complete', 100);
      
      const result = summarizeImportExecution(details, Date.now() - startTime);
      
      this.logger.info('导入完成', {
        importedCount: result.importedCount,
        skippedCount: result.skippedCount,
        failedCount: result.failedCount,
      });
      
      return result;
    } catch (error) {
      this.logger.error('导入失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '导入失败',
        importedCount: 0,
        skippedCount: 0,
        failedCount: data.projects.length,
        details,
        durationMs: Date.now() - startTime,
      };
    } finally {
      this._isImporting.set(false);
    }
  }

  private async importProjects(
    data: ExportData,
    existingProjects: Project[],
    options: ImportOptions,
    onProjectImported?: (project: Project) => void | Promise<void>
  ): Promise<ImportProjectResult[]> {
    const details: ImportProjectResult[] = [];
    const existingById = new Map(existingProjects.map(project => [project.id, project]));

    for (let i = 0; i < data.projects.length; i++) {
      const exportProject = data.projects[i];
      const progress = 10 + (i / data.projects.length) * 80;
      this.updateProgress('importing', progress, exportProject.name);

      const result = await this.importProject(
        exportProject,
        existingById.get(exportProject.id),
        options,
        onProjectImported
      );

      details.push(result);
    }

    return details;
  }
  
  /**
   * 导入单个项目
   */
  private async importProject(
    exportProject: ExportProject,
    existingProject: Project | undefined,
    options: ImportOptions,
    onProjectImported?: (project: Project) => void | Promise<void>
  ): Promise<ImportProjectResult> {
    const plan = resolveImportProjectPlan(exportProject, existingProject, options);
    if (plan.kind === 'skip') {
      return plan.result;
    }

    if (plan.kind === 'merge') {
      return this.mergeProject(plan.exportProject, plan.existingProject, onProjectImported);
    }
    
    try {
      // 转换为 Project 类型
      const conversion = this.convertToProject(plan.exportProject, plan.generateNewIds);
      const project = conversion.project;
      
      // 调用回调保存项目
      if (onProjectImported) {
        await onProjectImported(project);
      }
      await this.importExternalSourceLinks(plan.exportProject, conversion.taskIdMap);
      
      return buildImportedProjectResult(project, plan.action);
    } catch (error) {
      return {
        projectId: plan.exportProject.id,
        projectName: plan.exportProject.name,
        success: false,
        action: 'failed',
        error: error instanceof Error ? error.message : '导入失败',
      };
    }
  }
  
  /**
   * 合并项目
   */
  private async mergeProject(
    exportProject: ExportProject,
    existingProject: Project,
    onProjectImported?: (project: Project) => void | Promise<void>
  ): Promise<ImportProjectResult> {
    try {
      const preparedMerge = this.prepareMergedProject(exportProject, existingProject);
      
      if (onProjectImported) {
        await onProjectImported(preparedMerge.project);
      }
      await this.importExternalSourceLinks(
        { ...exportProject, tasks: preparedMerge.newExportTasks },
        new Map()
      );
      
      return {
        projectId: preparedMerge.project.id,
        projectName: preparedMerge.project.name,
        success: true,
        action: 'merged',
        taskCount: preparedMerge.newTasks.length,
        connectionCount: preparedMerge.importedConnections.length,
      };
    } catch (error) {
      return {
        projectId: exportProject.id,
        projectName: exportProject.name,
        success: false,
        action: 'failed',
        error: error instanceof Error ? error.message : '合并失败',
      };
    }
  }

  private prepareMergedProject(
    exportProject: ExportProject,
    existingProject: Project
  ): {
    project: Project;
    newExportTasks: ExportTask[];
    newTasks: Task[];
    importedConnections: Connection[];
  } {
    const existingTaskIds = new Set(existingProject.tasks.map(task => task.id));
    const newExportTasks = (exportProject.tasks ?? [])
      .filter(task => !existingTaskIds.has(task.id));
    const newTasks = newExportTasks.map(task => this.convertToTask(task));
    const existingConnIds = new Set(existingProject.connections.map(conn => conn.id));
    const importedConnections = this.prepareMergeConnections(
      exportProject,
      existingProject,
      newTasks,
      existingConnIds,
    );
    const mergedTasks = [...existingProject.tasks, ...newTasks];

    return {
      project: {
        ...existingProject,
        tasks: mergedTasks,
        connections: softDeleteParentChildDuplicateConnections(
          mergedTasks,
          [...existingProject.connections, ...importedConnections],
          new Date().toISOString(),
        ),
        updatedAt: new Date().toISOString(),
      },
      newExportTasks,
      newTasks,
      importedConnections,
    };
  }

  private prepareMergeConnections(
    exportProject: ExportProject,
    existingProject: Project,
    newTasks: Task[],
    existingConnIds: ReadonlySet<string>
  ): Connection[] {
    const taskIds = new Set([
      ...existingProject.tasks.map(task => task.id),
      ...newTasks.map(task => task.id),
    ]);
    const newConnections = (exportProject.connections ?? [])
      .filter(conn => !existingConnIds.has(conn.id))
      .map(conn => this.convertToConnection(conn));

    return filterParentChildDuplicateConnections(
      [...existingProject.tasks, ...newTasks],
      newConnections.filter(conn => (
        conn.deletedAt || (taskIds.has(conn.source) && taskIds.has(conn.target))
      )),
    );
  }
  
  // ==================== 转换方法 ====================
  
  /**
   * 转换导出项目为 Project
   * 【P2-44 修复】对导入数据执行 sanitizeProject 消毒
   *
   * Hard Rule: ID 必须客户端 UUID。导出文件中的实体 ID 本身就是客户端 UUID，
   * 因此默认保留原始 ID；仅在显式要求或 rename 导入时重生整棵项目树 ID。
   */
  private convertToProject(exportProject: ExportProject, generateNewIds: boolean = false): { project: Project; taskIdMap: Map<string, string> } {
    const projectId = generateNewIds ? crypto.randomUUID() : exportProject.id;
    
    if (generateNewIds) {
      this.logger.info('导入时重生项目树 ID', { projectId: exportProject.id });
    }
    
    // 始终构建任务 ID 映射：重生 ID 时用于引用改写，保留 ID 时用于恢复外部锚点指针。
    const idMap = new Map<string, string>();
    for (const task of exportProject.tasks ?? []) {
      idMap.set(task.id, generateNewIds ? crypto.randomUUID() : task.id);
    }
    
    const rawTasks = (exportProject.tasks ?? []).map(t => 
      this.convertToTask(t, generateNewIds ? idMap : undefined)
    );
    const rawConnections = filterParentChildDuplicateConnections(
      rawTasks,
      (exportProject.connections ?? []).map(c => 
        this.convertToConnection(c, generateNewIds ? idMap : undefined)
      ),
    );

    const rawProject: Project = {
      id: projectId,
      name: exportProject.name,
      description: exportProject.description ?? '',
      tasks: rawTasks,
      connections: rawConnections,
      createdDate: exportProject.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      viewState: exportProject.viewState,
      flowchartUrl: exportProject.flowchartUrl,
      flowchartThumbnailUrl: exportProject.flowchartThumbnailUrl,
      version: exportProject.version,
    };
    
    // 导入数据消毒：防止 XSS 和无效数据
    const sanitized = sanitizeProject(rawProject);

    // 【P2-45 修复】导入后执行树结构校验 + 修复
    const { project: validated, issues } = this.layoutService.validateAndFixTree(sanitized);
    if (issues.length > 0) {
      this.logger.warn('导入项目树结构修复', { projectId, issues });
    }
    return { project: validated, taskIdMap: idMap };
  }

  private async importExternalSourceLinks(exportProject: ExportProject, taskIdMap: Map<string, string>): Promise<void> {
    const links: ExternalSourceLink[] = [];
    for (const task of exportProject.tasks ?? []) {
      const taskId = taskIdMap.get(task.id) ?? task.id;
      const regenerateLinkId = taskId !== task.id;
      for (const link of task.externalSourceLinks ?? []) {
        const normalized = this.toExternalSourceLink(link, taskId, regenerateLinkId);
        if (normalized) links.push(normalized);
      }
    }
    await this.externalSourceLinks.importPointers(links);
  }

  private toExternalSourceLink(
    link: ExportExternalSourceLink,
    taskId: string,
    regenerateId = false
  ): ExternalSourceLink | null {
    if (link.sourceType !== 'siyuan-block' || !link.targetId || !link.uri) return null;
    // 校验 targetId 与 uri 是否符合思源块 ID 形式，否则丢弃并打 warn。
    // 不过滤会导致脏数据进 IndexedDB 且在推送到 Supabase 时被 CHECK 约束拒绝，反复重试。
    const parsed = parseSiyuanBlockLink(link.targetId) ?? parseSiyuanBlockLink(link.uri);
    if (!parsed) {
      this.logger.warn('导入跳过非法思源锚点', { taskId, targetId: link.targetId });
      return null;
    }
    return {
      id: regenerateId ? crypto.randomUUID() : (link.id || crypto.randomUUID()),
      taskId,
      sourceType: 'siyuan-block',
      targetId: parsed.blockId,
      uri: parsed.uri,
      label: link.label,
      hpath: link.hpath,
      role: link.role,
      sortOrder: typeof link.sortOrder === 'number' ? link.sortOrder : 0,
      deletedAt: link.deletedAt ?? null,
      createdAt: link.createdAt ?? new Date().toISOString(),
      updatedAt: link.updatedAt ?? new Date().toISOString(),
    };
  }
  
  /**
   * 转换导出任务为 Task
   */
  private convertToTask(
    exportTask: ExportProject['tasks'][0],
    idMap?: Map<string, string>
  ): Task {
    return convertExportTaskToTask(exportTask, { idMap });
  }
  
  /**
   * 转换导出连接为 Connection
   */
  private convertToConnection(
    exportConn: ExportProject['connections'][0],
    idMap?: Map<string, string>
  ): Connection {
    const newId = idMap ? crypto.randomUUID() : exportConn.id;
    const newSource = idMap?.get(exportConn.source) ?? exportConn.source;
    const newTarget = idMap?.get(exportConn.target) ?? exportConn.target;
    
    return {
      id: newId,
      source: newSource,
      target: newTarget,
      title: exportConn.title,
      description: exportConn.description,
      updatedAt: exportConn.updatedAt,
      deletedAt: exportConn.deletedAt,
    };
  }
  
  /**
   * 验证校验和
   */
  private async verifyChecksum(data: ExportData): Promise<boolean> {
    return verifyImportChecksum(data, error => {
      this.logger.debug('校验和验证失败', { error });
    });
  }
  
  /**
   * 更新进度
   */
  private updateProgress(
    stage: ImportProgress['stage'],
    percentage: number,
    currentItem?: string
  ): void {
    this._progress.set({
      stage,
      percentage: Math.min(100, Math.max(0, percentage)),
      currentItem,
    });
  }
  
}
