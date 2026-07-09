import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellLaunchSnapshotController,
  readWorkspaceLaunchSnapshotColorMode,
  type WorkspaceShellLaunchSnapshotControllerOptions,
} from './workspace-shell-launch-snapshot.controller';
import type { Project } from '../../../models';

function createController(
  overrides: Partial<WorkspaceShellLaunchSnapshotControllerOptions> = {},
) {
  const projects = [] as Project[];
  const cancelPendingPersist = vi.fn();
  const schedulePersistDeferred = vi.fn();
  const controller = new WorkspaceShellLaunchSnapshotController({
    isWriteBlocked: () => false,
    isHintOnlyStartupPlaceholderVisible: () => false,
    cancelPendingPersist,
    projects: () => projects,
    currentUserId: () => 'user-1',
    isSessionInitialized: () => true,
    isCheckingSession: () => false,
    getPersistOwnerDuringAuthSettle: () => null,
    activeProjectId: () => 'project-1',
    activeView: () => 'flow',
    routeUrl: () => '/projects/project-1/flow',
    isMobile: () => false,
    theme: () => 'default',
    readColorMode: () => 'dark',
    schedulePersistDeferred,
    ...overrides,
  });

  return {
    cancelPendingPersist,
    controller,
    projects,
    schedulePersistDeferred,
  };
}

describe('WorkspaceShellLaunchSnapshotController', () => {
  it('resolves the current user id when a confirmed user is available', () => {
    const { controller } = createController({
      currentUserId: () => 'confirmed-user',
    });

    expect(controller.resolveUserId()).toBe('confirmed-user');
  });

  it('pauses launch snapshot owner writes while auth is settling without a confirmed owner', () => {
    const { controller } = createController({
      currentUserId: () => null,
      isSessionInitialized: () => false,
      isCheckingSession: () => false,
      getPersistOwnerDuringAuthSettle: () => null,
    });

    expect(controller.resolveUserId()).toBeNull();
  });

  it('uses the prehydrated owner while auth is settling', () => {
    const { controller } = createController({
      currentUserId: () => null,
      isSessionInitialized: () => false,
      getPersistOwnerDuringAuthSettle: () => 'offline-owner',
    });

    expect(controller.resolveUserId()).toBe('offline-owner');
  });

  it('returns null when auth is stable and no user is active', () => {
    const { controller } = createController({
      currentUserId: () => null,
      isSessionInitialized: () => true,
      isCheckingSession: () => false,
      getPersistOwnerDuringAuthSettle: () => 'stale-owner',
    });

    expect(controller.resolveUserId()).toBeNull();
  });

  it('cancels pending persistence when hint-only startup placeholder is visible', () => {
    const { cancelPendingPersist, controller, schedulePersistDeferred } = createController({
      isHintOnlyStartupPlaceholderVisible: () => true,
    });

    controller.sync();

    expect(cancelPendingPersist).toHaveBeenCalledTimes(1);
    expect(schedulePersistDeferred).not.toHaveBeenCalled();
  });

  it('cancels pending persistence while launch snapshot writes are blocked', () => {
    const { cancelPendingPersist, controller, schedulePersistDeferred } = createController({
      isWriteBlocked: () => true,
    });

    controller.sync();

    expect(cancelPendingPersist).toHaveBeenCalledTimes(1);
    expect(schedulePersistDeferred).not.toHaveBeenCalled();
  });

  it('cancels pending persistence when no launch snapshot owner can be resolved', () => {
    const { cancelPendingPersist, controller, schedulePersistDeferred } = createController({
      currentUserId: () => null,
      isSessionInitialized: () => true,
      isCheckingSession: () => false,
      getPersistOwnerDuringAuthSettle: () => null,
    });

    controller.sync();

    expect(cancelPendingPersist).toHaveBeenCalledTimes(1);
    expect(schedulePersistDeferred).not.toHaveBeenCalled();
  });

  it('schedules a deferred launch snapshot persist with mobile degrade metadata', () => {
    const { controller, projects, schedulePersistDeferred } = createController({
      activeView: () => null,
      routeUrl: () => '/projects/project-1/task/task-1',
      isMobile: () => true,
    });

    controller.sync();

    expect(schedulePersistDeferred).toHaveBeenCalledWith(projects, {
      userId: 'user-1',
      activeProjectId: 'project-1',
      lastActiveView: null,
      routeUrl: '/projects/project-1/task/task-1',
      resolvedLaunchView: 'text',
      mobileDegraded: true,
      degradeReason: 'mobile-default-text',
      theme: 'default',
      colorMode: 'dark',
    });
  });
});

describe('readWorkspaceLaunchSnapshotColorMode', () => {
  it('reads light and dark color modes from the document root', () => {
    const documentRef = {
      documentElement: {
        getAttribute: vi.fn(() => 'light'),
      },
    } as unknown as Document;

    expect(readWorkspaceLaunchSnapshotColorMode(documentRef)).toBe('light');
  });

  it('falls back to system for unknown or missing color mode', () => {
    const documentRef = {
      documentElement: {
        getAttribute: vi.fn(() => 'auto'),
      },
    } as unknown as Document;

    expect(readWorkspaceLaunchSnapshotColorMode(documentRef)).toBe('system');
    expect(readWorkspaceLaunchSnapshotColorMode(undefined)).toBe('system');
  });
});
