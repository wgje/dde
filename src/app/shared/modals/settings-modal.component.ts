import { Component, inject, output, input, computed, viewChild, ElementRef, isDevMode, ChangeDetectionStrategy, effect, signal } from '@angular/core';
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
import { SettingsModalAppearanceComponent } from './settings-modal-appearance.component';
import { ThemeType, ColorMode, Project } from '../../../models';
import { SIYUAN_CONFIG } from '../../../config/siyuan.config';
import { ExternalSourceCacheService } from '../../core/external-sources/external-source-cache.service';
import { SiyuanPreviewService } from '../../core/external-sources/siyuan/siyuan-preview.service';
import { isTrustedSiyuanDirectBaseUrl } from '../../core/external-sources/siyuan/siyuan-direct-provider';
import type { SiyuanRuntimeMode } from '../../core/external-sources/external-source.model';
import {
  runAttachmentImportWorkflow,
} from './settings-modal-attachment-import.helpers';
import {
  formatSiyuanDiagnosisMessage,
  formatSiyuanExtensionStatusClass,
  formatSiyuanExtensionStatusMessage,
  formatSiyuanPushConfigError,
  formatSiyuanTokenLabel,
  formatSiyuanTokenPlaceholder,
  resolveSiyuanExtensionSupported,
  SIYUAN_TOKEN_MASK,
  type SiyuanExtensionStatusView,
} from './settings-modal-siyuan-view.helpers';

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, SettingsModalAppearanceComponent],
  providers: [LocalBackupUIService],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-modal.component.html',
})
export class SettingsModalComponent {
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
  private readonly siyuanCache = inject(ExternalSourceCacheService);
  private readonly siyuanPreview = inject(SiyuanPreviewService);
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
  readonly siyuanRuntimeMode = signal<SiyuanRuntimeMode>('extension-relay');
  readonly siyuanBaseUrl = signal<string>(SIYUAN_CONFIG.DEFAULT_BASE_URL);
  readonly siyuanTokenMask = signal('');
  readonly siyuanConnectionStatus = signal<string>('');
  readonly defaultSiyuanBaseUrl = SIYUAN_CONFIG.DEFAULT_BASE_URL;
  /**
   * 扩展中已保存的配置状态：
   * - undefined：尚未加载（首次渲染前）
   * - null：扩展未安装/未注入/旧版本不支持 get-config-status
    * - 对象：扩展可达，hasToken 反映扩展侧实际授权；configChannelAvailable=false 表示页面配置读写通道不可用；connectionVerified=true 表示预览通道已通过连接测试；readError=true 表示连接可用但状态读取失败
   */
  readonly siyuanExtensionStatus = signal<SiyuanExtensionStatusView | null | undefined>(undefined);
  readonly isSavingSiyuanToExtension = signal(false);
  /**
   * relay 模式下用户在输入框中暂存的 token 明文（仅内存，永不写入 IndexedDB）。
   * 用户点击"保存到扩展"按钮后 push 给扩展并立即清空。
   */
  private readonly siyuanPendingToken = signal<string>('');

  readonly siyuanExtensionSupported = computed(() => resolveSiyuanExtensionSupported(this.siyuanExtensionStatus()));
  readonly siyuanExtensionStatusMessage = computed(() => formatSiyuanExtensionStatusMessage(
    this.siyuanExtensionStatus(),
    SIYUAN_CONFIG.DEFAULT_BASE_URL,
  ));
  readonly siyuanExtensionStatusClass = computed(() => formatSiyuanExtensionStatusClass(this.siyuanExtensionStatus()));
  readonly siyuanTokenLabel = computed(() => formatSiyuanTokenLabel(this.siyuanRuntimeMode()));
  readonly siyuanTokenPlaceholder = computed(() => formatSiyuanTokenPlaceholder(this.siyuanRuntimeMode()));
  
  /** 文件输入引用 - 使用 viewChild signal 引用模板中的 #fileInput */
  private readonly fileInputRef = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  /** 附件 ZIP 导入文件输入 */
  private readonly attachmentZipInputRef = viewChild<ElementRef<HTMLInputElement>>('attachmentZipInput');
  
