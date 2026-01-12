/**
 * Shared Services
 * 
 * 共享工具服务
 */

// Toast 服务
export { ToastService } from '../../../services/toast.service';

// 主题服务
export { ThemeService } from '../../../services/theme.service';

// UI 状态服务
export { UiStateService } from '../../../services/ui-state.service';

// 日志服务
export { LoggerService, LogLevel, type LogCategory } from '../../../services/logger.service';

// 模态框服务
export { ModalService } from '../../../services/modal.service';
export { DynamicModalService } from '../../../services/dynamic-modal.service';
// 模态框基类现在从 shared/modals 导出
export { BaseModalComponent, ConfirmModalComponent, EditableModalComponent } from '../modals/base-modal.component';

// 偏好设置服务
export { PreferenceService } from '../../../services/preference.service';

// 全局错误处理
export { GlobalErrorHandlerService } from '../../../services/global-error-handler.service';

// 搜索服务
export { SearchService } from '../../../services/search.service';
