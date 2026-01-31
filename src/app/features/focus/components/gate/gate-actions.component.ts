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

@Component({
  selector: 'app-gate-actions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="w-full">
      <!-- 三列布局布局 -->
      <div class="grid grid-cols-3 gap-3">
        
        <!-- 稍后提醒 (最左，黄色但柔和) -->
        <button 
          data-testid="gate-snooze-button"
          class="group relative px-2 py-4 rounded-2xl font-medium text-xs
                 bg-stone-100 dark:bg-[#2c2c2e] 
                 text-stone-500 dark:text-stone-400
                 hover:bg-orange-50 dark:hover:bg-orange-900/10
                 hover:text-orange-600 dark:hover:text-orange-400
                 active:scale-[0.96] transition-all duration-200
                 flex flex-col items-center justify-center gap-2
                 focus-visible:ring-2 focus-visible:ring-orange-500/30"
          [class.opacity-50]="!canSnooze()"
          [disabled]="!canSnooze() || isProcessing()"
          (click)="snooze()">
          <span class="text-xl group-hover:scale-110 transition-transform duration-200">👀</span>
          <span>稍后</span>
          
          @if (canSnooze()) {
             <span class="absolute top-2 right-2 flex h-2 w-2">
               <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
               <span class="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
             </span>
          }
        </button>

        <!-- 已读 (中间，中性) -->
        <button 
          data-testid="gate-read-button"
          class="group px-2 py-4 rounded-2xl font-medium text-xs
                 bg-white dark:bg-[#3a3a3c] 
                 border border-stone-200 dark:border-stone-700
                 text-stone-600 dark:text-stone-300
                 hover:bg-stone-50 dark:hover:bg-[#48484a]
                 active:scale-[0.96] transition-all duration-200
                 flex flex-col items-center justify-center gap-2
                 focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2"
          [disabled]="isProcessing()"
          (click)="markAsRead()">
          <span class="text-xl group-hover:scale-110 transition-transform duration-200">📖</span>
          <span>已读</span>
        </button>
        
        <!-- 完成 (最右，强调) -->
        <button 
          data-testid="gate-complete-button"
          class="group px-2 py-4 rounded-2xl font-medium text-xs
                 bg-stone-900 dark:bg-[#d1d1d6]
                 text-white dark:text-black
                 hover:shadow-lg hover:shadow-stone-900/20 dark:hover:shadow-white/10
                 active:scale-[0.96] transition-all duration-200
                 flex flex-col items-center justify-center gap-2
                 focus-visible:ring-2 focus-visible:ring-stone-500 focus-visible:ring-offset-2"
          [disabled]="isProcessing()"
          (click)="markAsCompleted()">
          <span class="text-xl group-hover:scale-110 transition-transform duration-200">✅</span>
          <span>完成</span>
        </button>
      </div>
      
      <!-- 额外信息 -->
      @if (canSnooze()) {
        <div class="mt-4 text-center">
            <span class="text-[10px] font-mono text-stone-300 dark:text-stone-500 tracking-wider">
                今日剩余 {{ remainingSnoozes() }} 次推迟机会
            </span>
        </div>
      }
      
      <!-- 快速录入区域 -->
      <div class="mt-4 pt-3 border-t border-stone-200/50 dark:border-white/10">
        <div class="flex items-center gap-2">
          <input 
            type="text"
            class="flex-1 px-3 py-2 rounded-xl 
                   bg-stone-100 dark:bg-white/10 
                   text-stone-700 dark:text-white 
                   placeholder-stone-400 dark:placeholder-white/40 
                   text-sm outline-none
                   focus:bg-stone-200 dark:focus:bg-white/20 
                   transition-colors border border-stone-200 dark:border-transparent"
            placeholder="记录一个想法..."
            [(ngModel)]="quickInputText"
            [disabled]="isRecording() || isTranscribing()"
            (keydown.enter)="submitQuickInput()"
          />
          @if (speechSupported()) {
            <button 
              class="p-2.5 rounded-full transition-all duration-200
                     flex items-center justify-center
                     focus-visible:ring-2 focus-visible:ring-orange-500/30"
              [class]="isRecording() 
                ? 'bg-red-500 text-white animate-pulse scale-110' 
                : 'bg-stone-100 dark:bg-white/10 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-white/20'"
              [disabled]="isTranscribing()"
              (mousedown)="startRecording($event)"
              (mouseup)="stopRecording()"
              (mouseleave)="stopRecording()"
              (touchstart)="startRecording($event)"
              (touchend)="stopRecording()">
              @if (isTranscribing()) {
                <span class="animate-spin">⏳</span>
              } @else if (isRecording()) {
                <span>🔴</span>
              } @else {
                <span>🎤</span>
              }
            </button>
          }
        </div>
        @if (quickInputText() || isRecording()) {
          <div class="mt-2 text-center">
            <span class="text-[10px] text-stone-400 dark:text-stone-500">
              @if (isRecording()) {
                松开停止录音
              } @else {
                按回车键快速录入
              }
            </span>
          </div>
        }
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateActionsComponent {
  private gateService = inject(GateService);
  private toast = inject(ToastService);
  private blackBoxService = inject(BlackBoxService);
  private speechService = inject(SpeechToTextService);
  
  readonly canSnooze = this.gateService.canSnooze;
  
  // 动画期间禁用按钮
  readonly isProcessing = computed(() => 
    this.gateService.cardAnimation() !== 'idle'
  );
  
  // 快速录入文本
  readonly quickInputText = signal('');
  
  // 语音录入状态
  readonly isRecording = this.speechService.isRecording;
  readonly isTranscribing = this.speechService.isTranscribing;
  readonly speechSupported = this.speechService.isSupported;
  
  /**
   * 剩余跳过次数
   */
  remainingSnoozes(): number {
    // 默认每日最大 3 次
    const max = 3;
    return Math.max(0, max - this.gateService.snoozeCount());
  }
  
  /**
   * 标记为已读
   */
  markAsRead(): void {
    const result = this.gateService.markAsRead();
    if (result.ok) {
      // 可选：显示反馈
    }
  }
  
  /**
   * 标记为完成
   */
  markAsCompleted(): void {
    const result = this.gateService.markAsCompleted();
    if (result.ok) {
      // 可选：显示反馈
    }
  }
  
  /**
   * 稍后提醒
   */
  snooze(): void {
    const result = this.gateService.snooze();
    if (!result.ok) {
      this.toast.warning('跳过失败', result.error.message);
    }
  }
  
  /**
   * 提交快速录入
   */
  submitQuickInput(): void {
    const text = this.quickInputText().trim();
    if (!text) return;
    
    const result = this.blackBoxService.create({ content: text });
    if (result.ok) {
      this.quickInputText.set('');
      this.toast.success('已记录', '想法已添加到黑匣子');
    } else {
      this.toast.error('录入失败', result.error.message);
    }
  }
  
  /**
   * 开始语音录入
   */
  startRecording(event: Event): void {
    event.preventDefault(); // 阻止触摸事件冒泡
    this.speechService.startRecording();
  }
  
  /**
   * 停止语音录入并转写
   */
  async stopRecording(): Promise<void> {
    if (!this.isRecording()) return;
    
    try {
      const text = await this.speechService.stopAndTranscribe();
      if (text && text.trim()) {
        // 直接创建条目
        const result = this.blackBoxService.create({ content: text.trim() });
        if (result.ok) {
          this.toast.success('已记录', '语音已转写并添加到黑匣子');
        } else {
          // 转写成功但创建失败，将文本放入输入框
          this.quickInputText.set(text.trim());
          this.toast.warning('创建失败', '请手动提交');
        }
      }
    } catch (error) {
      // 记录错误便于排查
      console.error('[GateActions] 语音转写失败:', error);
      this.toast.error('语音转写失败', '请重试或手动输入');
    }
  }
}
