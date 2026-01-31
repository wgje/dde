import { Injectable, inject, NgZone } from '@angular/core';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowLinkService } from './flow-link.service';
import * as go from 'gojs';

export type KeyboardActionResult = 'handled' | 'not-handled';

/**
 * 流程图快捷键服务
 * 处理图表相关的键盘快捷键
 */
@Injectable({ providedIn: 'root' })
export class FlowKeyboardService {
  private readonly diagram = inject(FlowDiagramService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly taskOpsAdapter = inject(TaskOperationAdapterService);
  private readonly link = inject(FlowLinkService);
  private readonly zone = inject(NgZone);

  /**
   * 处理图表快捷键
   * @returns 是否处理了该事件
   */
  handleShortcut(event: KeyboardEvent): KeyboardActionResult {
    if (!this.diagram.isInitialized) return 'not-handled';
    if (!event.altKey) return 'not-handled';

    const key = event.key.toLowerCase();
    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return 'not-handled';

    // Alt+Z: 解除父子关系
    if (key === 'z') {
      return this.handleDetachTasks(event);
    }

    // Alt+X: 删除选中的连接线（跨树连接）
    if (key === 'x') {
      return this.handleDeleteCrossTreeLinks(event, diagramInstance);
    }

    return 'not-handled';
  }

  /**
   * Alt+Z: 解除选中任务的父子关系
   */
  private handleDetachTasks(event: KeyboardEvent): KeyboardActionResult {
    const selectedKeys = this.selectionService.getSelectedNodeKeys();
    if (!selectedKeys.length) return 'not-handled';

    event.preventDefault();
    event.stopPropagation();

    this.zone.run(() => {
      selectedKeys.forEach(id => this.taskOpsAdapter.detachTask(id));
    });

    return 'handled';
  }

  /**
   * Alt+X: 删除选中的跨树连接线
   */
  private handleDeleteCrossTreeLinks(
    event: KeyboardEvent,
    diagramInstance: go.Diagram
  ): KeyboardActionResult {
    const selectedLinks: go.ObjectData[] = [];
    diagramInstance.selection.each((part: go.Part) => {
      if (part instanceof go.Link && part?.data?.isCrossTree) {
        selectedLinks.push(part.data);
      }
    });

    if (!selectedLinks.length) return 'not-handled';

    event.preventDefault();
    event.stopPropagation();

    this.zone.run(() => {
      this.link.handleDeleteCrossTreeLinks(selectedLinks);
    });

    return 'handled';
  }
}
