import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import {
  ProjectStateService,
  type ActiveProjectOwner,
} from '../../../../services/project-state.service';

/**
 * 流程图命令类型枚举
 * 
 * 定义所有可能的流程图操作命令
 */
export enum FlowCommandType {
  /** 居中到指定节点 */
  CenterOnNode = 'CENTER_ON_NODE',
  /** 重试初始化图表 */
  RetryDiagram = 'RETRY_DIAGRAM',
  /** 缩放到适合视口 */
  ZoomToFit = 'ZOOM_TO_FIT',
  /** 放大 */
  ZoomIn = 'ZOOM_IN',
  /** 缩小 */
  ZoomOut = 'ZOOM_OUT',
  /** 自动布局 */
  AutoLayout = 'AUTO_LAYOUT',
  /** 导出为图片 */
  ExportImage = 'EXPORT_IMAGE'
}

/**
 * 通用命令队列仅作为诊断历史，限制其内存和每次追加的复制成本。
 */
export const FLOW_COMMAND_DIAGNOSTIC_HISTORY_LIMIT = 100;

/**
 * 流程图命令接口
 * 
 * 纯数据结构，可序列化，不包含运行时逻辑
 */
export interface FlowCommand {
  /** 唯一标识符，用于去重和确认消费 */
  id: string;
  /** 命令类型 */
  type: FlowCommandType;
  /** 命令携带的参数 */
  payload?: Record<string, unknown>;
  /** 创建时间戳，用于排序或过期处理 */
  timestamp: number;
}

/**
 * 居中到节点命令的 payload 类型
 */
export interface CenterNodePayload extends Record<string, unknown> {
  taskId: string;
  openDetail: boolean;
}

export interface CenterNodeCommandClaim {
  readonly commandId: number;
  readonly owner: ActiveProjectOwner;
  readonly payload: CenterNodePayload;
}

/**
 * 流程图命令服务
 * 
 * 作用：解耦 ProjectShellComponent 和 FlowViewComponent
 * 使 @defer 懒加载真正生效
 * 
 * 设计决策：
 * - 使用 Angular Signals 而非 RxJS Subject（符合项目架构）
 * - 命令包含 timestamp 确保相同参数也能触发响应
 * - 命令模式而非直接调用，支持 FlowView 未加载时的命令缓存
 * - 实现乐观 UI：界面立即响应用户操作，不等待底层执行完成
 * 
 * 核心机制：
 * 1. 命令队列模式：Shell 发布意图，View 订阅并响应
 * 2. 待处理命令缓存：解决 FlowView 未加载时的命令丢失问题
 * 3. 信号驱动：利用 Angular Signals 的同步响应特性
 * 
 * @example
 * // 在 ProjectShellComponent 中
 * this.flowCommand.centerOnNode('task-123', true);
 * 
 * // 在 FlowViewComponent 中通过 effect() 自动响应
 */
@Injectable({ providedIn: 'root' })
export class FlowCommandService {
  private readonly logger = new LoggerService().category('FlowCommand');
  private readonly projectState = inject(ProjectStateService);

  // ========== 命令队列信号 ==========
  
  /**
   * 命令队列信号
   * 仅保留有限的诊断历史，不作为 Flow 行为的消费通道
   */
  private readonly _commandQueue = signal<FlowCommand[]>([]);
  
  /**
   * 只读命令队列（供外部订阅）
   */
  readonly commandQueue = this._commandQueue.asReadonly();

  /**
   * 队列中是否有待处理命令
   */
  readonly hasPendingCommands = computed(() => this._commandQueue().length > 0);

  // ========== 专用命令信号（简化常用操作） ==========

  /**
   * 居中到节点命令信号
   * 每次写入触发 FlowViewComponent 响应
   */
  private readonly _pendingCenterCommand = signal<CenterNodeCommandClaim | null>(null);
  readonly centerNodeCommand = computed(() => {
    const command = this._pendingCenterCommand();
    return command && this.projectState.isActiveProjectOwnerCurrent(command.owner)
      ? command.payload
      : null;
  });

  /**
   * 重试初始化命令信号
   * 值递增时触发重试
   */
  private readonly _retryDiagramCommand = signal<number>(0);
  readonly retryDiagramCommand = this._retryDiagramCommand.asReadonly();

  // ========== 待执行命令缓存 ==========

  /**
   * 待执行的居中命令
   * FlowView 未加载时缓存，初始化后执行
   */
  private nextCenterCommandId = 0;

  /** 只有发布 readiness 的精确 ActiveProjectOwner 仍有效时才可消费命令。 */
  private readonly _readyOwner = signal<ActiveProjectOwner | null>(null);
  readonly isViewReady = computed(() => {
    const owner = this._readyOwner();
    return owner !== null && this.projectState.isActiveProjectOwnerCurrent(owner);
  });

