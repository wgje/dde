import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../core-bridge';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockEngineLifecycleService } from './dock-engine-lifecycle.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockPromotionService } from './dock-promotion.service';
import { DockTaskFlowService } from './dock-task-flow.service';
import { DockTaskSyncService } from './dock-task-sync.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';

const mockLogger = {
  category: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
};

describe('DockTaskFlowService', () => {
  it('should not resolve task operation adapter during construction', () => {
    const throwingTaskOpsProvider = vi.fn(() => {
      throw new Error('TaskOperationAdapterService should not be resolved during dock flow startup');
    });
    const injector = Injector.create({
      providers: [
        DockTaskFlowService,
        { provide: TaskStore, useValue: {} },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ProjectStateService, useValue: {} },
        { provide: TaskOperationAdapterService, useFactory: throwingTaskOpsProvider },
        { provide: DockCompletionFlowService, useValue: {} },
        { provide: DockPromotionService, useValue: {} },
        { provide: DockTaskSyncService, useValue: {} },
        { provide: DockFragmentRestService, useValue: {} },
        { provide: DockEngineLifecycleService, useValue: {} },
      ],
    });

    expect(() => runInInjectionContext(
      injector,
      () => injector.get(DockTaskFlowService),
    )).not.toThrow();
    expect(throwingTaskOpsProvider).not.toHaveBeenCalled();
  });
});
