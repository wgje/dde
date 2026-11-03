import { signal, inject, Injectable } from '@angular/core';
import { LocalBackupService } from '../../../../services/local-backup.service';
import { ImportService } from '../../../../services/import.service';
import { LoggerService } from '../../../../services/logger.service';
import { LOCAL_BACKUP_CONFIG } from '../../../../config/local-backup.config';
import type { Project } from '../../../../models';
import type { ExportData } from '../../../../services/export.service';
import type { BackupData } from '../../../../../supabase/functions/_shared/backup-utils';
import {
  extractBackupActionQueueActionsForRestore,
  haveSameQueuedActionRestoreSnapshots,
} from '../../../../services/action-queue-restore.helpers';
import { ActionQueueService } from '../../../../services/action-queue.service';
import type { QueuedAction } from '../../../../services/action-queue.types';
import { LOCAL_QUEUE_CONFIG } from '../../../../services/action-queue-storage.helpers';
import { QueueBackupService } from '../../../../services/queue-backup.service';
import {
  countRestorableAttachmentUploadsFromBackup,
  type DataSafetyMetadataRestoreCounts,
} from '../../../../services/import-backup-conversion.helpers';
import { BackupDataSafetyMetadataRestoreService } from '../../../../services/backup-data-safety-metadata-restore.service';
import { DisasterBackupService } from '../../../../services/disaster-backup.service';
import {
  buildLocalBackupFilename,
  createLocalBackupTimestamp,
} from '../../../../services/local-backup-file.helpers';
import { AuthService } from '../../../../services/auth.service';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { LocalBackupUiRestoreTransactionService } from '../../../../services/local-backup-ui-restore-transaction.service';
import { LocalBackupUiRestoreStageService } from '../../../../services/local-backup-ui-restore-stage.service';
import type {
  LocalBackupUiRestoreStageProtocolResult,
} from '../../../../services/local-backup-ui-restore-stage-protocol';
import type { LocalBackupUiRestoreSource } from '../../../../services/local-backup-ui-restore-types';

export interface LocalBackupRestorePreview {
  projects: number;
  tasks: number;
  connections: number;
  attachmentUploads: number;
  actionQueue: number;
  retryQueue: number;
  deadLetters: number;
  conflicts: number;
  projectCursors: number;
  lastSyncTime: number;
  replayLog: number;
  lastWriteExplain: number;
  taskTombstones: number;
  connectionTombstones: number;
}

type RestoredLocalStateCounts = Omit<
  LocalBackupRestorePreview,
  'projects' | 'tasks' | 'connections'
>;

interface RestoreRunContext {
  generation: number;
  ownerUserId: string;
  authIdentityFence: string;
}

interface PendingRestoreContext extends RestoreRunContext {
  data: ExportData;
  rawBackupData: BackupData;
  source: LocalBackupUiRestoreSource;
}

class RestoreContextChangedError extends Error {}
class ActionQueueRestoreReadbackError extends Error {}

/**
 * 本地备份 UI 服务
 *
 * 职责：
 * - 备份/恢复流程的 UI 状态管理
 * - 备份文件列表展示与选择
 * - 恢复预览与确认流程
 * - 自动备份开关协调
 *
 * 从 SettingsModalComponent 抽离（2026-05-13）
 */
