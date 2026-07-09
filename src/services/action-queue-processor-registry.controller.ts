import type { ActionQueueProcessorResult } from './action-queue-processor-result.helpers';
import type { QueueProcessor } from './action-queue-processing.types';
import type { QueuedAction } from './action-queue.types';

export interface ActionQueueProcessorRegistryOptions {
  getPendingActions: () => QueuedAction[];
  requestQueueProcessing: (reason: string) => void;
  debug: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

export class ActionQueueProcessorRegistryController {
  readonly processors: Map<string, QueueProcessor> = new Map();
  private processorRegistrationReady = false;

  constructor(private readonly options: ActionQueueProcessorRegistryOptions) {}

  registerProcessor(
    type: string,
    processor: (action: QueuedAction) => Promise<ActionQueueProcessorResult>,
  ): void {
    this.processors.set(type, processor);
    this.options.debug('处理器已注册', { type });
    if (this.processorRegistrationReady && this.hasPendingActionsForProcessor(type)) {
      this.options.requestQueueProcessing('processor-registered');
    }
  }

  validateProcessors(requiredProcessors: string[]): string[] {
    const missing = requiredProcessors.filter(type => !this.processors.has(type));
    if (missing.length > 0) {
      this.options.error('缺少必需的处理器', { missing });
      return missing;
    }

    this.markProcessorRegistrationReady();
    return missing;
  }

  isReady(): boolean {
    return this.processorRegistrationReady;
  }

  getRegisteredProcessorTypes(): string[] {
    return Array.from(this.processors.keys());
  }

  clearProcessors(): void {
    this.processors.clear();
  }

  private markProcessorRegistrationReady(): void {
    if (this.processorRegistrationReady) {
      return;
    }

    this.processorRegistrationReady = true;
    if (this.options.getPendingActions().length > 0) {
      this.options.requestQueueProcessing('processors-ready');
    }
  }

  private hasPendingActionsForProcessor(processorType: string): boolean {
    return this.options.getPendingActions().some(action => `${action.entityType}:${action.type}` === processorType);
  }
}
