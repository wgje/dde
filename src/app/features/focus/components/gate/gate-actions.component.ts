/**
 * 大门按钮组组件
 *
 * 已读、完成、稍后提醒按钮，以及快速录入区域
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  computed,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GateService } from '../../../../../services/gate.service';
import { ToastService } from '../../../../../services/toast.service';
import { BlackBoxService } from '../../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { LoggerService } from '../../../../../services/logger.service';

@Component({
  selector: 'app-gate-actions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="max-w-md mx-auto">
      <div class="flex flex-col gap-6">
        <!-- 主要操作按钮 (圆形极简风) -->
        <div class="flex items-center justify-center gap-8" role="group" aria-label="大门处理操作">
          <!-- 已读 -->
          <button
            data-testid="gate-read-button"
            class="group relative w-16 h-16 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 active:scale-95 transition-all duration-200 flex items-center justify-center shadow-sm"
            [disabled]="isProcessing()"
            (click)="markAsRead()">
            <span class="text-2xl text-black dark:text-white font-light group-hover:scale-110 transition-transform">◎</span>
            <span class="absolute -bottom-8 text-xs font-medium text-gray-500 dark:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">已读</span>
          </button>

          <!-- 完成 (主操作，稍微大一点) -->
          <button
            data-testid="gate-complete-button"
            class="group relative w-20 h-20 rounded-full bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 active:scale-95 transition-all duration-200 flex items-center justify-center shadow-lg shadow-black/10"
            [disabled]="isProcessing()"
            (click)="markAsCompleted()">
            <span class="text-3xl text-white dark:text-black font-light group-hover:scale-110 transition-transform">✓</span>
             <span class="absolute -bottom-8 text-xs font-medium text-gray-500 dark:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">完成</span>
          </button>

           <!-- 稍后 (如有) -->
           <button
             *ngIf="canSnooze()"
             data-testid="gate-snooze-button"
             class="group relative w-16 h-16 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 active:scale-95 transition-all duration-200 flex items-center justify-center shadow-sm"
             [disabled]="isProcessing()"
             (click)="snooze()">
             <span class="text-2xl text-black dark:text-white font-light group-hover:scale-110 transition-transform">Zzz</span>
             <span class="absolute -bottom-8 text-xs font-medium text-gray-500 dark:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">稍后</span>
           </button>
        </div>

        <!-- 快速录入区 (iOS 搜索栏风格) -->
        <div class="mt-4 relative bg-gray-100/80 dark:bg-white/5 backdrop-blur-xl rounded-2xl p-1 transition-all duration-300 ring-1 ring-black/5 dark:ring-white/10 focus-within:ring-blue-500/50 dark:focus-within:ring-blue-400/50 focus-within:bg-white dark:focus-within:bg-black/40">
          <div class="flex items-center px-3 py-2">
            <!-- 录音按钮 -->
            @if (speechSupported()) {
              <button
                class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300 mr-2"
                [class.bg-red-500]="isRecording()"
                [class.animate-pulse]="isRecording()"
                [ngClass]="{'bg-gray-200': !isRecording() && !isTranscribing(), 'dark:bg-white/10': !isRecording() && !isTranscribing()}"
                [disabled]="isTranscribing()"
                (mousedown)="startRecording($event)"
                (mouseup)="stopRecording()"
                (mouseleave)="stopRecording()"
                (touchstart)="startRecording($event)"
                (touchend)="stopRecording()"
                (keydown.space)="startRecording($event)"
                (keyup.space)="stopRecording()">
                
                @if (isTranscribing()) {
                  <svg class="animate-spin h-4 w-4 text-gray-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                } @else if (isRecording()) {
                  <div class="w-3 h-3 bg-white rounded-[2px]"></div>
                } @else {
                  <svg class="w-4 h-4 text-gray-500 dark:text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"></path>
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"></path>
                  </svg>
                }
              </button>
            }

            <input
              type="text"
              class="w-full bg-transparent border-0 p-0 text-base text-black dark:text-white placeholder:text-gray-400 focus:ring-0 leading-relaxed font-sans"
              placeholder="快速记录想法..."
              [(ngModel)]="quickInputText"
              [disabled]="isRecording() || isTranscribing()"
              (keydown.enter)="submitQuickInput()"
            />
            
            <!-- 回车提交提示 -->
            @if (quickInputText() && !isRecording() && !isTranscribing()) {
              <button 
                (click)="submitQuickInput()"
                class="ml-2 w-7 h-7 bg-blue-500 rounded-full flex items-center justify-center text-white hover:bg-blue-600 transition-colors">
                <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            }
          </div>
        </div>
        
        <!-- 状态提示 -->
        @if (isRecording() || isTranscribing()) {
           <p class="text-center text-xs text-gray-400 animate-pulse font-medium">
             {{ isTranscribing() ? '正在转写语音...' : '正在录音...' }}
           </p>
        }
      </div>
    </section>
  `,
  styles: [`
    :host {
      display: block;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateActionsComponent {
  // 注入服务
  gateService = inject(GateService);
  toast = inject(ToastService);
  blackBoxService = inject(BlackBoxService);
  speechService = inject(SpeechToTextService);
  logger = inject(LoggerService);

  // 状态信号
  isProcessing = computed(() => this.gateService.cardAnimation() !== 'idle'); // 比如正在提交已读/完成
  canSnooze = this.gateService.canSnooze; // 是否允许推迟

  // 快速录入相关
  quickInputText = signal('');
  
  // 直接使用 Service 状态，保持全局一致
  isRecording = this.speechService.isRecording;
  isTranscribing = this.speechService.isTranscribing;
  
  speechSupported = signal(this.speechService.isSupported());

  markAsRead() {
    this.gateService.markAsRead();
  }

  markAsCompleted() {
    this.gateService.markAsCompleted();
  }
  
  snooze() {
    if (this.canSnooze()) {
      this.gateService.snooze();
    }
  }

  // --- 快速录入逻辑 ---

  async submitQuickInput() {
    const text = this.quickInputText().trim();
    if (!text) return;

    // Use BlackBoxService.create to add entry
    const result = this.blackBoxService.create({
      content: text
    });

    if (result.ok) {
        this.logger.info('Quick input submitted:', text);
        this.quickInputText.set('');
        this.toast.success('已记录');
    } else {
        this.logger.error('Failed to submit quick input', result.error.message);
        this.toast.error(result.error.message || '记录失败');
    }
  }

  // --- 语音逻辑 (简化版，复用现有服务) ---

  startRecording(event: Event) {
    if (event.type === 'keydown' && (event as KeyboardEvent).repeat) return;
    event.preventDefault();

    if (this.isTranscribing()) return;

    // Service handles state update
    this.speechService.startRecording().catch(err => {
      this.logger.error('Failed to start recording', err);
      this.toast.error('无法启动录音');
    });
  }

  async stopRecording() {
    if (!this.isRecording()) return;
    
    // Service handles state update
    try {
      const text = await this.speechService.stopAndTranscribe();
      if (text) {
        // 追加到输入框
        const current = this.quickInputText();
        this.quickInputText.set(current ? current + ' ' + text : text);
      }
    } catch (err) {
      this.logger.error('Transcription failed', err instanceof Error ? err.message : String(err));
      // Service usually handles toast for errors, but we can add specific fallback
    }
  }
}
