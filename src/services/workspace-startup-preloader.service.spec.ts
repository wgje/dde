import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_STARTUP_ASSET_LOADER,
  type WorkspaceStartupAssetLoader,
  WorkspaceStartupPreloaderService,
} from './workspace-startup-preloader.service';

describe('WorkspaceStartupPreloaderService', () => {
  function createService(loader: WorkspaceStartupAssetLoader) {
    const injector = Injector.create({
      providers: [
        { provide: WORKSPACE_STARTUP_ASSET_LOADER, useValue: loader },
        { provide: WorkspaceStartupPreloaderService, useClass: WorkspaceStartupPreloaderService },
      ],
    });
    return injector.get(WorkspaceStartupPreloaderService);
  }

  it('stage-1 start() should only preload workspace shell', async () => {
    const loader: WorkspaceStartupAssetLoader = {
      preloadWorkspaceShell: vi.fn().mockResolvedValue(undefined),
      preloadProjectShell: vi.fn().mockResolvedValue(undefined),
    };

    const service = createService(loader);
    service.start();
    await service.preloadWorkspaceShell();

    expect(loader.preloadWorkspaceShell).toHaveBeenCalledTimes(1);
    expect(loader.preloadProjectShell).not.toHaveBeenCalled();
    expect(service.workspaceShellReady()).toBe(true);
    expect(service.projectShellReady()).toBe(false);
    expect(service.routeShellsReady()).toBe(false);
  });

  it('stage-2 scheduleProjectShellPreload() should preload project shell', async () => {
    const loader: WorkspaceStartupAssetLoader = {
      preloadWorkspaceShell: vi.fn().mockResolvedValue(undefined),
      preloadProjectShell: vi.fn().mockResolvedValue(undefined),
    };

    const service = createService(loader);
    service.start();
    await service.preloadWorkspaceShell();

    service.scheduleProjectShellPreload();
    await service.preloadProjectShell();

    expect(loader.preloadWorkspaceShell).toHaveBeenCalledTimes(1);
    expect(loader.preloadProjectShell).toHaveBeenCalledTimes(1);
    expect(service.routeShellsReady()).toBe(true);
  });

  it('start() should be idempotent', async () => {
    const loader: WorkspaceStartupAssetLoader = {
      preloadWorkspaceShell: vi.fn().mockResolvedValue(undefined),
      preloadProjectShell: vi.fn().mockResolvedValue(undefined),
    };

    const service = createService(loader);
    service.start();
    service.start();
    await service.preloadWorkspaceShell();

    expect(loader.preloadWorkspaceShell).toHaveBeenCalledTimes(1);
  });

  it('preloadRouteShells() should load both in parallel for backward compat', async () => {
    const loader: WorkspaceStartupAssetLoader = {
      preloadWorkspaceShell: vi.fn().mockResolvedValue(undefined),
      preloadProjectShell: vi.fn().mockResolvedValue(undefined),
    };

    const service = createService(loader);
    await service.preloadRouteShells();

    expect(loader.preloadWorkspaceShell).toHaveBeenCalledTimes(1);
    expect(loader.preloadProjectShell).toHaveBeenCalledTimes(1);
    // styles.css 已恢复到静态构建，workspaceStylesReady 始终为 true
    expect(service.workspaceStylesReady()).toBe(true);
    expect(service.routeShellsReady()).toBe(true);
  });
});
