import { Component, inject, output, input, computed, viewChild, ElementRef, isDevMode, ChangeDetectionStrategy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LoggerService } from '../../../services/logger.service';
import { UserSessionService } from '../../../services/user-session.service';
import { PreferenceService } from '../../../services/preference.service';
import { ExportService } from '../../../services/export.service';
import { ImportService, ImportOptions } from '../../../services/import.service';
import { AttachmentExportService } from '../../../services/attachment-export.service';
import { AttachmentImportService, type AttachmentImportItem } from '../../../services/attachment-import.service';
import { LocalBackupService } from '../../../services/local-backup.service';
import { ThemeService } from '../../../services/theme.service';
import { DockEngineService } from '../../../services/dock-engine.service';
import { FocusPreferenceService } from '../../../services/focus-preference.service';
import { GateService } from '../../../services/gate.service';
import { ThemeType, ColorMode, Project } from '../../../models';
import { LOCAL_BACKUP_CONFIG } from '../../../config/local-backup.config';

interface TaskAttachmentMetadata {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fixed inset-0 bg-black/40 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div data-testid="settings-modal" class="bg-slate-50 dark:bg-stone-900 rounded-2xl shadow-2xl w-full max-w-[420px] animate-scale-in max-h-[85vh] flex flex-col overflow-hidden ring-1 ring-slate-900/5 dark:ring-stone-700" (click)="$event.stopPropagation()">
        <!-- 头部 -->
        <div class="px-4 py-3 border-b border-slate-200/60 dark:border-stone-700 flex items-center justify-between bg-white dark:bg-stone-800 sticky top-0 z-10">
          <h2 class="text-base font-bold text-slate-800 dark:text-stone-200">系统设置</h2>
          <button (click)="close.emit()" class="p-1.5 hover:bg-slate-100 dark:hover:bg-stone-700 rounded-full transition-colors text-slate-400 dark:text-stone-500 hover:text-slate-600 dark:hover:text-stone-300">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div class="flex-1 overflow-y-auto p-3 space-y-4 custom-scrollbar">
          
          <!-- 账户信息 (置顶) -->
          <section class="bg-white dark:bg-stone-800 rounded-xl border border-slate-200 dark:border-stone-700 shadow-sm p-3">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-slate-100 dark:bg-stone-700 flex items-center justify-center text-slate-400 dark:text-stone-500 ring-1 ring-slate-200 dark:ring-stone-600">
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                </div>
                <div>
                  <div class="text-xs font-bold text-slate-700 dark:text-stone-200">
                    {{ userSession.currentUserId() ? (sessionEmail() || "已登录用户") : "访客模式" }}
                  </div>
                  <div class="text-[10px] flex items-center gap-1.5" [class.text-emerald-600]="userSession.currentUserId()" [class.text-slate-400]="!userSession.currentUserId()">
                    <span class="w-1.5 h-1.5 rounded-full" [class.bg-emerald-500]="userSession.currentUserId()" [class.bg-slate-300]="!userSession.currentUserId()"></span>
                    {{ userSession.currentUserId() ? "云端同步中" : "仅本地存储" }}
                  </div>
                </div>
              </div>
              @if (userSession.currentUserId()) {
                <button (click)="signOut.emit()" class="px-2.5 py-1 text-[10px] font-bold text-slate-500 dark:text-stone-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors">退出</button>
              }
            </div>
          </section>

          <!-- 系统仪表盘入口 -->
          <section>
            <div class="group rounded-xl border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50/40 dark:bg-indigo-900/20 p-2.5 hover:bg-indigo-50 dark:hover:bg-indigo-900/40 transition-all cursor-pointer flex items-center justify-between" (click)="openDashboard.emit()">
              <div class="flex items-center gap-2.5">
                <div class="w-7 h-7 rounded-lg bg-indigo-500 dark:bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-200 dark:shadow-indigo-900/50 group-hover:scale-105 transition-transform">
                  <svg class="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <div>
                  <div class="text-xs font-bold text-indigo-900 dark:text-indigo-300">系统仪表盘</div>
                  <div class="text-[10px] text-indigo-600/70 dark:text-indigo-400/70">查看同步状态与冲突</div>
                </div>
              </div>
              <svg class="w-3 h-3 text-indigo-300 dark:text-indigo-500 group-hover:text-indigo-500 dark:group-hover:text-indigo-400 group-hover:translate-x-0.5 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </section>
          
