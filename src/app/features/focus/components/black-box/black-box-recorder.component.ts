/**
 * 黑匣子录音按钮组件
 * 
 * 对讲机式交互：按住说话，松开转文字
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  input,
  output,
  OnDestroy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { LoggerService } from '../../../../../services/logger.service';

@Component({
  selector: 'app-black-box-recorder',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="black-box-recorder">
      <!-- 转写结果预览 -->
      @if (transcription()) {
        <div class="mb-2 p-2 rounded-lg text-xs animate-fade-in" [class]="transcriptionPreviewClass()">
          <p class="line-clamp-3">{{ transcription() }}</p>
        </div>
      }

      <!-- 录音按钮 -->
      <button
        class="record-btn w-full px-4 py-5 rounded-xl transition-all duration-200
               flex items-center justify-center gap-2 text-sm font-medium
               select-none touch-none
               border-2 border-solid border-transparent
               hover:border-dashed hover:border-amber-300/50
               dark:hover:border-stone-500/50"
        [class]="getButtonClass()"
        [disabled]="voiceService.isTranscribing()"
        (mousedown)="start($event)"
        (mouseup)="stop()"
        (mouseleave)="stop()"
        (touchstart)="start($event)"
        (touchend)="stop()"
        (touchcancel)="stop()"
        (keydown.space)="start($event)"
        (keyup.space)="stop()"
        [attr.aria-pressed]="voiceService.isRecording()"
        [attr.aria-label]="getAriaLabel()"
        data-testid="black-box-recorder">
        
        @if (voiceService.isTranscribing()) {
          <span class="w-4 h-4 border-2 border-stone-400 border-t-transparent 
                       rounded-full animate-spin"></span>
          <span>转写中...</span>
        } @else if (voiceService.isRecording()) {
          <span class="recording-dot w-3 h-3 rounded-full bg-white"></span>
          <span>录音中...</span>
          <span class="text-white/70 text-xs font-mono ml-1">
            {{ recordingDuration() }}s
          </span>
        } @else {
          <span class="text-lg">🎤</span>
          <span>按住开始录音</span>
        }
      </button>
      
      <!-- 提示文字 -->
      @if (!voiceService.isRecording() && !voiceService.isTranscribing()) {
        <p class="mt-1.5 text-center text-[10px] text-stone-400 dark:text-stone-500">
          按住说话，松开自动转写
        </p>
      }
    </div>
  `,
  styles: [`
    .record-btn {
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
    
    .record-btn.recording {
      animation: recording-pulse 1.5s ease-in-out infinite;
    }
    
    @keyframes recording-pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
      }
      50% {
        box-shadow: 0 0 0 12px rgba(239, 68, 68, 0);
      }
    }
    
    .recording-dot {
      animation: recording-blink 0.8s ease-in-out infinite;
    }
    
    @keyframes recording-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .animate-fade-in {
      animation: fade-in 0.2s ease-out;
    }
    
    @keyframes fade-in {
      from { opacity: 0; transform: translateY(-5px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class BlackBoxRecorderComponent implements OnDestroy {
  voiceService = inject(SpeechToTextService);
  private readonly logger = inject(LoggerService);
  appearance = input<'default' | 'obsidian'>('default');
  onTranscribed = input<((text: string) => void) | null>(null);
  
  transcription = signal('');
  recordingDuration = signal(0);
  
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  
  transcribed = output<string>();

  ngOnDestroy(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
  }

  /**
   * 获取按钮样式类
   */
  getButtonClass(): string {
    if (this.voiceService.isTranscribing()) {
      if (this.appearance() === 'obsidian') {
        return 'bg-stone-700 text-stone-300 cursor-wait';
      }
      return 'bg-stone-200 dark:bg-stone-600 text-stone-500 dark:text-stone-300 cursor-wait';
    }
    if (this.voiceService.isRecording()) {
      return 'recording bg-red-500 text-white shadow-lg shadow-red-500/30 scale-[0.98] border-2 border-dashed border-red-400';
    }
    if (this.appearance() === 'obsidian') {
      return `bg-stone-800 text-amber-300 border border-stone-600/70
              hover:bg-stone-700 active:scale-[0.98]`;
    }
    return `bg-amber-100/80 dark:bg-stone-700/80 
            text-amber-700 dark:text-amber-300 
            hover:bg-amber-200 dark:hover:bg-stone-600 
            active:scale-[0.98]`;
  }

  transcriptionPreviewClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'bg-stone-800 border border-stone-700 text-stone-200';
    }
    return 'bg-amber-100/80 dark:bg-stone-700 text-stone-700 dark:text-stone-200';
  }
  
  /**
   * 获取 ARIA 标签
   */
  getAriaLabel(): string {
    if (this.voiceService.isTranscribing()) return '正在转写';
    if (this.voiceService.isRecording()) return '松开停止录音';
    return '按住开始录音';
  }

  /**
   * 开始录音
   */
  start(event: Event): void {
    event.preventDefault();
    
    if (this.voiceService.isTranscribing()) return;
    
    this.transcription.set('');
    this.recordingDuration.set(0);
    
    // 开始计时
    this.durationTimer = setInterval(() => {
      this.recordingDuration.update(d => d + 1);
    }, 1000);
    
    this.voiceService.startRecording();
  }

  /**
   * 停止录音并转写
   */
  async stop(): Promise<void> {
    if (!this.voiceService.isRecording()) return;
    
    // 停止计时
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
    
    try {
      const text = await this.voiceService.stopAndTranscribe();
      
      if (text.trim()) {
        this.transcription.set(text);
        this.transcribed.emit(text);
        this.onTranscribed()?.(text);
        
        // 3秒后清除预览
        setTimeout(() => {
          this.transcription.set('');
        }, 3000);
      }
    } catch (e) {
      this.logger.error('BlackBoxRecorder', 'Recording failed', e);
    }
  }
}