  updateTheme(theme: ThemeType) {
    this.themeChange.emit(theme);
  }
  
  updateColorMode(mode: ColorMode) {
    this.themeService.setColorMode(mode);
  }

  async loadSiyuanConfig(): Promise<void> {
    const config = await this.siyuanCache.loadConfig();
    this.siyuanRuntimeMode.set(config.runtimeMode);
    this.siyuanBaseUrl.set(config.baseUrl || SIYUAN_CONFIG.DEFAULT_BASE_URL);
    // relay 模式下页面端不持久化 token；direct 模式下沿用原有 mask 逻辑。
    this.siyuanTokenMask.set(config.runtimeMode === 'extension-relay'
      ? ''
      : (config.token ? SIYUAN_TOKEN_MASK : ''));
    this.siyuanPendingToken.set('');
    if (config.runtimeMode === 'extension-relay') {
      await this.refreshSiyuanExtensionStatus();
    } else {
      this.siyuanExtensionStatus.set(undefined);
    }
  }

  /** 拉取扩展中已保存的 baseUrl/hasToken 状态，供徽标渲染。 */
  private async refreshSiyuanExtensionStatus(options: { connectionVerified?: boolean } = {}): Promise<SiyuanExtensionStatusView | null> {
    try {
      const probe = await this.siyuanPreview.probeExtensionConfigStatus();
      if (probe.kind === 'ok') {
        this.siyuanExtensionStatus.set(probe.status);
        // 扩展若已配置 baseUrl，则同步回 UI 显示（不影响 IndexedDB 中保存的 baseUrl）。
        if (probe.status.baseUrl) {
          this.siyuanBaseUrl.set(probe.status.baseUrl);
        }
        return probe.status;
      }

      if (probe.kind === 'unsupported') {
        const unsupportedStatus: SiyuanExtensionStatusView = {
          baseUrl: this.siyuanBaseUrl() || SIYUAN_CONFIG.DEFAULT_BASE_URL,
          hasToken: options.connectionVerified === true,
          configChannelAvailable: false,
          connectionVerified: options.connectionVerified === true,
        };
        this.siyuanExtensionStatus.set(unsupportedStatus);
        return unsupportedStatus;
      }

      if (probe.kind === 'unavailable') {
        this.siyuanExtensionStatus.set(null);
        return null;
      }

      const errorStatus: SiyuanExtensionStatusView = {
        baseUrl: this.siyuanBaseUrl() || SIYUAN_CONFIG.DEFAULT_BASE_URL,
        hasToken: false,
        readError: true,
      };
      this.logger.warn('SettingsModal', '读取扩展配置状态失败', {
        code: probe.errorCode,
      });
      this.siyuanExtensionStatus.set(errorStatus);
      return errorStatus;
    } catch (error) {
      this.logger.warn('SettingsModal', '读取扩展配置状态失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      const errorStatus: SiyuanExtensionStatusView = {
        baseUrl: this.siyuanBaseUrl() || SIYUAN_CONFIG.DEFAULT_BASE_URL,
        hasToken: false,
        readError: true,
      };
      this.siyuanExtensionStatus.set(errorStatus);
      return errorStatus;
    }
  }

  async updateSiyuanRuntimeMode(event: Event): Promise<void> {
    const rawValue = (event.target as HTMLSelectElement | null)?.value;
    if (rawValue !== 'extension-relay' && rawValue !== 'direct' && rawValue !== 'cache-only') return;
    const value: SiyuanRuntimeMode = rawValue;
    const config = await this.siyuanCache.loadConfig();
    // 切到 relay 模式时把 IndexedDB 中残留的 token 清掉，避免 direct 模式遗留 token 与 relay 语义混淆。
    const nextConfig = value === 'extension-relay'
      ? { ...config, runtimeMode: value, token: undefined }
      : { ...config, runtimeMode: value };
    await this.siyuanCache.saveConfig(nextConfig);
    this.siyuanRuntimeMode.set(value);
    this.siyuanConnectionStatus.set('');
    this.siyuanPendingToken.set('');
    this.siyuanTokenMask.set(value === 'extension-relay' ? '' : (nextConfig.token ? SIYUAN_TOKEN_MASK : ''));
    if (value === 'extension-relay') {
      await this.refreshSiyuanExtensionStatus();
    } else {
      this.siyuanExtensionStatus.set(undefined);
    }
  }

