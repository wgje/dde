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
import { SpotlightService } from '../../../services/spotlight.service';
import { BlackBoxService } from '../../../services/black-box.service';
import { BlackBoxSyncService } from '../../../services/black-box-sync.service';
import { FocusPreferenceService } from '../../../services/focus-preference.service';
import { 
  gateState, 
  spotlightMode, 
  focusPreferences 
} from '../../../state/focus-stores';
import { LoggerService } from '../../../services/logger.service';
import { FOCUS_CONFIG } from '../../../config/focus.config';

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
  private readonly gateService = inject(GateService);
  private readonly spotlightService = inject(SpotlightService);
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly blackBoxSyncService = inject(BlackBoxSyncService);
  private readonly focusPrefService = inject(FocusPreferenceService);
  private readonly logger = inject(LoggerService);
  private readonly ngZone = inject(NgZone);

  /** 页面隐藏时的时间戳，用于计算待机时长 */
  private hiddenAt: number | null = null;
  /** visibilitychange 监听引用，销毁时清理 */
  private visibilityHandler: (() => void) | null = null;

  // 计算属性 - 决定各组件是否可见
  readonly isGateVisible = computed(() => 
    gateState() === 'reviewing' && focusPreferences().gateEnabled
  );

  readonly isSpotlightActive = computed(() => 
    spotlightMode() && focusPreferences().spotlightEnabled
  );

  ngOnInit(): void {
    this.logger.debug('FocusMode', '初始化');
    
    // FocusPreferenceService 在构造函数中已自动加载偏好
    // 先从服务器加载黑匣子数据，然后检查大门状态
    this.initializeAndCheckGate();
    
    // 监听页面可见性变化：待机一段时间后回来重新检查大门
    this.setupVisibilityListener();
  }

  ngOnDestroy(): void {
    this.logger.debug('FocusMode', '销毁');
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  /**
   * 监听页面可见性变化
   * 
   * 用户切走（页面 hidden）时记录时间戳，
   * 切回（页面 visible）时如果待机超过阈值，重新拉取数据并检查大门
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
            this.initializeAndCheckGate();
          });
        }
      }
    };
    
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  /**
   * 初始化：加载黑匣子数据并检查大门
   * 必须先加载数据，否则 pendingBlackBoxEntries 为空
   */
  private async initializeAndCheckGate(): Promise<void> {
    try {
      // ⚠️ 关键：先从服务器/IndexedDB 加载黑匣子条目
      this.logger.debug('FocusMode', '加载黑匣子数据...');
      await this.blackBoxSyncService.pullChanges();
      this.logger.debug('FocusMode', '黑匣子数据加载完成');
      
      // 然后检查大门状态
      this.checkGateOnStartup();
    } catch (error) {
      this.logger.error('FocusMode', '初始化失败', error instanceof Error ? error.message : String(error));
      // 即使加载失败，也尝试检查大门（可能有本地缓存）
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
