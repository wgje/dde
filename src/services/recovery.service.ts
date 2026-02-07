/**
 * RecoveryService - 数据恢复服务
 * 
 * 【P2 E 层服务端恢复】
 * 职责：
 * - 列出可用的恢复点（来自服务端备份）
 * - 预览恢复内容（下载备份元数据）
 * - 执行两阶段恢复（快照 → 恢复 → 回滚/提交）
 * - 与 ErrorRecoveryModalComponent 集成
 * 
 * 设计理念：
 * - 恢复前必须创建当前数据快照
 * - 使用两阶段提交保证原子性
 * - 失败自动回滚到恢复前快照
 * - 支持全量恢复和单项目恢复
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SupabaseClientService } from './supabase-client.service';
import { ExportService, type ExportData } from './export.service';
import { ImportService } from './import.service';
import { UserSessionService } from './user-session.service';
import { ProjectStateService } from './project-state.service';
import { CACHE_CONFIG } from '../config';
import { Project } from '../models';

/**
 * 恢复点
 */
export interface RecoveryPoint {
  /** 恢复点 ID */
  id: string;
  /** 备份类型 */
  type: 'full' | 'incremental';
  /** 备份时间 */
  timestamp: string;
  /** 项目数量 */
  projectCount: number;
  /** 任务数量 */
  taskCount: number;
  /** 备份大小（字节） */
  size: number;
  /** 存储路径 */
  path: string;
}

/**
 * 恢复预览
 */
export interface RecoveryPreview {
  /** 恢复点信息 */
  point: RecoveryPoint;
  /** 项目列表摘要 */
  projects: Array<{ id: string; name: string; taskCount: number }>;
  /** 与当前数据的差异概要 */
  diff: {
    projectsToRestore: number;
    tasksToRestore: number;
    connectionsToRestore: number;
  };
}

/**
 * 恢复选项
 */
export interface RecoveryOptions {
  /** 恢复模式：替换或合并 */
  mode: 'replace' | 'merge';
  /** 恢复范围 */
  scope: 'all' | 'project';
  /** 指定项目 ID（scope 为 project 时必填） */
  projectId?: string;
  /** 是否在恢复前创建快照 */
  createSnapshot: boolean;
}

/**
 * 恢复结果
 */
export interface RecoveryResult {
  /** 是否成功 */
  success: boolean;
  /** 恢复时间 */
  recoveredAt?: string;
  /** 错误信息 */
  error?: string;
  /** 是否已回滚 */
  rolledBack?: boolean;
  /** 恢复前快照 ID */
  snapshotId?: string;
}

/**
 * 恢复进度
 */
export interface RecoveryProgress {
  stage: 'idle' | 'listing' | 'previewing' | 'snapshot' | 'recovering' | 'rolling-back' | 'complete' | 'failed';
  percentage: number;
  message?: string;
}

