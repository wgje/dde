import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { GateService } from './gate.service';
import { LoggerService } from './logger.service';
import { FEATURE_FLAGS } from '../config/feature-flags.config';

@Injectable({ providedIn: 'root' })
export class FocusStartupProbeService {
  private readonly auth = inject(AuthService);
  private readonly blackBoxSync = inject(BlackBoxSyncService);
  private readonly gateService = inject(GateService);
  private readonly logger = inject(LoggerService).category('FocusStartupProbe');

  private readonly probeDoneSignal = signal(false);
  private readonly pendingGateWorkSignal = signal(false);

  private probePromise: Promise<void> | null = null;
  private initializedForUser: string | null = null;
  /** 【修复 P1-06】版本号递增，异步完成后对比确保不写入过期用户数据 */
  private probeVersion = 0;

  initialize(): void {
    if (!FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) {
      this.probeDoneSignal.set(true);
      this.pendingGateWorkSignal.set(false);
      return;
    }

    const userId = this.auth.currentUserId();
    if (!userId) {
      this.initializedForUser = null;
      this.probeDoneSignal.set(false);
      this.pendingGateWorkSignal.set(false);
      return;
    }

    if (this.initializedForUser === userId && (this.probeDoneSignal() || this.probePromise)) {
      return;
    }

    // 用户切换时标记之前正在运行的探测为已中止
    if (this.initializedForUser !== null && this.initializedForUser !== userId && this.probePromise) {
      // 【修复 P1-06】递增版本号使旧 probe 的结果失效
      this.probeVersion++;
      // 【修复 M-18】清除 probePromise，避免旧 promise 阻塞新用户的探测
      this.probePromise = null;
    }

    this.initializedForUser = userId;
    this.probeDoneSignal.set(false);
    this.pendingGateWorkSignal.set(false);

    if (this.probePromise) {
      return;
    }

    const capturedVersion = this.probeVersion;
    this.probePromise = this.runLocalProbe(capturedVersion).finally(() => {
      this.probePromise = null;
    });
  }

  isProbeDone(): boolean {
    return this.probeDoneSignal();
  }

  hasPendingGateWork(): boolean {
    return this.pendingGateWorkSignal();
  }

  private async runLocalProbe(version: number): Promise<void> {
    try {
      await this.blackBoxSync.loadFromLocal();

      // 【修复 P1-06】探测期间用户已切换，版本号不匹配则放弃本次结果
      if (version !== this.probeVersion) {
        this.logger.debug('探测被中止（用户已切换，版本号不匹配）');
        return;
      }

      this.gateService.checkGate();
      // 通过 GateService 抽象访问 gate 状态，不直接访问 store
      this.pendingGateWorkSignal.set(this.gateService.state() === 'reviewing');
      this.logger.debug('Focus 启动探针完成', {
        pendingGateWork: this.pendingGateWorkSignal(),
      });
    } catch (error) {
      this.logger.warn('Focus 启动探针失败', error);
      this.pendingGateWorkSignal.set(false);
    } finally {
      this.probeDoneSignal.set(true);
    }
  }
}
