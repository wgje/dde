import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellDestroyController } from './workspace-shell-destroy.controller';

function createController(overrides: {
  isResumeInteractionFirstEnabled?: () => boolean;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const record: string[] = [];
  const push = (label: string) => vi.fn(() => record.push(label));
  const controller = new WorkspaceShellDestroyController({
    warn: overrides.warn,
    initialPhase: {
      markDestroyed: push('component.destroyed'),
      teardownSignalEffects: push('signalEffects.teardown'),
      teardownStartupBootstrap: push('startupBootstrap.teardown'),
      teardownStorageEscape: push('storageEscape.teardown'),
      teardownStartupEntryIntent: push('startupEntryIntent.teardown'),
      flushPendingUndoAction: push('undo.flushPendingAction'),
      clearModalCallbacks: push('modalCoord.clearCallbacks'),
      cleanupConflictHandler: push('conflictHandler.cleanup'),
      cleanupRouteSync: push('routeSync.cleanup'),
      cleanupSessionTransition: push('sessionTransition.cleanup'),
      teardownRemoteCallbacks: push('remoteCallbacks.teardown'),
      teardownNgOnInitStartup: push('ngOnInitStartup.teardown'),
      teardownStartupLazyServices: push('startupLazyServices.teardown'),
      cleanupSidebarToggleEvent: push('sidebarToggleEvent.cleanup'),
    },
    interactionPhase: {
      teardownKeyboardShortcutsStage: push('lazyLifecycles.teardownKeyboardShortcutsStage'),
      teardownInteractionDestroyStage: push('interactionLifecycle.teardownDestroyStage'),
      teardownToolLazyLoad: push('toolLazyLoad.teardown'),
      teardownAndroidWidget: push('androidWidget.teardown'),
      teardownFocusMountIntent: push('focusMountIntent.teardown'),
    },
    runtimePhase: {
      clearFocusEntrySyncPulseRetry: push('syncPulse.clearFocusEntrySyncPulseRetry'),
      teardownFlowPrewarm: push('flowPrewarm.teardown'),
      teardownStartupStage: push('lazyLifecycles.teardownStartupStage'),
      destroySyncPulse: push('syncPulse.destroy'),
      destroyStartupTier: push('startupTier.destroy'),
      clearProjectSubscription: push('projectSubscription.clear'),
      isResumeInteractionFirstEnabled:
        overrides.isResumeInteractionFirstEnabled ?? (() => true),
    },
    finalPhase: {
      cleanupBeforeUnload: push('beforeUnload.cleanup'),
      cleanupSearch: push('search.cleanup'),
      cleanupInteractionViewportStage: push('interactionLifecycle.cleanupViewportStage'),
    },
  });

  return { controller, record };
}

describe('WorkspaceShellDestroyController', () => {
  it('groups destroy dependencies by lifecycle phase instead of one flat callback bag', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-destroy.controller.ts'),
      'utf8',
    );

    expect(source).toContain('initialPhase: WorkspaceShellDestroyInitialPhaseOptions');
    expect(source).toContain('interactionPhase: WorkspaceShellDestroyInteractionPhaseOptions');
    expect(source).toContain('runtimePhase: WorkspaceShellDestroyRuntimePhaseOptions');
    expect(source).toContain('finalPhase: WorkspaceShellDestroyFinalPhaseOptions');
    const controllerOptionsBlock = source.match(
      /export interface WorkspaceShellDestroyControllerOptions \{[\s\S]*?\n\}/,
    )?.[0] ?? '';

    expect(controllerOptionsBlock).not.toContain('flushPendingUndoAction');
    expect(controllerOptionsBlock).not.toContain('cleanupInteractionViewportStage');
  });

  it('runs workspace shell teardown in the existing order', () => {
    const { controller, record } = createController();

    controller.destroy();

    expect(record).toEqual([
      'component.destroyed',
      'signalEffects.teardown',
      'startupBootstrap.teardown',
      'storageEscape.teardown',
      'startupEntryIntent.teardown',
      'undo.flushPendingAction',
      'modalCoord.clearCallbacks',
      'conflictHandler.cleanup',
      'routeSync.cleanup',
      'sessionTransition.cleanup',
      'remoteCallbacks.teardown',
      'ngOnInitStartup.teardown',
      'startupLazyServices.teardown',
      'sidebarToggleEvent.cleanup',
      'lazyLifecycles.teardownKeyboardShortcutsStage',
      'interactionLifecycle.teardownDestroyStage',
      'toolLazyLoad.teardown',
      'androidWidget.teardown',
      'focusMountIntent.teardown',
      'syncPulse.clearFocusEntrySyncPulseRetry',
      'flowPrewarm.teardown',
      'lazyLifecycles.teardownStartupStage',
      'syncPulse.destroy',
      'startupTier.destroy',
      'projectSubscription.clear',
      'beforeUnload.cleanup',
      'search.cleanup',
      'interactionLifecycle.cleanupViewportStage',
    ]);
  });

  it('does not repeat destroy phases after the first destroy call', () => {
    const { controller, record } = createController();

    controller.destroy();
    const firstDestroyRecord = [...record];
    controller.destroy();

    expect(record).toEqual(firstDestroyRecord);
  });

  it('skips project subscription cleanup when resume-interaction startup is disabled', () => {
    const { controller, record } = createController({
      isResumeInteractionFirstEnabled: () => false,
    });

    controller.destroy();

    expect(record).not.toContain('projectSubscription.clear');
  });

  it('still clears project subscription when the resume-interaction flag check throws', () => {
    const error = new Error('resume flag failed');
    const warn = vi.fn();
    const { controller, record } = createController({
      isResumeInteractionFirstEnabled: () => {
        throw error;
      },
      warn,
    });

    expect(() => controller.destroy()).not.toThrow();

    expect(record).toContain('projectSubscription.clear');
    expect(record.indexOf('projectSubscription.clear'))
      .toBeGreaterThan(record.indexOf('startupTier.destroy'));
    expect(record.indexOf('projectSubscription.clear'))
      .toBeLessThan(record.indexOf('beforeUnload.cleanup'));
    expect(record).toContain('search.cleanup');
    expect(record).toContain('interactionLifecycle.cleanupViewportStage');
    expect(warn).toHaveBeenCalledWith(
      '工作区销毁步骤 isResumeInteractionFirstEnabled 执行失败，已继续清理后续资源',
      error,
    );
  });

  it('continues later cleanup steps when a destroy step throws', () => {
    const error = new Error('route cleanup failed');
    const warn = vi.fn();
    const record: string[] = [];
    const push = (label: string) => vi.fn(() => record.push(label));
    const controller = new WorkspaceShellDestroyController({
      warn,
      initialPhase: {
        markDestroyed: push('component.destroyed'),
        teardownSignalEffects: push('signalEffects.teardown'),
        teardownStartupBootstrap: push('startupBootstrap.teardown'),
        teardownStorageEscape: push('storageEscape.teardown'),
        teardownStartupEntryIntent: push('startupEntryIntent.teardown'),
        flushPendingUndoAction: push('undo.flushPendingAction'),
        clearModalCallbacks: push('modalCoord.clearCallbacks'),
        cleanupConflictHandler: push('conflictHandler.cleanup'),
        cleanupRouteSync: vi.fn(() => {
          record.push('routeSync.cleanup');
          throw error;
        }),
        cleanupSessionTransition: push('sessionTransition.cleanup'),
        teardownRemoteCallbacks: push('remoteCallbacks.teardown'),
        teardownNgOnInitStartup: push('ngOnInitStartup.teardown'),
        teardownStartupLazyServices: push('startupLazyServices.teardown'),
        cleanupSidebarToggleEvent: push('sidebarToggleEvent.cleanup'),
      },
      interactionPhase: {
        teardownKeyboardShortcutsStage: push('lazyLifecycles.teardownKeyboardShortcutsStage'),
        teardownInteractionDestroyStage: push('interactionLifecycle.teardownDestroyStage'),
        teardownToolLazyLoad: push('toolLazyLoad.teardown'),
        teardownAndroidWidget: push('androidWidget.teardown'),
        teardownFocusMountIntent: push('focusMountIntent.teardown'),
      },
      runtimePhase: {
        clearFocusEntrySyncPulseRetry: push('syncPulse.clearFocusEntrySyncPulseRetry'),
        teardownFlowPrewarm: push('flowPrewarm.teardown'),
        teardownStartupStage: push('lazyLifecycles.teardownStartupStage'),
        destroySyncPulse: push('syncPulse.destroy'),
        destroyStartupTier: push('startupTier.destroy'),
        clearProjectSubscription: push('projectSubscription.clear'),
        isResumeInteractionFirstEnabled: () => true,
      },
      finalPhase: {
        cleanupBeforeUnload: push('beforeUnload.cleanup'),
        cleanupSearch: push('search.cleanup'),
        cleanupInteractionViewportStage: push('interactionLifecycle.cleanupViewportStage'),
      },
    });

    expect(() => controller.destroy()).not.toThrow();

    expect(record).toEqual([
      'component.destroyed',
      'signalEffects.teardown',
      'startupBootstrap.teardown',
      'storageEscape.teardown',
      'startupEntryIntent.teardown',
      'undo.flushPendingAction',
      'modalCoord.clearCallbacks',
      'conflictHandler.cleanup',
      'routeSync.cleanup',
      'sessionTransition.cleanup',
      'remoteCallbacks.teardown',
      'ngOnInitStartup.teardown',
      'startupLazyServices.teardown',
      'sidebarToggleEvent.cleanup',
      'lazyLifecycles.teardownKeyboardShortcutsStage',
      'interactionLifecycle.teardownDestroyStage',
      'toolLazyLoad.teardown',
      'androidWidget.teardown',
      'focusMountIntent.teardown',
      'syncPulse.clearFocusEntrySyncPulseRetry',
      'flowPrewarm.teardown',
      'lazyLifecycles.teardownStartupStage',
      'syncPulse.destroy',
      'startupTier.destroy',
      'projectSubscription.clear',
      'beforeUnload.cleanup',
      'search.cleanup',
      'interactionLifecycle.cleanupViewportStage',
    ]);
    expect(warn).toHaveBeenCalledWith(
      '工作区销毁步骤 cleanupRouteSync 执行失败，已继续清理后续资源',
      error,
    );
  });
});
