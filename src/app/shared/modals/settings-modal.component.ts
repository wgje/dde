import { Component, inject, output, input, computed, viewChild, ElementRef, isDevMode, ChangeDetectionStrategy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LoggerService } from '../../../services/logger.service';
import { UserSessionService } from '../../../services/user-session.service';
import { PreferenceService } from '../../../services/preference.service';
import { ExportService } from '../../../services/export.service';
import { ImportService, ImportOptions } from '../../../services/import.service';
import { AttachmentExportService } from '../../../services/attachment-export.service';
import { AttachmentImportService } from '../../../services/attachment-import.service';
import { LocalBackupService } from '../../../services/local-backup.service';
import { ThemeService } from '../../../services/theme.service';
import { DockEngineService } from '../../../services/dock-engine.service';
import { FocusPreferenceService } from '../../../services/focus-preference.service';
import { GateService } from '../../../services/gate.service';
import { LocalBackupUIService } from './settings-modal/local-backup-ui.service';
import { SiyuanSettingsUIService } from './settings-modal/siyuan-settings-ui.service';
import { SettingsModalAppearanceComponent } from './settings-modal-appearance.component';
import { ThemeType, ColorMode, Project } from '../../../models';
import {
  runAttachmentImportWorkflow,
} from './settings-modal-attachment-import.helpers';

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, SettingsModalAppearanceComponent],
  providers: [LocalBackupUIService, SiyuanSettingsUIService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-modal.component.html',
})
export class SettingsModalComponent {
  private readonly siyuanUI = inject(SiyuanSettingsUIService);

