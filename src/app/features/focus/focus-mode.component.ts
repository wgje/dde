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
  computed
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
} from '../../core/state/focus-stores';
import { LoggerService } from '../../../services/logger.service';

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
    // 检查大门状态
    this.checkGateOnStartup();
  }

  ngOnDestroy(): void {
    this.logger.debug('FocusMode', '销毁');
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
