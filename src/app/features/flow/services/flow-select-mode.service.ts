import { Injectable, inject, signal } from '@angular/core';
import { UiStateService } from '../../../../services/ui-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowSelectionService } from './flow-selection.service';
import * as go from 'gojs';

/**
 * 框选模式服务
 * 处理移动端的框选模式和平移模式切换
 */
@Injectable({ providedIn: 'root' })
export class FlowSelectModeService {
  private readonly uiState = inject(UiStateService);
  private readonly diagram = inject(FlowDiagramService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowSelectMode');

  /** 移动端：框选模式（区分平移和框选） */
  readonly isSelectMode = signal(false);

  /** 保存原始的 standardMouseSelect 方法 */
  private originalStandardMouseSelect?: () => void;

  /**
   * 切换移动端框选模式（框选 vs 平移）
   * - 框选模式：dragSelectingTool 启用，panningTool 禁用，点击节点切换选择状态
   * - 平移模式：panningTool 启用，dragSelectingTool 禁用，点击节点单选并显示详情
   */
  toggleSelectMode(): void {
    if (!this.uiState.isMobile()) {
      this.logger.debug('跳过桌面端框选模式切换');
      return;
    }

    const newMode = !this.isSelectMode();
    this.isSelectMode.set(newMode);

    this.logger.debug('切换框选模式', { newMode, isMobile: this.uiState.isMobile() });

    const diagramInstance = this.diagram.diagramInstance;
    if (diagramInstance) {
      // 切换工具启用状态
      diagramInstance.toolManager.dragSelectingTool.isEnabled = newMode;
      diagramInstance.toolManager.panningTool.isEnabled = !newMode;

      this.logger.debug('工具状态更新', {
        dragSelectingToolEnabled: diagramInstance.toolManager.dragSelectingTool.isEnabled,
        panningToolEnabled: diagramInstance.toolManager.panningTool.isEnabled
      });

      // 关键修改：保持 ClickSelectingTool 启用，但拦截其默认选择行为
      // 这样可以确保 click 事件被触发，从而让 FlowTemplateService 中的多选逻辑生效
      const clickTool = diagramInstance.toolManager.clickSelectingTool;
      clickTool.isEnabled = true;

      if (newMode) {
        // 进入框选模式：拦截 standardMouseSelect
        // 保存原始方法（如果还没保存）
        if (!this.originalStandardMouseSelect) {
          this.originalStandardMouseSelect = clickTool.standardMouseSelect.bind(clickTool);
        }
        // 覆盖为无操作，交由节点 click 事件处理多选
        clickTool.standardMouseSelect = function() {
          // Do nothing
        };

        this.logger.debug('移动端切换到框选模式：可拖拽框选或点击节点多选');
        this.toast.info('框选模式', '拖拽框选或点击节点多选');
      } else {
        // 退出框选模式：恢复 standardMouseSelect
        if (this.originalStandardMouseSelect) {
          clickTool.standardMouseSelect = this.originalStandardMouseSelect;
          this.originalStandardMouseSelect = undefined;
        }

        this.selectionService.clearSelection();
        this.logger.debug('移动端切换到平移模式：点击节点查看详情');
        this.toast.info('平移模式', '可拖拽移动画布');
      }
    }
  }

  /**
   * 重置框选模式（组件销毁时调用）
   */
  resetSelectMode(): void {
    const diagramInstance = this.diagram.diagramInstance;
    if (diagramInstance && this.originalStandardMouseSelect) {
      const clickTool = diagramInstance.toolManager.clickSelectingTool;
      clickTool.standardMouseSelect = this.originalStandardMouseSelect;
      this.originalStandardMouseSelect = undefined;
    }
    this.isSelectMode.set(false);
  }
}
