import { LOCAL_QUEUE_CONFIG } from './action-queue-storage.helpers';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';

interface ActionQueueDeadLetterLogger {
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

interface ActionQueueDeadLetterToast {
  warning: (title: string, message: string) => void;
  error: (title: string, message: string) => void;
}

interface ActionQueueDeadLetterTelemetry {
  addBreadcrumb: (breadcrumb: {
    category?: string;
    message?: string;
    level?: 'warning';
    data?: Record<string, unknown>;
  }) => void;
  captureMessage: (message: string, context?: {
    level?: 'warning';
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
  }) => void;
}

export interface ActionQueueDeadLetterNotifierOptions {
  logger: ActionQueueDeadLetterLogger;
  toast: ActionQueueDeadLetterToast;
  sentryLazyLoader: ActionQueueDeadLetterTelemetry;
  getFailureCallbacks: () => Array<(item: DeadLetterItem) => void>;
  getDeadLetterQueue: () => DeadLetterItem[];
  getActionDescription: (action: QueuedAction) => string;
}

export class ActionQueueDeadLetterNotifier {
  private criticalThresholdNotified = false;

  constructor(private readonly options: ActionQueueDeadLetterNotifierOptions) {}

  handleDeadLetterMoved(deadLetterItem: DeadLetterItem, reason: string): void {
    const action = deadLetterItem.action;
    this.notifyDeadLetterFailure(deadLetterItem);
    this.notifyCriticalDeadLetterFailure(action);
    this.recordDeadLetterBreadcrumb(action, reason);

    this.safeWarn('Action moved to dead letter queue:', {
      actionId: action.id,
      type: action.type,
      entityType: action.entityType,
      entityId: action.entityId,
      priority: action.priority,
      reason
    });
  }

  pauseDependentActions(entityType: string, entityId: string, queue: QueuedAction[]): void {
    const dependentActions = queue.filter(a =>
      a.entityType === entityType && a.entityId === entityId && a.type !== 'create'
    );

    if (dependentActions.length === 0) {
      return;
    }

    this.safeWarn('Create 失败，暂停依赖操作', {
      entityType,
      entityId,
      dependentCount: dependentActions.length,
      dependentTypes: dependentActions.map(a => a.type)
    });

    this.safeCaptureMessage('Create failed, dependent actions paused', {
      level: 'warning',
      tags: { operation: 'pauseDependentActions', entityType },
      extra: {
        entityId,
        dependentCount: dependentActions.length,
        dependentActions: dependentActions.map(a => ({ id: a.id, type: a.type }))
      }
    });

    if (dependentActions.some(a => a.priority === 'critical')) {
      this.safeToastWarning('同步受阻', '有操作因前置操作失败而暂停，请检查网络连接');
    }
  }

  private notifyDeadLetterFailure(deadLetterItem: DeadLetterItem): void {
    let callbacks: Array<(item: DeadLetterItem) => void>;
    try {
      callbacks = this.options.getFailureCallbacks();
    } catch (error) {
      this.safeError('Dead letter callback provider error', { error });
      return;
    }

    for (const callback of callbacks) {
      try {
        callback(deadLetterItem);
      } catch (e) {
        this.safeError('Dead letter callback error', { error: e });
      }
    }
  }

  private notifyCriticalDeadLetterFailure(action: QueuedAction): void {
    if (action.priority !== 'critical') {
      return;
    }

    const criticalFailures = this.readDeadLetterQueue()
      .filter(d => d.action.priority === 'critical');
    if (criticalFailures.length === 1) {
      this.criticalThresholdNotified = false;
      this.safeToastWarning(
        '操作未能同步',
        `"${this.options.getActionDescription(action)}" 同步失败，稍后将自动重试`,
      );
      this.safeWarn('首次关键操作失败，已通知用户', {
        actionId: action.id,
        entityType: action.entityType,
        type: action.type
      });
      return;
    }

    if (criticalFailures.length < LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD) {
      this.criticalThresholdNotified = false;
      return;
    }

    if (this.criticalThresholdNotified) {
      return;
    }

    this.criticalThresholdNotified = true;
    this.safeToastError(
      '同步失败',
      `有 ${criticalFailures.length} 个重要操作无法完成同步，请检查网络或稍后重试`,
    );
    this.safeWarn('关键操作失败超过阈值，已通知用户', {
      count: criticalFailures.length,
      threshold: LOCAL_QUEUE_CONFIG.CRITICAL_FAILURE_NOTIFY_THRESHOLD
    });
  }

  private recordDeadLetterBreadcrumb(action: QueuedAction, reason: string): void {
    try {
      this.options.sentryLazyLoader.addBreadcrumb({
        category: 'sync',
        message: 'Action moved to dead letter',
        level: 'warning',
        data: {
          actionId: action.id,
          entityType: action.entityType,
          entityId: action.entityId,
          type: action.type,
          priority: action.priority,
          reason,
          deadLetterSize: this.readDeadLetterQueue().length
        }
      });
    } catch (error) {
      this.safeError('Dead letter breadcrumb error', { error });
    }
  }

  private readDeadLetterQueue(): DeadLetterItem[] {
    try {
      return this.options.getDeadLetterQueue();
    } catch (error) {
      this.safeError('Dead letter queue provider error', { error });
      return [];
    }
  }

  private safeWarn(message: string, data?: unknown): void {
    try {
      this.options.logger.warn(message, data);
    } catch {
      // Dead-letter settlement must not depend on observability sinks.
    }
  }

  private safeError(message: string, data?: unknown): void {
    try {
      this.options.logger.error(message, data);
    } catch {
      // Dead-letter settlement must not depend on observability sinks.
    }
  }

  private safeToastWarning(title: string, message: string): void {
    try {
      this.options.toast.warning(title, message);
    } catch (error) {
      this.safeError('Dead letter warning toast error', { error });
    }
  }

  private safeToastError(title: string, message: string): void {
    try {
      this.options.toast.error(title, message);
    } catch (error) {
      this.safeError('Dead letter error toast error', { error });
    }
  }

  private safeCaptureMessage(
    message: string,
    context?: {
      level?: 'warning';
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    },
  ): void {
    try {
      this.options.sentryLazyLoader.captureMessage(message, context);
    } catch (error) {
      this.safeError('Dead letter telemetry message error', { error });
    }
  }
}
