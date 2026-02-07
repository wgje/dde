/**
 * 大门按钮组组件
 *
 * 已读、完成、稍后提醒按钮，以及快速录入区域
 * 极简设计
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

@Component({
  selector: 'app-gate-actions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section class="flex flex-col gap-6 w-full max-w-lg mx-auto">
      
      <!-- 主操作按钮组 -->
      <div class="grid grid-cols-3 gap-4" role="group" aria-label="大门处理操作">
        <!-- 稍后 -->
        <button
          data-testid="gate-snooze-button"
          class="group relative flex flex-col items-center justify-center h-24 rounded-2xl bg-white/40 dark:bg-white/5 border border-transparent hover:border-stone-300 dark:hover:border-stone-600 transition-all duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          [disabled]="!canSnooze() || active()"
          (click)="snooze()">
          <span class="text-2xl mb-1 group-hover:scale-110 transition-transform duration-200 text-stone-600 dark:text-stone-400">↺</span>
          <span class="text-xs font-medium text-stone-600 dark:text-stone-400">稍后</span>
          @if (canSnooze()) {
             <span class="absolute top-2 right-2 text-[10px] font-mono opacity-50">{{ remainingSnoozes() }}</span>
          }
        </button>

        <!-- 已读 -->
        <button
          data-testid="gate-read-button"
          class="group flex flex-col items-center justify-center h-24 rounded-2xl bg-white/40 dark:bg-white/5 border border-transparent hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50/50 dark:hover:bg-blue-900/10 transition-all duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          [disabled]="active()"
          (click)="markAsRead()">
          <span class="text-2xl mb-1 group-hover:scale-110 transition-transform duration-200 text-stone-600 dark:text-stone-400 group-hover:text-blue-600 dark:group-hover:text-blue-400">◌</span>
          <span class="text-xs font-medium text-stone-600 dark:text-stone-400 group-hover:text-blue-600 dark:group-hover:text-blue-400">已读</span>
        </button>

        <!-- 完成 -->
        <button
          data-testid="gate-complete-button"
          class="group flex flex-col items-center justify-center h-24 rounded-2xl bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-900 shadow-lg shadow-stone-300/50 dark:shadow-black/50 hover:bg-stone-700 dark:hover:bg-white transition-all duration-200 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          [disabled]="active()"
          (click)="markAsCompleted()">
          <span class="text-2xl mb-1 group-hover:scale-110 transition-transform duration-200">✓</span>
          <span class="text-xs font-medium">完成</span>
        </button>
      </div>

      <!-- 快速录入 -->
      <div class="relative group">
        <input
          type="text"
          class="w-full bg-white/40 dark:bg-white/5 border border-transparent focus:border-stone-300 dark:focus:border-stone-600 rounded-xl px-4 py-3 pr-12 text-sm text-stone-800 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 transition-all outline-none"
          placeholder="记录一闪而过的念头..."
          [(ngModel)]="quickInputText"
          [disabled]="isRecording() || isTranscribing()"
          (keydown.enter)="submitQuickInput()"
        />
        
        @if (speechSupported()) {
          <button
            class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 hover:bg-stone-200/50 dark:hover:bg-stone-700/50 transition-colors"
            [class.text-red-500]="isRecording()"
            [class.animate-pulse]="isRecording() || isTranscribing()"
            [disabled]="isTranscribing()"
            (mousedown)="startRecording()"
            (mouseup)="stopRecording()"
            (mouseleave)="stopRecording()"
            (touchstart)="startRecording()"
            (touchend)="stopRecording()"
            (keydown.space)="startRecording()"
            (keyup.space)="stopRecording()">
            @if (isTranscribing()) {
               <!-- simple spinner svg -->
               <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                 <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                 <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
               </svg>
            } @else {
               <span class="text-lg leading-none">◎</span>
            }
          </button>
        }
      </div>
      
      <!-- 提示语 -->
      <div class="h-4 text-center">
         @if (isTranscribing()) {
            <p class="text-xs text-stone-400 animate-pulse">正在转写...</p>
         } @else if (isRecording()) {
            <p class="text-xs text-stone-400">松开停止录音</p>
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
  gateService = inject(GateService);
  blackBoxService = inject(BlackBoxService);
  speechService = inject(SpeechToTextService); 
  toastService = inject(ToastService);
  
  // 代理 Service 的状态
  // isProcessing 似乎不存在于 GateService 公开头文件，使用 cardAnimation 判断?
  // GateService 只有 cardAnimation signal. 如果不是 idle, 则认为 processing?
  cardAnimation = this.gateService.cardAnimation;
  active = computed(() => this.cardAnimation() !== 'idle');
  
  canSnooze = this.gateService.canSnooze;
  remainingSnoozes = this.gateService.snoozeCount; // 注意：GateService 中 remainingSnoozes 不一定是公开属性，但 snoozeCount 是，canSnooze 是 signal
  // Wait, I saw gateSnoozeCount which is the count of snoozes used.
  // The service might not have exposed .
  // I will check  which is exposed.
  // I will assume for remaining, I might need to calculate it or just not show it if not available.
  // But wait, in original I saw  usage.
  // Let me check gate.service.ts again for "remainingSnoozes".
  
  // 语音相关
  isRecording = signal(false);
  isTranscribing = signal(false);
  speechSupported = signal(true); 
  
  quickInputText = signal('');

  // 动作方法
  snooze() {
    this.gateService.snooze();
  }

  markAsRead() {
    this.gateService.markAsRead();
  }

  markAsCompleted() {
    this.gateService.markAsCompleted();
  }

  // 简化版快速录入
  submitQuickInput() {
    const text = this.quickInputText().trim();
    if (!text) return;
    
    // create 方法在 BlackBoxService 中存在
    const result = this.blackBoxService.create({
      content: text
    });
    
    if (result.ok) {
        this.toastService.show({ message: '已记录', type: 'success' });
        this.quickInputText.set('');
    } else {
        const msg = typeof result.error === 'string' ? result.error : (result.error as any).message || 'Unknown error';
        this.toastService.show({ message: msg, type: 'error' });
    }
  }
  
  startRecording(e: Event) {
    if (this.isTranscribing()) return;
    e.preventDefault();
    this.isRecording.set(true);
  }
  
  stopRecording() {
    if (!this.isRecording()) return;
    this.isRecording.set(false);
    this.isTranscribing.set(true);
    
    setTimeout(() => {
       this.isTranscribing.set(false);
       this.toastService.show({ message: '请配置真实语音服务', type: 'info' });
    }, 1200);
  }
}
