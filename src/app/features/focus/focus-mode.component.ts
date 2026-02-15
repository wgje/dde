/**
 * Focus Mode 容器组件
 * 
 * 管理所有 Focus Mode 子组件的渲染和状态协调
 * 放置在 app.component.html 中作为全局覆盖层
 */

import { 
  Component, 
  ChangeDetectionStrategy, 
  inject,
  OnInit,
  OnDestroy,
  computed,
  NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { GateOverlayComponent } from './components/gate/gate-overlay.component';
import { SpotlightViewComponent } from './components/spotlight/spotlight-view.component';
import { GateService } from '../../../services/gate.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { 
  gateState, 
  spotlightMode, 
  focusPreferences 
} from '../../../state/focus-stores';
import { LoggerService } from '../../../services/logger.service';
import { FOCUS_CONFIG } from '../../../config/focus.config';
import { FEATURE_FLAGS } from '../../../config/feature-flags.config';

@Component({
  selector: 'app-focus-mode',
  standalone: true,
  imports: [
    CommonModule,
    GateOverlayComponent,
    SpotlightViewComponent
  ],
  template: `
    <!-- 大门覆盖层 - 优先级最高，包含地质层预览 -->
    @if (isGateVisible()) {
      <app-gate-overlay
        (closed)="onGateClosed()">
      </app-gate-overlay>
    }

    <!-- 聚光灯模式 -->
    @if (isSpotlightActive()) {
      <app-spotlight-view>
      </app-spotlight-view>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FocusModeComponent implements OnInit, OnDestroy {
  private static focusAnimationStyleLoaded = false;

  private readonly gateService = inject(GateService);
  private readonly blackBoxSyncService = inject(BlackBoxSyncService);
  private readonly logger = inject(LoggerService);
  private readonly ngZone = inject(NgZone);

  /** 页面隐藏时的时间戳，用于计算待机时长 */
  private hiddenAt: number | null = null;
  /** visibilitychange 监听引用，销毁时清理 */
  private visibilityHandler: (() => void) | null = null;
  /** 旧策略启动定时器（开关关闭时兼容） */
  private legacyInitialLoadTimer: ReturnType<typeof setTimeout> | null = null;

  // 计算属性 - 决定各组件是否可见
  readonly isGateVisible = computed(() => 
    gateState() === 'reviewing' && focusPreferences().gateEnabled
  );

  readonly isSpotlightActive = computed(() => 
    spotlightMode() && focusPreferences().spotlightEnabled
  );

  ngOnInit(): void {
    this.ensureFocusAnimationStyleLoaded();
    this.logger.debug('FocusMode', '初始化');

    if (FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) {
      void this.initializeLocalGateCheck();
    } else {
      this.scheduleLegacyInitialGateCheck();
    }

    // 监听页面可见性变化：待机一段时间后回来重新检查大门
    this.setupVisibilityListener();
  }

  private ensureFocusAnimationStyleLoaded(): void {
    if (FocusModeComponent.focusAnimationStyleLoaded) return;
    FocusModeComponent.focusAnimationStyleLoaded = true;

    void import('./focus.animations.css').catch((error: unknown) => {
      FocusModeComponent.focusAnimationStyleLoaded = false;
      this.logger.warn(
        'FocusMode',
        'focus 动画样式按需加载失败，降级继续',
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  ngOnDestroy(): void {
    this.logger.debug('FocusMode', '销毁');
    if (this.legacyInitialLoadTimer) {
      clearTimeout(this.legacyInitialLoadTimer);
      this.legacyInitialLoadTimer = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /**
   * 开关关闭时保留旧策略，防止灰度回滚风险
   */
  private scheduleLegacyInitialGateCheck(): void {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const requestIdle = (window as Window & { requestIdleCallback: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number }).requestIdleCallback;
      requestIdle(() => {
        this.ngZone.run(() => {
          void this.initializeAndCheckGateLegacy('startup');
        });
      }, { timeout: 4000 });
      return;
    }

    this.legacyInitialLoadTimer = setTimeout(() => {
      this.ngZone.run(() => {
        void this.initializeAndCheckGateLegacy('startup');
      });
    }, 1200);
  }

  /**
   * 启动时先做本地加载 + gate 检查，不触发远端请求
   * 【修复 2026-02-14】本地检查后延迟触发后台拉取，防止 gate 状态长期不同步
   */
  private async initializeLocalGateCheck(): Promise<void> {
    try {
      await this.blackBoxSyncService.loadFromLocal();
      this.checkGateOnStartup();
    } catch (error) {
      this.logger.warn('FocusMode', '本地黑匣子加载失败，降级继续 gate 检查',
        error instanceof Error ? error.message : String(error));
      this.checkGateOnStartup();
    }

    // 延迟后台拉取远端数据，纠正可能过期的本地 gate 状态
    this.blackBoxSyncService.pullChanges({ reason: 'startup' }).then(() => {
      this.ngZone.run(() => this.checkGateOnStartup());
    }).catch(pullError => {
      this.logger.warn('FocusMode', '后台拉取失败（throttled）',
        pullError instanceof Error ? pullError.message : String(pullError));
    });
  }

  /**
   * 监听页面可见性变化
   */
  private setupVisibilityListener(): void {
    if (typeof document === 'undefined') return;
    
    this.visibilityHandler = () => {
      if (document.visibilityState === 'hidden') {
        this.hiddenAt = Date.now();
      } else if (document.visibilityState === 'visible' && this.hiddenAt) {
        const idleDuration = Date.now() - this.hiddenAt;
        this.hiddenAt = null;

        const threshold = FOCUS_CONFIG.GATE.IDLE_RECHECK_THRESHOLD;
        if (idleDuration >= threshold) {
          this.logger.info('FocusMode', 
            `待机 ${Math.round(idleDuration / 1000)}s 后回来，重新检查大门`);
          // 在 NgZone 内执行，确保变更检测正确触发
          this.ngZone.run(() => {
            void this.handleResumeGateCheck();
          });
        }
      }
    };
    
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /**
   * 恢复场景：Focus 侧仅做补充本地检查，远端恢复由 Lifecycle Orchestrator 主导
   */
  private async handleResumeGateCheck(): Promise<void> {
    if (FEATURE_FLAGS.FOCUS_STARTUP_THROTTLED_CHECK_V1) {
      await this.initializeLocalGateCheck();
      return;
    }

    await this.initializeAndCheckGateLegacy('resume');
  }

  /**
   * 旧策略（开关关闭时）：
   * 本地检查后立即后台拉远端
   */
  private async initializeAndCheckGateLegacy(reason: 'startup' | 'resume'): Promise<void> {
    try {
      await this.blackBoxSyncService.loadFromLocal();
      this.checkGateOnStartup();

      this.blackBoxSyncService.pullChanges({ reason }).then(() => {
        this.checkGateOnStartup();
      }).catch(pullError => {
        this.logger.warn('FocusMode', '后台拉取失败（legacy）',
          pullError instanceof Error ? pullError.message : String(pullError));
      });
    } catch (error) {
      this.logger.error('FocusMode', '初始化失败', error instanceof Error ? error.message : String(error));
      this.checkGateOnStartup();
    }
  }

  /**
   * 启动时检查大门
   * 如果有未处理的项目，显示大门
   */
  private checkGateOnStartup(): void {
    try {
      this.gateService.checkGate();
      if (gateState() === 'reviewing') {
        this.logger.info('FocusMode', '检测到未处理项目，显示大门');
      }
    } catch (error) {
      this.logger.error('FocusMode', '检查大门状态失败', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 大门关闭回调
   */
  onGateClosed(): void {
    this.logger.info('FocusMode', '大门已关闭');
  }
}
