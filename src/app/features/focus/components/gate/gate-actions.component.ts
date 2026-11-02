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
  templateUrl: './gate-actions.component.html',
  styleUrl: './gate-actions.component.css',
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
    return this.gateService.cardAnimation() !== 'idle';
  }

  quickCaptureOpen = signal(false);

  quickInputText = signal('');
  manualQuickCaptureFallback = signal(false);

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

  private isDestroyed = false;
  private globalCleanups: (() => void)[] = [];
  private readonly recordingOwnerToken = Symbol('GateActionsComponent');
  private fabPressActive = false;
  private fabStartPending = false;
  private fabOwnsRecording = false;
  private fabStartRequestId = 0;
  private recordPressActive = false;
  private recordStartPending = false;
  private recordOwnsRecording = false;
  private recordStartRequestId = 0;
  private transcriptionGeneration = 0;

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
    if (this.isDestroyed) return;
    const shouldCancelRecording =
      this.fabStartPending ||
      this.fabOwnsRecording ||
      this.recordStartPending ||
      this.recordOwnsRecording;
    this.isDestroyed = true;
    this.fabPressActive = false;
    this.fabStartPending = false;
    this.fabOwnsRecording = false;
    this.fabStartRequestId += 1;
    this.recordPressActive = false;
    this.recordStartPending = false;
    this.recordOwnsRecording = false;
    this.recordStartRequestId += 1;
    this.transcriptionGeneration += 1;
    this.clearLongPressTimer();
    this.removeGlobalListeners();
    if (shouldCancelRecording) {
      this.speechService.cancelRecording(this.recordingOwnerToken);
    }
    this.isFabRecording.set(false);
    this.isFabOutOfZone.set(false);
    this.isFabTranscribing.set(false);
  }

  markAsRead(): void {
    this.gateService.markAsRead();
  }

  markAsCompleted(): void {
    this.gateService.markAsCompleted();
  }

  toggleQuickCapture(): void {
    const nextOpen = !this.quickCaptureOpen();
    this.quickCaptureOpen.set(nextOpen);
    this.manualQuickCaptureFallback.set(nextOpen && !this.speechService.isSupported());
  }

  closeQuickCapture(): void {
    this.quickCaptureOpen.set(false);
    this.manualQuickCaptureFallback.set(false);
    this.removeGlobalListeners();
    this.isOutOfZone.set(false);
  }

  // ─── FAB 长按录音逻辑 ───

  /** 鼠标按下 FAB：启动长按检测 */
  onFabMouseDown(event: MouseEvent): void {
    event.preventDefault();
    if (this.isDestroyed) return;
    if (this.isFabTranscribing() || this.isTranscribing()) return;

    if (!this.speechService.isSupported()) {
      this.toggleQuickCapture();
      return;
    }
    if (this.fabPressActive) return;

    this.fabPressActive = true;
    this.longPressTriggered = false;
    // 【修复 P4-02】清除上一次定时器，防止快速双击产生两个定时器
    this.clearLongPressTimer();

    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (!this.fabPressActive || this.isDestroyed) return;
      this.longPressTriggered = true;
      this.startFabRecording();
    }, GateActionsComponent.LONG_PRESS_DELAY);

    const onMouseMove = (e: MouseEvent) => {
      if (this.isFabRecording()) {
        this.checkFabZone(e.clientX, e.clientY);
      }
    };
    const onMouseUp = () => {
      this.finishFabPress(false, 'pointer released before recording started');
      // 【2026-04-23 倒置】短按不再打开面板；面板仅在转写成功后才自动出现。
      // 若用户误触短按（未达长按阈值），什么也不做，保持桌面清爽。
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
    if (this.isDestroyed) return;
    if (this.isFabTranscribing() || this.isTranscribing()) return;

    if (!this.speechService.isSupported()) {
      this.toggleQuickCapture();
      return;
    }
    if (this.fabPressActive) return;

    this.fabPressActive = true;
    this.longPressTriggered = false;
    // 【修复 P4-02】清除上一次定时器，防止快速双击产生两个定时器
    this.clearLongPressTimer();

    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (!this.fabPressActive || this.isDestroyed) return;
      this.longPressTriggered = true;
      this.startFabRecording();
    }, GateActionsComponent.LONG_PRESS_DELAY);

    const onTouchMove = (e: TouchEvent) => {
      if (this.isFabRecording() && e.touches.length > 0) {
        this.checkFabZone(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchEnd = () => {
      this.finishFabPress(false, 'touch released before recording started');
      // 【2026-04-23 倒置】短按不再打开面板（详见 mousedown 分支注释）。
      this.removeFabListeners();
    };
    const onTouchCancel = () => {
      this.finishFabPress(true, 'touch cancelled');
      this.removeFabListeners();
    };

    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchCancel);

    this.globalCleanups.push(
      () => document.removeEventListener('touchmove', onTouchMove),
      () => document.removeEventListener('touchend', onTouchEnd),
      () => document.removeEventListener('touchcancel', onTouchCancel)
    );
  }

  /** 在 FAB 上开始录音 */
  private startFabRecording(): void {
    if (this.isDestroyed) return;
    if (!this.prepareFabRecordingSupport()) return;

    this.beginRecordingSession();
    this.isFabRecording.set(true);
    this.isFabOutOfZone.set(false);
    const requestId = ++this.fabStartRequestId;
    this.fabStartPending = true;

    void this.speechService.startRecording(this.recordingOwnerToken)
      .then(started => {
        if (!this.isFabStartRequestCurrent(requestId)) {
          return;
        }
        this.fabStartPending = false;
        if (started === false) {
          this.fabOwnsRecording = false;
          this.isFabRecording.set(false);
          this.isFabOutOfZone.set(false);
          if (this.isRecording()) return;
          this.logger.warn('GateActions', 'FAB recording unavailable, fallback to manual quick capture');
          this.openManualQuickCaptureFallback();
          return;
        }
        this.fabOwnsRecording = true;
      })
      .catch(err => {
        if (!this.isFabStartRequestCurrent(requestId)) {
          return;
        }
        this.fabStartPending = false;
        this.fabOwnsRecording = false;
        this.logger.error('GateActions', 'FAB recording failed to start', err);
        this.toast.error('无法启动录音');
        this.openManualQuickCaptureFallback();
      });
  }

  private isFabStartRequestCurrent(requestId: number): boolean {
    return !this.isDestroyed && requestId === this.fabStartRequestId && this.fabPressActive;
  }

  private prepareFabRecordingSupport(): boolean {
    if (this.speechService.isSupported()) return true;
    if (!this.isDevMode) {
      this.toast.error('当前环境不支持语音录入');
      return false;
    }

    const mockTexts = GateActionsComponent.DEV_MOCK_TRANSCRIPTIONS;
    const mockText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
    this.isFabRecording.set(false);
    this.pendingTranscription.set(mockText);
    this.editableTranscription = mockText;
    this.quickCaptureOpen.set(true);
    return false;
  }

  private finishFabPress(forceCancel: boolean, reason: string): void {
    this.fabPressActive = false;
    this.clearLongPressTimer();
    const startWasPending = this.fabStartPending;
    const ownedRecording = this.fabOwnsRecording;
    this.fabStartPending = false;
    this.fabOwnsRecording = false;
    this.fabStartRequestId += 1;

    if (!startWasPending && !ownedRecording) {
      this.isFabRecording.set(false);
      this.isFabOutOfZone.set(false);
      return;
    }
    if (forceCancel || startWasPending || !this.isRecording()) {
      this.cancelFabRecording(reason);
      return;
    }

    this.stopFabRecording();
  }

  /** 检查指针是否仍在 FAB 按钮区域内 */
  private checkFabZone(clientX: number, clientY: number): void {
    const fab = this.captureFab()?.nativeElement;
    if (!fab) return;

    const rect = fab.getBoundingClientRect();
    // 【修复 P4-12】元素不可见时 rect 全为 0，跳过检测
    if (rect.width === 0 || rect.height === 0) return;
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
      this.cancelFabRecording('pointer left zone');
      return;
    }

    // 正常结束 → 转写
    this.isFabTranscribing.set(true);
    void this.doFabTranscribe();
  }

  private cancelFabRecording(reason: string): void {
    this.isFabRecording.set(false);
    this.isFabOutOfZone.set(false);
    this.isFabTranscribing.set(false);
    this.speechService.cancelRecording(this.recordingOwnerToken);
    this.logger.debug('GateActions', `FAB recording cancelled: ${reason}`);
  }

  /** FAB 录音转写 → 结果写入面板 */
  private async doFabTranscribe(): Promise<void> {
    const generation = this.transcriptionGeneration;
    try {
      const text = await this.speechService.stopAndTranscribe(this.recordingOwnerToken);
      if (!this.isTranscriptionGenerationCurrent(generation)) return;
      if (text && text.trim()) {
        this.pendingTranscription.set(text);
        this.editableTranscription = text;
        this.quickCaptureOpen.set(true);
      }
    } catch (err) {
      if (!this.isTranscriptionGenerationCurrent(generation)) return;
      this.logger.error('GateActions', 'FAB transcription failed', err instanceof Error ? err.message : String(err));
    } finally {
      if (this.isTranscriptionGenerationCurrent(generation)) {
        this.isFabTranscribing.set(false);
      }
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

    const result = await this.blackBoxService.createDurably({ content: text });

    if (result.ok) {
      this.logger.info('GateActions', 'Quick input submitted');
      this.quickInputText.set('');
      this.quickCaptureOpen.set(false);
      this.manualQuickCaptureFallback.set(false);
      this.toast.success('已记录');
      return;
    }

    this.logger.error('GateActions', 'Failed to submit quick input', result.error.message);
    this.toast.error(result.error.message || '记录失败');
  }

  /**
   * 【2026-04-23 倒置】确认 = 直接把转写结果保存为黑匣子条目，然后关闭面板。
   * 不再把文本回填到"手动 textarea"（已移除），让用户一步到位，不用再点二次保存。
   */
  async confirmPendingTranscription(): Promise<void> {
    const text = this.editableTranscription.trim();
    if (!text) {
      this.cancelPendingTranscription();
      return;
    }

    const result = await this.blackBoxService.createDurably({ content: text });
    if (result.ok) {
      this.logger.info('GateActions', 'Transcription saved to black box');
      this.toast.success('已记录');
      this.pendingTranscription.set('');
      this.editableTranscription = '';
      this.quickCaptureOpen.set(false);
    } else {
      this.logger.error('GateActions', 'Failed to save transcription', result.error.message);
      this.toast.error(result.error.message || '记录失败');
    }
  }

  /**
   * 【2026-04-23 倒置】取消 = 丢弃本次录音的转写结果并关闭面板。不保存，不回填。
   */
  cancelPendingTranscription(): void {
    this.pendingTranscription.set('');
    this.editableTranscription = '';
    this.quickCaptureOpen.set(false);
    this.manualQuickCaptureFallback.set(false);
  }

  onRecordMouseDown(event: MouseEvent): void {
    event.preventDefault();
    if (this.isDestroyed || this.recordPressActive) return;
    if (this.isTranscribing() || this.pendingTranscription()) return;

    this.recordPressActive = true;
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
    if (this.isDestroyed || this.recordPressActive) return;
    if (this.isTranscribing() || this.pendingTranscription()) return;

    this.recordPressActive = true;
    this.doStartRecording();

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) {
        this.checkInRecordZone(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchEnd = () => this.doStopOrCancel();
    const onTouchCancel = () => this.doStopOrCancel(true, 'touch cancelled');

    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchCancel);

    this.globalCleanups.push(
      () => document.removeEventListener('touchmove', onTouchMove),
      () => document.removeEventListener('touchend', onTouchEnd),
      () => document.removeEventListener('touchcancel', onTouchCancel)
    );
  }

  onRecordKeyStart(event: Event): void {
    if ((event as KeyboardEvent).repeat) return;
    event.preventDefault();
    if (this.isDestroyed || this.recordPressActive) return;
    if (this.isTranscribing() || this.pendingTranscription()) return;
    this.recordPressActive = true;
    this.doStartRecording();
  }

  onRecordKeyStop(): void {
    this.isOutOfZone.set(false);
    this.doStopOrCancel();
  }

  private static readonly DEV_MOCK_TRANSCRIPTIONS = [
    '把今天没收尾的任务补到黑匣子，明天大门统一结算。',
    '需要先修同步冲突，再看性能报警。',
    '用户反馈入口动效过快，降低抖动幅度。',
  ];

  private doStartRecording(): void {
    if (!this.speechService.isSupported()) {
      if (this.isDevMode) {
        const mockTexts = GateActionsComponent.DEV_MOCK_TRANSCRIPTIONS;
        const mockText = mockTexts[Math.floor(Math.random() * mockTexts.length)];
        this.pendingTranscription.set(mockText);
        this.editableTranscription = mockText;
        return;
      }

      this.openManualQuickCaptureFallback();
      return;
    }

    this.beginRecordingSession();
    this.isOutOfZone.set(false);
    const requestId = ++this.recordStartRequestId;
    this.recordStartPending = true;
    this.recordOwnsRecording = false;
    void this.speechService.startRecording(this.recordingOwnerToken)
      .then(started => {
        if (!this.isRecordStartRequestCurrent(requestId)) {
          return;
        }
        this.recordStartPending = false;
        if (started === false) {
          this.recordOwnsRecording = false;
          if (this.isRecording()) return;
          this.logger.warn('GateActions', 'Recording unavailable, fallback to manual quick capture');
          this.openManualQuickCaptureFallback();
          return;
        }
        this.recordOwnsRecording = true;
      })
      .catch(err => {
        if (!this.isRecordStartRequestCurrent(requestId)) {
          return;
        }
        this.recordStartPending = false;
        this.recordOwnsRecording = false;
        this.logger.error('GateActions', 'Failed to start recording', err);
        this.toast.error('无法启动录音');
        this.openManualQuickCaptureFallback();
      });
  }

  private isRecordStartRequestCurrent(requestId: number): boolean {
    return !this.isDestroyed &&
      requestId === this.recordStartRequestId &&
      this.recordPressActive;
  }

  private openManualQuickCaptureFallback(): void {
    if (this.isDestroyed) return;
    this.isFabRecording.set(false);
    this.isFabOutOfZone.set(false);
    this.fabOwnsRecording = false;
    this.manualQuickCaptureFallback.set(true);
    this.quickCaptureOpen.set(true);
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

  private doStopOrCancel(forceCancel = false, reason = 'pointer left zone'): void {
    this.removeGlobalListeners();
    this.recordPressActive = false;
    const startWasPending = this.recordStartPending;
    const ownedRecording = this.recordOwnsRecording;
    this.recordStartPending = false;
    this.recordOwnsRecording = false;
    this.recordStartRequestId += 1;

    if (!startWasPending && !ownedRecording) return;

    if (forceCancel || startWasPending || this.isOutOfZone() || !this.isRecording()) {
      this.speechService.cancelRecording(this.recordingOwnerToken);
      this.isOutOfZone.set(false);
      this.logger.debug('GateActions', `Recording cancelled: ${reason}`);
      return;
    }

    void this.doTranscribe();
  }

  private async doTranscribe(): Promise<void> {
    this.removeGlobalListeners();
    const generation = this.transcriptionGeneration;

    try {
      const text = await this.speechService.stopAndTranscribe(this.recordingOwnerToken);
      if (!this.isTranscriptionGenerationCurrent(generation)) return;
      if (text && text.trim()) {
        this.pendingTranscription.set(text);
        this.editableTranscription = text;
      }
    } catch (err) {
      if (!this.isTranscriptionGenerationCurrent(generation)) return;
      this.logger.error('GateActions', 'Transcription failed', err instanceof Error ? err.message : String(err));
    }
  }

  private beginRecordingSession(): void {
    this.transcriptionGeneration += 1;
    this.isFabTranscribing.set(false);
  }

  private isTranscriptionGenerationCurrent(generation: number): boolean {
    return !this.isDestroyed && generation === this.transcriptionGeneration;
  }

  private removeGlobalListeners(): void {
    const cleanups = this.globalCleanups;
    this.globalCleanups = [];

    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (err) {
        this.logger.error('GateActions', 'Failed to remove global listener', err instanceof Error ? err.message : String(err));
      }
    }
  }
}
