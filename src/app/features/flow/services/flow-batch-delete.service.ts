import { Injectable, inject, signal } from '@angular/core';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowTaskOperationsService } from './flow-task-operations.service';
import { BatchDeleteDialogData } from '../components/flow-batch-delete-dialog.component';
import { Task } from '../../../../models';

/**
 * 批量删除服务
 * 处理流程图中的批量删除操作
 */
@Injectable({ providedIn: 'root' })
export class FlowBatchDeleteService {
  private readonly projectState = inject(ProjectStateService);
  private readonly selectionService = inject(FlowSelectionService);
  private readonly taskOps = inject(FlowTaskOperationsService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowBatchDelete');

  /** 批量删除确认对话框状态 */
  readonly dialogData = signal<BatchDeleteDialogData | null>(null);

  /**
   * 请求批量删除（由 Delete 键或工具栏按钮触发）
   * 计算删除影响并显示确认弹窗
   * @returns 单选时返回需要删除的单个任务，否则返回 null
   */
  requestBatchDelete(): Task | null {
    const selectedIds = Array.from(this.selectionService.selectedTaskIds());
    if (selectedIds.length === 0) return null;

    // 单选时返回单任务，由组件走单任务删除流程
    if (selectedIds.length === 1) {
      const task = this.projectState.getTask(selectedIds[0]);
      return task || null;
    }

    // 多选时计算删除影响并显示批量确认弹窗
    const impact = this.taskOps.calculateBatchDeleteImpact(selectedIds);

    this.dialogData.set({
      selectedIds,
      impact
    });

    return null;
  }

  /**
   * 确认批量删除
   * @param clearSelectionCallback 清空选择的回调
   * @returns 删除的任务数量
   */
  confirmBatchDelete(clearSelectionCallback?: () => void): number {
    const dialogData = this.dialogData();
    if (!dialogData) return 0;

    // 清空选择
    this.selectionService.clearSelection();
    if (clearSelectionCallback) {
      clearSelectionCallback();
    }

    // 执行批量删除
    const deletedCount = this.taskOps.deleteTasksBatch(dialogData.selectedIds);

    // 关闭弹窗
    this.dialogData.set(null);

    // 显示成功提示
    if (deletedCount > 0) {
      this.toast.success('操作成功', `已删除 ${deletedCount} 个任务`);
    }

    return deletedCount;
  }

  /**
   * 取消批量删除
   */
  cancelBatchDelete(): void {
    this.dialogData.set(null);
  }

  /**
   * 处理 Delete 键删除事件（由 GoJS commandHandler 拦截后触发）
   * @returns 单选时返回需要删除的单个任务，否则返回 null
   */
  handleDeleteKeyPressed(): Task | null {
    const selectedIds = Array.from(this.selectionService.selectedTaskIds());
    if (selectedIds.length === 0) return null;

    this.logger.debug(`Delete 键删除: ${selectedIds.length} 个选中任务`);
    return this.requestBatchDelete();
  }
}
