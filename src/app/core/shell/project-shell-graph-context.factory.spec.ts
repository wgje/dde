import { Injector, runInInjectionContext } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { DockEngineService } from '../../../services/dock-engine.service';
import { HandoffCoordinatorService } from '../../../services/handoff-coordinator.service';
import { LaunchSnapshotService } from '../../../services/launch-snapshot.service';
import { LoggerService } from '../../../services/logger.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { TabSyncService } from '../../../services/tab-sync.service';
import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { ToastService } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';
import { UserSessionService } from '../../../services/user-session.service';
import { FlowCommandService } from '../../features/flow/services/flow-command.service';
import {
  createProjectShellGraphContext,
} from './project-shell-graph-context.factory';

const PROVIDER_TOKENS = [
  ['dockEngine', DockEngineService],
  ['flowCommand', FlowCommandService],
  ['handoffCoordinator', HandoffCoordinatorService],
  ['projectState', ProjectStateService],
  ['route', ActivatedRoute],
  ['router', Router],
  ['syncCoordinator', SyncCoordinatorService],
  ['tabSync', TabSyncService],
  ['toast', ToastService],
  ['uiState', UiStateService],
  ['userSession', UserSessionService],
] as const;

type ProviderKey = typeof PROVIDER_TOKENS[number][0];

describe('createProjectShellGraphContext', () => {
  it('resolves project shell dependencies and startup state from Angular context', () => {
    const values = Object.fromEntries(
      PROVIDER_TOKENS.map(([key]) => [key, { key }]),
    ) as Record<ProviderKey, object>;
    const startupLaunchSnapshot = { routeIntent: null };
    const launchSnapshot = { read: vi.fn(() => startupLaunchSnapshot) };
    const logger = { debug: vi.fn() };
    const loggerService = { category: vi.fn(() => logger) };
    const injector = Injector.create({
      providers: [
        ...PROVIDER_TOKENS.map(([key, token]) => ({
          provide: token,
          useValue: values[key],
        })),
        { provide: LaunchSnapshotService, useValue: launchSnapshot },
        { provide: LoggerService, useValue: loggerService },
      ],
    });

    const context = runInInjectionContext(
      injector,
      createProjectShellGraphContext,
    );

    for (const [key] of PROVIDER_TOKENS) {
      expect(context[key]).toBe(values[key]);
    }
    expect(context.destroyRef).toBe(injector);
    expect(context.injector).toBe(injector);
    expect(context.logger).toBe(logger);
    expect(context.startupLaunchSnapshot).toBe(startupLaunchSnapshot);
    expect(launchSnapshot.read).toHaveBeenCalledOnce();
    expect(loggerService.category).toHaveBeenCalledWith('ProjectShell');
  });

  it('keeps TaskOperationAdapterService lazy until the route delegate needs it', () => {
    let taskOpsResolutions = 0;
    const addFloatingTask = vi.fn();
    const injector = Injector.create({
      providers: [
        ...PROVIDER_TOKENS.map(([, token]) => ({
          provide: token,
          useValue: {},
        })),
        { provide: LaunchSnapshotService, useValue: { read: () => null } },
        {
          provide: LoggerService,
          useValue: { category: () => ({ debug: vi.fn() }) },
        },
        {
          provide: TaskOperationAdapterService,
          useFactory: () => {
            taskOpsResolutions += 1;
            return { addFloatingTask };
          },
        },
      ],
    });

    const context = runInInjectionContext(
      injector,
      createProjectShellGraphContext,
    );

    expect(taskOpsResolutions).toBe(0);
    const invokeLazyTaskOp = context.taskOpsAdapter.addFloatingTask as unknown as (
      ...args: unknown[]
    ) => unknown;
    invokeLazyTaskOp();
    expect(taskOpsResolutions).toBe(1);
    expect(addFloatingTask).toHaveBeenCalledOnce();
  });
});
