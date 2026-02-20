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
          <span class="action-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
          </span>
          <span class="action-label">已读</span>
        </button>

        <button
          data-testid="gate-complete-button"
          class="action-btn action-complete"
          [disabled]="isProcessing()"
          (click)="markAsCompleted()">
          <span class="action-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
          </span>
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
          <span class="fab-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          </span>
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
      min-width: 150px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 9999px;
      padding: 0.9rem 1.8rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 100%);
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.15), 
        inset 0 -1px 1px rgba(0, 0, 0, 0.2),
        0 8px 20px -4px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      color: rgba(255, 255, 255, 0.95);
      transition: all 300ms cubic-bezier(0.25, 0.8, 0.25, 1);
      font-size: 0.95rem;
      font-weight: 400;
      letter-spacing: 0.06em;
      cursor: pointer;
    }

    .action-btn:hover:not(:disabled) {
      transform: translateY(-3px);
      border-color: rgba(255, 255, 255, 0.2);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.05) 100%);
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.25), 
        inset 0 -1px 1px rgba(0, 0, 0, 0.2),
        0 12px 28px -6px rgba(0, 0, 0, 0.5);
    }

    .action-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: 
        inset 0 1px 2px rgba(0, 0, 0, 0.2),
        0 4px 12px -4px rgba(0, 0, 0, 0.3);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.02) 100%);
    }

    .action-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .action-complete {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.05) 100%);
      border-color: rgba(255, 255, 255, 0.18);
    }

    .action-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.85;
    }

    .fab-icon {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .quick-capture-fab {
      position: absolute;
      right: 0;
      bottom: -3.5rem;
      width: 64px;
      height: 64px;
      border-radius: 9999px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: linear-gradient(135deg, rgba(45, 45, 50, 0.9) 0%, rgba(24, 24, 27, 0.95) 100%);
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.2), 
        inset 0 -1px 1px rgba(0, 0, 0, 0.4),
        0 12px 32px -8px rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      color: rgba(255, 255, 255, 0.95);
      transition: all 300ms cubic-bezier(0.25, 0.8, 0.25, 1);
      z-index: 4;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }

    .quick-capture-fab:hover:not(:disabled):not(.fab-recording) {
      transform: translateY(-4px) scale(1.04);
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.3), 
        0 16px 40px -8px rgba(0, 0, 0, 0.8);
      border-color: rgba(255, 255, 255, 0.3);
      background: linear-gradient(135deg, rgba(55, 55, 60, 0.95) 0%, rgba(30, 30, 35, 0.98) 100%);
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
      display: flex;
      align-items: center;
      justify-content: center;
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
      right: 1.5rem;
      bottom: 1.5rem;
      width: min(440px, calc(100vw - 3rem));
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: linear-gradient(180deg, rgba(45, 45, 50, 0.85) 0%, rgba(24, 24, 27, 0.95) 100%);
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.15), 
        0 32px 64px -16px rgba(0, 0, 0, 0.9);
      backdrop-filter: blur(32px);
      -webkit-backdrop-filter: blur(32px);
      padding: 1.25rem;
      z-index: 91;
      color: rgba(255, 255, 255, 0.95);
      animation: panel-up 400ms cubic-bezier(0.175, 0.885, 0.32, 1.1);
    }

    @keyframes panel-up {
      from {
        opacity: 0;
        transform: translateY(20px) scale(0.95);
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
      margin-bottom: 0.8rem;
    }

    .panel-header h3 {
      margin: 0;
      font-size: 0.9rem;
      font-weight: 500;
      letter-spacing: 0.04em;
    }

    .panel-close {
      border: none;
      background: transparent;
      color: rgba(255, 255, 255, 0.5);
      font-size: 0.8rem;
      cursor: pointer;
      transition: color 200ms ease;
    }

    .panel-close:hover {
      color: rgba(255, 255, 255, 0.9);
    }

    .transcription-editor {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 0.6rem;
      margin-bottom: 0.6rem;
      background: rgba(0, 0, 0, 0.2);
      box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.2);
    }

    .transcription-input,
    .capture-input {
      width: 100%;
      resize: none;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.25);
      color: rgba(255, 255, 255, 0.95);
      padding: 0.7rem;
      font-size: 0.85rem;
      line-height: 1.5;
      box-sizing: border-box;
      font-family: inherit;
      box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.2);
      transition: border-color 200ms ease, box-shadow 200ms ease;
    }

    .transcription-input:focus,
    .capture-input:focus {
      outline: none;
      border-color: rgba(255, 255, 255, 0.25);
      box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.2), 0 0 0 2px rgba(255, 255, 255, 0.05);
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
      width: 48px;
      min-width: 48px;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.03) 100%);
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.15), 
        0 4px 12px -2px rgba(0, 0, 0, 0.3);
      color: rgba(255, 255, 255, 0.9);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 250ms cubic-bezier(0.25, 0.8, 0.25, 1);
      touch-action: none;
    }

    .record-btn:hover:not(:disabled) {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.15) 0%, rgba(255, 255, 255, 0.05) 100%);
      border-color: rgba(255, 255, 255, 0.2);
      box-shadow: 
        inset 0 1px 1px rgba(255, 255, 255, 0.25), 
        0 6px 16px -2px rgba(0, 0, 0, 0.4);
      transform: translateY(-2px);
    }

    .record-btn.recording {
      background: linear-gradient(180deg, rgba(239, 68, 68, 0.9) 0%, rgba(220, 38, 38, 0.95) 100%);
      border-color: rgba(248, 113, 113, 0.5);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 4px 16px rgba(220, 38, 38, 0.4);
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
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 0.5rem 1rem;
      font-size: 0.85rem;
      cursor: pointer;
      transition: all 250ms cubic-bezier(0.25, 0.8, 0.25, 1);
      letter-spacing: 0.04em;
    }

    .ghost-btn {
      background: transparent;
      color: rgba(255, 255, 255, 0.7);
      border-color: transparent;
    }

    .ghost-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.95);
    }

    .solid-btn {
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.85) 100%);
      color: rgba(9, 9, 11, 0.95);
      font-weight: 500;
      border-color: transparent;
      box-shadow: 0 2px 8px rgba(255, 255, 255, 0.15);
    }

    .solid-btn:hover:not(:disabled) {
      background: linear-gradient(180deg, #fff 0%, rgba(255, 255, 255, 0.9) 100%);
      box-shadow: 0 4px 16px rgba(255, 255, 255, 0.25);
      transform: translateY(-2px);
    }

    .solid-btn:active:not(:disabled) {
      transform: translateY(1px);
      box-shadow: 0 2px 4px rgba(255, 255, 255, 0.1);
    }

    .solid-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      box-shadow: none;
      transform: none;
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