@Injectable({
  providedIn: 'root'
})
export class RecoveryService {
  private readonly logger = inject(LoggerService).category('Recovery');
  private readonly toast = inject(ToastService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabaseClient = inject(SupabaseClientService);
  private readonly exportService = inject(ExportService);
  private readonly importService = inject(ImportService);
  private readonly userSession = inject(UserSessionService);
  private readonly projectState = inject(ProjectStateService);

  /** 可用恢复点列表 */
  private readonly _recoveryPoints = signal<RecoveryPoint[]>([]);
  readonly recoveryPoints = computed(() => this._recoveryPoints());

  /** 恢复进度 */
  private readonly _progress = signal<RecoveryProgress>({ stage: 'idle', percentage: 0 });
  readonly progress = computed(() => this._progress());

  /** 是否正在恢复 */
  readonly isRecovering = computed(() => {
    const stage = this._progress().stage;
    return stage !== 'idle' && stage !== 'complete' && stage !== 'failed';
  });

  /** 恢复前快照（用于回滚） */
  private preRecoverySnapshot: Blob | null = null;

  /**
   * 列出可用的恢复点
   * 从 Supabase Storage 的备份桶中获取
   */
  async listRecoveryPoints(): Promise<RecoveryPoint[]> {
    this._progress.set({ stage: 'listing', percentage: 10, message: '正在获取恢复点列表...' });

    try {
      const client = this.supabaseClient.client();
      if (!client) {
        this.logger.warn('Supabase 客户端不可用，无法获取恢复点');
        this._progress.set({ stage: 'idle', percentage: 0 });
        return [];
      }

      const userId = this.userSession.currentUserId();
      if (!userId) {
        this._progress.set({ stage: 'idle', percentage: 0 });
        return [];
      }

      // 从 backups 存储桶列出用户的备份文件
      const { data: files, error } = await client.storage
        .from('backups')
        .list(`${userId}/`, {
          limit: 50,
          sortBy: { column: 'created_at', order: 'desc' },
        });

      if (error) {
        this.logger.error('获取备份列表失败', error);
        this._progress.set({ stage: 'idle', percentage: 0 });
        return [];
      }

      const points: RecoveryPoint[] = (files || [])
        .filter(f => f.name.endsWith('.json') || f.name.endsWith('.nanoflow'))
        .map(f => ({
          id: f.id ?? f.name,
          type: f.name.includes('incremental') ? 'incremental' as const : 'full' as const,
          timestamp: f.created_at ?? new Date().toISOString(),
          projectCount: 0, // 需要下载元数据才能获取
          taskCount: 0,
          size: f.metadata?.size ?? 0,
          path: `${userId}/${f.name}`,
        }));

      this._recoveryPoints.set(points);
      this._progress.set({ stage: 'idle', percentage: 0 });

      this.logger.info(`找到 ${points.length} 个恢复点`);
      return points;
    } catch (error) {
      this.logger.error('列出恢复点失败', error);
      this._progress.set({ stage: 'failed', percentage: 0, message: '获取恢复点失败' });
      return [];
    }
  }

  /**
   * 预览恢复内容
   * 下载备份文件的元数据部分
   */
  async previewRecovery(pointId: string): Promise<RecoveryPreview | null> {
    this._progress.set({ stage: 'previewing', percentage: 20, message: '正在加载恢复预览...' });

    try {
      const point = this._recoveryPoints().find(p => p.id === pointId);
      if (!point) {
        this.logger.error('恢复点不存在', { pointId });
        this._progress.set({ stage: 'idle', percentage: 0 });
        return null;
      }

      const client = this.supabaseClient.client();
      if (!client) {
        this._progress.set({ stage: 'idle', percentage: 0 });
        return null;
      }

      // 下载备份文件
      const { data, error } = await client.storage
        .from('backups')
        .download(point.path);

      if (error || !data) {
        this.logger.error('下载备份预览失败', error);
        this._progress.set({ stage: 'idle', percentage: 0 });
        return null;
      }

      // 解析备份内容（只取元数据部分）
      const text = await data.text();
      const backupData = JSON.parse(text) as {
        projects?: Array<{ id: string; name: string; tasks?: unknown[] }>;
        tasks?: unknown[];
        connections?: unknown[];
      };

      const projects = (backupData.projects || []).map(p => ({
        id: p.id,
        name: p.name,
        taskCount: Array.isArray(p.tasks) ? p.tasks.length : 0,
      }));

      const totalTasks = projects.reduce((sum, p) => sum + p.taskCount, 0) 
        || (Array.isArray(backupData.tasks) ? backupData.tasks.length : 0);
      const totalConnections = Array.isArray(backupData.connections) ? backupData.connections.length : 0;

      // 更新恢复点的统计信息
      point.projectCount = projects.length;
      point.taskCount = totalTasks;

      const preview: RecoveryPreview = {
        point,
        projects,
        diff: {
          projectsToRestore: projects.length,
          tasksToRestore: totalTasks,
          connectionsToRestore: totalConnections,
        },
      };

      this._progress.set({ stage: 'idle', percentage: 0 });
      return preview;
    } catch (error) {
      this.logger.error('预览恢复内容失败', error);
      this._progress.set({ stage: 'idle', percentage: 0 });
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：预览失败由调用方处理
      return null;
    }
  }

  /**
   * 执行恢复（两阶段提交）
   * 
   * 阶段 1：创建恢复前快照
   * 阶段 2：下载备份并导入
   * 失败时回滚到快照
   */
  async executeRecovery(pointId: string, options: RecoveryOptions): Promise<RecoveryResult> {
    const point = this._recoveryPoints().find(p => p.id === pointId);
    if (!point) {
      return { success: false, error: '恢复点不存在' };
    }

    if (options.scope === 'project' && !options.projectId) {
      return { success: false, error: '恢复单项目时必须提供 projectId' };
    }

    this.logger.info('开始执行恢复', { pointId, options });

    try {
      // ===== 阶段 1：创建恢复前快照 =====
      let snapshotId: string | undefined;
      if (options.createSnapshot) {
        this._progress.set({ stage: 'snapshot', percentage: 20, message: '正在创建恢复前快照...' });

        const snapshotResult = await this.createPreRecoverySnapshot();
        if (!snapshotResult) {
          return { success: false, error: '无法创建恢复前快照，恢复已中止' };
        }
        snapshotId = snapshotResult;
      }

      // ===== 阶段 2：下载并应用备份 =====
      this._progress.set({ stage: 'recovering', percentage: 40, message: '正在下载备份数据...' });

      const client = this.supabaseClient.client();
      if (!client) {
        return { success: false, error: 'Supabase 客户端不可用' };
      }

      const { data: backupBlob, error: downloadError } = await client.storage
        .from('backups')
        .download(point.path);

      if (downloadError || !backupBlob) {
        this.logger.error('下载备份失败', downloadError);
        return { success: false, error: '下载备份数据失败', snapshotId };
      }

      this._progress.set({ stage: 'recovering', percentage: 60, message: '正在恢复数据...' });

      // 将备份 Blob 转为 File 对象，交给 ImportService 处理
      const fileName = `recovery-${point.id}.json`;
      const file = new File([backupBlob], fileName, { type: 'application/json' });

      // 验证文件
      const validation = await this.importService.validateFile(file);
      if (!validation.valid || !validation.data) {
        const importError = validation.error || '备份数据格式无效';
        this.logger.error('备份文件验证失败', { error: importError });

        if (options.createSnapshot && this.preRecoverySnapshot) {
          this._progress.set({ stage: 'rolling-back', percentage: 80, message: '验证失败，正在回滚...' });
          await this.rollbackToSnapshot();
          return { success: false, error: importError, rolledBack: true, snapshotId };
        }
        return { success: false, error: importError, snapshotId };
      }

      const scopedData = this.applyRecoveryScope(validation.data, options);
      if (!scopedData) {
        if (options.createSnapshot && this.preRecoverySnapshot) {
          this._progress.set({ stage: 'rolling-back', percentage: 80, message: '恢复范围无效，正在回滚...' });
          await this.rollbackToSnapshot();
          return { success: false, error: '恢复范围无效或目标项目不存在', rolledBack: true, snapshotId };
        }
        return { success: false, error: '恢复范围无效或目标项目不存在', snapshotId };
      }

      const existingProjects = this.getAllCurrentProjects();
      const importedProjects = new Map<string, Project>();
      const importedProjectIds = new Set<string>();

      // 执行导入
      const importResult = await this.importService.executeImport(
        scopedData,
        existingProjects,
        { conflictStrategy: options.mode === 'replace' ? 'overwrite' : 'merge' },
        async (project: Project) => {
          importedProjects.set(project.id, project);
          importedProjectIds.add(project.id);
        }
      );

      if (!importResult.success) {
        this.logger.error('导入备份数据失败', { error: importResult.error });

        // 恢复失败：回滚到快照
        if (options.createSnapshot && this.preRecoverySnapshot) {
          this._progress.set({ stage: 'rolling-back', percentage: 80, message: '恢复失败，正在回滚...' });
          await this.rollbackToSnapshot();
          return { success: false, error: importResult.error || '导入失败', rolledBack: true, snapshotId };
        }

        return { success: false, error: importResult.error || '导入失败', snapshotId };
      }

      const finalProjects = this.buildFinalProjectState(
        existingProjects,
        importedProjects,
        importedProjectIds,
        options
      );
      this.projectState.setProjects(finalProjects);

      // ===== 恢复成功 =====
      this._progress.set({ stage: 'complete', percentage: 100, message: '恢复完成' });

      this.toast.success('数据恢复成功', `已从 ${new Date(point.timestamp).toLocaleString()} 的备份恢复`);
      this.preRecoverySnapshot = null; // 清理快照

      this.logger.info('恢复完成', { pointId, snapshotId });

      return {
        success: true,
        recoveredAt: new Date().toISOString(),
        snapshotId,
      };
    } catch (error) {
      this.logger.error('恢复过程中发生异常', error);

      this.sentryLazyLoader.captureException(error instanceof Error ? error : new Error('恢复异常'), {
        pointId,
        options,
      });

      // 尝试回滚
      if (options.createSnapshot && this.preRecoverySnapshot) {
        this._progress.set({ stage: 'rolling-back', percentage: 80, message: '异常，正在回滚...' });
        await this.rollbackToSnapshot();
        return {
          success: false,
          error: error instanceof Error ? error.message : '未知错误',
          rolledBack: true,
        };
      }

      this._progress.set({ stage: 'failed', percentage: 0, message: '恢复失败' });
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误',
      };
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 创建恢复前快照
   * 导出当前数据为 Blob 存储在内存中
   */
  private async createPreRecoverySnapshot(): Promise<string | null> {
    try {
      // 使用 ExportService 的能力导出当前全量数据
      const projects = this.getAllCurrentProjects();
      if (projects.length === 0) {
        // 没有数据时跳过快照
        return 'empty-snapshot';
      }

      const result = await this.exportService.exportAllProjects(projects);
      if (result.success && result.blob) {
        this.preRecoverySnapshot = result.blob;
        this.logger.info('恢复前快照已创建');
        return `snapshot-${Date.now()}`;
      }

      this.logger.warn('创建恢复前快照失败：导出返回不成功');
      return null;
    } catch (error) {
      this.logger.error('创建恢复前快照异常', error);
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：快照创建失败不阻断流程
      return null;
    }
  }

  /**
   * 回滚到恢复前快照
   */
  private async rollbackToSnapshot(): Promise<boolean> {
    if (!this.preRecoverySnapshot) {
      this.logger.warn('无恢复前快照可回滚');
      return false;
    }

    try {
      const file = new File(
        [this.preRecoverySnapshot],
        'rollback-snapshot.json',
        { type: 'application/json' }
      );
      const rollbackValidation = await this.importService.validateFile(file);
      if (!rollbackValidation.valid || !rollbackValidation.data) {
        this.logger.error('回滚文件验证失败');
        this.toast.error('回滚失败', '请手动从导出文件恢复');
        return false;
      }

      const existingProjects = this.getAllCurrentProjects();
      const restoredProjects = new Map<string, Project>();
      const restoredProjectIds = new Set<string>();
      const result = await this.importService.executeImport(
        rollbackValidation.data,
        existingProjects,
        { conflictStrategy: 'overwrite' },
        async (project: Project) => {
          restoredProjects.set(project.id, project);
          restoredProjectIds.add(project.id);
        }
      );
      this.preRecoverySnapshot = null;

      if (result.success) {
        const finalProjects = this.buildFinalProjectState(
          existingProjects,
          restoredProjects,
          restoredProjectIds,
          { mode: 'replace', scope: 'all', createSnapshot: false }
        );
        this.projectState.setProjects(finalProjects);
        this.toast.warning('已回滚', '恢复失败，数据已回滚到恢复前状态');
        this.logger.info('已回滚到恢复前快照');
        return true;
      } else {
        this.logger.error('回滚失败', { error: result.error });
        this.toast.error('回滚失败', '请手动从导出文件恢复');
        return false;
      }
    } catch (error) {
      this.logger.error('回滚异常', error);
      return false;
    }
  }

  /**
   * 获取当前所有项目
   * 从 stores 中读取
   */
  private getAllCurrentProjects(): Project[] {
    const inMemoryProjects = this.projectState.projects();
    if (inMemoryProjects.length > 0) {
      return inMemoryProjects;
    }

    try {
      // 从离线快照读取项目列表作为兜底源
      const stored = localStorage.getItem(CACHE_CONFIG.OFFLINE_CACHE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as { projects?: Project[] };
        if (Array.isArray(parsed.projects)) {
          return parsed.projects;
        }
      }
    } catch {
      // 忽略解析错误
    }
    return [];
  }

  /**
   * 按恢复范围过滤备份数据
   */
  private applyRecoveryScope(data: ExportData, options: RecoveryOptions): ExportData | null {
    if (options.scope === 'all') {
      return data;
    }

    if (!options.projectId) {
      return null;
    }

    const targetProject = data.projects.find(project => project.id === options.projectId);
    if (!targetProject) {
      return null;
    }

    const taskCount = targetProject.tasks?.length ?? 0;
    const connectionCount = targetProject.connections?.length ?? 0;
    const attachmentCount = (targetProject.tasks ?? []).reduce((sum, task) => {
      return sum + (task.attachments?.length ?? 0);
    }, 0);

    return {
      ...data,
      metadata: {
        ...data.metadata,
        projectCount: 1,
        taskCount,
        connectionCount,
        attachmentCount,
        exportType: 'single-project',
      },
      projects: [targetProject],
    };
  }

  /**
   * 根据恢复模式生成最终项目状态
   */
  private buildFinalProjectState(
    existingProjects: Project[],
    importedProjects: Map<string, Project>,
    importedProjectIds: Set<string>,
    options: RecoveryOptions
  ): Project[] {
    if (options.mode === 'replace' && options.scope === 'all') {
      return Array.from(importedProjects.values());
    }

    const merged = new Map(existingProjects.map(project => [project.id, project]));
    for (const projectId of importedProjectIds) {
      const imported = importedProjects.get(projectId);
      if (imported) {
        merged.set(projectId, imported);
      }
    }

    return Array.from(merged.values());
  }
}