          <!-- 主题设置 -->
          <section class="space-y-1.5">
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">外观风格</h3>
            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl p-2.5 shadow-sm space-y-3">
              
              <!-- 颜色模式切换 -->
              <div class="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-stone-700">
                <span class="text-xs font-medium text-slate-600 dark:text-stone-400">颜色模式</span>
                <div class="flex items-center gap-1 bg-slate-100 dark:bg-stone-700 rounded-lg p-0.5">
                  <!-- 浅色 -->
                  <button 
                    (click)="updateColorMode('light')"
                    class="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all"
                    [ngClass]="{
                      'bg-white dark:bg-stone-600 shadow-sm text-slate-800 dark:text-stone-200': themeService.colorMode() === 'light',
                      'text-slate-500 dark:text-stone-400': themeService.colorMode() !== 'light'
                    }">
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                    浅色
                  </button>
                  <!-- 系统 -->
                  <button 
                    (click)="updateColorMode('system')"
                    class="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all"
                    [ngClass]="{
                      'bg-white dark:bg-stone-600 shadow-sm text-slate-800 dark:text-stone-200': themeService.colorMode() === 'system',
                      'text-slate-500 dark:text-stone-400': themeService.colorMode() !== 'system'
                    }">
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    自动
                  </button>
                  <!-- 深色 -->
                  <button 
                    (click)="updateColorMode('dark')"
                    class="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all"
                    [ngClass]="{
                      'bg-white dark:bg-stone-600 shadow-sm text-slate-800 dark:text-stone-200': themeService.colorMode() === 'dark',
                      'text-slate-500 dark:text-stone-400': themeService.colorMode() !== 'dark'
                    }">
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                    </svg>
                    深色
                  </button>
                </div>
              </div>
              
              <!-- 色调主题选择 -->
              <div class="grid grid-cols-5 gap-2">
                <!-- 默认主题 -->
                <button (click)="updateTheme('default')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'default'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-slate-100 to-slate-300 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-indigo-500]="preferenceService.theme() === 'default'"
                       [class.border-transparent]="preferenceService.theme() !== 'default'"></div>
                  <span class="text-[9px] font-medium" [class.text-indigo-600]="preferenceService.theme() === 'default'" [class.text-slate-500]="preferenceService.theme() !== 'default'">默认</span>
                </button>
                
                <!-- 海洋主题 -->
                <button (click)="updateTheme('ocean')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'ocean'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-sky-200 to-cyan-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-sky-500]="preferenceService.theme() === 'ocean'"
                       [class.border-transparent]="preferenceService.theme() !== 'ocean'"></div>
                  <span class="text-[9px] font-medium" [class.text-sky-600]="preferenceService.theme() === 'ocean'" [class.text-slate-500]="preferenceService.theme() !== 'ocean'">海洋</span>
                </button>
                
                <!-- 森林主题 -->
                <button (click)="updateTheme('forest')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'forest'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-green-200 to-emerald-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-green-500]="preferenceService.theme() === 'forest'"
                       [class.border-transparent]="preferenceService.theme() !== 'forest'"></div>
                  <span class="text-[9px] font-medium" [class.text-green-600]="preferenceService.theme() === 'forest'" [class.text-slate-500]="preferenceService.theme() !== 'forest'">森林</span>
                </button>
                
                <!-- 日落主题 -->
                <button (click)="updateTheme('sunset')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'sunset'
                        }">
                  <div class="w-5 h-5 rounded-full bg-gradient-to-br from-orange-200 to-red-400 border-2 group-hover:scale-110 transition-transform shadow-sm"
                       [class.border-orange-500]="preferenceService.theme() === 'sunset'"
                       [class.border-transparent]="preferenceService.theme() !== 'sunset'"></div>
                  <span class="text-[9px] font-medium" [class.text-orange-600]="preferenceService.theme() === 'sunset'" [class.text-slate-500]="preferenceService.theme() !== 'sunset'">日落</span>
                </button>
                
                <!-- 薰衣草主题 -->
                <button (click)="updateTheme('lavender')" 
                        class="flex flex-col items-center gap-1.5 p-1.5 rounded-lg transition-all group hover:bg-slate-50 dark:hover:bg-stone-700"
                        [ngClass]="{
                          'bg-slate-50 dark:bg-stone-700': preferenceService.theme() === 'lavender'
                        }">
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
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">数据管理</h3>
            
            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-stone-700 overflow-hidden">
              <!-- 自动解决冲突 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">自动解决冲突</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">使用 LWW 策略自动合并</div>
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
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div class="flex-1">
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">备份与恢复</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">JSON 格式数据</div>
                </div>
                <div class="flex items-center gap-2">
                  <button 
                    (click)="handleExport()"
                    [disabled]="exportService.isExporting()"
                    class="px-2.5 py-1 bg-white dark:bg-stone-700 border border-slate-200 dark:border-stone-600 rounded-md text-[10px] font-bold text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-600 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
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
                    class="px-2.5 py-1 bg-white dark:bg-stone-700 border border-slate-200 dark:border-stone-600 rounded-md text-[10px] font-bold text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-600 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
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

              <!-- 附件导出导入 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div class="flex-1">
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">附件备份（ZIP）</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">{{ attachmentTransferStatus() }}</div>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    (click)="handleAttachmentExport()"
                    [disabled]="attachmentExportService.isExporting() || attachmentImportService.isImporting()"
                    class="px-2.5 py-1 bg-white dark:bg-stone-700 border border-slate-200 dark:border-stone-600 rounded-md text-[10px] font-bold text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-600 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
                    @if (attachmentExportService.isExporting()) {
                      <div class="w-2.5 h-2.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                    } @else {
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                    }
                    <span>导出 ZIP</span>
                  </button>
                  <button
                    (click)="triggerAttachmentImportFileSelect()"
                    [disabled]="attachmentImportService.isImporting() || attachmentExportService.isExporting()"
                    class="px-2.5 py-1 bg-white dark:bg-stone-700 border border-slate-200 dark:border-stone-600 rounded-md text-[10px] font-bold text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-600 hover:border-slate-300 transition-all disabled:opacity-50 flex items-center gap-1 shadow-sm">
                    @if (attachmentImportService.isImporting()) {
                      <div class="w-2.5 h-2.5 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
                    } @else {
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                    }
                    <span>导入 ZIP</span>
                  </button>
                  <input
                    #attachmentZipInput
                    type="file"
                    accept=".zip,application/zip"
                    class="hidden"
                    (change)="handleAttachmentImportFileSelected($event)" />
                </div>
              </div>

            </div>
          </section>
          
          <!-- 专注模式设置 -->
          <section class="space-y-1.5">
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">专注模式</h3>
            
            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl shadow-sm divide-y divide-slate-100 dark:divide-stone-700 overflow-hidden">
              <!-- 大门功能 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">🚪 大门</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">强制处理昨日遗留</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleGateEnabled()"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="focusPreferenceService.preferences().gateEnabled"
                  [class.bg-slate-200]="!focusPreferenceService.preferences().gateEnabled">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="focusPreferenceService.preferences().gateEnabled">
                  </span>
                </button>
              </div>
              
              <!-- 聚光灯功能 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">🔦 聚光灯</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">单任务专注模式</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleSpotlightEnabled()"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="focusPreferenceService.preferences().spotlightEnabled"
                  [class.bg-slate-200]="!focusPreferenceService.preferences().spotlightEnabled">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="focusPreferenceService.preferences().spotlightEnabled">
                  </span>
                </button>
              </div>
              
              <!-- 黑匣子功能 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">📦 黑匣子</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">语音/文字快速捕捉</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleBlackBoxEnabled()"
                  data-testid="settings-blackbox-toggle"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="focusPreferenceService.preferences().blackBoxEnabled"
                  [class.bg-slate-200]="!focusPreferenceService.preferences().blackBoxEnabled">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="focusPreferenceService.preferences().blackBoxEnabled">
                  </span>
                </button>
              </div>
              
              <!-- 地质层功能 -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">🗻 地质层</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">已完成任务堆叠显示</div>
                </div>
                <button 
                  type="button"
                  (click)="toggleStrataEnabled()"
                  class="relative w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none"
                  [class.bg-indigo-500]="focusPreferenceService.preferences().strataEnabled"
                  [class.bg-slate-200]="!focusPreferenceService.preferences().strataEnabled">
                  <span 
                    class="absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transform transition-transform duration-200"
                    [class.translate-x-4]="focusPreferenceService.preferences().strataEnabled">
                  </span>
                </button>
              </div>
              
              <!-- Snooze 配置兼容保留：Gate UI 已移除跳过动作，这里隐藏入口 -->
              
              <!-- 开发工具（仅开发模式可见） -->
              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">高负荷休息提醒</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">累计高负荷专注多久后给轻提醒</div>
                </div>
                <select
                  class="rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1 text-[11px] text-slate-700 dark:text-stone-200"
                  [value]="focusPreferenceService.preferences().restReminderHighLoadMinutes"
                  (change)="updateRestReminderHighLoadMinutes($event)"
                  data-testid="settings-rest-reminder-high">
                  @for (minutes of restReminderHighLoadOptions; track minutes) {
                    <option [value]="minutes">{{ formatReminderMinutes(minutes) }}</option>
                  }
                </select>
              </div>

              <div class="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-stone-700 transition-colors">
                <div>
                  <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">低负荷休息提醒</div>
                  <div class="text-[10px] text-slate-400 dark:text-stone-500">累计低负荷专注多久后给轻提醒</div>
                </div>
                <select
                  class="rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1 text-[11px] text-slate-700 dark:text-stone-200"
                  [value]="focusPreferenceService.preferences().restReminderLowLoadMinutes"
                  (change)="updateRestReminderLowLoadMinutes($event)"
                  data-testid="settings-rest-reminder-low">
                  @for (minutes of restReminderLowLoadOptions; track minutes) {
                    <option [value]="minutes">{{ formatReminderMinutes(minutes) }}</option>
                  }
                </select>
              </div>

              @if (isDev) {
                <div class="px-3 py-2.5 bg-orange-50 dark:bg-orange-900/20 border-t border-orange-200/50 dark:border-orange-800/30">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <div class="text-xs font-semibold text-orange-700 dark:text-orange-300">🛠️ 开发测试</div>
                      <div class="text-[10px] text-orange-500 dark:text-orange-400/70">触发大门界面（带模拟数据）</div>
                    </div>
                    <button 
                      data-testid="settings-dev-gate"
                      (click)="triggerDevGate()"
                      class="px-2.5 py-1 text-[10px] font-bold bg-orange-500 text-white rounded-md hover:bg-orange-600 transition-colors shadow-sm">
                      测试大门
                    </button>
                  </div>
                </div>
              }
            </div>
          </section>

          <section class="space-y-1.5" #focusRoutineSection>
            <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">日常任务</h3>

            <div class="bg-white dark:bg-stone-800 border border-slate-200 dark:border-stone-700 rounded-xl shadow-sm overflow-hidden">
              <div class="px-3 py-3 border-b border-slate-100 dark:border-stone-700 space-y-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="text-xs font-semibold text-slate-700 dark:text-stone-200">重置时间</div>
                    <div class="text-[10px] text-slate-400 dark:text-stone-500">日常任务每日计数按本地小时切日</div>
                  </div>
                  <select
                    class="rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-1 text-[11px] text-slate-700 dark:text-stone-200"
                    [value]="focusPreferenceService.preferences().routineResetHourLocal"
                    (change)="updateRoutineResetHour($event)">
                    @for (hour of routineResetHours; track hour) {
                      <option [value]="hour">{{ formatRoutineResetHour(hour) }}</option>
                    }
                  </select>
                </div>

                <div class="grid grid-cols-[1fr,84px,auto] gap-2 items-center">
                  <input
                    type="text"
                    [(ngModel)]="newRoutineTitle"
                    placeholder="新增日常任务，例如：喝水"
                    class="rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-3 py-2 text-xs text-slate-700 dark:text-stone-200 outline-none" />
                  <input
                    type="number"
                    min="1"
                    max="24"
                    [(ngModel)]="newRoutineMaxCount"
                    class="rounded-lg border border-slate-200 dark:border-stone-600 bg-slate-50 dark:bg-stone-700 px-2 py-2 text-xs text-slate-700 dark:text-stone-200 outline-none"
                    placeholder="次数" />
                  <button
                    type="button"
                    class="rounded-lg bg-indigo-600 px-3 py-2 text-[11px] font-semibold text-white hover:bg-indigo-500"
                    (click)="addRoutineSlot()">
                    添加
                  </button>
                </div>
              </div>

              <div class="divide-y divide-slate-100 dark:divide-stone-700">
                @for (slot of routineSlots(); track slot.id) {
                  <div class="px-3 py-2.5 flex items-center gap-2">
                    <div class="min-w-0 flex-1">
                      <div class="text-xs font-semibold text-slate-700 dark:text-stone-200 truncate">{{ slot.title }}</div>
                      <div class="text-[10px] text-slate-400 dark:text-stone-500">
                        今日 {{ slot.todayCompletedCount }}/{{ slot.maxDailyCount }}
                        · {{ slot.isEnabled ? '已启用' : '已停用' }}
                      </div>
                    </div>
                    <button
                      type="button"
                      class="rounded-md border border-slate-200 dark:border-stone-600 px-2 py-1 text-[10px] text-slate-600 dark:text-stone-300 hover:bg-slate-100 dark:hover:bg-stone-700"
                      [disabled]="!slot.isEnabled || slot.todayCompletedCount >= slot.maxDailyCount"
                      (click)="completeRoutineSlot(slot.id)">
                      计 1 次
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-slate-200 dark:border-stone-600 px-2 py-1 text-[10px] text-slate-600 dark:text-stone-300 hover:bg-slate-100 dark:hover:bg-stone-700"
                      (click)="toggleRoutineSlot(slot.id, !slot.isEnabled)">
                      {{ slot.isEnabled ? '停用' : '启用' }}
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-rose-200 dark:border-rose-800 px-2 py-1 text-[10px] text-rose-600 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                      (click)="removeRoutineSlot(slot.id)">
                      删除
                    </button>
                  </div>
                } @empty {
                  <div class="px-3 py-5 text-center text-[11px] text-slate-400 dark:text-stone-500">
                    暂无日常任务，可在这里新增并手动记次。
                  </div>
                }
              </div>
            </div>
          </section>
          
          <!-- 本地自动备份 -->
          @if (localBackupService.isAvailable()) {
            <section class="space-y-1.5">
              <h3 class="text-[10px] font-bold text-slate-400 dark:text-stone-500 uppercase tracking-wider px-1">本地增强备份</h3>
              
              <div class="bg-amber-50/40 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/50 rounded-xl p-3 space-y-3">
                <!-- 状态 1：未授权且无保存的 handle -->
                @if (!localBackupService.isAuthorized() && !localBackupService.hasSavedHandle()) {
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex-1">
                      <div class="text-xs font-bold text-amber-900 dark:text-amber-300">开启本地自动备份</div>
                      <div class="text-[10px] text-amber-700/70 dark:text-amber-400/70 mt-0.5">配合坚果云/Dropbox 实现自动同步</div>
                    </div>
                    <button 
                      (click)="handleSetupLocalBackup()"
                      class="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-[10px] font-bold hover:bg-amber-600 transition-colors shadow-sm shadow-amber-200">
                      选择目录
                    </button>
                  </div>
                }
                
                <!-- 状态 2 & 3：有保存的目录（可能需要恢复权限，开关打开时自动请求） -->
                @if (localBackupService.hasSavedHandle()) {
                  <div class="space-y-2.5">
                    <div class="flex items-center justify-between bg-white/50 dark:bg-stone-700/50 p-2 rounded-lg border border-amber-100 dark:border-amber-900/50">
                      <div class="flex items-center gap-2 min-w-0">
                        @if (localBackupService.isAuthorized()) {
                          <div class="w-6 h-6 rounded bg-green-100 flex items-center justify-center flex-shrink-0">
                            <svg class="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
                          </div>
                        } @else {
                          <div class="w-6 h-6 rounded bg-amber-100 flex items-center justify-center flex-shrink-0">
                            <svg class="w-3.5 h-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                          </div>
                        }
                        <div class="min-w-0">
                          <div class="text-[11px] font-bold text-amber-900 dark:text-amber-300 truncate max-w-[120px]">{{ localBackupService.directoryName() }}</div>
                          @if (localBackupService.isAuthorized()) {
                            <div class="text-[9px] text-green-600 dark:text-green-400">✓ 已授权</div>
                          } @else {
                            <div class="text-[9px] text-amber-600 dark:text-amber-400">开启备份时自动授权</div>
                          }
                        </div>
                      </div>
                      <button (click)="handleRevokeLocalBackup()" class="text-[10px] font-bold text-amber-600 hover:text-amber-800 px-2">取消</button>
                    </div>
                    
                    <div class="flex items-center justify-between px-1 gap-3">
                      <div>
                        <div class="text-[11px] font-semibold text-amber-800 dark:text-amber-300">自动定时备份</div>
                        <div class="text-[10px] text-amber-600/80 dark:text-amber-400/80">当前默认间隔 {{ selectedBackupInterval() }}</div>
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
                    
                    @if (formattedLastBackupTime()) {
                      <div class="text-[9px] text-amber-600/70 dark:text-amber-400/70 px-1">
                        上次备份：{{ formattedLastBackupTime() }}
                      </div>
                    }

                    <button 
                      (click)="handleManualBackup()"
                      [disabled]="localBackupService.isBackingUp()"
                      class="w-full py-1.5 bg-white dark:bg-stone-700 border border-amber-200 dark:border-amber-700 rounded-lg text-[10px] font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30 transition-all flex items-center justify-center gap-2 shadow-sm">
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
  }
  readonly dockEngine = inject(DockEngineService);
  readonly userSession = inject(UserSessionService);
  readonly preferenceService = inject(PreferenceService);
  readonly exportService = inject(ExportService);
  readonly importService = inject(ImportService);
  readonly attachmentExportService = inject(AttachmentExportService);
  readonly attachmentImportService = inject(AttachmentImportService);
  readonly localBackupService = inject(LocalBackupService);
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
      const zipData = await file.arrayBuffer();
      const projects = this.projects();
      const taskAttachmentMap = this.buildTaskAttachmentMap(projects);
      const taskProjectIndex = this.buildTaskProjectIndex(projects);

      const extractedItems = await this.attachmentImportService.extractAttachmentsFromZip(
        zipData,
        taskAttachmentMap
      );

      if (extractedItems.length === 0) {
        alert('附件包中未找到可导入的附件');
        return;
      }

      const groupedByProject = new Map<string, AttachmentImportItem[]>();
      let unmatchedCount = 0;

      for (const item of extractedItems) {
        const projectId = item.projectId ?? taskProjectIndex.get(item.taskId);
        if (!projectId) {
          unmatchedCount++;
          continue;
        }

        const existingGroup = groupedByProject.get(projectId);
        if (existingGroup) {
          existingGroup.push(item);
        } else {
          groupedByProject.set(projectId, [item]);
        }
      }

      if (groupedByProject.size === 0) {
        alert('附件包中的任务与当前项目不匹配，无法导入');
        return;
      }

      let imported = 0;
      let failed = 0;
      let skipped = unmatchedCount;
      const errorMessages: string[] = [];

      for (const [projectId, items] of groupedByProject) {
        const importResult = await this.attachmentImportService.importAttachments(projectId, items);
        imported += importResult.imported;
        failed += importResult.failed;
        skipped += importResult.skipped;
        errorMessages.push(...importResult.errors.map(e => `${e.attachmentName || '未知附件'}: ${e.error}`));
      }

      if (failed === 0) {
        alert(`附件导入完成！\n成功: ${imported}\n跳过: ${skipped}`);
      } else {
        const topError = errorMessages[0] ?? '未知错误';
        alert(`附件导入部分失败。\n成功: ${imported}\n失败: ${failed}\n跳过: ${skipped}\n首个错误: ${topError}`);
      }

      if (unmatchedCount > 0) {
        this.logger.warn('SettingsModal', `部分附件未匹配到项目，已跳过: ${unmatchedCount}`);
      }
    } catch (error: unknown) {
      this.logger.error('SettingsModal', '附件 ZIP 导入失败', error);
      alert(`附件导入失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  private buildTaskAttachmentMap(projects: Project[]): Map<string, TaskAttachmentMetadata[]> {
    const map = new Map<string, TaskAttachmentMetadata[]>();

    for (const project of projects) {
      for (const task of project.tasks) {
        if (!task.attachments || task.attachments.length === 0) continue;

        const attachments: TaskAttachmentMetadata[] = task.attachments.map(att => ({
          id: att.id,
          name: att.name,
          size: att.size ?? 0,
          mimeType: att.mimeType ?? 'application/octet-stream',
        }));

        map.set(task.id, attachments);
      }
    }

    return map;
  }

  private buildTaskProjectIndex(projects: Project[]): Map<string, string> {
    const index = new Map<string, string>();

    for (const project of projects) {
      for (const task of project.tasks) {
        index.set(task.id, project.id);
      }
    }

    return index;
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
  async handleRevokeLocalBackup(): Promise<void> {
    if (confirm('确定要取消本地备份吗？')) {
      await this.localBackupService.revokeDirectoryAccess();
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
   * 开启时自动请求权限（用户点击开关本身就是用户手势）
   */
  async toggleAutoBackup(): Promise<void> {
    if (this.localBackupService.autoBackupEnabled()) {
      // 关闭自动备份
      this.localBackupService.stopAutoBackup();
    } else {
      // 开启自动备份
      // 先确保已授权（浏览器重启后需要重新请求权限）
      if (!this.localBackupService.isAuthorized()) {
        // 设置项目提供者
        this.localBackupService.setProjectsProvider(() => this.projects());
        // 请求权限（用户点击开关就是用户手势，可以触发权限请求）
        const granted = await this.localBackupService.resumePermission();
        if (!granted) {
          // 权限请求失败或被拒绝，不开启自动备份
          return;
        }
      }
      
      // 权限已授予，启动自动备份
      this.localBackupService.startAutoBackup(
        () => this.projects(),
        LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS
      );
    }
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
   * 切换聚光灯功能
   */
  toggleSpotlightEnabled(): void {
    const current = this.focusPreferenceService.preferences().spotlightEnabled;
    this.focusPreferenceService.update({ spotlightEnabled: !current });
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

  addRoutineSlot(): void {
    const title = this.newRoutineTitle.trim();
    if (!title) return;
    const nextMax = Math.min(24, Math.max(1, Math.floor(Number(this.newRoutineMaxCount) || 1)));
    this.dockEngine.dailySlotService.addDailySlot(title, nextMax);
    this.newRoutineTitle = '';
    this.newRoutineMaxCount = 1;
  }

  completeRoutineSlot(id: string): void {
    this.dockEngine.dailySlotService.completeDailySlot(id);
  }

  toggleRoutineSlot(id: string, enabled: boolean): void {
    this.dockEngine.dailySlotService.setDailySlotEnabled(id, enabled);
  }

  removeRoutineSlot(id: string): void {
    this.dockEngine.dailySlotService.removeDailySlot(id);
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
