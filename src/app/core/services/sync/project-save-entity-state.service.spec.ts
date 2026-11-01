import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import {
  SessionRuntimeResetRegistry,
  type SessionRuntimeResetReason,
} from '../../../../services/session-runtime-reset.service';
import { ProjectSaveEntityStateService } from './project-save-entity-state.service';

describe('ProjectSaveEntityStateService session isolation', () => {
  it('owner reset 应清空任务与连接终态冲突抑制，避免新 owner 继承旧账号状态', () => {
    let resetRuntime: ((reason: SessionRuntimeResetReason) => void) | undefined;
    const injector = Injector.create({
      providers: [
        ProjectSaveEntityStateService,
        { provide: ChangeTrackerService, useValue: {} },
        { provide: LoggerService, useValue: { category: () => ({ warn: vi.fn() }) } },
        {
          provide: SessionRuntimeResetRegistry,
          useValue: {
            register: vi.fn((_owner: string, reset: typeof resetRuntime) => {
              resetRuntime = reset;
              return vi.fn();
            }),
          },
        },
      ],
    });
    const service = runInInjectionContext(injector, () => injector.get(ProjectSaveEntityStateService));

    service.suppressTaskUntilFingerprintChanges('project-shared', 'task-shared', 'task-fingerprint');
    service.suppressConnectionUntilFingerprintChanges('project-shared', 'connection-shared', 'connection-fingerprint');
    expect(service.getTerminalTaskIds('project-shared')).toEqual(['task-shared']);
    expect(service.getTerminalConnectionIds('project-shared')).toEqual(['connection-shared']);
    expect(resetRuntime).toBeTypeOf('function');

    resetRuntime?.('owner-change');

    expect(service.getTerminalTaskIds('project-shared')).toEqual([]);
    expect(service.getTerminalConnectionIds('project-shared')).toEqual([]);
    expect(service.isTaskSuppressedUntilFreshEdit('project-shared', 'task-shared', new Set())).toBe(false);
    expect(service.isConnectionSuppressedUntilFreshEdit('project-shared', 'connection-shared', new Set())).toBe(false);
  });
});
