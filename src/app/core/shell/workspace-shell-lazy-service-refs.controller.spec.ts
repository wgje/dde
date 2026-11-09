import { describe, expect, it, vi } from 'vitest';

import { SimpleSyncService } from '../services/simple-sync.service';
import { BlackBoxService } from '../../../services/black-box.service';
import { ExportService } from '../../../services/export.service';
import { FocusStartupProbeService } from '../../../services/focus-startup-probe.service';
import { ParkingService } from '../../../services/parking.service';
import { WorkspaceShellLazyServiceRefsController } from './workspace-shell-lazy-service-refs.controller';

function createController() {
  const parkingService = { previewTask: vi.fn() } as unknown as ParkingService;
  const blackBoxService = { create: vi.fn() } as unknown as BlackBoxService;
  const exportService = { needsExportReminder: vi.fn() } as unknown as ExportService;
  const focusStartupProbe = {
    initialize: vi.fn(),
  } as unknown as FocusStartupProbeService;
  const simpleSync = { startRuntime: vi.fn() } as unknown as SimpleSyncService;
  const instances = new Map<unknown, unknown>([
    [ParkingService, parkingService],
    [BlackBoxService, blackBoxService],
    [ExportService, exportService],
    [FocusStartupProbeService, focusStartupProbe],
    [SimpleSyncService, simpleSync],
  ]);
  const injector = {
    get: vi.fn((token: unknown) => {
      if (!instances.has(token)) {
        throw new Error('Unknown token');
      }

      return instances.get(token);
    }),
  };
  const controller = new WorkspaceShellLazyServiceRefsController({
    injector,
  });

  return {
    blackBoxService,
    controller,
    exportService,
    focusStartupProbe,
    injector,
    parkingService,
    simpleSync,
  };
}

describe('WorkspaceShellLazyServiceRefsController', () => {
  it('does not resolve any service before its accessor is used', () => {
    const { injector } = createController();

    expect(injector.get).not.toHaveBeenCalled();
  });

  it('resolves each shell lazy service on demand and caches the instance', () => {
    const {
      blackBoxService,
      controller,
      exportService,
      focusStartupProbe,
      injector,
      parkingService,
      simpleSync,
    } = createController();

    expect(controller.parkingService).toBe(parkingService);
    expect(controller.parkingService).toBe(parkingService);
    expect(controller.blackBoxService).toBe(blackBoxService);
    expect(controller.exportService).toBe(exportService);
    expect(controller.focusStartupProbe).toBe(focusStartupProbe);
    expect(controller.simpleSync).toBe(simpleSync);
    expect(controller.simpleSync).toBe(simpleSync);

    expect(injector.get).toHaveBeenCalledTimes(5);
    expect(injector.get).toHaveBeenNthCalledWith(1, ParkingService);
    expect(injector.get).toHaveBeenNthCalledWith(2, BlackBoxService);
    expect(injector.get).toHaveBeenNthCalledWith(3, ExportService);
    expect(injector.get).toHaveBeenNthCalledWith(4, FocusStartupProbeService);
    expect(injector.get).toHaveBeenNthCalledWith(5, SimpleSyncService);
  });
});
