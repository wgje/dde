/**
 * dock-audio.utils.ts
 * 停泊坞音频通知工具：从 DockEngineService 提取，
 * 实现关注点分离——状态管理服务不应持有 AudioContext。
 */
import { PARKING_CONFIG } from '../config/parking.config';
import { TimerHandle } from '../utils/timer-handle';

/** 封装共享 AudioContext 及其生命周期 */
export class DockAudioPlayer {
  private audioCtx: AudioContext | null = null;
  private readonly stopTimer = new TimerHandle();

  private getOrCreateContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext();
    }
    return this.audioCtx;
  }

  /** 播放等待结束提示音（失败时静默忽略） */
  playWaitEndSound(): void {
    try {
      const ctx = this.getOrCreateContext();
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.frequency.value = PARKING_CONFIG.STATUS_MACHINE_NOTIFICATION_TONE_HZ;
      gain.gain.value = 0.08;
      oscillator.start();
      this.stopTimer.schedule(
        () => oscillator.stop(),
        PARKING_CONFIG.STATUS_MACHINE_NOTIFICATION_DURATION_MS + 20,
      );
    } catch {
      // 音频 API 不可用或被浏览器策略阻止时静默忽略
    }
  }

  /** 释放所有音频资源 */
  dispose(): void {
    this.stopTimer.cancel();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}
