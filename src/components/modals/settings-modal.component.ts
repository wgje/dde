import { Component, inject, Output, EventEmitter, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StoreService } from '../../services/store.service';
import { ThemeType } from '../../models';

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 bg-black/30 z-50 flex items-center justify-center backdrop-blur-sm animate-fade-in p-4" (click)="close.emit()">
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 animate-scale-in max-h-[90vh] overflow-y-auto" (click)="$event.stopPropagation()">
        <h2 class="text-xl font-bold mb-5 text-slate-800">设置</h2>
        
        <div class="space-y-5">
          <!-- 系统仪表盘入口 -->
          <div class="rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-purple-50 p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer" (click)="openDashboard.emit()">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                  <svg class="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <div>
                  <div class="text-sm font-semibold text-indigo-900">系统仪表盘</div>
                  <div class="text-xs text-indigo-600">监控同步状态与数据冲突</div>
                </div>
              </div>
              <svg class="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </div>
          
          <!-- 主题设置 -->
          <div class="rounded-xl border border-stone-200 bg-stone-50/60 p-4 shadow-sm space-y-4">
            <div>
              <div class="text-[11px] font-semibold text-stone-400 uppercase tracking-wide mb-1">外观</div>
              <div class="text-sm font-semibold text-stone-800">主题风格</div>
            </div>
            
            <div class="grid grid-cols-5 gap-2">
              <!-- 默认主题 -->
              <button (click)="updateTheme('default')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-indigo-500]="store.theme() === 'default'"
                      [class.bg-indigo-50]="store.theme() === 'default'"
                      [class.border-stone-200]="store.theme() !== 'default'"
                      [class.hover:border-stone-300]="store.theme() !== 'default'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-stone-100 to-stone-300 border border-stone-300"></div>
                <span class="text-[10px] text-stone-600">默认</span>
              </button>
              
              <!-- 海洋主题 -->
              <button (click)="updateTheme('ocean')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-sky-500]="store.theme() === 'ocean'"
                      [class.bg-sky-50]="store.theme() === 'ocean'"
                      [class.border-stone-200]="store.theme() !== 'ocean'"
                      [class.hover:border-stone-300]="store.theme() !== 'ocean'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-sky-200 to-cyan-400 border border-sky-300"></div>
                <span class="text-[10px] text-stone-600">海洋</span>
              </button>
              
              <!-- 森林主题 -->
              <button (click)="updateTheme('forest')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-green-500]="store.theme() === 'forest'"
                      [class.bg-green-50]="store.theme() === 'forest'"
                      [class.border-stone-200]="store.theme() !== 'forest'"
                      [class.hover:border-stone-300]="store.theme() !== 'forest'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-green-200 to-emerald-400 border border-green-300"></div>
                <span class="text-[10px] text-stone-600">森林</span>
              </button>
              
              <!-- 日落主题 -->
              <button (click)="updateTheme('sunset')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-orange-500]="store.theme() === 'sunset'"
                      [class.bg-orange-50]="store.theme() === 'sunset'"
                      [class.border-stone-200]="store.theme() !== 'sunset'"
                      [class.hover:border-stone-300]="store.theme() !== 'sunset'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-orange-200 to-red-400 border border-orange-300"></div>
                <span class="text-[10px] text-stone-600">日落</span>
              </button>
              
              <!-- 薰衣草主题 -->
              <button (click)="updateTheme('lavender')" 
                      class="flex flex-col items-center gap-1.5 p-2 rounded-lg border-2 transition-all"
                      [class.border-purple-500]="store.theme() === 'lavender'"
                      [class.bg-purple-50]="store.theme() === 'lavender'"
                      [class.border-stone-200]="store.theme() !== 'lavender'"
                      [class.hover:border-stone-300]="store.theme() !== 'lavender'">
                <div class="w-8 h-8 rounded-full bg-gradient-to-br from-purple-200 to-fuchsia-400 border border-purple-300"></div>
                <span class="text-[10px] text-stone-600">薰衣草</span>
              </button>
            </div>
          </div>
          
          <!-- 账户信息 (只读显示) -->
          <div class="rounded-xl border border-stone-200 bg-stone-50/60 p-4 shadow-sm space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-[11px] font-semibold text-stone-400 uppercase tracking-wide">账户</div>
                <div class="text-sm font-semibold text-stone-800">同步状态</div>
              </div>
              <span class="px-2.5 py-1 text-[11px] rounded-full border"
                    [class.bg-emerald-50]="store.currentUserId()"
                    [class.border-emerald-100]="store.currentUserId()"
                    [class.text-emerald-700]="store.currentUserId()"
                    [class.bg-amber-50]="!store.currentUserId()"
                    [class.border-amber-100]="!store.currentUserId()"
                    [class.text-amber-700]="!store.currentUserId()">
                @if (store.currentUserId()) { 已登录 } @else { 未登录 }
              </span>
            </div>

            <div class="text-xs text-stone-500">
              @if (store.currentUserId()) {
                当前账号：{{ sessionEmail() || "Supabase 用户" }}
              } @else {
                点击侧边栏底部的"登录同步"按钮进行登录。
              }
            </div>

            @if (store.currentUserId()) {
              <div class="flex flex-wrap gap-2 pt-1">
                <button type="button" (click)="signOut.emit()" class="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 transition">退出登录</button>
              </div>
            }
          </div>
        </div>
        
        <div class="mt-6 flex justify-end">
          <button (click)="close.emit()" class="px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-700 transition-colors text-sm font-medium">关闭</button>
        </div>
      </div>
    </div>
  `
})
export class SettingsModalComponent {
  store = inject(StoreService);
  
  /** 当前登录用户邮箱 */
  sessionEmail = input<string | null>(null);
  @Output() close = new EventEmitter<void>();
  @Output() signOut = new EventEmitter<void>();
  @Output() themeChange = new EventEmitter<ThemeType>();
  @Output() openDashboard = new EventEmitter<void>();
  
  updateTheme(theme: ThemeType) {
    this.themeChange.emit(theme);
  }
}
