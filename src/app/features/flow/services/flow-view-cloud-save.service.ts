import { Injectable, inject } from '@angular/core';

import { ProjectSaveFlightCoordinatorService } from '../../../core/services/sync/project-save-flight-coordinator.service';
import { SyncStateService } from '../../../core/services/sync/sync-state.service';
import { TIMEOUT_CONFIG } from '../../../../config';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ToastService } from '../../../../services/toast.service';

export type FlowCloudSaveResult = { ok: boolean; message?: string };

@Injectable({ providedIn: 'root' })
export class FlowViewCloudSaveService {
  private readonly authService = inject(AuthService);
  private readonly logger = inject(LoggerService).category('FlowView');
  private readonly projectSaveCoordinator = inject(ProjectSaveFlightCoordinatorService);
  private readonly projectState = inject(ProjectStateService);
  private readonly syncStateService = inject(SyncStateService);
  private readonly toast = inject(ToastService);

  async saveToCloud(): Promise<FlowCloudSaveResult> {
    const userId = this.authService.currentUserId();
    const activeProject = this.projectState.activeProject();

    if (!this.syncStateService.syncState().isOnline) {
      this.toast.info('当前处于离线模式', '数据已安全保存在本地，联网后自动同步');
      return { ok: true, message: '离线模式' };
    }

    if (!userId || !activeProject) {
      this.toast.warning('无法保存', '请先登录并打开一个项目');
      return { ok: false, message: '未登录或无活动项目' };
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        this.projectSaveCoordinator.save(activeProject, userId),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_CONFIG.HEAVY);
        }),
      ]);

      if (result.success) {
        this.toast.success('已保存到云端', `最后同步: ${new Date().toLocaleTimeString()}`);
        return { ok: true };
      }
      if (result.conflict) {
        this.toast.warning('存在同步冲突', '请在同步面板中解决冲突后重试');
        return { ok: false, message: '同步冲突' };
      }

      this.toast.error('保存失败', '请检查网络连接后重试');
      return { ok: false, message: '保存失败' };
    } catch (error: unknown) {
      return this.handleSaveError(error);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private handleSaveError(error: unknown): FlowCloudSaveResult {
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    if (errorMsg === 'TIMEOUT') {
      this.toast.warning('保存超时', '数据已缓存，将在连接恢复后自动同步');
      return { ok: false, message: '超时' };
    }

    this.toast.error('保存失败', errorMsg);
    this.logger.error('saveToCloud 异常', error);
    return { ok: false, message: errorMsg };
  }
}
