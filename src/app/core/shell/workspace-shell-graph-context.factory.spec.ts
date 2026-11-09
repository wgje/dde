import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Injector, runInInjectionContext } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { ActionQueueService } from '../../../services/action-queue.service';
import { AppLifecycleOrchestratorService } from '../../../services/app-lifecycle-orchestrator.service';
import { AuthService } from '../../../services/auth.service';
import { BeforeUnloadManagerService } from '../../../services/before-unload-manager.service';
import { BeforeUnloadGuardService } from '../../../services/guards';
import { BootStageService } from '../../../services/boot-stage.service';
import { EventBusService } from '../../../services/event-bus.service';
import { FocusPreferenceService } from '../../../services/focus-preference.service';
import { HandoffCoordinatorService } from '../../../services/handoff-coordinator.service';
import { LoggerService } from '../../../services/logger.service';
import { ModalService } from '../../../services/modal.service';
import { NetworkAwarenessService } from '../../../services/network-awareness.service';
import { PreferenceService } from '../../../services/preference.service';
import { ProjectStateService } from '../../../services/project-state.service';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { StartupTierOrchestratorService } from '../../../services/startup-tier-orchestrator.service';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { SyncCoordinatorService } from '../../../services/sync-coordinator.service';
import { ToastService } from '../../../services/toast.service';
import { UiStateService } from '../../../services/ui-state.service';
import { UndoService } from '../../../services/undo.service';
import { UserSessionService } from '../../../services/user-session.service';
import { WidgetBindingService } from '../../../services/widget-binding.service';
import { WorkspaceModalCoordinatorService } from '../../../services/workspace-modal-coordinator.service';
import { AppAuthCoordinatorService } from '../services/app-auth-coordinator.service';
import { AppProjectCoordinatorService } from '../services/app-project-coordinator.service';
import { TaskStore } from '../state/stores';
import {
  createWorkspaceShellGraphContext,
} from './workspace-shell-graph-context.factory';

const CONTEXT_PROVIDER_TOKENS = [
  ['actionQueue', ActionQueueService],
  ['appLifecycle', AppLifecycleOrchestratorService],
  ['authCoord', AppAuthCoordinatorService],
  ['authService', AuthService],
  ['beforeUnloadGuard', BeforeUnloadGuardService],
  ['beforeUnloadManager', BeforeUnloadManagerService],
  ['bootStage', BootStageService],
  ['eventBus', EventBusService],
  ['focusPrefs', FocusPreferenceService],
  ['handoffCoordinator', HandoffCoordinatorService],
  ['modal', ModalService],
  ['modalCoord', WorkspaceModalCoordinatorService],
  ['networkAwareness', NetworkAwarenessService],
  ['preferenceService', PreferenceService],
  ['projectCoord', AppProjectCoordinatorService],
  ['projectState', ProjectStateService],
  ['sentryLazyLoader', SentryLazyLoaderService],
  ['startupTier', StartupTierOrchestratorService],
  ['supabaseClient', SupabaseClientService],
  ['syncCoordinator', SyncCoordinatorService],
  ['taskStore', TaskStore],
  ['toast', ToastService],
  ['uiState', UiStateService],
  ['undoService', UndoService],
  ['userSession', UserSessionService],
  ['widgetBinding', WidgetBindingService],
] as const;

type ContextProviderKey = typeof CONTEXT_PROVIDER_TOKENS[number][0];

function createProviderValues(): Record<ContextProviderKey, object> {
  return Object.fromEntries(
    CONTEXT_PROVIDER_TOKENS.map(([key]) => [key, { key }]),
  ) as Record<ContextProviderKey, object>;
}

function createContextInjector(
  values: Record<ContextProviderKey, object>,
  loggerService: Pick<LoggerService, 'category'>,
): Injector {
  return Injector.create({
    providers: [
      ...CONTEXT_PROVIDER_TOKENS.map(([key, token]) => ({
        provide: token,
        useValue: values[key],
      })),
      { provide: LoggerService, useValue: loggerService },
    ],
  });
}

describe('createWorkspaceShellGraphContext', () => {
  it('resolves shell graph dependencies from Angular injection context', () => {
    const values = createProviderValues();
    const loggerCategory = { warn: vi.fn() };
    const loggerService = {
      category: vi.fn(() => loggerCategory),
    } as unknown as Pick<LoggerService, 'category'>;
    const injector = createContextInjector(values, loggerService);

    const context = runInInjectionContext(
      injector,
      () => createWorkspaceShellGraphContext(),
    );

    for (const [key] of CONTEXT_PROVIDER_TOKENS) {
      expect(context[key]).toBe(values[key]);
    }
    expect(context.injector).toBe(injector);
    expect(context.logger).toBe(loggerCategory);
    expect(loggerService.category).toHaveBeenCalledWith('App');
  });

  it('wires warn and runtime delegates from the graph runtime context factory', () => {
    const values = createProviderValues();
    const loggerCategory = { warn: vi.fn() };
    const loggerService = {
      category: vi.fn(() => loggerCategory),
    } as unknown as Pick<LoggerService, 'category'>;
    const injector = createContextInjector(values, loggerService);
    const context = runInInjectionContext(injector, createWorkspaceShellGraphContext);
    const error = new Error('shell graph warning');

    expect(context.runtime()).toBe(false);
    context.warn('shell graph message', error);
    context.markDestroyed();

    expect(loggerCategory.warn).toHaveBeenCalledWith('shell graph message', error);
    expect(context.runtime()).toBe(true);
  });

  it('keeps graph runtime context assembly out of the service injection factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-graph-context.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellGraphRuntimeContext');
    expect(source).not.toContain('new WorkspaceShellRuntimeStateController');
    expect(source).not.toContain("inject(LoggerService).category('App')");
    expect(source).not.toContain('warn: (message, error) => logger.warn(message, error)');
  });
});
