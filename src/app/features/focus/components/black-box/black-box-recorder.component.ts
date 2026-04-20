/**
 * 黑匣子录音按钮组件
 * 
 * 长按录音区域交互：
 * - 在区域内长按开始录音
 * - 手指/鼠标超出区域则取消本次录音
 * - 录音完成后显示可编辑的转录文本
 * - 用户可确认保存或取消（取消不存入黑匣子）
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  input,
  output,
  OnDestroy,
  ElementRef,
  viewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { LoggerService } from '../../../../../services/logger.service';

@Component({
  selector: 'app-black-box-recorder',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="black-box-recorder">
      <!-- 转写结果编辑区 -->
      @if (transcription()) {
        <div class="mb-2 rounded-lg animate-fade-in" [class]="transcriptionPreviewClass()">
          <textarea
            class="w-full bg-transparent border-0 text-xs leading-relaxed resize-none
                   focus:ring-0 focus:outline-none p-2"
            [class]="transcriptionTextClass()"
            rows="3"
            [(ngModel)]="editableText"
            placeholder="编辑转录内容..."
            data-testid="transcription-editor">
          </textarea>
          <div class="flex items-center justify-end gap-2 px-2 pb-2">
            <button
              class="px-3 py-1 rounded text-[10px] transition-colors"
              [class]="cancelBtnClass()"
              (click)="cancelTranscription()"
              data-testid="transcription-cancel">
              取消
            </button>
            <button
              class="px-3 py-1 rounded text-[10px] transition-colors"
              [class]="confirmBtnClass()"
              (click)="confirmTranscription()"
              data-testid="transcription-confirm">
              保存
            </button>
          </div>
        </div>
      }

      <!-- 录音区域 - 长按开始，超出取消 -->
      <div
        #recordZone
        class="record-zone w-full px-4 py-5 rounded-xl transition-all duration-200
               flex items-center justify-center gap-2 text-sm font-medium
               select-none touch-none cursor-pointer
               border-2 border-solid border-transparent
               hover:border-dashed hover:border-amber-300/50
               dark:hover:border-stone-500/50"
        [class]="getButtonClass()"
        [class.pointer-events-none]="voiceService.isTranscribing()"
        (mousedown)="onZoneMouseDown($event)"
        (touchstart)="onZoneTouchStart($event)"
        (keydown.space)="onKeyStart($event)"
        (keyup.space)="onKeyStop()"
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
            {{ formatDuration(recordingDuration()) }}
          </span>
          @if (isOutOfZone()) {
            <span class="text-white/50 text-[10px] ml-1">松开取消</span>
          }
        } @else {
          <span class="text-lg">🎤</span>
          <span>长按开始录音</span>
        }
      </div>
      
      <!-- 提示文字 -->
      @if (!voiceService.isRecording() && !voiceService.isTranscribing() && !transcription()) {
        <p class="mt-1.5 text-center text-[10px] text-stone-400 dark:text-stone-500">
          长按说话，松开自动转写 · 超出区域则取消
        </p>
      }
    </div>
  `,
  styles: [`
    .record-zone {
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
    }
    
    .record-zone.recording {
      animation: recording-pulse 1.5s ease-in-out infinite;
    }
    
    .record-zone.out-of-zone {
      animation: none;
      opacity: 0.6;
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
      animation: fade-in var(--pk-panel-enter) var(--pk-ease-enter);
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
  /**
   * @deprecated Use the (transcribed) output event instead.
   * This callback input is an anti-pattern. Callers should migrate to:
   *   <app-black-box-recorder (transcribed)="onTranscribed($event)" />
   * Retained temporarily for workspace-shell.component.ts compatibility.
   */
  onTranscribed = input<((text: string) => void) | null>(null);
  
  /** 原始转录文本（非空时显示编辑区） */
  transcription = signal('');
  /** 用户可编辑的文本 */
  editableText = '';
  /** 录音时长（秒） */
  recordingDuration = signal(0);
  /** 鼠标/手指是否已超出录音区域 */
  isOutOfZone = signal(false);
  
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private recordingStartTime = 0;
  /** 全局事件清理函数集合 */
  private globalCleanups: (() => void)[] = [];
  
  readonly recordZone = viewChild<ElementRef<HTMLElement>>('recordZone');
  
  transcribed = output<string>();

  ngOnDestroy(): void {
    this.clearDurationTimer();
    this.removeGlobalListeners();
  }

  // ===============================================
  // 公共 API
  // ===============================================

  /**
   * 格式化录音时长为 mm:ss 格式
   */
  formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * 确认保存转录内容
   */
  confirmTranscription(): void {
    const text = this.editableText.trim();
    if (text) {
      this.transcribed.emit(text);
      this.onTranscribed()?.(text);
    }
    this.clearTranscription();
  }

  /**
   * 取消转录内容（不存入黑匣子）
   */
  cancelTranscription(): void {
    this.logger.debug('BlackBoxRecorder', 'Transcription cancelled by user');
    this.clearTranscription();
  }

  // ===============================================
  // 鼠标事件处理（桌面端）
  // ===============================================

  /**
   * 录音区域鼠标按下 - 开始录音
   */
  onZoneMouseDown(event: MouseEvent): void {
    event.preventDefault();
    // 阻止冒泡到父层（如手机抽屉 mobile-black-box-drawer、专注面板）的 swipe
    // 手势检测，避免按住录音后释放时被误判为“左右滑动切换视图”。
    event.stopPropagation();
    // 【修复 P3-05】增加 isRecording 检查，防止双击创建双重 MediaRecorder
    if (this.voiceService.isTranscribing() || this.transcription() || this.voiceService.isRecording()) return;
    
    this.startRecording();
    
    // 绑定全局 mousemove 和 mouseup
    const onMouseMove = (e: MouseEvent) => this.checkMouseInZone(e.clientX, e.clientY);
    const onMouseUp = () => this.stopOrCancel();
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    
    this.globalCleanups.push(
      () => document.removeEventListener('mousemove', onMouseMove),
      () => document.removeEventListener('mouseup', onMouseUp)
    );
  }

  // ===============================================
  // 触摸事件处理（移动端）
  // ===============================================

  /**
   * 录音区域触摸开始 - 开始录音
   */
  onZoneTouchStart(event: TouchEvent): void {
    event.preventDefault();
    // 阻止冒泡到父层抽屉的左右滑动检测器：按住录音期间手指如果有任何水平
    // 位移，释放时 mobile-black-box-drawer.onSwipeTouchEnd 会误认为一次滑动手势并发出
    // swipeToSwitch，造成「录音与手势冲突」。这里提前截断传播，使父层根本不会启动
    // swipeState，从根源上隔离这两种手势。
    event.stopPropagation();
    // 【修复 P3-05】增加 isRecording 检查，防止双击创建双重 MediaRecorder
    if (this.voiceService.isTranscribing() || this.transcription() || this.voiceService.isRecording()) return;
    
    this.startRecording();
    
    // 绑定全局 touchmove 和 touchend/touchcancel
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        this.checkMouseInZone(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchEnd = () => this.stopOrCancel();
    
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    
    this.globalCleanups.push(
      () => document.removeEventListener('touchmove', onTouchMove),
      () => document.removeEventListener('touchend', onTouchEnd),
      () => document.removeEventListener('touchcancel', onTouchEnd)
    );
  }

  // ===============================================
  // 键盘事件处理
  // ===============================================

  onKeyStart(event: Event): void {
    event.preventDefault();
    if (this.voiceService.isTranscribing() || this.transcription()) return;
    if ((event as KeyboardEvent).repeat) return;
    this.startRecording();
  }

  onKeyStop(): void {
    if (!this.voiceService.isRecording()) return;
    this.isOutOfZone.set(false);
    this.doStopAndTranscribe();
  }

  // ===============================================
  // 样式方法
  // ===============================================

  getButtonClass(): string {
    if (this.voiceService.isTranscribing()) {
      if (this.appearance() === 'obsidian') {
        return 'bg-stone-700 text-stone-300 cursor-wait';
      }
      return 'bg-stone-200 dark:bg-stone-600 text-stone-500 dark:text-stone-300 cursor-wait';
    }
    if (this.voiceService.isRecording()) {
      const base = 'bg-red-500 text-white shadow-lg shadow-red-500/30 scale-[0.98] border-2 border-dashed border-red-400';
      return this.isOutOfZone() ? `${base} out-of-zone` : `recording ${base}`;
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

  transcriptionTextClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'text-stone-200 placeholder-stone-500';
    }
    return 'text-stone-700 dark:text-stone-200 placeholder-stone-400';
  }

  cancelBtnClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'bg-stone-700 text-stone-300 hover:bg-stone-600';
    }
    return 'bg-stone-200 dark:bg-stone-600 text-stone-600 dark:text-stone-300 hover:bg-stone-300 dark:hover:bg-stone-500';
  }

  confirmBtnClass(): string {
    if (this.appearance() === 'obsidian') {
      return 'bg-amber-600 text-white hover:bg-amber-500';
    }
    return 'bg-amber-500 text-white hover:bg-amber-600';
  }

  getAriaLabel(): string {
    if (this.voiceService.isTranscribing()) return '正在转写';
    if (this.voiceService.isRecording()) return '松开停止录音';
    return '长按开始录音';
  }

  // ===============================================
  // 内部方法
  // ===============================================

  /**
   * 开始录音 + 启动计时器
   */
  private startRecording(): void {
    this.transcription.set('');
    this.editableText = '';
    this.recordingDuration.set(0);
    this.isOutOfZone.set(false);
    this.recordingStartTime = Date.now();
    
    // 使用 Date.now() 差值计算，避免 setInterval 漂移
    this.durationTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - this.recordingStartTime) / 1000);
      this.recordingDuration.set(elapsed);
    }, 500); // 每 500ms 更新一次，提高精度
    
    this.voiceService.startRecording();
  }

  /**
   * 检测鼠标/手指是否在录音区域内
   */
  private checkMouseInZone(clientX: number, clientY: number): void {
    if (!this.voiceService.isRecording()) return;
    
    const zone = this.recordZone()?.nativeElement;
    if (!zone) return;
    
    const rect = zone.getBoundingClientRect();
    // 留 20px 容差，避免边缘误取消
    const tolerance = 20;
    const inZone = clientX >= rect.left - tolerance &&
                   clientX <= rect.right + tolerance &&
                   clientY >= rect.top - tolerance &&
                   clientY <= rect.bottom + tolerance;
    
    this.isOutOfZone.set(!inZone);
  }

  /**
   * 松开时根据是否在区域内决定保存或取消
   */
  private stopOrCancel(): void {
    this.clearDurationTimer();
    this.removeGlobalListeners();
    
    if (!this.voiceService.isRecording()) return;
    
    if (this.isOutOfZone()) {
      // 超出区域 → 取消录音
      this.voiceService.cancelRecording();
      this.isOutOfZone.set(false);
      this.logger.debug('BlackBoxRecorder', 'Recording cancelled: pointer left zone');
    } else {
      // 在区域内 → 正常停止并转写
      this.doStopAndTranscribe();
    }
  }

  /**
   * 停止录音并进行转写
   */
  private async doStopAndTranscribe(): Promise<void> {
    this.clearDurationTimer();
    this.removeGlobalListeners();
    
    try {
      const text = await this.voiceService.stopAndTranscribe();
      
      if (text.trim()) {
        // 显示可编辑的转录结果，等待用户确认
        this.transcription.set(text);
        this.editableText = text;
      }
    } catch (e) {
      this.logger.error('BlackBoxRecorder', 'Recording failed', e);
    }
  }

  /**
   * 清除转录状态
   */
  private clearTranscription(): void {
    this.transcription.set('');
    this.editableText = '';
  }

  /**
   * 清除计时器
   */
  private clearDurationTimer(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
  }

  /**
   * 移除所有全局事件监听
   */
  private removeGlobalListeners(): void {
    for (const cleanup of this.globalCleanups) {
      cleanup();
    }
    this.globalCleanups = [];
  }
}