  async updateSiyuanBaseUrl(event: Event): Promise<void> {
    const value = (event.target as HTMLInputElement | null)?.value.trim() || SIYUAN_CONFIG.DEFAULT_BASE_URL;
    if (!isTrustedSiyuanDirectBaseUrl(value, typeof window === 'undefined' ? null : window.location)) {
      // 拒绝可疑 baseUrl 时一并清空已保存的 token，防止下次 testSiyuanConnection 把 token 发到错误的 host。
      const config = await this.siyuanCache.loadConfig();
      await this.siyuanCache.saveConfig({ ...config, baseUrl: SIYUAN_CONFIG.DEFAULT_BASE_URL, token: undefined });
      this.siyuanBaseUrl.set(SIYUAN_CONFIG.DEFAULT_BASE_URL);
      this.siyuanTokenMask.set('');
      this.siyuanPendingToken.set('');
      this.siyuanConnectionStatus.set('仅支持本机思源地址 http://127.0.0.1:6806 或 http://localhost:6806，已重置授权');
      return;
    }
    // relay 模式下 baseUrl 只暂存到 UI signal，真正生效要等用户点"保存到扩展"。
    // 但仍把 baseUrl 写入 IndexedDB，便于切到 direct 模式时复用，且 baseUrl 本身非敏感。
    const config = await this.siyuanCache.loadConfig();
    await this.siyuanCache.saveConfig({ ...config, baseUrl: value });
    this.siyuanBaseUrl.set(value);
    this.siyuanConnectionStatus.set('');
  }

  async updateSiyuanToken(event: Event): Promise<void> {
    const value = (event.target as HTMLInputElement | null)?.value.trim() ?? '';
    if (value === SIYUAN_TOKEN_MASK) return;
    if (this.siyuanRuntimeMode() === 'extension-relay') {
      // relay 模式：token 仅在内存暂存，永不写入 IndexedDB；等待"保存到扩展"按钮触发推送。
      this.siyuanPendingToken.set(value);
      this.siyuanTokenMask.set(value ? SIYUAN_TOKEN_MASK : '');
      return;
    }
    const config = await this.siyuanCache.loadConfig();
    await this.siyuanCache.saveConfig({ ...config, token: value || undefined });
    this.siyuanTokenMask.set(value ? SIYUAN_TOKEN_MASK : '');
  }

