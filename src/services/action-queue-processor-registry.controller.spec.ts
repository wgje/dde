import { describe, expect, it, vi } from 'vitest';

import { ActionQueueProcessorRegistryController } from './action-queue-processor-registry.controller';
import type { QueuedAction } from './action-queue.types';

function action(type: string, entityType = 'task'): QueuedAction {
  return {
    id: `${entityType}-${type}`,
    operationId: `${entityType}-${type}-op`,
    type,
    entityType,
    entityId: 'entity-1',
    payload: {},
    timestamp: '2026-07-06T00:00:00.000Z',
    retryCount: 0,
    priority: 'normal',
  } as unknown as QueuedAction;
}

describe('ActionQueueProcessorRegistryController', () => {
  it('registers processors and exposes their types', () => {
    const controller = new ActionQueueProcessorRegistryController({
      getPendingActions: () => [],
      requestQueueProcessing: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    });
    const processor = vi.fn();

    controller.registerProcessor('task:update', processor);

    expect(controller.processors.get('task:update')).toBe(processor);
    expect(controller.getRegisteredProcessorTypes()).toEqual(['task:update']);
  });

  it('requests queue processing for matching pending actions after processors are ready', () => {
    const requestQueueProcessing = vi.fn();
    const controller = new ActionQueueProcessorRegistryController({
      getPendingActions: () => [action('update')],
      requestQueueProcessing,
      debug: vi.fn(),
      error: vi.fn(),
    });

    controller.registerProcessor('task:create', vi.fn());
    expect(controller.validateProcessors(['task:create'])).toEqual([]);
    controller.registerProcessor('task:update', vi.fn());

    expect(requestQueueProcessing).toHaveBeenCalledWith('processors-ready');
    expect(requestQueueProcessing).toHaveBeenCalledWith('processor-registered');
  });

  it('reports missing processors without marking the registry ready', () => {
    const error = vi.fn();
    const requestQueueProcessing = vi.fn();
    const controller = new ActionQueueProcessorRegistryController({
      getPendingActions: () => [action('update')],
      requestQueueProcessing,
      debug: vi.fn(),
      error,
    });

    expect(controller.validateProcessors(['task:update'])).toEqual(['task:update']);
    controller.registerProcessor('task:update', vi.fn());

    expect(error).toHaveBeenCalledWith('缺少必需的处理器', { missing: ['task:update'] });
    expect(requestQueueProcessing).not.toHaveBeenCalled();
  });

  it('clears processor registrations without changing ready state', () => {
    const requestQueueProcessing = vi.fn();
    const controller = new ActionQueueProcessorRegistryController({
      getPendingActions: () => [action('update')],
      requestQueueProcessing,
      debug: vi.fn(),
      error: vi.fn(),
    });

    controller.registerProcessor('task:create', vi.fn());
    controller.validateProcessors(['task:create']);
    controller.clearProcessors();
    controller.registerProcessor('task:update', vi.fn());

    expect(controller.getRegisteredProcessorTypes()).toEqual(['task:update']);
    expect(requestQueueProcessing).toHaveBeenCalledWith('processor-registered');
  });
});
