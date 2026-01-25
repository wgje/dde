/**
 * 黑匣子面板组件
 * 
 * 显示黑匣子条目列表和录音入口
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { BlackBoxService } from '../../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../../../../services/focus-preference.service';
import { BlackBoxRecorderComponent } from './black-box-recorder.component';
import { BlackBoxTextInputComponent } from './black-box-text-input.component';
import { BlackBoxDateGroupComponent } from './black-box-date-group.component';

@Component({
  selector: 'app-black-box-panel',
  standalone: true,
  imports: [
    CommonModule, 
    BlackBoxRecorderComponent, 
    BlackBoxTextInputComponent,
    BlackBoxDateGroupComponent
  ],
  template: `
    @if (focusPrefs.isBlackBoxEnabled()) {
                <div class="relative rounded-xl bg-amber-50/60 dark:bg-stone-800/60 
                  border border-amber-100/50 dark:border-stone-700/50 
                  backdrop-blur-md overflow-hidden"
                data-testid="black-box-panel"
                role="dialog"
                aria-label="黑匣子面板">
        
        <!-- 标题栏 -->
        <div 
          class="px-3 py-2.5 cursor-pointer flex justify-between items-center 
                 group select-none hover:bg-amber-100/30 dark:hover:bg-stone-700/30
                 transition-colors duration-150"
          (click)="toggleExpand()">
          <span class="font-bold text-stone-700 dark:text-stone-100 text-xs 
                       flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full bg-amber-500 
                         shadow-[0_0_6px_rgba(245,158,11,0.4)]"></span>
            📦 黑匣子
            @if (pendingCount() > 0) {
              <span class="bg-amber-500 text-white text-[9px] px-1.5 py-0.5 
                           rounded-full font-mono">
                {{ pendingCount() }}
              </span>
            }
          </span>
          <span 
            class="text-stone-300 dark:text-stone-500 text-[10px] 
                   transition-transform duration-300"
            [class.rotate-180]="isExpanded()">
            ▼
          </span>
        </div>
        
        <!-- 内容区 -->
        @if (isExpanded()) {
          <div class="px-2 pb-2 animate-slide-down">
            
            <!-- 录音按钮或文字输入 -->
            @if (speechService.isSupported()) {
              <app-black-box-recorder 
                (transcribed)="onTranscribed($event)" />
              <div class="mt-2">
                <app-black-box-text-input 
                  [showFallbackHint]="false"
                  (submitted)="onTranscribed($event)" />
              </div>
            } @else {
              <app-black-box-text-input 
                (submitted)="onTranscribed($event)" />
            }
            
            <!-- 离线待处理提示 -->
            @if (speechService.offlinePendingCount() > 0) {
              <div class="mt-2 px-2 py-1.5 bg-amber-100 dark:bg-amber-900/30 
                          rounded-lg text-xs text-amber-700 dark:text-amber-300
                          flex items-center gap-2">
                <span class="animate-pulse">📡</span>
                <span>{{ speechService.offlinePendingCount() }} 条录音待联网后转写</span>
              </div>
            }
            
            <!-- 剩余配额提示 -->
            @if (speechService.remainingQuota() <= 10) {
              <div class="mt-2 px-2 py-1.5 bg-stone-100 dark:bg-stone-700 
                          rounded-lg text-xs text-stone-500 dark:text-stone-400
                          flex items-center gap-2">
                <span>⚡</span>
                <span>今日剩余 {{ speechService.remainingQuota() }} 次转写</span>
              </div>
            }
            
            <!-- 条目列表（按日期分组） -->
            @for (group of entriesByDate(); track group.date) {
              <app-black-box-date-group 
                [group]="group"
                (markRead)="onMarkRead($event)"
                (markCompleted)="onMarkCompleted($event)"
                (archive)="onArchive($event)"
                (delete)="onDeleteRequested($event)" />
            }
            
            <!-- 空状态 -->
            @if (entriesByDate().length === 0) {
              <div class="py-6 text-center text-xs text-stone-400 dark:text-stone-500">
                <p class="mb-1">按住按钮开始录音</p>
                <p class="opacity-60">语音会自动转为文字</p>
              </div>
            }

            <!-- 删除确认栏 -->
            @if (pendingDeleteId()) {
              <div class="mt-2 px-2 py-1.5 bg-red-50 dark:bg-red-900/30 
                          rounded-lg text-xs text-red-600 dark:text-red-300
                          flex items-center justify-between gap-2">
                <span>确认删除该条目？</span>
                <div class="flex items-center gap-1.5">
                  <button
                    class="px-2 py-1 rounded bg-red-500 text-white text-[10px]
                           hover:bg-red-600 transition-colors"
                    data-testid="confirm-delete"
                    (click)="confirmDelete()">
                    删除
                  </button>
                  <button
                    class="px-2 py-1 rounded bg-stone-200 dark:bg-stone-700
                           text-stone-600 dark:text-stone-300 text-[10px]
                           hover:bg-stone-300 dark:hover:bg-stone-600 transition-colors"
                    (click)="cancelDelete()">
                    取消
                  </button>
                </div>
              </div>
            }
            
          </div>
        }
        
      </div>
    }
  `,
  styles: [`
    .animate-slide-down {
      animation: slide-down 0.2s ease-out;
    }
    
    @keyframes slide-down {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxPanelComponent {
  private blackBoxService = inject(BlackBoxService);
  speechService = inject(SpeechToTextService);
  focusPrefs = inject(FocusPreferenceService);
  
  isExpanded = signal(true);
  pendingDeleteId = signal<string | null>(null);
  readonly entriesByDate = this.blackBoxService.entriesByDate;
  readonly pendingCount = this.blackBoxService.pendingCount;
  
  /**
   * 切换展开状态
   */
  toggleExpand(): void {
    this.isExpanded.update(v => !v);
  }
  
  /**
   * 处理转写完成
   */
  onTranscribed(text: string): void {
    if (text.trim()) {
      this.blackBoxService.create({ content: text.trim() });
    }
  }
  
  /**
   * 标记为已读
   */
  onMarkRead(id: string): void {
    this.blackBoxService.markAsRead(id);
  }
  
  /**
   * 标记为完成
   */
  onMarkCompleted(id: string): void {
    this.blackBoxService.markAsCompleted(id);
  }
  
  /**
   * 归档
   */
  onArchive(id: string): void {
    this.blackBoxService.archive(id);
  }

  /**
   * 请求删除
   */
  onDeleteRequested(id: string): void {
    this.pendingDeleteId.set(id);
  }

  /**
   * 确认删除
   */
  confirmDelete(): void {
    const id = this.pendingDeleteId();
    if (!id) return;
    this.blackBoxService.delete(id);
    this.pendingDeleteId.set(null);
  }

  /**
   * 取消删除
   */
  cancelDelete(): void {
    this.pendingDeleteId.set(null);
  }
}
