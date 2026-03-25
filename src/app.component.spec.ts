import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppComponent } from './app.component';
import { BootStageService } from './services/boot-stage.service';
import { LaunchSnapshotService, type LaunchSnapshot } from './services/launch-snapshot.service';
import { WorkspaceStartupPreloaderService } from './services/workspace-startup-preloader.service';

describe('AppComponent (Launch Shell)', () => {
  const launchSnapshot: LaunchSnapshot = {
    version: 1,
    savedAt: '2026-03-25T10:00:00.000Z',
    activeProjectId: 'project-2',
    lastActiveView: 'text',
    theme: 'default',
    colorMode: 'light',
    projects: [
      {
        id: 'project-2',
        name: 'NanoFlow',
        description: '启动性能治理',
        updatedAt: '2026-03-25T09:59:00.000Z',
        taskCount: 3,
        openTaskCount: 2,
        recentTasks: [
          { id: 'task-1', title: '拆分启动壳', displayId: '1', status: 'active' },
        ],
      },
    ],
  };

  let handoffReady: ReturnType<typeof signal<boolean>>;
  let appReady: ReturnType<typeof signal<boolean>>;
  let stylesReady: ReturnType<typeof signal<boolean>>;
  let bootStageMock: {
    currentStage: ReturnType<typeof computed<string>>;
    isWorkspaceHandoffReady: ReturnType<typeof computed<boolean>>;
    isApplicationReady: ReturnType<typeof computed<boolean>>;
    markLaunchShellVisible: ReturnType<typeof vi.fn>;
    markApplicationReady: ReturnType<typeof vi.fn>;
    noteLoaderHidden: ReturnType<typeof vi.fn>;
  };
  let launchSnapshotServiceMock: {
    read: ReturnType<typeof vi.fn>;
  };
  let workspaceStartupPreloaderMock: {
    workspaceStylesReady: ReturnType<typeof computed<boolean>>;
    start: ReturnType<typeof vi.fn>;
    continueAfterLoaderHidden: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    handoffReady = signal(false);
    appReady = signal(false);
    stylesReady = signal(false);

    bootStageMock = {
      currentStage: computed(() => {
        if (appReady()) return 'ready';
        if (handoffReady()) return 'handoff';
        return 'launch-shell';
      }),
      isWorkspaceHandoffReady: computed(() => handoffReady()),
      isApplicationReady: computed(() => appReady()),
      markLaunchShellVisible: vi.fn(),
      markApplicationReady: vi.fn(() => appReady.set(true)),
      noteLoaderHidden: vi.fn(),
    };

    launchSnapshotServiceMock = {
      read: vi.fn(() => launchSnapshot),
    };

    workspaceStartupPreloaderMock = {
      workspaceStylesReady: computed(() => stylesReady()),
      start: vi.fn(),
      continueAfterLoaderHidden: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        { provide: BootStageService, useValue: bootStageMock },
        { provide: LaunchSnapshotService, useValue: launchSnapshotServiceMock },
        { provide: WorkspaceStartupPreloaderService, useValue: workspaceStartupPreloaderMock },
      ],
    });
  });

  it('should render the launch shell before workspace handoff is ready', async () => {
    const fixture = TestBed.createComponent(AppComponent);

    expect(workspaceStartupPreloaderMock.start).not.toHaveBeenCalled();

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(workspaceStartupPreloaderMock.start).toHaveBeenCalledTimes(1);
    expect(launchSnapshotServiceMock.read).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.querySelector('[data-testid="launch-shell"]')).toBeTruthy();
  });

  it('should continue project shell preload after loader hidden', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    window.dispatchEvent(new CustomEvent('nanoflow:loader-hidden'));

    expect(workspaceStartupPreloaderMock.continueAfterLoaderHidden).toHaveBeenCalledTimes(1);
  });

  it('should hide launch shell when workspace handoff is ready', async () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    // styles.css 已恢复到静态构建，showLaunchShell 仅依赖 handoff
    handoffReady.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(bootStageMock.markApplicationReady).toHaveBeenCalledTimes(1);
    expect(fixture.nativeElement.querySelector('[data-testid="launch-shell"]')).toBeFalsy();
  });
});
