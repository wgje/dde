import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LaunchSnapshot } from './launch-snapshot.service';
import { BootStageService } from './boot-stage.service';
import { HandoffCoordinatorService } from './handoff-coordinator.service';

describe('HandoffCoordinatorService', () => {
  let service: HandoffCoordinatorService;
  let bootStageMock: { markWorkspaceHandoffReady: ReturnType<typeof vi.fn> };
  const launchSnapshot = (overrides: Partial<LaunchSnapshot> = {}): LaunchSnapshot => ({
    version: 2,
    savedAt: '2026-03-25T10:00:00.000Z',
    activeProjectId: 'p-1',
    lastActiveView: 'text',
    preferredView: 'text',
    resolvedLaunchView: 'text',
    routeIntent: { kind: 'project', projectId: 'p-1', taskId: null },
    mobileDegraded: false,
    degradeReason: null,
    theme: 'default',
    colorMode: 'light',
    projects: [],
    currentProject: null,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    bootStageMock = {
      markWorkspaceHandoffReady: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: BootStageService, useValue: bootStageMock },
      ],
    });

    service = runInInjectionContext(injector, () => new HandoffCoordinatorService());
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should stay pending until layout is marked stable', () => {
    const result = service.resolve({
      routeUrl: '/projects/p-1/task/t-9',
      isMobile: true,
      hasProjects: true,
      activeProjectId: 'p-1',
      authConfigured: false,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: false,
      bootstrapFailed: false,
      snapshot: launchSnapshot({
        routeIntent: { kind: 'task', projectId: 'p-1', taskId: 't-9' },
        mobileDegraded: true,
        degradeReason: 'mobile-default-text',
      }),
      snapshotProjectsTrusted: true,
    });

    expect(result.kind).toBe('degraded-to-text');
    expect(result.degradeReason).toBe('mobile-default-text');
    vi.runAllTimers();
    expect(bootStageMock.markWorkspaceHandoffReady).not.toHaveBeenCalled();
  });

  it('should degrade startup mobile flow/task deep links to text before handoff once layout is stable', () => {
    service.markLayoutStable();

    const result = service.resolve({
      routeUrl: '/projects/p-1/task/t-9',
      isMobile: true,
      hasProjects: true,
      activeProjectId: 'p-1',
      authConfigured: false,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: false,
      bootstrapFailed: false,
      snapshot: launchSnapshot({
        routeIntent: { kind: 'task', projectId: 'p-1', taskId: 't-9' },
        mobileDegraded: true,
        degradeReason: 'mobile-default-text',
      }),
      snapshotProjectsTrusted: true,
    });

    expect(result.kind).toBe('degraded-to-text');
    expect(result.degradeReason).toBe('mobile-default-text');
    vi.runAllTimers();
    expect(bootStageMock.markWorkspaceHandoffReady).toHaveBeenCalledTimes(1);
  });

  it('should keep startup desktop flow deep links as full handoff', () => {
    service.markLayoutStable();

    const result = service.resolve({
      routeUrl: '/projects/p-1/flow',
      isMobile: false,
      hasProjects: true,
      activeProjectId: 'p-1',
      authConfigured: false,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: false,
      bootstrapFailed: false,
      snapshot: launchSnapshot({
        routeIntent: { kind: 'flow', projectId: 'p-1', taskId: null },
      }),
      snapshotProjectsTrusted: true,
    });

    expect(result.kind).toBe('full');
    expect(result.degradeReason).toBeNull();
  });

  it('should fall back to empty-workspace when no local projects are available', () => {
    service.markLayoutStable();

    const result = service.resolve({
      routeUrl: '/projects',
      isMobile: true,
      hasProjects: false,
      activeProjectId: null,
      authConfigured: false,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: false,
      bootstrapFailed: false,
      snapshot: null,
      snapshotProjectsTrusted: false,
    });

    expect(result.kind).toBe('empty-workspace');
  });

  it('should expose login-required once auth is settled without a user', () => {
    service.markLayoutStable();

    const result = service.resolve({
      routeUrl: '/projects',
      isMobile: true,
      hasProjects: false,
      activeProjectId: null,
      authConfigured: true,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: true,
      bootstrapFailed: false,
      snapshot: null,
      snapshotProjectsTrusted: false,
    });

    expect(result.kind).toBe('login-required');
  });

  it('should keep local workspace visible when login is required but projects are already restored', () => {
    service.markLayoutStable();

    const result = service.resolve({
      routeUrl: '/projects/p-1',
      isMobile: false,
      hasProjects: true,
      activeProjectId: 'p-1',
      authConfigured: true,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: true,
      bootstrapFailed: false,
      snapshot: launchSnapshot(),
      snapshotProjectsTrusted: true,
    });

    expect(result.kind).toBe('full');
    expect(result.degradeReason).toBe('login-required-nonblocking');
  });

  it('should record timeout0 as handoff trigger source when microtask fallback fires', () => {
    service.markLayoutStable();
    service.resolve({
      routeUrl: '/projects',
      isMobile: false,
      hasProjects: true,
      activeProjectId: 'p-1',
      authConfigured: false,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: false,
      bootstrapFailed: false,
      snapshot: launchSnapshot(),
      snapshotProjectsTrusted: true,
    });

    // microtask 先触发，但在 fake timers 下需用 setTimeout fallback
    vi.advanceTimersByTime(16);

    expect(
      (service as unknown as { handoffTriggerSource: () => string | null }).handoffTriggerSource()
    ).toBe('timeout0');
  });

  it('should degrade to project rail when target project is unavailable but local projects exist', () => {
    service.markLayoutStable();

    const result = service.resolve({
      routeUrl: '/projects/p-404/task/t-1',
      isMobile: false,
      hasProjects: true,
      activeProjectId: null,
      authConfigured: false,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: false,
      bootstrapFailed: false,
      snapshot: launchSnapshot({
        routeIntent: { kind: 'task', projectId: 'p-404', taskId: 't-1' },
      }),
      snapshotProjectsTrusted: true,
    });

    expect(result.kind).toBe('degraded-to-project');
    expect(result.degradeReason).toBe('project-unavailable');
  });

  it('should ignore untrusted snapshot projects and keep login-required gating intact', () => {
    service.markLayoutStable();

    const result = service.resolve({
      routeUrl: '/projects',
      isMobile: true,
      hasProjects: false,
      activeProjectId: null,
      authConfigured: true,
      authRuntimeState: 'ready',
      isCheckingSession: false,
      showLoginRequired: true,
      bootstrapFailed: false,
      snapshot: launchSnapshot({
        projects: [
          {
            id: 'stale-project',
            name: 'Stale Project',
            description: '',
            updatedAt: null,
            taskCount: 0,
            openTaskCount: 0,
            recentTasks: [],
          },
        ],
      }),
      snapshotProjectsTrusted: false,
    });

    expect(result.kind).toBe('login-required');
  });
});
