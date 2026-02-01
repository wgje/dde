import { Injectable, inject, NgZone, signal, WritableSignal, ElementRef } from '@angular/core';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowDiagramService } from './flow-diagram.service';
import { FLOW_VIEW_CONFIG } from '../../../../config';

/**
 * 图表初始化与重试服务
 * 
 * 职责：
 * - 图表初始化调度（使用 requestIdleCallback）
 * - 重试逻辑（指数退避 + 最大次数限制）
 * - 完全重置功能
 */
@Injectable({ providedIn: 'root' })
export class FlowDiagramRetryService {
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('FlowDiagramRetry');
  private readonly zone = inject(NgZone);
  private readonly diagram = inject(FlowDiagramService);

  /** 是否正在重试加载图表 */
  readonly isRetrying = signal(false);

  /** 是否已达到重试上限 */
  readonly hasReachedRetryLimit = signal(false);

  /** 当前重试次数 */
  private retryCount = 0;

  /** Idle 初始化句柄（用于取消） */
  private idleInitHandle: number | null = null;

  /**
   * 重置内部状态
   */
  resetState(): void {
    this.retryCount = 0;
    this.isRetrying.set(false);
    this.hasReachedRetryLimit.set(false);
    if (this.idleInitHandle !== null && typeof cancelIdleCallback !== 'undefined') {
      cancelIdleCallback(this.idleInitHandle);
      this.idleInitHandle = null;
    }
  }

  /**
   * 调度图表初始化（使用 requestIdleCallback）
   * 
   * @param initDiagram 初始化回调
   * @param onInitialized 初始化成功回调
   * @param scheduleTimer 定时器调度函数
   * @param isDestroyed 组件是否已销毁检查
   */
  scheduleDiagramInit(
    initDiagram: () => void,
    onInitialized: () => void,
    scheduleTimer: (callback: () => void, delay: number) => void,
    isDestroyed: () => boolean
  ): void {
    const startInit = () => {
      if (isDestroyed()) return;
      initDiagram();
      if (this.diagram.isInitialized) {
        onInitialized();
      }
    };

    // 使用 requestIdleCallback 延迟重任务，避免阻塞 LCP
    if (typeof requestIdleCallback !== 'undefined') {
      this.idleInitHandle = requestIdleCallback(() => {
        this.idleInitHandle = null;
        this.zone.run(() => startInit());
      }, { timeout: 5000 });
    } else {
      scheduleTimer(() => {
        this.zone.run(() => startInit());
      }, 1200);
    }
  }

  /**
   * 带指数退避的重试初始化
   * 
   * @param diagramDiv 图表容器 ElementRef
   * @param initDiagram 初始化回调
   * @param onInitialized 初始化成功回调
   * @param scheduleTimer 定时器调度函数
   */
  retryInitDiagram(
    diagramDiv: ElementRef | undefined,
    initDiagram: () => void,
    onInitialized: (delayMs?: number) => void,
    scheduleTimer: (callback: () => void, delay: number) => void
  ): void {
    // 检查是否超过最大重试次数
    if (this.retryCount >= FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES) {
      this.toast.error(
        '初始化失败',
        `流程图加载失败已重试 ${FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES} 次，请尝试刷新页面或切换到文本视图`
      );
      this.isRetrying.set(false);
      this.hasReachedRetryLimit.set(true);
      return;
    }

    this.retryCount++;
    this.isRetrying.set(true);
    this.hasReachedRetryLimit.set(false);

    // 显示重试进度反馈
    const remaining = FLOW_VIEW_CONFIG.MAX_DIAGRAM_RETRIES - this.retryCount;
    this.toast.info(
      `重试加载中...`,
      `第 ${this.retryCount} 次尝试（剩余 ${remaining} 次）`,
      { duration: 2000 }
    );

    // 使用指数退避
    const delay = FLOW_VIEW_CONFIG.DIAGRAM_RETRY_BASE_DELAY * Math.pow(2, this.retryCount - 1);

    scheduleTimer(() => {
      this.zone.run(() => {
        // 再次检查 DOM 是否准备好
        if (!diagramDiv || !diagramDiv.nativeElement) {
          this.logger.warn('[FlowDiagramRetry] 重试时 diagramDiv 仍未准备好，将再次重试');
          this.isRetrying.set(false);
          // 如果 DOM 未准备好，递归重试
          scheduleTimer(() => this.retryInitDiagram(diagramDiv, initDiagram, onInitialized, scheduleTimer), 500);
          return;
        }

        initDiagram();
        if (this.diagram.isInitialized) {
          onInitialized(0);
          // 成功后重置重试计数
          this.retryCount = 0;
          this.hasReachedRetryLimit.set(false);
          this.toast.success('加载成功', '流程图已就绪');
        }
        this.isRetrying.set(false);
      });
    }, delay);
  }

  /**
   * 完全重置图表状态并重新初始化
   * 
   * @param diagramDiv 图表容器 ElementRef
   * @param initDiagram 初始化回调
   * @param onInitialized 初始化成功回调
   * @param scheduleTimer 定时器调度函数
   */
  resetAndRetryDiagram(
    diagramDiv: ElementRef | undefined,
    initDiagram: () => void,
    onInitialized: (delayMs?: number) => void,
    scheduleTimer: (callback: () => void, delay: number) => void
  ): void {
    // 重置所有状态
    this.retryCount = 0;
    this.hasReachedRetryLimit.set(false);
    this.diagram.dispose();

    // 重新初始化
    this.toast.info('重置中...', '正在完全重置流程图');

    scheduleTimer(() => {
      this.zone.run(() => {
        // 检查 DOM 是否准备好
        if (!diagramDiv || !diagramDiv.nativeElement) {
          this.logger.error('[FlowDiagramRetry] 重置时 diagramDiv 不可用');
          this.toast.error('重置失败', '视图未准备好，请稍后重试');
          return;
        }

        initDiagram();
        if (this.diagram.isInitialized) {
          onInitialized(0);
          this.toast.success('重置成功', '流程图已就绪');
        } else {
          // 重置后仍然失败，显示错误但允许再次重试
          this.toast.error('重置失败', '流程图初始化失败，请尝试刷新页面');
        }
      });
    }, 200);
  }

  /**
   * 获取 idle 初始化句柄（用于清理）
   */
  getIdleInitHandle(): number | null {
    return this.idleInitHandle;
  }

  /**
   * 清除 idle 初始化句柄
   */
  clearIdleInitHandle(): void {
    if (this.idleInitHandle !== null && typeof cancelIdleCallback !== 'undefined') {
      cancelIdleCallback(this.idleInitHandle);
      this.idleInitHandle = null;
    }
  }
}