  /**
   * 把 UI 输入的 baseUrl/token 单向写入扩展 chrome.storage.local。
   * - token 在调用结束后从内存 signal 中立即清除；
   * - 失败按 errorCode 映射到中文提示；
   * - 旧扩展不支持该消息时按钮已被 disabled，但保险起见同样处理 runtime-not-supported 路径。
   */
  async saveSiyuanConfigToExtension(): Promise<void> {
    if (this.siyuanRuntimeMode() !== 'extension-relay') return;
    if (this.isSavingSiyuanToExtension()) return;
    const baseUrl = this.siyuanBaseUrl();
    if (!isTrustedSiyuanDirectBaseUrl(baseUrl, typeof window === 'undefined' ? null : window.location)) {
      this.siyuanConnectionStatus.set('仅支持本机思源地址 http://127.0.0.1:6806 或 http://localhost:6806');
      return;
    }
    this.isSavingSiyuanToExtension.set(true);
    const pendingToken = this.siyuanPendingToken();
    // 用户未在输入框输入 token 时不传 token 字段（语义：仅更新 baseUrl，保留扩展中已有 token）。
    const tokenForExtension = pendingToken.length > 0 ? pendingToken : undefined;
    try {
      const result = await this.siyuanPreview.pushExtensionConfig({
        baseUrl,
        token: tokenForExtension,
      });
      if (result.ok) {
        this.siyuanConnectionStatus.set('已写入扩展，可点击"测试连接"验证');
        this.siyuanPendingToken.set('');
        this.siyuanTokenMask.set('');
        await this.refreshSiyuanExtensionStatus();
        return;
      }
      this.siyuanConnectionStatus.set(formatSiyuanPushConfigError(result.errorCode));
    } catch (error) {
      this.logger.warn('SettingsModal', '写入扩展配置失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.siyuanConnectionStatus.set('写入扩展失败，请稍后重试');
    } finally {
      this.isSavingSiyuanToExtension.set(false);
    }
  }

  onSiyuanConfigSubmit(event: Event): void {
    // 该 form 仅用于满足浏览器对 password input 的结构化语义要求（避免 DOM 警告）。
    // relay 模式下真正保存由"保存到扩展"按钮触发；其它模式仍由各字段 (change) 事件就地持久化。
    event.preventDefault();
  }

  async testSiyuanConnection(): Promise<void> {
    this.siyuanConnectionStatus.set('正在检测思源连接…');
    try {
      const result = await this.siyuanPreview.diagnoseConnection();
      if (result.ok) {
        if (result.mode === 'extension-relay') {
          const status = await this.refreshSiyuanExtensionStatus({ connectionVerified: true });
          if (status?.readError) {
            this.siyuanConnectionStatus.set('思源预览通道可用，但读取扩展配置状态失败，请稍后重试');
            return;
          }
          if (status?.configChannelAvailable === false && status.connectionVerified) {
            this.siyuanConnectionStatus.set('思源预览通道可用；当前配置由扩展 Options 管理');
            return;
          }
          if (status === null) {
            this.siyuanConnectionStatus.set('思源预览通道可用，但扩展配置状态已失效，请刷新页面后重试');
            return;
          }
        }
        this.siyuanConnectionStatus.set(result.mode === 'cache-only' ? '当前为仅缓存与深链模式' : '思源预览通道可用');
        return;
      }
      if (result.mode === 'extension-relay' && result.errorCode === 'extension-unavailable') {
        this.siyuanExtensionStatus.set(null);
      }
      const message = formatSiyuanDiagnosisMessage(result.errorCode);
      this.siyuanConnectionStatus.set(message);
    } catch (error) {
      this.logger.warn('SettingsModal', '思源连接诊断失败', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      this.siyuanConnectionStatus.set('检测失败，请稍后重试');
    }
  }

  async clearSiyuanCache(): Promise<void> {
    await this.siyuanCache.clearPreviewCache();
    this.siyuanConnectionStatus.set('已清除当前账号的本机思源缓存');
  }

  async forgetSiyuanConfig(): Promise<void> {
    // 先尝试通知扩展清除 token（relay 模式下用户期望"忘记"是端到端的）。
    if (this.siyuanRuntimeMode() === 'extension-relay') {
      try {
        await this.siyuanPreview.pushExtensionConfig({
          baseUrl: this.siyuanBaseUrl() || SIYUAN_CONFIG.DEFAULT_BASE_URL,
          token: '',
        });
      } catch (error) {
        // 扩展不可达时仍继续本地 forget，避免本地状态卡住。
        this.logger.warn('SettingsModal', '通知扩展清除 token 失败，继续清除本机授权', {
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    await this.siyuanCache.forgetConfig();
    await this.loadSiyuanConfig();
    this.siyuanConnectionStatus.set('已忘记本机思源授权');
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
      async (project) => {
        this.importComplete.emit(project);
      }
    );
    
    if (result.success) {
      alert(`导入完成！\n成功: ${result.importedCount}\n跳过: ${result.skippedCount}`);
    } else {
      alert(`导入失败：${result.error}`);
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

  /** 确认恢复 */
  async confirmRestore(): Promise<void> {
    await this.localBackupUI.confirmRestore(this.projects(), async (project: Project) => {
      this.importComplete.emit(project);
    });
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
