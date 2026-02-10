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
    <section class="gate-actions">
      <div class="gate-actions__panel">
        <div class="gate-actions__buttons" role="group" aria-label="大门处理操作">
          <!-- 已读 -->
          <button
            data-testid="gate-read-button"
            class="gate-action-btn gate-action-btn--read"
            [disabled]="isProcessing()"
            (click)="markAsRead()">
            <span class="gate-action-btn__glyph" aria-hidden="true">◌</span>
            <span class="gate-action-btn__text">已读</span>
            <span class="gate-action-btn__sub">知晓不处理</span>
          </button>

          <!-- 完成 -->
          <button
            data-testid="gate-complete-button"
            class="gate-action-btn gate-action-btn--complete"
            [disabled]="isProcessing()"
            (click)="markAsCompleted()">
            <span class="gate-action-btn__glyph" aria-hidden="true">✓</span>
            <span class="gate-action-btn__text">完成</span>
            <span class="gate-action-btn__sub">立即结项</span>
          </button>
        </div>

        <div class="gate-actions__quick">
          <div class="gate-actions__quick-head">
            <span class="gate-actions__quick-title">快速记录</span>
            <span class="gate-actions__quick-hint">支持键盘回车与按住录音</span>
          </div>

          <div class="gate-actions__quick-row">
            <input
              type="text"
              class="gate-actions__input"
              placeholder="记录一个想法..."
              [(ngModel)]="quickInputText"
              [disabled]="isRecording() || isTranscribing()"
              (keydown.enter)="submitQuickInput()"
            />

            @if (speechSupported()) {
              <button
                class="gate-actions__mic"
                [class.gate-actions__mic--recording]="isRecording()"
                [class.gate-actions__mic--transcribing]="isTranscribing()"
                [disabled]="isTranscribing()"
                [attr.aria-label]="isRecording() ? '松开停止录音' : isTranscribing() ? '正在转写' : '按住开始录音'"
                (mousedown)="startRecording($event)"
                (mouseup)="stopRecording()"
                (mouseleave)="stopRecording()"
                (touchstart)="startRecording($event)"
                (touchend)="stopRecording()"
                (keydown.space)="startRecording($event)"
                (keyup.space)="stopRecording()">
                @if (isTranscribing()) {
                  <span class="gate-actions__mic-spinner" aria-hidden="true"></span>
                } @else if (isRecording()) {
                  <span class="gate-actions__mic-dot" aria-hidden="true"></span>
                } @else {
                  <span class="gate-actions__mic-icon" aria-hidden="true">◎</span>
                }
              </button>
            }
          </div>

          @if (quickInputText() || isRecording() || isTranscribing()) {
            <p class="gate-actions__helper">
              @if (isTranscribing()) {
                正在转写语音...
              } @else if (isRecording()) {
                松开即可停止录音
              } @else {
                按回车快速写入黑匣子
              }
            </p>
          }
        </div>
      </div>
    </section>
  `,
  styles: [`
    .gate-actions {
      width: 100%;
      font-family: "Avenir Next", "Noto Sans SC", "PingFang SC", sans-serif;
    }

    .gate-actions__panel {
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.11);
      background: linear-gradient(150deg, rgba(17, 20, 19, 0.82) 0%, rgba(24, 22, 18, 0.8) 100%);
      padding: 16px;
      backdrop-filter: blur(14px);
      box-shadow:
        0 18px 40px rgba(0, 0, 0, 0.28),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }

    .gate-actions__buttons {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .gate-action-btn {
      position: relative;
      overflow: hidden;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.11);
      min-height: 112px;
      padding: 14px 10px 12px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition:
        transform 0.18s ease,
        border-color 0.2s ease,
        background-color 0.2s ease,
        box-shadow 0.25s ease,
        color 0.2s ease;
      cursor: pointer;
      color: rgba(237, 241, 236, 0.84);
      background: rgba(255, 255, 255, 0.03);
    }

    .gate-action-btn::before {
      content: '';
      position: absolute;
      inset: -30% 15% auto;
      height: 60%;
      background: radial-gradient(closest-side, rgba(255, 255, 255, 0.14), rgba(255, 255, 255, 0));
      pointer-events: none;
      opacity: 0.4;
    }

    .gate-action-btn:hover:not(:disabled) {
      transform: translateY(-2px);
      border-color: rgba(255, 255, 255, 0.22);
    }

    .gate-action-btn:active:not(:disabled) {
      transform: translateY(0) scale(0.97);
    }

    .gate-action-btn:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px rgba(246, 187, 122, 0.28);
    }

    .gate-action-btn:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }

    .gate-action-btn__glyph {
      font-size: 1.45rem;
      line-height: 1;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .gate-action-btn__text {
      font-size: 0.84rem;
      line-height: 1.1;
      font-weight: 700;
      letter-spacing: 0.03em;
    }

    .gate-action-btn__sub {
      font-size: 0.68rem;
      line-height: 1.2;
      color: rgba(237, 241, 236, 0.56);
      letter-spacing: 0.02em;
      text-align: center;
    }

    .gate-action-btn--read {
      background: linear-gradient(155deg, rgba(53, 67, 83, 0.25), rgba(28, 35, 47, 0.28));
      border-color: rgba(119, 150, 190, 0.2);
    }

    .gate-action-btn--read:hover:not(:disabled) {
      box-shadow: 0 10px 22px rgba(52, 83, 114, 0.25);
      color: rgba(225, 239, 255, 0.96);
    }

    .gate-action-btn--complete {
      background: linear-gradient(160deg, rgba(231, 236, 227, 0.95), rgba(211, 219, 206, 0.92));
      border-color: rgba(255, 255, 255, 0.55);
      color: rgba(26, 36, 31, 0.9);
    }

    .gate-action-btn--complete .gate-action-btn__sub {
      color: rgba(31, 41, 55, 0.48);
    }

    .gate-action-btn--complete:hover:not(:disabled) {
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.18);
      color: rgba(16, 24, 18, 0.96);
    }

    .gate-actions__quick {
      margin-top: 12px;
      border-radius: 18px;
      border: 1px solid rgba(255, 255, 255, 0.11);
      background: rgba(7, 9, 10, 0.38);
      padding: 12px;
    }

    .gate-actions__quick-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }

    .gate-actions__quick-title {
      font-size: 0.78rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: rgba(244, 247, 243, 0.82);
      font-weight: 700;
    }

    .gate-actions__quick-hint {
      font-size: 0.68rem;
      color: rgba(244, 247, 243, 0.5);
    }

    .gate-actions__quick-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .gate-actions__input {
      width: 100%;
      flex: 1;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.08);
      color: rgba(244, 247, 243, 0.92);
      font-size: 0.9rem;
      line-height: 1.2;
      padding: 11px 12px;
      outline: none;
      transition: border-color 0.2s ease, background-color 0.2s ease;
    }

    .gate-actions__input::placeholder {
      color: rgba(244, 247, 243, 0.42);
    }

    .gate-actions__input:focus {
      border-color: rgba(248, 188, 120, 0.55);
      background: rgba(255, 255, 255, 0.12);
    }

    .gate-actions__input:disabled {
      opacity: 0.66;
      cursor: not-allowed;
    }

    .gate-actions__mic {
      width: 42px;
      height: 42px;
      border-radius: 9999px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.07);
      color: rgba(244, 247, 243, 0.92);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      transition: all 0.18s ease;
    }

    .gate-actions__mic:hover:not(:disabled) {
      border-color: rgba(248, 188, 120, 0.44);
      transform: translateY(-1px);
      background: rgba(255, 255, 255, 0.12);
    }

    .gate-actions__mic:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px rgba(246, 187, 122, 0.25);
    }

    .gate-actions__mic:disabled {
      opacity: 0.75;
      cursor: wait;
    }

    .gate-actions__mic--recording {
      border-color: rgba(254, 133, 133, 0.45);
      background: rgba(127, 29, 29, 0.5);
      box-shadow: 0 0 0 6px rgba(239, 68, 68, 0.15);
      animation: gate-mic-pulse 1.2s ease-in-out infinite;
    }

    .gate-actions__mic--transcribing {
      border-color: rgba(129, 140, 248, 0.45);
      background: rgba(67, 56, 202, 0.34);
    }

    .gate-actions__mic-icon {
      font-size: 1.05rem;
      line-height: 1;
    }

    .gate-actions__mic-dot {
      width: 9px;
      height: 9px;
      border-radius: 9999px;
      background: #fecaca;
      box-shadow: 0 0 0 5px rgba(239, 68, 68, 0.18);
    }

    .gate-actions__mic-spinner {
      width: 15px;
      height: 15px;
      border-radius: 9999px;
      border: 2px solid rgba(255, 255, 255, 0.22);
      border-top-color: rgba(255, 255, 255, 0.9);
      animation: gate-spin 0.9s linear infinite;
    }

    .gate-actions__helper {
      margin-top: 8px;
      font-size: 0.72rem;
      color: rgba(244, 247, 243, 0.62);
      letter-spacing: 0.01em;
    }

    :host-context(.gate-theme--paper) .gate-actions {
      font-family: "IBM Plex Sans", "Noto Sans SC", "PingFang SC", sans-serif;
    }

    :host-context(.gate-theme--paper) .gate-actions__panel {
      border-color: rgba(145, 116, 75, 0.24);
      background: linear-gradient(162deg, rgba(243, 235, 216, 0.9) 0%, rgba(236, 224, 197, 0.88) 100%);
      box-shadow:
        0 18px 42px rgba(115, 86, 46, 0.17),
        inset 0 1px 0 rgba(255, 255, 255, 0.86);
    }

    :host-context(.gate-theme--paper) .gate-action-btn {
      color: rgba(69, 52, 30, 0.86);
      border-color: rgba(135, 102, 59, 0.2);
      background: rgba(255, 255, 255, 0.46);
    }

    :host-context(.gate-theme--paper) .gate-action-btn::before {
      background: radial-gradient(closest-side, rgba(172, 134, 84, 0.2), rgba(172, 134, 84, 0));
      opacity: 0.52;
    }

    :host-context(.gate-theme--paper) .gate-action-btn__sub {
      color: rgba(88, 67, 41, 0.62);
    }

    :host-context(.gate-theme--paper) .gate-action-btn--read {
      background: linear-gradient(158deg, rgba(220, 229, 236, 0.7), rgba(209, 220, 230, 0.66));
      border-color: rgba(96, 121, 151, 0.24);
    }

    :host-context(.gate-theme--paper) .gate-action-btn--read:hover:not(:disabled) {
      box-shadow: 0 10px 22px rgba(78, 108, 138, 0.19);
      color: rgba(44, 64, 84, 0.95);
    }

    :host-context(.gate-theme--paper) .gate-action-btn--complete {
      background: linear-gradient(160deg, rgba(248, 245, 234, 0.96), rgba(236, 228, 208, 0.92));
      border-color: rgba(149, 115, 72, 0.3);
      color: rgba(53, 43, 28, 0.9);
    }

    :host-context(.gate-theme--paper) .gate-action-btn--complete .gate-action-btn__sub {
      color: rgba(95, 75, 48, 0.58);
    }

    :host-context(.gate-theme--paper) .gate-action-btn--complete:hover:not(:disabled) {
      box-shadow: 0 12px 24px rgba(115, 86, 46, 0.17);
      color: rgba(43, 33, 20, 0.98);
    }

    :host-context(.gate-theme--paper) .gate-actions__quick {
      border-color: rgba(145, 116, 75, 0.22);
      background: rgba(255, 253, 248, 0.58);
    }

    :host-context(.gate-theme--paper) .gate-actions__quick-title {
      color: rgba(80, 61, 36, 0.86);
    }

    :host-context(.gate-theme--paper) .gate-actions__quick-hint {
      color: rgba(90, 70, 43, 0.58);
    }

    :host-context(.gate-theme--paper) .gate-actions__input {
      border-color: rgba(145, 116, 75, 0.22);
      background: rgba(255, 255, 255, 0.76);
      color: rgba(54, 40, 24, 0.9);
    }

    :host-context(.gate-theme--paper) .gate-actions__input::placeholder {
      color: rgba(96, 74, 46, 0.48);
    }

    :host-context(.gate-theme--paper) .gate-actions__input:focus {
      border-color: rgba(185, 133, 72, 0.6);
      background: rgba(255, 255, 255, 0.88);
    }

    :host-context(.gate-theme--paper) .gate-actions__mic {
      border-color: rgba(145, 116, 75, 0.24);
      background: rgba(255, 255, 255, 0.72);
      color: rgba(69, 52, 30, 0.85);
    }

    :host-context(.gate-theme--paper) .gate-actions__mic:hover:not(:disabled) {
      border-color: rgba(185, 133, 72, 0.52);
      background: rgba(255, 255, 255, 0.9);
    }

    :host-context(.gate-theme--paper) .gate-actions__mic--recording {
      border-color: rgba(221, 108, 108, 0.45);
      background: rgba(203, 75, 75, 0.2);
      box-shadow: 0 0 0 6px rgba(203, 75, 75, 0.14);
    }

    :host-context(.gate-theme--paper) .gate-actions__mic--transcribing {
      border-color: rgba(107, 115, 210, 0.4);
      background: rgba(107, 115, 210, 0.2);
    }

    :host-context(.gate-theme--paper) .gate-actions__helper {
      color: rgba(86, 67, 40, 0.66);
    }

    @keyframes gate-mic-pulse {
      0%,
      100% {
        transform: scale(1);
      }
      50% {
        transform: scale(1.06);
      }
    }

    @keyframes gate-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    @media (max-width: 640px) {
      .gate-actions__panel {
        padding: 12px;
        border-radius: 20px;
      }

      .gate-actions__buttons {
        gap: 8px;
      }

      .gate-action-btn {
        min-height: 102px;
        border-radius: 15px;
      }

      .gate-action-btn__glyph {
        font-size: 1.3rem;
      }

      .gate-action-btn__text {
        font-size: 0.8rem;
      }

      .gate-action-btn__sub {
        font-size: 0.64rem;
      }

      .gate-actions__quick-head {
        flex-direction: column;
        align-items: flex-start;
        margin-bottom: 8px;
      }

      .gate-actions__quick-hint {
        font-size: 0.64rem;
      }

      .gate-actions__helper {
        font-size: 0.68rem;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GateActionsComponent {
  private gateService = inject(GateService);
  private toast = inject(ToastService);
  private blackBoxService = inject(BlackBoxService);
  private speechService = inject(SpeechToTextService);
  private readonly logger = inject(LoggerService);

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
      this.logger.error('GateActions', '语音转写失败', error);
      this.toast.error('语音转写失败', '请重试或手动输入');
    }
  }
}