  constructor() {
    // 组件初始化 - 开发日志已移除
    // 设置项目提供者，用于自动备份恢复
    this.localBackupService.setProjectsProvider(() => this.projects());
    effect(() => {
      if (this.initialSection() !== 'focus-routines') return;
      const section = this.focusRoutineSectionRef()?.nativeElement;
      if (!section) return;
      queueMicrotask(() => {
        section.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    });
    void this.loadSiyuanConfig();
  }
  readonly dockEngine = inject(DockEngineService);
  readonly userSession = inject(UserSessionService);
  readonly preferenceService = inject(PreferenceService);
  readonly exportService = inject(ExportService);
  readonly importService = inject(ImportService);
  readonly attachmentExportService = inject(AttachmentExportService);
  readonly attachmentImportService = inject(AttachmentImportService);
  readonly localBackupService = inject(LocalBackupService);
  readonly localBackupUI = inject(LocalBackupUIService);
  readonly themeService = inject(ThemeService);
  readonly focusPreferenceService = inject(FocusPreferenceService);
  readonly gateService = inject(GateService);
  private readonly logger = inject(LoggerService);
  
  /** 是否开发模式（用于显示开发工具） */
  readonly isDev = isDevMode();
  
  /** 当前登录用户邮箱 */
  sessionEmail = input<string | null>(null);
  initialSection = input<'focus-routines' | null>(null);
  
  /** 所有项目（用于导出） */
  projects = input<Project[]>([]);
  private readonly focusRoutineSectionRef = viewChild<ElementRef<HTMLElement>>('focusRoutineSection');
  
  readonly close = output<void>();
  readonly signOut = output<void>();
  readonly themeChange = output<ThemeType>();
  readonly openDashboard = output<void>();
  readonly importComplete = output<Project>();
  readonly importProject = input<(project: Project) => void | Promise<void>>();
  readonly routineSlots = computed(() =>
    [...this.dockEngine.dailySlots()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
  newRoutineTitle = '';
  newRoutineMaxCount = 1;

  /** 附件传输状态文案 */
  readonly attachmentTransferStatus = computed(() => {
    if (this.attachmentExportService.isExporting()) {
      const progress = this.attachmentExportService.progress();
      const processed = progress.processedCount;
      const total = progress.totalCount;
      return `导出中 ${Math.round(progress.percentage)}% (${processed}/${total || 0})`;
    }

    if (this.attachmentImportService.isImporting()) {
      const progress = this.attachmentImportService.progress();
      const processed = progress.completedItems + progress.failedItems + progress.skippedItems;
      return `导入中 ${Math.round(progress.percentage)}% (${processed}/${progress.totalItems || 0})`;
    }

    return 'ZIP 原文件导出与分批导入';
  });
  
  /** 本地备份间隔选项 */
  readonly backupIntervalOptions = [
    { label: '15 分钟', value: 15 * 60 * 1000 },
    { label: '30 分钟', value: 30 * 60 * 1000 },
    { label: '1 小时', value: 60 * 60 * 1000 },
    { label: '2 小时', value: 2 * 60 * 60 * 1000 },
  ];
  readonly routineResetHours = Array.from({ length: 24 }, (_, index) => index);
  readonly restReminderHighLoadOptions = [45, 60, 75, 90, 120, 150, 180];
  readonly restReminderLowLoadOptions = [10, 15, 20, 30, 45, 60, 90];
  
  /** 当前选择的备份间隔 */
  readonly selectedBackupInterval = computed(() => {
    const currentInterval = this.localBackupService.autoBackupIntervalMs();
    return this.backupIntervalOptions.find(opt => opt.value === currentInterval)?.label || '30 分钟';
  });
  
  /** 格式化上次备份时间 */
  readonly formattedLastBackupTime = computed(() => {
    const time = this.localBackupService.lastBackupTime();
    if (!time) return null;
    const date = new Date(time);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  /** 是否正在从备份恢复（委托给 localBackupUI） */
  readonly isRestoringFromBackup = this.localBackupUI.isRestoringFromBackup;
  readonly siyuanRuntimeMode = this.siyuanUI.runtimeMode;
  readonly siyuanBaseUrl = this.siyuanUI.baseUrl;
  readonly siyuanTokenMask = this.siyuanUI.tokenMask;
  readonly siyuanConnectionStatus = this.siyuanUI.connectionStatus;
  readonly defaultSiyuanBaseUrl = this.siyuanUI.defaultBaseUrl;
  readonly siyuanExtensionStatus = this.siyuanUI.extensionStatus;
  readonly isSavingSiyuanToExtension = this.siyuanUI.isSavingToExtension;
  readonly siyuanExtensionSupported = this.siyuanUI.extensionSupported;
  readonly siyuanExtensionStatusMessage = this.siyuanUI.extensionStatusMessage;
  readonly siyuanExtensionStatusClass = this.siyuanUI.extensionStatusClass;
  readonly siyuanTokenLabel = this.siyuanUI.tokenLabel;
  readonly siyuanTokenPlaceholder = this.siyuanUI.tokenPlaceholder;
  
  /** 文件输入引用 - 使用 viewChild signal 引用模板中的 #fileInput */
  private readonly fileInputRef = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  /** 个人数据安全包恢复文件输入 */
  private readonly dataSafetyRestoreInputRef = viewChild<ElementRef<HTMLInputElement>>('dataSafetyRestoreInput');
  /** 附件 ZIP 导入文件输入 */
  private readonly attachmentZipInputRef = viewChild<ElementRef<HTMLInputElement>>('attachmentZipInput');
  
  updateTheme(theme: ThemeType) {
    this.themeChange.emit(theme);
  }
  
  updateColorMode(mode: ColorMode) {
    this.themeService.setColorMode(mode);
  }

  async loadSiyuanConfig(): Promise<void> {
    await this.siyuanUI.loadConfig();
  }

  async updateSiyuanRuntimeMode(event: Event): Promise<void> {
    await this.siyuanUI.updateRuntimeMode(event);
  }

  async updateSiyuanBaseUrl(event: Event): Promise<void> {
    await this.siyuanUI.updateBaseUrl(event);
  }

  async updateSiyuanToken(event: Event): Promise<void> {
    await this.siyuanUI.updateToken(event);
  }

  async saveSiyuanConfigToExtension(): Promise<void> {
    await this.siyuanUI.saveConfigToExtension();
  }

  onSiyuanConfigSubmit(event: Event): void {
    this.siyuanUI.onConfigSubmit(event);
  }

  async testSiyuanConnection(): Promise<void> {
    await this.siyuanUI.testConnection();
  }

  async clearSiyuanCache(): Promise<void> {
    await this.siyuanUI.clearPreviewCache();
  }

  async forgetSiyuanConfig(): Promise<void> {
    await this.siyuanUI.forgetConfig();
  }

  toggleAutoResolve() {
    const current = this.preferenceService.autoResolveConflicts();
    this.preferenceService.setAutoResolveConflicts(!current);
  }
  
  /**
   * 处理导出
   */
  async handleExport(): Promise<void> {
    const projectList = this.projects();
    if (projectList.length === 0) {
      return;
    }
    
    await this.exportService.exportAndDownload(projectList);
  }

  /**
   * 导出附件 ZIP
   */
  async handleAttachmentExport(): Promise<void> {
    const projectList = this.projects();
    if (projectList.length === 0) {
      alert('没有可导出的项目');
      return;
    }

    const result = await this.attachmentExportService.exportAndDownload(projectList);
    if (!result.success) {
      alert(`附件导出失败：${result.error ?? '未知错误'}`);
      return;
    }

    if (!result.blob) {
      alert('附件导出完成：当前项目没有可导出的附件');
      return;
    }
  }
  
  /**
   * 触发文件选择
   */
  triggerImportFileSelect(): void {
    // 使用 viewChild 引用获取文件输入元素
    const inputRef = this.fileInputRef();
    if (inputRef?.nativeElement) {
      inputRef.nativeElement.click();
    } else {
      this.logger.error('SettingsModal', '文件输入元素未找到');
    }
  }

  async handleDataSafetyPackageExport(): Promise<void> {
    await this.localBackupUI.handleDownloadDataSafetyPackage(this.projects());
  }

  triggerDataSafetyRestoreFileSelect(): void {
    const inputRef = this.dataSafetyRestoreInputRef();
    if (inputRef?.nativeElement) {
      inputRef.nativeElement.click();
    } else {
      this.logger.error('SettingsModal', '个人数据安全包输入元素未找到');
    }
  }

  async handleDataSafetyRestoreFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    await this.localBackupUI.loadRestorePreviewFromFile(file, this.projects());
  }

  /**
   * 触发附件 ZIP 导入文件选择
   */
  triggerAttachmentImportFileSelect(): void {
    const inputRef = this.attachmentZipInputRef();
    if (inputRef?.nativeElement) {
      inputRef.nativeElement.click();
    } else {
      this.logger.error('SettingsModal', '附件 ZIP 输入元素未找到');
    }
  }
  
  /**
   * 处理文件选择
   */
  async handleFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    
    if (!file) return;
    
    // 清空 input 以便可以再次选择同一文件
    input.value = '';

    if (await this.isPortableDataSafetyBackupFile(file)) {
      await this.localBackupUI.loadRestorePreviewFromFile(file, this.projects());
      return;
    }
    
    // 验证文件
    const validation = await this.importService.validateFile(file);
    if (!validation.valid || !validation.data) {
      alert(`导入失败：${validation.error}`);
      return;
    }
    
    // 生成预览
    const preview = await this.importService.generatePreview(
      validation.data,
      this.projects()
    );
    
    // 如果有冲突，询问用户
    let conflictStrategy: ImportOptions['conflictStrategy'] = 'skip';
    if (preview.conflicts.length > 0) {
      const choice = confirm(
        `发现 ${preview.conflicts.length} 个冲突项目。\n` +
        `点击"确定"跳过冲突项目，点击"取消"覆盖现有项目。`
      );
      conflictStrategy = choice ? 'skip' : 'overwrite';
    }
    
    // 执行导入
    const result = await this.importService.executeImport(
      validation.data,
      this.projects(),
      { conflictStrategy },
      project => this.notifyImportComplete(project)
    );
    
    if (result.success) {
      alert(`导入完成！\n成功: ${result.importedCount}\n跳过: ${result.skippedCount}`);
    } else {
      alert(`导入失败：${result.error}`);
    }
  }

  private async isPortableDataSafetyBackupFile(file: File): Promise<boolean> {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== 'object') return false;
      const record = parsed as Record<string, unknown>;
      return typeof record['payloadVersion'] === 'string'
        && !!record['localState']
        && typeof record['localState'] === 'object'
        && Array.isArray(record['projects'])
        && Array.isArray(record['tasks'])
        && Array.isArray(record['connections']);
    } catch {
      return false;
    }
  }

  /**
   * 处理附件 ZIP 选择并导入
   */
  async handleAttachmentImportFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) return;
    input.value = '';

    if (!file.name.toLowerCase().endsWith('.zip')) {
      alert('请选择 ZIP 附件包文件');
      return;
    }

    try {
      const result = await runAttachmentImportWorkflow(
        file,
        this.projects(),
        (zipData, taskAttachmentMap) => this.attachmentImportService.extractAttachmentsFromZip(
          zipData,
          taskAttachmentMap,
        ),
        (projectId, items) => this.attachmentImportService.importAttachments(projectId, items),
      );
      alert(result.message);
      if (result.warning) {
        this.logger.warn('SettingsModal', result.warning);
      }
    } catch (error: unknown) {
      this.logger.error('SettingsModal', '附件 ZIP 导入失败', error);
      alert(`附件导入失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  // ============================================
  // 本地备份方法（委托给 LocalBackupUIService）
  // ============================================

  /**
   * 设置本地备份目录
   */
  async handleSetupLocalBackup(): Promise<void> {
    await this.localBackupUI.handleSetupLocalBackup();
  }

  /**
   * 取消本地备份授权
   */
  async handleRevokeLocalBackup(): Promise<void> {
    await this.localBackupUI.handleRevokeLocalBackup();
  }

  /**
   * 手动执行本地备份
   */
  async handleManualBackup(): Promise<void> {
    await this.localBackupUI.handleManualBackup(this.projects());
  }

  /**
   * 从本地备份恢复 — 打开文件列表面板
   */
  async handleRestoreFromLocalBackup(): Promise<void> {
    await this.localBackupUI.handleRestoreFromLocalBackup();
  }

  /** 选择备份文件 */
  selectRestoreFile(index: number): void {
    this.localBackupUI.selectRestoreFile(index);
  }

  /** 格式化备份文件日期 */
  formatBackupDate(timestamp: number): string {
    return this.localBackupUI.formatBackupDate(timestamp);
  }

  /** 格式化备份文件大小 */
  formatBackupSize(size: number): string {
    return this.localBackupUI.formatBackupSize(size);
  }

  /** 加载所选备份的预览信息 */
  async loadRestorePreview(): Promise<void> {
    await this.localBackupUI.loadRestorePreview(this.projects());
  }

  backFromRestorePreview(): void {
    this.localBackupUI.backFromRestorePreview();
  }

  /** 确认恢复 */
  async confirmRestore(): Promise<void> {
    await this.localBackupUI.confirmRestore(this.projects());
  }

  private async notifyImportComplete(project: Project): Promise<void> {
    const importProject = this.importProject();
    if (importProject) {
      await importProject(project);
      return;
    }
    this.importComplete.emit(project);
  }

  /** 取消/关闭恢复面板 */
  cancelRestore(): void {
    this.localBackupUI.cancelRestore();
  }

  /**
   * 切换自动备份
   * 开启时自动请求权限（用户点击开关本身就是用户手势）
   */
  async toggleAutoBackup(): Promise<void> {
    await this.localBackupUI.toggleAutoBackup(() => this.projects());
  }

  async resumeLocalBackupPermission(): Promise<void> {
    await this.localBackupUI.handleResumeLocalBackupPermission(() => this.projects());
  }
  
  // ============================================
  // 专注模式设置方法
  // ============================================
  
  /**
   * 切换大门功能
   */
  toggleGateEnabled(): void {
    const current = this.focusPreferenceService.preferences().gateEnabled;
    this.focusPreferenceService.update({ gateEnabled: !current });
  }
  
  /**
   * 切换黑匣子功能
   */
  toggleBlackBoxEnabled(): void {
    const current = this.focusPreferenceService.preferences().blackBoxEnabled;
    this.focusPreferenceService.update({ blackBoxEnabled: !current });
  }
  
  /**
   * 切换地质层功能
   */
  toggleStrataEnabled(): void {
    const current = this.focusPreferenceService.preferences().strataEnabled;
    this.focusPreferenceService.update({ strataEnabled: !current });
  }
  
  updateRoutineResetHour(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = Number.parseInt(select.value, 10);
    if (Number.isNaN(value)) return;
    this.focusPreferenceService.update({
      routineResetHourLocal: Math.min(23, Math.max(0, value)),
    });
  }

  updateRestReminderHighLoadMinutes(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = Number.parseInt(select.value, 10);
    if (Number.isNaN(value)) return;
    this.focusPreferenceService.setRestReminderHighLoadMinutes(value);
  }

  updateRestReminderLowLoadMinutes(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = Number.parseInt(select.value, 10);
    if (Number.isNaN(value)) return;
    this.focusPreferenceService.setRestReminderLowLoadMinutes(value);
  }

  formatRoutineResetHour(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
  }

  formatReminderMinutes(minutes: number): string {
    if (minutes >= 60 && minutes % 60 === 0) {
      return `${minutes / 60} 小时`;
    }
    return `${minutes} 分钟`;
  }

  async addRoutineSlot(): Promise<void> {
    const title = this.newRoutineTitle.trim();
    if (!title) return;
    const nextMax = Math.min(24, Math.max(1, Math.floor(Number(this.newRoutineMaxCount) || 1)));
    const id = await this.dockEngine.dailySlotService.addDailySlot(title, nextMax);
    if (!id) return;
    this.newRoutineTitle = '';
    this.newRoutineMaxCount = 1;
  }

  completeRoutineSlot(id: string): Promise<boolean> {
    return this.dockEngine.dailySlotService.completeDailySlot(id);
  }

  toggleRoutineSlot(id: string, enabled: boolean): Promise<boolean> {
    return this.dockEngine.dailySlotService.setDailySlotEnabled(id, enabled);
  }

  removeRoutineSlot(id: string): Promise<boolean> {
    return this.dockEngine.dailySlotService.removeDailySlot(id);
  }
  
  /**
   * [DEV] 触发大门测试界面
   * 关闭设置模态框并显示大门（带模拟数据）
   */
  triggerDevGate(): void {
    this.gateService.devForceShowGate();
    this.close.emit();
  }
}
