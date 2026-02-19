/**
 * 大门动作区组件
 *
 * 保留两个主动作：已读 / 完成。
 * 快速录入悬浮按钮：短按打开面板，长按直接录音。
 * 录音过程中手指/鼠标离开按钮范围则自动撤销。
 */

import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  isDevMode,
  OnDestroy,
  viewChild,
  ElementRef,
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
    <section class="gate-actions-wrap">
      <div class="primary-actions" role="group" aria-label="大门处理操作">
        <button
          data-testid="gate-read-button"
          class="action-btn action-read"
          [disabled]="isProcessing()"
          (click)="markAsRead()">
          <span class="action-icon">↑</span>
          <span class="action-label">已读</span>
        </button>

        <button
          data-testid="gate-complete-button"
          class="action-btn action-complete"
          [disabled]="isProcessing()"
          (click)="markAsCompleted()">
          <span class="action-icon">↓</span>
          <span class="action-label">完成</span>
        </button>
      </div>

      <button
        #captureFab
        type="button"
        class="quick-capture-fab"
        [class.fab-recording]="isFabRecording()"
        [class.fab-out-of-zone]="isFabOutOfZone()"
        [class.fab-transcribing]="isFabTranscribing()"
        [disabled]="isProcessing()"
        (mousedown)="onFabMouseDown($event)"
        (touchstart)="onFabTouchStart($event)"
        aria-label="快速录入：点按打开面板，长按录音"
        data-testid="gate-quick-capture-toggle">
        @if (isFabTranscribing()) {
          <span class="fab-spinner"></span>
        } @else if (isFabRecording()) {
          <span class="fab-pulse"></span>
        } @else {
          <span class="fab-icon">+</span>
        }
      </button>

      @if (isFabRecording() || isFabTranscribing()) {
        <div class="fab-hint" aria-live="polite">
          @if (isFabOutOfZone()) {
            松开取消
          } @else if (isFabTranscribing()) {
            转写中…
          } @else {
            松开结束录音
          }
        </div>
      }

      @if (quickCaptureOpen()) {
        <div class="quick-capture-mask" (click)="closeQuickCapture()"></div>

        <section class="quick-capture-panel" data-testid="gate-quick-capture-panel">
          <header class="panel-header">
            <h3>快速记录</h3>
            <button type="button" class="panel-close" (click)="closeQuickCapture()">关闭</button>
          </header>

          @if (pendingTranscription()) {
            <div class="transcription-editor">
              <textarea
                class="transcription-input"
                rows="3"
                [(ngModel)]="editableTranscription"
                placeholder="编辑转写内容...">
              </textarea>
              <div class="transcription-actions">
                <button type="button" class="ghost-btn" (click)="cancelPendingTranscription()">取消</button>
                <button type="button" class="solid-btn" (click)="confirmPendingTranscription()">使用</button>
              </div>
            </div>
          }

          <div class="capture-input-row">
            @if (speechSupported() || isDevMode) {
              <button
                #recordBtn
                type="button"
                class="record-btn"
                [class.recording]="isRecording()"
                [class.out-of-zone]="isOutOfZone()"
                [disabled]="isTranscribing()"
                (mousedown)="onRecordMouseDown($event)"
                (touchstart)="onRecordTouchStart($event)"
                (keydown.space)="onRecordKeyStart($event)"
                (keyup.space)="onRecordKeyStop()">
                @if (isTranscribing()) {
                  <span class="spinner"></span>
                } @else if (isRecording()) {
                  <span class="record-stop"></span>
                } @else {
                  <span>🎤</span>
                }
              </button>
            }

            <textarea
              class="capture-input"
              rows="3"
              [ngModel]="quickInputText()"
              (ngModelChange)="quickInputText.set($event)"
              [disabled]="isRecording() || isTranscribing()"
              placeholder="记录一个待处理想法...">
            </textarea>
          </div>

          <footer class="panel-footer">
            @if (isRecording()) {
              <span class="hint">{{ isOutOfZone() ? '松开取消录音' : '录音中，离开按钮区域会取消' }}</span>
            } @else if (isTranscribing()) {
              <span class="hint">正在转写语音...</span>
            } @else {
              <span class="hint">在门内快速补录，不打断当前结算流程</span>
            }

            <button
              type="button"
              class="solid-btn"
              [disabled]="!quickInputText().trim()"
              (click)="submitQuickInput()">
              保存
            </button>
          </footer>
        </section>
      }
    </section>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
    }

    .gate-actions-wrap {
      position: relative;
      width: 100%;
      padding: 0.35rem 0.25rem 0.6rem;
    }

    .primary-actions {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.9rem;
    }

    .action-btn {
      min-width: 132px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 0.72rem 1.2rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.85);
      transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms ease, background-color 180ms ease;
      font-size: 0.84rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .action-btn:hover:not(:disabled) {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.1);
    }

    .action-btn:active:not(:disabled) {
      transform: translateY(1px);
    }

    .action-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .action-complete {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .action-icon {
      font-size: 1rem;
      line-height: 1;
    }

    .quick-capture-fab {
      position: absolute;
      right: -0.2rem;
      bottom: -2.8rem;
      width: 56px;
      height: 56px;
      border-radius: 9999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(24, 24, 27, 0.92);
      color: rgba(255, 255, 255, 0.9);
      box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.5);
      transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 160ms ease, background-color 200ms ease;
      z-index: 4;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .quick-capture-fab:hover:not(:disabled):not(.fab-recording) {
      transform: translateY(-2px);
      box-shadow: 0 10px 28px -8px rgba(0, 0, 0, 0.6);
    }

    .quick-capture-fab:disabled {
      opacity: 0.4;
    }

    .quick-capture-fab.fab-recording {
      background: rgba(220, 38, 38, 0.85);
      border-color: rgba(248, 113, 113, 0.4);
      box-shadow: 0 0 0 4px rgba(220, 38, 38, 0.2), 0 8px 24px -8px rgba(0, 0, 0, 0.5);
      animation: fab-breathe 1.5s ease-in-out infinite;
    }

    .quick-capture-fab.fab-recording.fab-out-of-zone {
      background: rgba(82, 82, 91, 0.7);
      border-color: rgba(255, 255, 255, 0.08);
      box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.5);
      animation: none;
      opacity: 0.6;
    }

    .quick-capture-fab.fab-transcribing {
      background: rgba(24, 24, 27, 0.92);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .fab-icon {
      font-size: 1.5rem;
      font-weight: 300;
      line-height: 1;
    }

    .fab-pulse {
      width: 14px;
      height: 14px;
      border-radius: 9999px;
      background: white;
    }

    .fab-spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.25);
      border-top-color: rgba(255, 255, 255, 0.9);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }

    .fab-hint {
      position: absolute;
      right: 0;
      bottom: -4.6rem;
      white-space: nowrap;
      font-size: 0.7rem;
      color: rgba(255, 255, 255, 0.5);
      letter-spacing: 0.02em;
      z-index: 4;
      pointer-events: none;
    }

    @keyframes fab-breathe {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.06); }
    }

    .quick-capture-mask {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      z-index: 90;
    }

    .quick-capture-panel {
      position: fixed;
      right: 1rem;
      bottom: 1rem;
      width: min(420px, calc(100vw - 2rem));
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(24, 24, 27, 0.96);
      box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.7);
      padding: 0.85rem;
      z-index: 91;
      color: rgba(255, 255, 255, 0.9);
      animation: panel-up 220ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    @keyframes panel-up {
      from {
        opacity: 0;
        transform: translateY(14px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.6rem;
    }

    .panel-header h3 {
      margin: 0;
      font-size: 0.87rem;
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    .panel-close {
      border: none;
      background: transparent;
      color: rgba(255, 255, 255, 0.6);
      font-size: 0.78rem;
      cursor: pointer;
    }

    .transcription-editor {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 0.5rem;
      margin-bottom: 0.55rem;
      background: rgba(0, 0, 0, 0.25);
    }

    .transcription-input,
    .capture-input {
      width: 100%;
      resize: none;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.2);
      color: rgba(255, 255, 255, 0.92);
      padding: 0.55rem;
      font-size: 0.82rem;
      line-height: 1.45;
      box-sizing: border-box;
      font-family: inherit;
    }

    .transcription-input:focus,
    .capture-input:focus {
      outline: 1px solid rgba(255, 255, 255, 0.2);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .transcription-actions {
      margin-top: 0.45rem;
      display: flex;
      justify-content: flex-end;
      gap: 0.45rem;
    }

    .capture-input-row {
      display: flex;
      gap: 0.55rem;
      align-items: stretch;
      margin-bottom: 0.65rem;
    }

    .record-btn {
      width: 42px;
      min-width: 42px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.85);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background-color 160ms ease, opacity 160ms ease;
      touch-action: none;
    }

    .record-btn.recording {
      background: rgba(220, 38, 38, 0.82);
    }

    .record-btn.out-of-zone {
      opacity: 0.58;
    }

    .record-stop {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      background: white;
    }

    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(245, 245, 244, 0.38);
      border-top-color: rgba(245, 245, 244, 1);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .panel-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.65rem;
    }

    .hint {
      font-size: 0.72rem;
      color: rgba(255, 255, 255, 0.45);
      line-height: 1.35;
    }

    .ghost-btn,
    .solid-btn {
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 0.35rem 0.62rem;
      font-size: 0.76rem;
      cursor: pointer;
    }

    .ghost-btn {
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.8);
    }

    .solid-btn {
      background: rgba(255, 255, 255, 0.9);
      color: rgba(9, 9, 11, 0.95);
      font-weight: 700;
    }

    .solid-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    @media (max-width: 640px) {
      .quick-capture-fab {
        right: 0;
        width: 52px;
        height: 52px;
      }

      .action-btn {
        min-width: 118px;
      }

      .quick-capture-panel {
        right: 0.75rem;
        left: 0.75rem;
        width: auto;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GateActionsComponent implements OnDestroy {
  gateService = inject(GateService);
  toast = inject(ToastService);
  blackBoxService = inject(BlackBoxService);
  speechService = inject(SpeechToTextService);
  logger = inject(LoggerService);

  /** 动画处理中状态 - 禁用操作按钮 */
  isProcessing(): boolean {
    try {
      return this.gateService.cardAnimation() !== 'idle';
    } catch {
      return false;
    }
  }

  quickCaptureOpen = signal(false);

  quickInputText = signal('');

  isRecording = this.speechService.isRecording;
  isTranscribing = this.speechService.isTranscribing;

  speechSupported = signal(this.speechService.isSupported());
  readonly isDevMode = isDevMode();

  isOutOfZone = signal(false);
  pendingTranscription = signal('');
  editableTranscription = '';

  /** FAB 按钮上的录音状态 */
  isFabRecording = signal(false);
  isFabOutOfZone = signal(false);
  isFabTranscribing = signal(false);

  private globalCleanups: (() => void)[] = [];

  /** 长按定时器 */
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  /** 长按是否已触发（用于区分短按 vs 长按） */
  private longPressTriggered = false;
  /** 长按检测阈值（ms） */
  private static readonly LONG_PRESS_DELAY = 350;
  /** FAB 录音区域容差（px） */
  private static readonly FAB_ZONE_TOLERANCE = 60;

  readonly recordBtn = viewChild<ElementRef<HTMLElement>>('recordBtn');
  readonly captureFab = viewChild<ElementRef<HTMLElement>>('captureFab');

  ngOnDestroy(): void {
    this.clearLongPressTimer();
    this.removeGlobalListeners();
  }

  markAsRead(): void {
    this.gateService.markAsRead();
  }

  markAsCompleted(): void {
    this.gateService.markAsCompleted();
  }

  toggleQuickCapture(): void {
    this.quickCaptureOpen.update(open => !open);
  }

  closeQuickCapture(): void {
    this.quickCaptureOpen.set(false);
    this.removeGlobalListeners();
    this.isOutOfZone.set(false);
  }

  // ─── FAB 长按录音逻辑 ───

  /** 鼠标按下 FAB：启动长按检测 */
  onFabMouseDown(event: MouseEvent): void {
    event.preventDefault();
    if (this.isFabTranscribing()) return;

    this.longPressTriggered = false;

    this.longPressTimer = setTimeout(() => {
      this.longPressTriggered = true;
      this.startFabRecording();
    }, GateActionsComponent.LONG_PRESS_DELAY);

    const onMouseMove = (e: MouseEvent) => {
      if (this.isFabRecording()) {
        this.checkFabZone(e.clientX, e.clientY);
      }
    };
    const onMouseUp = () => {
      this.clearLongPressTimer();
      if (this.isFabRecording()) {
        this.stopFabRecording();
      } else if (!this.longPressTriggered) {
        // 短按 → 切换面板
        this.toggleQuickCapture();
      }
      this.removeFabListeners();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    this.globalCleanups.push(
      () => document.removeEventListener('mousemove', onMouseMove),
      () => document.removeEventListener('mouseup', onMouseUp)
    );
  }

  /** 触摸按下 FAB：启动长按检测 */
  onFabTouchStart(event: TouchEvent): void {
    event.preventDefault();
    if (this.isFabTranscribing()) return;

    this.longPressTriggered = false;

    this.longPressTimer = setTimeout(() => {
      this.longPressTriggered = true;
      this.startFabRecording();
    }, GateActionsComponent.LONG_PRESS_DELAY);

    const onTouchMove = (e: TouchEvent) => {
      if (this.isFabRecording() && e.touches.length > 0) {
        this.checkFabZone(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchEnd = () => {
      this.clearLongPressTimer();
      if (this.isFabRecording()) {
        this.stopFabRecording();
      } else if (!this.longPressTriggered) {
        this.toggleQuickCapture();
      }
      this.removeFabListeners();
    };

    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);

    this.globalCleanups.push(
      () => document.removeEventListener('touchmove', onTouchMove),
      () => document.removeEventListener('touchend', onTouchEnd),
      () => document.removeEventListener('touchcancel', onTouchEnd)
    );
  }

  /** 在 FAB 上开始录音 */
  private startFabRecording(): void {
    if (!this.speechService.isSupported()) {
      // DEV mock
      const mockTexts = GateActionsComponent.DEV_MOCK_TRANSCRIPTIONS;
      const mockText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
      this.isFabRecording.set(false);
      this.pendingTranscription.set(mockText);
      this.editableTranscription = mockText;
      this.quickCaptureOpen.set(true);
      return;
    }

    this.isFabRecording.set(true);
    this.isFabOutOfZone.set(false);

    void this.speechService.startRecording().catch(err => {
      this.logger.error('GateActions', 'FAB recording failed to start', err);
      this.toast.error('无法启动录音');
      this.isFabRecording.set(false);
    });
  }

  /** 检查指针是否仍在 FAB 按钮区域内 */
  private checkFabZone(clientX: number, clientY: number): void {
    const fab = this.captureFab()?.nativeElement;
    if (!fab) return;

    const rect = fab.getBoundingClientRect();
    const tolerance = GateActionsComponent.FAB_ZONE_TOLERANCE;
    const inZone =
      clientX >= rect.left - tolerance &&
      clientX <= rect.right + tolerance &&
      clientY >= rect.top - tolerance &&
      clientY <= rect.bottom + tolerance;

    this.isFabOutOfZone.set(!inZone);
  }

  /** 松开 FAB：根据是否在区域内决定转写或取消 */
  private stopFabRecording(): void {
    const outOfZone = this.isFabOutOfZone();
    this.isFabRecording.set(false);
    this.isFabOutOfZone.set(false);

    if (outOfZone) {
      this.speechService.cancelRecording();
      this.logger.debug('GateActions', 'FAB recording cancelled: pointer left zone');
      return;
    }

    // 正常结束 → 转写
    this.isFabTranscribing.set(true);
    void this.doFabTranscribe();
  }

  /** FAB 录音转写 → 结果写入面板 */
  private async doFabTranscribe(): Promise<void> {
    try {
      const text = await this.speechService.stopAndTranscribe();
      if (text && text.trim()) {
        this.pendingTranscription.set(text);
        this.editableTranscription = text;
        this.quickCaptureOpen.set(true);
      }
    } catch (err) {
      this.logger.error('GateActions', 'FAB transcription failed', err instanceof Error ? err.message : String(err));
    } finally {
      this.isFabTranscribing.set(false);
    }
  }

  private clearLongPressTimer(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private removeFabListeners(): void {
    this.removeGlobalListeners();
  }

  // ─── 面板内录音逻辑（保留原有） ───

  async submitQuickInput(): Promise<void> {
    const text = this.quickInputText().trim();
    if (!text) return;

    const result = this.blackBoxService.create({ content: text });

    if (result.ok) {
      this.logger.info('GateActions', 'Quick input submitted');
      this.quickInputText.set('');
      this.toast.success('已记录');
      return;
    }

    this.logger.error('GateActions', 'Failed to submit quick input', result.error.message);
    this.toast.error(result.error.message || '记录失败');
  }

  confirmPendingTranscription(): void {
    const text = this.editableTranscription.trim();
    if (text) {
      const current = this.quickInputText();
      this.quickInputText.set(current ? `${current} ${text}` : text);
    }
    this.pendingTranscription.set('');
    this.editableTranscription = '';
  }

  cancelPendingTranscription(): void {
    this.pendingTranscription.set('');
    this.editableTranscription = '';
  }

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
    void this.doTranscribe();
  }

  private static readonly DEV_MOCK_TRANSCRIPTIONS = [
    '把今天没收尾的任务补到黑匣子，明天大门统一结算。',
    '需要先修同步冲突，再看性能报警。',
    '用户反馈入口动效过快，降低抖动幅度。',
  ];

  private doStartRecording(): void {
    if (!this.speechService.isSupported()) {
      const mockTexts = GateActionsComponent.DEV_MOCK_TRANSCRIPTIONS;
      const mockText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
      this.pendingTranscription.set(mockText);
      this.editableTranscription = mockText;
      return;
    }

    this.isOutOfZone.set(false);
    void this.speechService.startRecording().catch(err => {
      this.logger.error('GateActions', 'Failed to start recording', err);
      this.toast.error('无法启动录音');
    });
  }

  private checkInRecordZone(clientX: number, clientY: number): void {
    if (!this.isRecording()) return;

    const btn = this.recordBtn()?.nativeElement;
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    const tolerance = 40;
    const inZone =
      clientX >= rect.left - tolerance &&
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
      return;
    }

    void this.doTranscribe();
  }

  private async doTranscribe(): Promise<void> {
    this.removeGlobalListeners();

    try {
      const text = await this.speechService.stopAndTranscribe();
      if (text && text.trim()) {
        this.pendingTranscription.set(text);
        this.editableTranscription = text;
      }
    } catch (err) {
      this.logger.error('GateActions', 'Transcription failed', err instanceof Error ? err.message : String(err));
    }
  }

  private removeGlobalListeners(): void {
    for (const cleanup of this.globalCleanups) {
      cleanup();
    }
    this.globalCleanups = [];
  }
}
