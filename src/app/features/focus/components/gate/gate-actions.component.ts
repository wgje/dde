/**
 * 大门按钮组组件
 *
 * 已读、完成、稍后提醒按钮，以及快速录入区域
 * 录音支持长按区域交互：超出区域取消录音
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  isDevMode,
  OnDestroy,
  viewChild,
  ElementRef
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
           @if (canSnooze()) {
             <button
               data-testid="gate-snooze-button"
               class="group relative w-16 h-16 rounded-full bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 active:scale-95 transition-all duration-200 flex items-center justify-center shadow-sm"
               [disabled]="isProcessing()"
               (click)="snooze()">
               <span class="text-2xl text-black dark:text-white font-light group-hover:scale-110 transition-transform">Zzz</span>
               <span class="absolute -bottom-8 text-xs font-medium text-gray-500 dark:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity">稍后</span>
             </button>
           }
        </div>

        <!-- 转写结果编辑区 -->
        @if (pendingTranscription()) {
          <div class="mt-2 rounded-2xl bg-white/80 dark:bg-black/40 backdrop-blur-xl ring-1 ring-black/5 dark:ring-white/10 overflow-hidden animate-fade-in">
            <textarea
              class="w-full bg-transparent border-0 text-sm leading-relaxed resize-none
                     focus:ring-0 focus:outline-none p-3 text-black dark:text-white
                     placeholder:text-gray-400"
              rows="3"
              [(ngModel)]="editableTranscription"
              placeholder="编辑转录内容...">
            </textarea>
            <div class="flex items-center justify-end gap-2 px-3 pb-2">
              <button
                class="px-3 py-1 rounded-lg text-xs bg-gray-200 dark:bg-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-white/20 transition-colors"
                (click)="cancelPendingTranscription()">
                取消
              </button>
              <button
                class="px-3 py-1 rounded-lg text-xs bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                (click)="confirmPendingTranscription()">
                保存
              </button>
            </div>
          </div>
        }

        <!-- 快速录入区 (iOS 搜索栏风格) -->
        <div class="mt-4 relative bg-gray-100/80 dark:bg-white/5 backdrop-blur-xl rounded-2xl p-1 transition-all duration-300 ring-1 ring-black/5 dark:ring-white/10 focus-within:ring-blue-500/50 dark:focus-within:ring-blue-400/50 focus-within:bg-white dark:focus-within:bg-black/40">
          <div class="flex items-center px-3 py-2">
            <!-- 录音按钮区域 - 长按开始，超出取消 -->
            @if (speechSupported() || isDevMode) {
              <div
                #recordBtn
                class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300 mr-2 select-none touch-none cursor-pointer"
                [class.bg-red-500]="isRecording()"
                [class.animate-pulse]="isRecording() && !isOutOfZone()"
                [class.opacity-50]="isOutOfZone()"
                [ngClass]="{'bg-gray-200': !isRecording() && !isTranscribing(), 'dark:bg-white/10': !isRecording() && !isTranscribing()}"
                [class.pointer-events-none]="isTranscribing()"
                (mousedown)="onRecordMouseDown($event)"
                (touchstart)="onRecordTouchStart($event)"
                (keydown.space)="onRecordKeyStart($event)"
                (keyup.space)="onRecordKeyStop()">
                
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
              </div>
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
        @if (isRecording()) {
           <p class="text-center text-xs text-gray-400 font-medium"
              [class.animate-pulse]="!isOutOfZone()">
             {{ isOutOfZone() ? '松开取消录音' : '正在录音... 超出按钮区域将取消' }}
           </p>
        }
        @if (isTranscribing()) {
           <p class="text-center text-xs text-gray-400 animate-pulse font-medium">
             正在转写语音...
           </p>
        }
      </div>
    </section>
  `,
  styles: [`
    :host {
      display: block;
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
export class GateActionsComponent implements OnDestroy {
  // 注入服务
  gateService = inject(GateService);
  toast = inject(ToastService);
  blackBoxService = inject(BlackBoxService);
  speechService = inject(SpeechToTextService);
  logger = inject(LoggerService);

  /**
   * 动画处理中状态 - 禁用操作按钮
   *
   * 【Bug Fix #96645099】从 class field (computed signal) 改为原型方法
   * 原因：极端情况下（如 Service Worker 缓存导致 chunk 不一致），
   * class field 可能未正确初始化，导致模板调用时
   * 报 "n.isProcessing is not a function"。
   * 原型方法始终存在于类原型上，不受实例初始化影响。
   */
  isProcessing(): boolean {
    try {
      return this.gateService.cardAnimation() !== 'idle';
    } catch {
      return false;
    }
  }

  /** 是否可以跳过（原型方法，同上理由） */
  canSnooze(): boolean {
    try {
      return this.gateService.canSnooze();
    } catch {
      return false;
    }
  }

  // 快速录入相关
  quickInputText = signal('');
  
  // 直接使用 Service 状态，保持全局一致
  isRecording = this.speechService.isRecording;
  isTranscribing = this.speechService.isTranscribing;
  
  speechSupported = signal(this.speechService.isSupported());
  
  /** 开发模式标志，用于展示录音按钮 UI（即使浏览器不支持录音） */
  readonly isDevMode = isDevMode();
  
  /** 鼠标/手指是否超出录音按钮区域 */
  isOutOfZone = signal(false);
  /** 待确认的转录文本 */
  pendingTranscription = signal('');
  /** 可编辑的转录文本 */
  editableTranscription = '';
  
  /** 全局事件清理函数 */
  private globalCleanups: (() => void)[] = [];
  
  readonly recordBtn = viewChild<ElementRef<HTMLElement>>('recordBtn');

  ngOnDestroy(): void {
    this.removeGlobalListeners();
  }

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

    const result = this.blackBoxService.create({ content: text });

    if (result.ok) {
        this.logger.info('Quick input submitted:', text);
        this.quickInputText.set('');
        this.toast.success('已记录');
    } else {
        this.logger.error('Failed to submit quick input', result.error.message);
        this.toast.error(result.error.message || '记录失败');
    }
  }

  // --- 转录确认/取消 ---

  confirmPendingTranscription(): void {
    const text = this.editableTranscription.trim();
    if (text) {
      // 追加到输入框（如果有内容），或直接写入
      const current = this.quickInputText();
      this.quickInputText.set(current ? current + ' ' + text : text);
    }
    this.pendingTranscription.set('');
    this.editableTranscription = '';
  }

  cancelPendingTranscription(): void {
    this.logger.debug('GateActions', 'Transcription cancelled by user');
    this.pendingTranscription.set('');
    this.editableTranscription = '';
  }

  // --- 录音区域交互 ---

  onRecordMouseDown(event: MouseEvent): void {
    event.preventDefault();
    if (this.isTranscribing() || this.pendingTranscription()) return;
    
    this.doStartRecording();
    
    const onMouseMove = (e: MouseEvent) => this.checkInRecordZone(e.clientX, e.clientY);
    const onMouseUp = () => this.doStopOrCancel();
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    
    this.globalCleanups.push(
      () => document.removeEventListener('mousemove', onMouseMove),
      () => document.removeEventListener('mouseup', onMouseUp)
    );
  }

  onRecordTouchStart(event: TouchEvent): void {
    event.preventDefault();
    if (this.isTranscribing() || this.pendingTranscription()) return;
    
    this.doStartRecording();
    
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        this.checkInRecordZone(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchEnd = () => this.doStopOrCancel();
    
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    
    this.globalCleanups.push(
      () => document.removeEventListener('touchmove', onTouchMove),
      () => document.removeEventListener('touchend', onTouchEnd),
      () => document.removeEventListener('touchcancel', onTouchEnd)
    );
  }

  onRecordKeyStart(event: Event): void {
    if ((event as KeyboardEvent).repeat) return;
    event.preventDefault();
    if (this.isTranscribing() || this.pendingTranscription()) return;
    this.doStartRecording();
  }

  onRecordKeyStop(): void {
    if (!this.isRecording()) return;
    this.isOutOfZone.set(false);
    this.doTranscribe();
  }

  // --- 内部方法 ---

  /** 开发模式模拟转写文本，用于 UI 调试 */
  private static readonly DEV_MOCK_TRANSCRIPTIONS = [
    '先把登录模块的样式调一下，按钮间距太紧了，还有那个输入框的圆角要改成 8px',
    '明天和设计师确认一下大门卡片的动画时长，现在感觉有点快',
    '这个 bug 的根因是同步时 content 字段被漏掉了，需要在查询里加上',
  ];

  private doStartRecording(): void {
    // 开发模式下浏览器不支持录音时，直接注入模拟转写文本，便于 UI 调试
    if (!this.speechService.isSupported()) {
      this.logger.debug('GateActions', '[DEV] 录音不可用，注入模拟转写文本');
      const mockTexts = GateActionsComponent.DEV_MOCK_TRANSCRIPTIONS;
      const mockText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
      this.pendingTranscription.set(mockText);
      this.editableTranscription = mockText;
      return;
    }
    this.isOutOfZone.set(false);
    this.speechService.startRecording().catch(err => {
      this.logger.error('Failed to start recording', err);
      this.toast.error('无法启动录音');
    });
  }

  private checkInRecordZone(clientX: number, clientY: number): void {
    if (!this.isRecording()) return;
    
    const btn = this.recordBtn()?.nativeElement;
    if (!btn) return;
    
    const rect = btn.getBoundingClientRect();
    // 较大容差（40px），因为录音按钮较小
    const tolerance = 40;
    const inZone = clientX >= rect.left - tolerance &&
                   clientX <= rect.right + tolerance &&
                   clientY >= rect.top - tolerance &&
                   clientY <= rect.bottom + tolerance;
    
    this.isOutOfZone.set(!inZone);
  }

  private doStopOrCancel(): void {
    this.removeGlobalListeners();
    
    if (!this.isRecording()) return;
    
    if (this.isOutOfZone()) {
      this.speechService.cancelRecording();
      this.isOutOfZone.set(false);
      this.logger.debug('GateActions', 'Recording cancelled: pointer left zone');
    } else {
      this.doTranscribe();
    }
  }

  private async doTranscribe(): Promise<void> {
    this.removeGlobalListeners();
    
    try {
      const text = await this.speechService.stopAndTranscribe();
      if (text && text.trim()) {
        // 显示可编辑的转录结果，等待用户确认
        this.pendingTranscription.set(text);
        this.editableTranscription = text;
      }
    } catch (err) {
      this.logger.error('Transcription failed', err instanceof Error ? err.message : String(err));
    }
  }

  private removeGlobalListeners(): void {
    for (const cleanup of this.globalCleanups) {
      cleanup();
    }
    this.globalCleanups = [];
  }
}
