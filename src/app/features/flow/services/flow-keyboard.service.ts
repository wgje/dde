import { Injectable, Injector, inject, NgZone } from '@angular/core';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowLinkService } from './flow-link.service';
import { LoggerService } from '../../../../services/logger.service';
import * as go from 'gojs';

export type KeyboardActionResult =
  | { status: 'handled'; completed: Promise<void> }
  | { status: 'not-handled' };

/**
 * 流程图快捷键服务
 * 处理图表相关的键盘快捷键
 */
@Injectable({ providedIn: 'root' })
export class FlowKeyboardService {
  private readonly injector = inject(Injector);
  private readonly diagram = inject(FlowDiagramService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly link = inject(FlowLinkService);
  private readonly zone = inject(NgZone);
  private readonly logger = inject(LoggerService).category('FlowKeyboard');

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  /**
   * 处理图表快捷键
   * @returns 是否处理了该事件
   */
  handleShortcut(event: KeyboardEvent): KeyboardActionResult {
    if (!this.diagram.isInitialized) return { status: 'not-handled' };
    if (!event.altKey) return { status: 'not-handled' };
    if (event.repeat) return { status: 'not-handled' };
    if (this.isEditableTarget(event.target)) return { status: 'not-handled' };

    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (!key) return { status: 'not-handled' };

    const diagramInstance = this.diagram.diagramInstance;
    if (!diagramInstance) return { status: 'not-handled' };

    // Alt+Z: 解除父子关系
    if (key === 'z') {
      return this.handleDetachTasks(event);
    }

    // Alt+X: 删除选中的连接线（跨树连接）
    if (key === 'x') {
      return this.handleDeleteCrossTreeLinks(event, diagramInstance);
    }

    return { status: 'not-handled' };
  }

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false;
    }

    return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
  }

  /**
   * Alt+Z: 解除选中任务的父子关系
   */
  private handleDetachTasks(event: KeyboardEvent): KeyboardActionResult {
    const selectedKeys = this.selectionService.getSelectedNodeKeys();
    if (!selectedKeys.length) return { status: 'not-handled' };

    event.preventDefault();
    event.stopPropagation();

    const completed = this.zone.run(() => this.detachSelectedTasks(selectedKeys));

    return { status: 'handled', completed };
  }

  private async detachSelectedTasks(selectedKeys: string[]): Promise<void> {
    const results = await Promise.allSettled(
      selectedKeys.map(async id => ({
        id,
        detached: await this.taskOpsAdapter.detachTask(id),
      })),
    );

    const failedTaskIds: string[] = [];
    const errors: unknown[] = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failedTaskIds.push(selectedKeys[index] ?? '');
        errors.push(result.reason);
        return;
      }

      if (!result.value.detached) {
        failedTaskIds.push(result.value.id);
      }
    });

    if (failedTaskIds.length > 0) {
      this.logDetachTasksFailure(failedTaskIds.filter(Boolean), selectedKeys.length, errors);
    }
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

    if (!selectedLinks.length) return { status: 'not-handled' };

    event.preventDefault();
    event.stopPropagation();

    const completed = this.zone.run(() => this.deleteSelectedCrossTreeLinks(selectedLinks));

    return { status: 'handled', completed };
  }

  private deleteSelectedCrossTreeLinks(selectedLinks: go.ObjectData[]): Promise<void> {
    try {
      return Promise.resolve(this.link.handleDeleteCrossTreeLinks(selectedLinks))
        .catch((error: unknown) => {
          this.logDeleteCrossTreeLinksFailure(error, selectedLinks.length);
        });
    } catch (error) {
      this.logDeleteCrossTreeLinksFailure(error, selectedLinks.length);
      return Promise.resolve();
    }
  }

  private logDeleteCrossTreeLinksFailure(error: unknown, selectedCount: number): void {
    this.logger.warn('删除跨树连接快捷键执行失败', {
      error,
      selectedCount,
    });
  }

  private logDetachTasksFailure(failedTaskIds: string[], selectedCount: number, errors: unknown[]): void {
    this.logger.warn('解除父子关系快捷键执行失败', {
      failedTaskIds,
      selectedCount,
      errors,
    });
  }
}