@Injectable()
export class LocalBackupUIService {
  private readonly localBackupService = inject(LocalBackupService);
  private readonly importService = inject(ImportService);
  private readonly logger = inject(LoggerService);
  private readonly authService = inject(AuthService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly queueBackup = inject(QueueBackupService);
  private readonly metadataRestore = inject(BackupDataSafetyMetadataRestoreService);
  private readonly disasterBackup = inject(DisasterBackupService);
  private readonly restoreTransaction = inject(LocalBackupUiRestoreTransactionService);
  private readonly restoreStages = inject(LocalBackupUiRestoreStageService);

  /** 恢复流程状态 */
  readonly restoreStep = signal<'idle' | 'list' | 'loading' | 'preview' | 'restoring' | 'done' | 'error'>('idle');
  readonly restoreBackupFiles = signal<{ name: string; timestamp: number; size: number }[]>([]);
  readonly restoreSelectedIndex = signal<number>(-1);
  readonly restorePreview = signal<LocalBackupRestorePreview | null>(null);
  readonly restoreError = signal<string>('');
  readonly restoreResultMsg = signal<string>('');
  readonly isRestoringFromBackup = signal(false);
  readonly isExportingDataSafetyPackage = signal(false);
  readonly restoreOrigin = signal<'directory' | 'file'>('directory');

  private restoreGeneration = 0;
  private dataSafetyExportGeneration = 0;
  private pendingRestoreContext: PendingRestoreContext | null = null;
  private confirmRestorePromise: Promise<void> | null = null;

  constructor() {
    // Empty constructor for Angular DI
  }

  /**
   * 设置本地备份目录
   */
  async handleSetupLocalBackup(): Promise<void> {
    await this.localBackupService.requestDirectoryAccess();
  }

  async handleResumeLocalBackupPermission(projectsProvider: () => Project[]): Promise<void> {
    this.localBackupService.setProjectsProvider(projectsProvider);
    const granted = await this.localBackupService.resumePermission();
    if (granted && this.localBackupService.autoBackupEnabled()) {
      this.localBackupService.startAutoBackup(projectsProvider, undefined, { silent: true });
    }
  }

  /**
   * 取消本地备份授权
   */
  async handleRevokeLocalBackup(): Promise<boolean> {
    if (!confirm('确定要取消本地备份吗？')) {
      return false;
    }
    await this.localBackupService.revokeDirectoryAccess();
    return true;
  }

  /**
   * 手动执行本地备份
   */
  async handleManualBackup(projects: Project[]): Promise<void> {
    if (projects.length === 0) {
      alert('没有可备份的项目');
      return;
    }

    const result = await this.localBackupService.performBackup(projects);

    if (result.success) {
      alert(`备份成功！\n文件：${result.filename}\n位置：${result.pathHint}`);
    } else if (result.deferred) {
      alert(`备份暂未完成：${result.error ?? '浏览器恢复连接中，请稍后重试'}`);
    } else {
      alert(`备份失败：${result.error}`);
    }
  }

  async handleDownloadDataSafetyPackage(projects: Project[]): Promise<void> {
    if (this.isExportingDataSafetyPackage()) return;

    const generation = ++this.dataSafetyExportGeneration;
    const ownerUserId = this.resolveRestoreOwnerUserId();
    this.isExportingDataSafetyPackage.set(true);
    try {
      const { blob, deferredCloudUserState } = await this.disasterBackup.buildLocalBlob(projects, {
        autoBackupEnabled: this.localBackupService.autoBackupEnabled(),
        autoBackupIntervalMs: this.localBackupService.autoBackupIntervalMs(),
      });
      if (!this.isDataSafetyExportRunCurrent(generation, ownerUserId)) return;

      this.downloadDataSafetyBlob(
        blob,
        buildLocalBackupFilename(createLocalBackupTimestamp()),
      );
      if (deferredCloudUserState) {
        alert('安全包已导出；云端用户状态本次未完整读取，包内 coverage.includesCloudUserState=false。');
      }
    } catch (error) {
      if (!this.isDataSafetyExportRunCurrent(generation, ownerUserId)) return;
      this.logger.error('导出个人数据安全包失败', error instanceof Error ? error.message : String(error));
      alert(`安全包导出失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      if (generation === this.dataSafetyExportGeneration) {
        this.isExportingDataSafetyPackage.set(false);
      }
    }
  }

  /**
   * 从本地备份恢复 — 打开文件列表面板
   */
  async handleRestoreFromLocalBackup(): Promise<void> {
    if (this.isRestoringFromBackup()) return;
    const run = this.beginRestoreRun();
    this.restoreOrigin.set('directory');
    this.restoreStep.set('loading');
    this.restoreBackupFiles.set([]);
    this.restoreSelectedIndex.set(-1);
    this.restorePreview.set(null);
    this.restoreError.set('');
    this.restoreResultMsg.set('');
    try {
      const files = await this.localBackupService.listBackupFiles();
      if (!this.isRestoreRunCurrent(run)) return;
      this.restoreBackupFiles.set(files);
      this.restoreStep.set('list');
    } catch (error: unknown) {
      if (!this.isRestoreRunCurrent(run)) return;
      this.logger.error('列出备份文件失败', error instanceof Error ? error.message : String(error));
      this.restoreError.set('读取备份目录失败');
      this.restoreStep.set('error');
    }
  }

  /** 选择备份文件 */
  selectRestoreFile(index: number): void {
    if (this.isRestoringFromBackup()) return;
    this.restoreSelectedIndex.set(index);
  }

  /** 格式化备份文件日期 */
  formatBackupDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** 格式化备份文件大小 */
  formatBackupSize(size: number): string {
    return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
  }

  /** 加载所选备份的预览信息 */
  async loadRestorePreview(existingProjects: Project[]): Promise<void> {
    if (this.isRestoringFromBackup()) return;
    const idx = this.restoreSelectedIndex();
    const files = this.restoreBackupFiles();
    if (idx < 0 || idx >= files.length) return;

    const run = this.beginRestoreRun();
    this.restoreStep.set('loading');
    try {
      await this.loadRestorePreviewRun(run, files[idx].name, existingProjects);
    } catch (error: unknown) {
      if (!this.isRestoreRunCurrent(run)) return;
      this.logger.error('读取备份预览失败', error instanceof Error ? error.message : String(error));
      this.restoreError.set('读取备份文件失败');
      this.restoreStep.set('error');
    }
  }

  async loadRestorePreviewFromFile(file: File, existingProjects: Project[]): Promise<void> {
    if (this.isRestoringFromBackup()) return;
    const run = this.beginRestoreRun();
    this.restoreOrigin.set('file');
    this.restoreStep.set('loading');
    this.restoreBackupFiles.set([]);
    this.restoreSelectedIndex.set(-1);
    this.restorePreview.set(null);
    this.restoreError.set('');
    this.restoreResultMsg.set('');
    try {
      await this.loadRestorePreviewFileRun(run, file, existingProjects);
    } catch (error) {
      if (!this.isRestoreRunCurrent(run)) return;
      this.logger.error('读取安全包预览失败', error instanceof Error ? error.message : String(error));
      this.restoreError.set('读取安全包文件失败');
      this.restoreStep.set('error');
    }
  }

  /** 确认恢复 */
  async confirmRestore(
    existingProjects: Project[],
  ): Promise<void> {
    if (this.confirmRestorePromise) return this.confirmRestorePromise;
    const context = this.pendingRestoreContext;
    if (!context) return;
    if (!this.ensureRestoreContextCurrent(context)) return;

    const promise = this.confirmRestoreContext(context, existingProjects)
      .finally(() => {
        if (this.confirmRestorePromise === promise) {
          this.confirmRestorePromise = null;
        }
      });
    this.confirmRestorePromise = promise;
    return promise;
  }

  private async confirmRestoreContext(
    context: PendingRestoreContext,
    existingProjects: Project[],
  ): Promise<void> {
    this.restoreStep.set('restoring');
    this.isRestoringFromBackup.set(true);
    let prepared = false;
    let runStarted = false;
    let transaction: Awaited<ReturnType<LocalBackupUiRestoreTransactionService['prepare']>> | null = null;
    try {
      transaction = await this.restoreTransaction.prepare({
        ownerUserId: context.ownerUserId,
        source: context.source,
        touchedProjectIds: context.data.projects.map(project => project.id),
        retryQueueRestoreItems: Array.isArray(context.rawBackupData.localState?.retryQueue) ? context.rawBackupData.localState.retryQueue : [],
        restoredActionQueueItems: extractBackupActionQueueActionsForRestore(
          context.rawBackupData.localState?.actionQueue,
        ),
        blackBoxBackup: context.rawBackupData,
      });
      prepared = true;
      this.requireRestoreContextCurrent(context);
      const operations = this.restoreStages.createOperations({
        ownerUserId: context.ownerUserId,
        data: context.data,
        backup: context.rawBackupData,
        existingProjects,
        actionQueueRestore: transaction.actionQueueRestore,
        verifyRunContext: () => this.requireRestoreContextCurrent(context),
      });
      runStarted = true;
      const result = await transaction.run(operations);
      if (!this.isRestoreContextCurrent(context)) return;
      if (result.status === 'completed') {
        await this.reloadAndVerifyActionQueue(context);
        if (!this.isRestoreContextCurrent(context)) return;
      }
      this.completeRestoreResult(context, result);
    } catch (error: unknown) {
      if (prepared && !runStarted && transaction) {
        await transaction.abortBeforeMutation().catch(abortError => {
          if (this.isRestoreContextCurrent(context)) {
            this.logger.error(
              '本地备份 prepared transaction 清理失败',
              abortError instanceof Error ? abortError.message : String(abortError),
            );
          }
        });
      }
      if (error instanceof RestoreContextChangedError
        || !this.isRestoreContextCurrent(context)) return;
      this.logger.error('从本地备份恢复失败', error instanceof Error ? error.message : String(error));
      this.restoreError.set(error instanceof ActionQueueRestoreReadbackError
        ? '恢复数据已写入，但队列内存与持久化读回不一致。请刷新页面后继续操作。'
        : '恢复过程中发生错误');
      this.restoreStep.set('error');
    } finally {
      this.isRestoringFromBackup.set(false);
      if (this.pendingRestoreContext === context) {
        this.pendingRestoreContext = null;
      }
    }
  }

  /** 取消/关闭恢复面板 */
  cancelRestore(): void {
    if (this.isRestoringFromBackup()) return;
    this.restoreGeneration += 1;
    this.restoreStep.set('idle');
    this.restoreBackupFiles.set([]);
    this.restoreSelectedIndex.set(-1);
    this.restorePreview.set(null);
    this.pendingRestoreContext = null;
  }

  backFromRestorePreview(): void {
    if (this.isRestoringFromBackup()) return;
    if (this.restoreOrigin() === 'file') {
      this.cancelRestore();
      return;
    }
    this.restoreStep.set('list');
  }

  private async loadRestorePreviewRun(
    run: RestoreRunContext,
    fileName: string,
    existingProjects: Project[],
  ): Promise<void> {
    const file = await this.localBackupService.readBackupFile(fileName);
    if (!this.isRestoreRunCurrent(run)) return;
    if (!file) {
      this.setRestoreError('无法读取备份文件');
      return;
    }

    await this.loadRestorePreviewFileRun(run, file, existingProjects);
  }

  private async loadRestorePreviewFileRun(
    run: RestoreRunContext,
    file: File,
    existingProjects: Project[],
  ): Promise<void> {
    const captured = await captureRestoreFileSnapshot(file);
    const rawBackupData = await this.readBackupDataFromFile(captured.file);
    if (!this.isRestoreRunCurrent(run)) return;
    const validation = await this.importService.validateFile(captured.file);
    if (!this.isRestoreRunCurrent(run)) return;
    if (!validation.valid || !validation.data) {
      this.setRestoreError(`验证失败：${validation.error ?? '未知错误'}`);
      return;
    }
    const ownerScopeError = this.getRestoreOwnerScopeError(rawBackupData, run.ownerUserId);
    if (ownerScopeError) {
      this.restorePreview.set(null);
      this.setRestoreError(ownerScopeError);
      return;
    }

    const metadataCounts = await this.previewDataSafetyMetadata(run, rawBackupData);
    if (!metadataCounts) return;

    const preview = await this.importService.generatePreview(validation.data, existingProjects);
    if (!this.isRestoreRunCurrent(run)) return;
    if (!rawBackupData) {
      this.setRestoreError('该文件不是包含完整本地状态的 NanoFlow 备份，无法进入安全恢复事务。');
      return;
    }
    this.pendingRestoreContext = {
      ...run,
      data: validation.data,
      rawBackupData,
      source: {
        kind: 'local-file',
        reference: file.name || null,
        checksum: captured.sourceDigest,
      },
    };
    this.restorePreview.set({
      projects: preview.projects.length,
      tasks: preview.projects.reduce((sum, project) => sum + project.taskCount, 0),
      connections: preview.projects.reduce((sum, project) => sum + project.connectionCount, 0),
      ...this.buildLocalStateRestorePreview(rawBackupData, metadataCounts),
    });
    this.restoreStep.set('preview');
  }

  private async previewDataSafetyMetadata(
    run: RestoreRunContext,
    backupData: BackupData | null,
  ): Promise<DataSafetyMetadataRestoreCounts | null> {
    if (!backupData?.localState?.dataSafety) {
      return emptyDataSafetyMetadataRestoreCounts();
    }
    let counts: DataSafetyMetadataRestoreCounts | null = null;
    try {
      const metadataPlan = await this.metadataRestore.preview(backupData, run.ownerUserId);
      if (this.isRestoreRunCurrent(run)) counts = metadataPlan.counts;
    } catch (error) {
      if (this.isRestoreRunCurrent(run)) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('本地备份数据安全元数据校验失败', message);
        this.setRestoreError(`数据安全元数据校验失败：${message}`);
      }
    }
    return counts;
  }

  private isDataSafetyExportRunCurrent(generation: number, ownerUserId: string): boolean {
    return generation === this.dataSafetyExportGeneration
      && ownerUserId === this.resolveRestoreOwnerUserId();
  }

  private downloadDataSafetyBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      URL.revokeObjectURL(url);
    }
  }

  private beginRestoreRun(): RestoreRunContext {
    this.restoreGeneration += 1;
    this.pendingRestoreContext = null;
    return {
      generation: this.restoreGeneration,
      ownerUserId: this.resolveRestoreOwnerUserId(),
      authIdentityFence: this.authService.captureAuthIdentityFence(),
    };
  }

  private isRestoreRunCurrent(run: RestoreRunContext): boolean {
    return run.generation === this.restoreGeneration
      && run.ownerUserId === this.resolveRestoreOwnerUserId()
      && run.authIdentityFence === this.authService.captureAuthIdentityFence();
  }

  private ensureRestoreContextCurrent(context: PendingRestoreContext): boolean {
    if (this.isRestoreContextCurrent(context)) return true;
    if (this.pendingRestoreContext === context) {
      this.pendingRestoreContext = null;
    }
    this.restorePreview.set(null);
    this.restoreError.set('恢复已停止：当前账号或恢复上下文已变化，请重新选择备份。');
    this.restoreStep.set('error');
    return false;
  }

  private requireRestoreContextCurrent(context: PendingRestoreContext): void {
    if (!this.isRestoreContextCurrent(context)) throw new RestoreContextChangedError();
  }

  private isRestoreContextCurrent(context: PendingRestoreContext): boolean {
    return this.pendingRestoreContext === context && this.isRestoreRunCurrent(context);
  }

  private completeSuccessfulRestore(
    context: PendingRestoreContext,
    importedCount: number,
    restoreCounts: RestoredLocalStateCounts,
  ): void {
    if (!this.ensureRestoreContextCurrent(context)) return;
    this.restoreResultMsg.set(this.buildRestoreSuccessMessage(importedCount, restoreCounts));
    this.restoreStep.set('done');
  }

  private async reloadAndVerifyActionQueue(context: PendingRestoreContext): Promise<void> {
    try {
      this.requireRestoreContextCurrent(context);
      this.actionQueue.clearCurrentView();
      const [queueSnapshot, deadLetters] = await Promise.all([
        this.queueBackup.restoreQueueSnapshot(context.ownerUserId),
        this.queueBackup.restoreDeadLetters(context.ownerUserId),
      ]);
      this.requireRestoreContextCurrent(context);
      if (!queueSnapshot) {
        throw new ActionQueueRestoreReadbackError('V2 queue snapshot could not be read');
      }

      const durableQueue = queueSnapshot.recordFound ? queueSnapshot.actions : [];
      const mirrorQueue = readOwnerQueueSnapshot(context.ownerUserId);
      if (!mirrorQueue || !haveSameQueuedActionRestoreSnapshots(mirrorQueue as QueuedAction[], durableQueue)) {
        throw new ActionQueueRestoreReadbackError('owner-scoped queue mirror did not match its V2 record');
      }

      await this.actionQueue.reloadFromStorageForCurrentOwner();
      this.requireRestoreContextCurrent(context);
      if (this.actionQueue.getCurrentOwnerStorageLoadState() !== 'loaded') {
        throw new ActionQueueRestoreReadbackError('owner storage reload did not reach loaded state');
      }

      const memoryQueue = this.actionQueue.pendingActions();
      const queueMatches = queueSnapshot.recordFound
        ? haveSameQueuedActionRestoreSnapshots(memoryQueue, durableQueue)
        : memoryQueue.length === 0
          && readOwnerQueueSnapshot(context.ownerUserId)?.length === 0;
      if (!queueMatches) {
        throw new ActionQueueRestoreReadbackError('pending queue did not match its V2 record');
      }

      const expectedDeadLetters = deadLetters ?? readOwnerDeadLetterSnapshot(context.ownerUserId);
      if (!expectedDeadLetters
        || stableSerialize(this.actionQueue.deadLetterQueue()) !== stableSerialize(expectedDeadLetters)) {
        throw new ActionQueueRestoreReadbackError('dead-letter queue did not match durable storage');
      }
    } catch (error) {
      if (error instanceof RestoreContextChangedError) throw error;
      if (this.isRestoreContextCurrent(context)) {
        try {
          if (this.actionQueue.getCurrentOwnerStorageLoadState() !== 'unknown') {
            this.actionQueue.clearCurrentView();
          }
        } catch (clearError) {
          this.logger.error('ActionQueue read-back failure could not freeze the current owner view',
            clearError instanceof Error ? clearError.message : String(clearError));
        }
      }
      if (error instanceof ActionQueueRestoreReadbackError) throw error;
      throw new ActionQueueRestoreReadbackError('owner ActionQueue reload failed');
    }
  }

  private completeRestoreResult(
    context: PendingRestoreContext,
    result: LocalBackupUiRestoreStageProtocolResult,
  ): void {
    if (result.status === 'completed') {
      const importedCount = readStageCount(result.stageResults['projects']);
      this.completeSuccessfulRestore(context, importedCount, {
        attachmentUploads: readStageCount(result.stageResults['attachment-outbox']),
        actionQueue: readStageCount(result.stageResults['action-queue']),
        retryQueue: readStageCount(result.stageResults['retry-queue']),
        deadLetters: readStageCount(result.stageResults['dead-letters']),
        conflicts: readStageCount(result.stageResults['conflicts']),
        ...readMetadataCounts(result.stageResults['metadata']),
      });
      return;
    }
    if (result.status === 'rolled-back') {
      this.setRestoreError(`恢复失败，已恢复到写入前状态：${formatRestoreError(result.error)}`);
      return;
    }
    const reason = result.ownershipLost
      ? '恢复所有权已丢失'
      : '恢复或回滚未能完成';
    this.setRestoreError(`${reason}；安全标记和写入冻结已保留，请勿继续编辑，等待恢复接管。`);
  }

  private setRestoreError(message: string): void {
    this.restoreError.set(message);
    this.restoreStep.set('error');
  }

  private async readBackupDataFromFile(file: File): Promise<BackupData | null> {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      const candidate = parsed as Record<string, unknown>;
      if (typeof candidate['payloadVersion'] !== 'string' || !candidate['localState']) {
        return null;
      }

      return parsed as BackupData;
    } catch {
      // Malformed local backup files keep the UI contract: null triggers the restore error state.
    }
    return null;
  }

  private buildLocalStateRestorePreview(
    backupData: BackupData | null,
    metadataCounts?: DataSafetyMetadataRestoreCounts,
  ): Omit<LocalBackupRestorePreview, 'projects' | 'tasks' | 'connections'> {
    const localState = backupData?.localState;
    return {
      attachmentUploads: backupData
        ? countRestorableAttachmentUploadsFromBackup(backupData)
        : 0,
      actionQueue: this.countActionQueue(localState?.actionQueue),
      retryQueue: this.countArray(localState?.retryQueue),
      deadLetters: this.countArray(localState?.deadLetters),
      conflicts: this.countArray(localState?.conflicts),
      ...(metadataCounts ?? emptyDataSafetyMetadataRestoreCounts()),
    };
  }

  private countArray(source: unknown): number {
    return Array.isArray(source) ? source.length : 0;
  }

  private countActionQueue(source: unknown): number {
    if (Array.isArray(source)) {
      return source.length;
    }
    if (!source || typeof source !== 'object') {
      return 0;
    }

    const record = source as Record<string, unknown>;
    if (Array.isArray(record['actions'])) {
      return record['actions'].length;
    }
    if (Array.isArray(record['queue'])) {
      return record['queue'].length;
    }
    return 0;
  }

  private resolveRestoreOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private getRestoreOwnerScopeError(
    backupData: BackupData | null,
    currentOwnerUserId = this.resolveRestoreOwnerUserId(),
  ): string | null {
    const backupOwnerUserId = this.resolveBackupOwnerUserId(backupData);
    if (!backupOwnerUserId) {
      return '无法验证本地备份所属账号，或备份内的账号标识相互矛盾；已阻止恢复以避免跨账号写入。请使用由单一账号导出的完整备份。';
    }

    if (backupOwnerUserId === currentOwnerUserId) {
      return null;
    }

    return '该本地备份属于其他账号，已阻止恢复以避免把待同步队列、失败记录或冲突副本写入当前账号。请切换到对应账号后再恢复。';
  }

  private resolveBackupOwnerUserId(backupData: BackupData | null): string | null {
    const rawDataSafetyOwner: unknown = backupData?.localState?.dataSafety?.ownerUserId;
    const dataSafetyOwner = typeof rawDataSafetyOwner === 'string'
      && rawDataSafetyOwner.length > 0
      && rawDataSafetyOwner.trim() === rawDataSafetyOwner
      ? rawDataSafetyOwner
      : null;
    if (rawDataSafetyOwner !== undefined && dataSafetyOwner === null) {
      return null;
    }

    const projects: unknown = backupData?.projects ?? [];
    if (!Array.isArray(projects)) return null;

    const projectOwners = new Set<string>();
    for (const project of projects) {
      if (project === null || typeof project !== 'object') return null;
      const rawProjectOwner: unknown = (project as { userId?: unknown }).userId;
      if (rawProjectOwner === undefined || rawProjectOwner === null) continue;
      if (typeof rawProjectOwner !== 'string'
        || rawProjectOwner.length === 0
        || rawProjectOwner.trim() !== rawProjectOwner) {
        return null;
      }
      projectOwners.add(rawProjectOwner);
    }

    if (projectOwners.size > 1) return null;
    const projectOwner = projectOwners.values().next().value ?? null;
    if (dataSafetyOwner && projectOwner && dataSafetyOwner !== projectOwner) return null;

    return dataSafetyOwner ?? projectOwner;
  }

  private buildRestoreSuccessMessage(
    importedCount: number,
    restored: RestoredLocalStateCounts,
  ): string {
    const baseMessage = `恢复成功！已导入 ${importedCount} 个项目`;
    const segments = [
      ...this.buildQueueRestoreSuccessSegments(restored),
      ...this.buildDataSafetyRestoreSuccessSegments(restored),
    ];

    return segments.length === 0 ? baseMessage : `${baseMessage}，${segments.join('，')}`;
  }

  private buildQueueRestoreSuccessSegments(restored: RestoredLocalStateCounts): string[] {
    const segments: string[] = [];
    if (restored.attachmentUploads > 0) {
      segments.push(`已恢复 ${restored.attachmentUploads} 个待上传附件`);
    }
    if (restored.actionQueue > 0) {
      segments.push(`已恢复 ${restored.actionQueue} 个待同步操作`);
    }
    if (restored.retryQueue > 0) {
      segments.push(`已恢复 ${restored.retryQueue} 个待重试同步操作`);
    }
    if (restored.deadLetters > 0) {
      segments.push(`已恢复 ${restored.deadLetters} 条同步失败记录`);
    }
    if (restored.conflicts > 0) {
      segments.push(`已恢复 ${restored.conflicts} 条冲突副本`);
    }
    return segments;
  }

  private buildDataSafetyRestoreSuccessSegments(restored: RestoredLocalStateCounts): string[] {
    const segments: string[] = [];
    if (restored.projectCursors > 0) {
      segments.push(`已恢复 ${restored.projectCursors} 个项目同步游标`);
    }
    if (restored.lastSyncTime > 0) {
      segments.push('已恢复同步时间快照');
    }
    if (restored.replayLog > 0) {
      segments.push(`已恢复 ${restored.replayLog} 条写入审计`);
    }
    if (restored.lastWriteExplain > 0) {
      segments.push('已恢复最近写入解释');
    }
    if (restored.taskTombstones > 0) {
      segments.push(`已恢复 ${restored.taskTombstones} 个任务删除标记`);
    }
    if (restored.connectionTombstones > 0) {
      segments.push(`已恢复 ${restored.connectionTombstones} 个连接删除标记`);
    }
    return segments;
  }

  /**
   * 切换自动备份
   * 开启时自动请求权限（用户点击开关本身就是用户手势）
   */
  async toggleAutoBackup(projectsProvider: () => Project[]): Promise<void> {
    if (this.localBackupService.autoBackupEnabled()) {
      // 关闭自动备份
      this.localBackupService.stopAutoBackup();
    } else {
      // 开启自动备份
      // 先确保已授权（浏览器重启后需要重新请求权限）
      if (!this.localBackupService.isAuthorized()) {
        // 设置项目提供者
        this.localBackupService.setProjectsProvider(projectsProvider);
        // 请求权限（用户点击开关就是用户手势，可以触发权限请求）
        const granted = await this.localBackupService.resumePermission();
        if (!granted) {
          // 权限请求失败或被拒绝，不开启自动备份
          return;
        }
      }

      // 权限已授予，启动自动备份
      this.localBackupService.startAutoBackup(projectsProvider, LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS);
    }
  }
}

async function captureRestoreFileSnapshot(
  source: File,
): Promise<{ file: File; sourceDigest: string }> {
  const bytes = await source.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sourceDigest = `sha256:${Array.from(new Uint8Array(digest), byte => (
    byte.toString(16).padStart(2, '0')
  )).join('')}`;
  return {
    file: new File([bytes], source.name, { type: source.type, lastModified: source.lastModified }),
    sourceDigest,
  };
}

function emptyDataSafetyMetadataRestoreCounts(): DataSafetyMetadataRestoreCounts {
  return {
    projectCursors: 0,
    lastSyncTime: 0,
    replayLog: 0,
    lastWriteExplain: 0,
    taskTombstones: 0,
    connectionTombstones: 0,
  };
}

function readStageCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readMetadataCounts(value: unknown): DataSafetyMetadataRestoreCounts {
  if (!value || typeof value !== 'object') return emptyDataSafetyMetadataRestoreCounts();
  const record = value as Record<string, unknown>;
  return {
    projectCursors: readStageCount(record['projectCursors']),
    lastSyncTime: readStageCount(record['lastSyncTime']),
    replayLog: readStageCount(record['replayLog']),
    lastWriteExplain: readStageCount(record['lastWriteExplain']),
    taskTombstones: readStageCount(record['taskTombstones']),
    connectionTombstones: readStageCount(record['connectionTombstones']),
  };
}

function formatRestoreError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOwnerDeadLetterSnapshot(ownerUserId: string): unknown[] | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(`${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.${ownerUserId}`);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readOwnerQueueSnapshot(ownerUserId: string): unknown[] | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.${ownerUserId}`);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