  constructor() {
    // 调试日志
    effect(() => {
      const queue = this._commandQueue();
      if (queue.length > 0) {
        this.logger.debug('命令队列更新', { 
          count: queue.length, 
          types: queue.map(c => c.type) 
        });
      }
    });
  }

  // ========== 公共 API ==========

  /**
   * 发送居中到节点命令
   * 
   * @param taskId 目标任务 ID
   * @param openDetail 是否打开详情面板
   */
  centerOnNode(taskId: string, openDetail: boolean = true): void {
    const payload: CenterNodePayload = { taskId, openDetail };
    const command = Object.freeze({
      commandId: ++this.nextCenterCommandId,
      owner: Object.freeze({ ...this.projectState.captureActiveProjectOwner() }),
      payload: Object.freeze(payload),
    });
    this._pendingCenterCommand.set(command);
    
    // 3. 同时加入通用队列（用于调试和日志）
    this.dispatch(FlowCommandType.CenterOnNode, payload);

    this.logger.debug('发送居中命令', { taskId, openDetail });
  }

  /**
   * 发送重试初始化命令
   */
  retryDiagram(): void {
    this._retryDiagramCommand.update(v => v + 1);
    this.dispatch(FlowCommandType.RetryDiagram);
    this.logger.debug('发送重试命令');
  }

  /**
   * 发送缩放到适合命令
   */
  zoomToFit(): void {
    this.dispatch(FlowCommandType.ZoomToFit);
  }

  /**
   * 发送自动布局命令
   */
  autoLayout(): void {
    this.dispatch(FlowCommandType.AutoLayout);
  }

  /**
   * 通用命令分发方法
   * 仅保留最近的诊断历史；Flow 行为由专用信号和 owner claim 驱动。
   */
  dispatch(type: FlowCommandType, payload?: Record<string, unknown>): void {
    const command: FlowCommand = {
      id: crypto.randomUUID(),
      type,
      payload,
      timestamp: Date.now()
    };
    
    this._commandQueue.update(queue => {
      const nextQueue = [...queue, command];
      return nextQueue.length > FLOW_COMMAND_DIAGNOSTIC_HISTORY_LIMIT
        ? nextQueue.slice(-FLOW_COMMAND_DIAGNOSTIC_HISTORY_LIMIT)
        : nextQueue;
    });
  }

  // ========== View 端 API ==========

  /** 仅接受由 viewport controller 在 settlement issuance 时捕获的 owner。 */
  markViewReady(owner: ActiveProjectOwner = this.projectState.captureActiveProjectOwner()): void {
    if (owner.projectId === null || !this.projectState.isActiveProjectOwnerCurrent(owner)) return;
    this._readyOwner.set(Object.freeze({ ...owner }));
    this.logger.debug('FlowView 已就绪', owner);
  }

  /**
   * 标记 FlowView 已销毁
   * 由 FlowViewComponent 在 ngOnDestroy 时调用
   */
  markViewDestroyed(): void {
    this._readyOwner.set(null);
    this.logger.debug('FlowView 已销毁');
  }

  /** 非破坏性领取；失效 owner 的命令会被退休。 */
  claimPendingCenterCommand(): CenterNodeCommandClaim | null {
    const command = this._pendingCenterCommand();
    if (!command) return null;
    if (!this.projectState.isActiveProjectOwnerCurrent(command.owner)) {
      this._pendingCenterCommand.set(null);
      return null;
    }
    return command;
  }

  /** 仅确认精确领取对象，迟到确认不得清除后继命令。 */
  acknowledgePendingCenterCommand(command: CenterNodeCommandClaim): boolean {
    if (this._pendingCenterCommand() !== command
      || !this.projectState.isActiveProjectOwnerCurrent(command.owner)) return false;
    this._pendingCenterCommand.set(null);
    this.logger.debug('确认居中命令', { commandId: command.commandId });
    return true;
  }

  /**
   * 消费确认方法
   * 由 View 调用，用于清理已执行的命令，防止重复执行
   */
  acknowledgeCommands(processedIds: string[]): void {
    const oldLength = this._commandQueue().length;
    
    this._commandQueue.update(queue => 
      queue.filter(cmd => !processedIds.includes(cmd.id))
    );

    const newLength = this._commandQueue().length;
    if (oldLength !== newLength) {
      this.logger.debug('命令已确认消费', { 
        processed: processedIds.length, 
        remaining: newLength 
      });
    }
  }

  /**
   * 清空所有待处理命令
   * 通常在组件销毁或重置时调用
   */
  clearAllCommands(): void {
    this._commandQueue.set([]);
    this._pendingCenterCommand.set(null);
    this.logger.debug('已清空所有命令');
  }
}
