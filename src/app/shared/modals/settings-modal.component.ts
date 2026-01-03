import { Component, inject, Output, EventEmitter, input, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UserSessionService } from '../../../services/user-session.service';
import { PreferenceService } from '../../../services/preference.service';
import { ExportService } from '../../../services/export.service';
import { ImportService, ImportOptions } from '../../../services/import.service';
import { AttachmentExportService } from '../../../services/attachment-export.service';
import { LocalBackupService } from '../../../services/local-backup.service';
import { ThemeType, Project } from '../../../models';
import { LOCAL_BACKUP_CONFIG } from '../../../config/local-backup.config';

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div class="bg-slate-50 rounded-2xl shadow-2xl w-full max-w-[420px] animate-scale-in max-h-[85vh] flex flex-col overflow-hidden ring-1 ring-slate-900/5" (click)="$event.stopPropagation()">
        <!-- 头部 -->
        <div class="px-4 py-3 border-b border-slate-200/60 flex items-center justify-between bg-white sticky top-0 z-10">
          <h2 class="text-base font-bold text-slate-800">系统设置</h2>
          <button (click)="close.emit()" class="p-1.5 hover:bg-slate-100 rounded-full transition-colors text-slate-400 hover:text-slate-600">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div class="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar">
          
          <!-- 账户信息 (置顶) -->
          <section class="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 ring-1 ring-slate-200">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                </div>
                <div>
                  <div class="text-xs font-bold text-slate-700">
                    {{ userSession.currentUserId() ? (sessionEmail() || "已登录用户") : "访客模式" }}
                  </div>
                  <div class="text-[10px] flex items-center gap-1.5" [class.text-emerald-600]="userSession.currentUserId()" [class.text-slate-400]="!userSession.currentUserId()">
                    <span class="w-1.5 h-1.5 rounded-full" [class.bg-emerald-500]="userSession.currentUserId()" [class.bg-slate-300]="!userSession.currentUserId()"></span>
                    {{ userSession.currentUserId() ? "云端同步中" : "仅本地存储" }}
                  </div>
                </div>
              </div>
              @if (userSession.currentUserId()) {
                <button (click)="signOut.emit()" class="px-2.5 py-1 text-[10px] font-bold text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors">退出</button>
              }
            </div>
          </section>

          <!-- 系统仪表盘入口 -->
          <section>
            <div class="group rounded-xl border border-indigo-100 bg-indigo-50/40 p-2.5 hover:bg-indigo-50 transition-all cursor-pointer flex items-center justify-between" (click)="openDashboard.emit()">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-indigo-500 flex items-center justify-center shadow-sm shadow-indigo-200 group-hover:scale-105 transition-transform">
                  <svg class="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <div>
                  <div class="text-xs font-bold text-indigo-900">系统仪表盘</div>
                  <div class="text-[10px] text-indigo-600/70">查看同步状态与冲突</div>
                </div>
              </div>
              <svg class="w-3 h-3 text-indigo-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </section>
          
          <!-- 主题设置 -->
          <section class="space-y-1.5">
            <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">外观风格</h3>
            <div class="bg-white border border-slate-200 rounded-xl p-2.5 shadow-sm">
              <div class="grid grid-cols-5 gap-2">
                <!-- 默认主题 -->
                <button (click)="updateTheme('default')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50"
                        [class.bg-slate-50]="preferenceService.theme() === 'default'">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-slate-100 to-slate-300 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-indigo-500]="preferenceService.theme() === 'default'"
                       [class.border-transparent]="preferenceService.theme() !== 'default'"></div>
                  <span class="text-[9px] font-medium" [class.text-indigo-600]="preferenceService.theme() === 'default'" [class.text-slate-500]="preferenceService.theme() !== 'default'">默认</span>
                </button>
                
                <!-- 海洋主题 -->
                <button (click)="updateTheme('ocean')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50"
                        [class.bg-slate-50]="preferenceService.theme() === 'ocean'">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-sky-200 to-cyan-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-sky-500]="preferenceService.theme() === 'ocean'"
                       [class.border-transparent]="preferenceService.theme() !== 'ocean'"></div>
                  <span class="text-[9px] font-medium" [class.text-sky-600]="preferenceService.theme() === 'ocean'" [class.text-slate-500]="preferenceService.theme() !== 'ocean'">海洋</span>
                </button>
                
                <!-- 森林主题 -->
                <button (click)="updateTheme('forest')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50"
                        [class.bg-slate-50]="preferenceService.theme() === 'forest'">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-green-200 to-emerald-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-green-500]="preferenceService.theme() === 'forest'"
                       [class.border-transparent]="preferenceService.theme() !== 'forest'"></div>
                  <span class="text-[9px] font-medium" [class.text-green-600]="preferenceService.theme() === 'forest'" [class.text-slate-500]="preferenceService.theme() !== 'forest'">森林</span>
                </button>
                
                <!-- 日落主题 -->
                <button (click)="updateTheme('sunset')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50"
                        [class.bg-slate-50]="preferenceService.theme() === 'sunset'">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-orange-200 to-red-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-orange-500]="preferenceService.theme() === 'sunset'"
                       [class.border-transparent]="preferenceService.theme() !== 'sunset'"></div>
                  <span class="text-[9px] font-medium" [class.text-orange-600]="preferenceService.theme() === 'sunset'" [class.text-slate-500]="preferenceService.theme() !== 'sunset'">日落</span>
                </button>
                
                <!-- 薰衣草主题 -->
                <button (click)="updateTheme('lavender')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50"
                        [class.bg-slate-50]="preferenceService.theme() === 'lavender'">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-purple-200 to-fuchsia-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-purple-500]="preferenceService.theme() === 'lavender'"
                       [class.border-transparent]="preferenceService.theme() !== 'lavender'"></div>
                  <span class="text-[9px] font-medium" [class.text-purple-600]="preferenceService.theme() === 'lavender'" [class.text-slate-500]="preferenceService.theme() !== 'lavender'">薰衣草</span>
                </button>
              </div>
            </div>
          </section>
          
          <!-- 数据管理 -->
          <section class="space-y-1.5">
            <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">数据管理</h3>
            
            <div class="bg-white border border-slate-200 rounded-xl shadow-sm divide-y divide-slate-100 overflow-hidden">
              <!-- 自动解决冲突 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700">自动解决冲突</div>
                  <div class="text-[10px] text-slate-400">使用 LWW 策略自动合并</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleAutoResolve()"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="preferenceService.autoResolveConflicts()"
                  [class.bg-slate-200]="!preferenceService.autoResolveConflicts()">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="preferenceService.autoResolveConflicts()">
                  </span>
                </button>
              </div>
              
              <!-- 备份与恢复 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 transition-colors">
                <div class="flex-1">
                  <div class="text-xs font-semibold text-slate-700">备份与恢复</div>
                  <div class="text-[10px] text-slate-400">JSON 格式数据</div>
                </div>
                <div class="flex items-center gap-2">
                  <button 
                    (click)="handleExport()"
                    [disabled]="exportService.isExporting()"
                    class="px-2.5 py-1 bg-white border border-slate-200 rounded-md text-[10px] font-bold text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
                    @if (exportService.isExporting()) {
                      <div class="w-2.5 h-2.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                    } @else {
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                    }
                    <span>导出</span>
                  </button>
                  <button 
                    (click)="triggerImportFileSelect()"
                    [disabled]="importService.isImporting()"
                    class="px-2.5 py-1 bg-white border border-slate-200 rounded-md text-[10px] font-bold text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
                    @if (importService.isImporting()) {
                      <div class="w-2.5 h-2.5 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                    } @else {
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    }
                    <span>导入</span>
                  </button>
                  <input #fileInput type="file" accept=".json,application/json" class="hidden" (change)="handleFileSelected($event)" />
                </div>
              </div>

              <!-- 导出提醒 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700">定期备份提醒</div>
                  <div class="text-[10px] text-slate-400">每 7 天提醒一次</div>
                </div>
                <button 
                  (click)="toggleExportReminder()"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200"
                  [class.bg-blue-500]="exportReminderEnabled()"
                  [class.bg-slate-200]="!exportReminderEnabled()">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="exportReminderEnabled()">
                  </span>
                </button>
              </div>
            </div>
          </section>
          
          <!-- 本地自动备份 -->
          @if (localBackupService.isAvailable()) {
            <section class="space-y-1.5">
              <h3 class="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-1">本地增强备份</h3>
              
              <div class="bg-amber-50/40 border border-amber-100 rounded-xl p-3 space-y-3">
                @if (!localBackupService.isAuthorized()) {
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex-1">
                      <div class="text-xs font-bold text-amber-900">开启本地自动备份</div>
                      <div class="text-[10px] text-amber-700/70 mt-0.5">配合坚果云/Dropbox 实现自动同步</div>
                    </div>
                    <button 
                      (click)="handleSetupLocalBackup()"
                      class="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-[10px] font-bold hover:bg-amber-600 transition-colors shadow-sm shadow-amber-200">
                      选择目录
                    </button>
                  </div>
                } @else {
                  <div class="space-y-2.5">
                    <div class="flex items-center justify-between bg-white/50 p-2 rounded-lg border border-amber-100">
                      <div class="flex items-center gap-2 min-w-0">
                        <div class="w-6 h-6 rounded bg-amber-100 flex items-center justify-center flex-shrink-0">
                          <svg class="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                        </div>
                        <div class="min-w-0">
                          <div class="text-[11px] font-bold text-amber-900 truncate max-w-[120px]">{{ localBackupService.directoryName() }}</div>
                        </div>
                      </div>
                      <button (click)="handleRevokeLocalBackup()" class="text-[10px] font-bold text-amber-600 hover:text-amber-800 px-2">取消</button>
                    </div>
                    
                    <div class="flex items-center justify-between px-1 gap-3">
                      <div>
                        <div class="text-[11px] font-semibold text-amber-800">自动定时备份</div>
                        <div class="text-[10px] text-amber-600/80">间隔 {{ selectedBackupInterval() }}</div>
                      </div>
                      <button 
                        (click)="toggleAutoBackup()"
                        class="relative w-9 h-5 rounded-full transition-colors duration-200"
                        [class.bg-amber-500]="localBackupService.autoBackupEnabled()"
                        [class.bg-amber-200]="!localBackupService.autoBackupEnabled()">
                        <span 
                          class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                          [class.translate-x-4]="localBackupService.autoBackupEnabled()">
                        </span>
                      </button>
                    </div>

                    <button 
                      (click)="handleManualBackup()"
                      [disabled]="localBackupService.isBackingUp()"
                      class="w-full py-1.5 bg-white border border-amber-200 rounded-lg text-[10px] font-bold text-amber-700 hover:bg-amber-50 transition-all flex items-center justify-center gap-2 shadow-sm">
                      @if (localBackupService.isBackingUp()) {
                        <div class="w-2.5 h-2.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
                        <span>备份中...</span>
                      } @else {
                        <span>立即执行备份</span>
                      }
                    </button>
                  </div>
                }
              </div>
            </section>
          }
        </div>
        
        <!-- 底部操作 -->
        <div class="p-3 bg-slate-50 border-t border-slate-200/60 flex justify-end">
          <button (click)="close.emit()" class="px-5 py-1.5 bg-slate-800 text-white rounded-lg hover:bg-slate-900 transition-all text-xs font-bold shadow-md shadow-slate-200 active:scale-95">
            完成
          </button>
        </div>
      </div>
    </div>
  `
})
export class SettingsModalComponent {
  constructor() {
    console.log('SettingsModalComponent initialized (v16-REDESIGN)');
  }
  readonly userSession = inject(UserSessionService);
  readonly preferenceService = inject(PreferenceService);
  readonly exportService = inject(ExportService);
  readonly importService = inject(ImportService);
  readonly attachmentExportService = inject(AttachmentExportService);
  readonly localBackupService = inject(LocalBackupService);
  
  /** 当前登录用户邮箱 */
  sessionEmail = input<string | null>(null);
  
  /** 所有项目（用于导出） */
  projects = input<Project[]>([]);
  
  @Output() close = new EventEmitter<void>();
  @Output() signOut = new EventEmitter<void>();
  @Output() themeChange = new EventEmitter<ThemeType>();
  @Output() openDashboard = new EventEmitter<void>();
  @Output() importComplete = new EventEmitter<Project>();
  
  /** 导出提醒开关状态 */
  exportReminderEnabled = signal(true);
  
  /** 本地备份间隔选项 */
  readonly backupIntervalOptions = [
    { label: '15 分钟', value: 15 * 60 * 1000 },
    { label: '30 分钟', value: 30 * 60 * 1000 },
    { label: '1 小时', value: 60 * 60 * 1000 },
    { label: '2 小时', value: 2 * 60 * 60 * 1000 },
  ];
  
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
  
  /** 文件输入引用 */
  private fileInput: HTMLInputElement | null = null;
  
  updateTheme(theme: ThemeType) {
    this.themeChange.emit(theme);
  }
  
  toggleAutoResolve() {
    const current = this.preferenceService.autoResolveConflicts();
    this.preferenceService.setAutoResolveConflicts(!current);
  }
  
  toggleExportReminder() {
    this.exportReminderEnabled.update(v => !v);
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
   * 触发文件选择
   */
  triggerImportFileSelect(): void {
    // 查找隐藏的文件输入
    const input = document.querySelector('input[type="file"][accept*=".json"]') as HTMLInputElement;
    if (input) {
      input.click();
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
  
  // ============================================
  // 本地备份方法
  // ============================================
  
  /**
   * 设置本地备份目录
   */
  async handleSetupLocalBackup(): Promise<void> {
    await this.localBackupService.requestDirectoryAccess();
  }
  
  /**
   * 取消本地备份授权
   */
  handleRevokeLocalBackup(): void {
    if (confirm('确定要取消本地备份吗？')) {
      this.localBackupService.revokeDirectoryAccess();
    }
  }
  
  /**
   * 手动执行本地备份
   */
  async handleManualBackup(): Promise<void> {
    const projectList = this.projects();
    if (projectList.length === 0) {
      alert('没有可备份的项目');
      return;
    }
    
    const result = await this.localBackupService.performBackup(projectList);
    
    if (result.success) {
      alert(`备份成功！\n文件：${result.filename}\n位置：${result.pathHint}`);
    } else {
      alert(`备份失败：${result.error}`);
    }
  }
  
  /**
   * 切换自动备份
   */
  toggleAutoBackup(): void {
    if (this.localBackupService.autoBackupEnabled()) {
      this.localBackupService.stopAutoBackup();
    } else {
      this.localBackupService.startAutoBackup(
        () => this.projects(),
        LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS
      );
    }
  }
}
