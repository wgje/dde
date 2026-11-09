import type { Injector } from '@angular/core';

import { SimpleSyncService } from '../services/simple-sync.service';
import { BlackBoxService } from '../../../services/black-box.service';
import { ExportService } from '../../../services/export.service';
import { FocusStartupProbeService } from '../../../services/focus-startup-probe.service';
import { ParkingService } from '../../../services/parking.service';

export interface WorkspaceShellLazyServiceRefsControllerOptions {
  injector: Pick<Injector, 'get'>;
}

export class WorkspaceShellLazyServiceRefsController {
  private blackBoxServiceRef: BlackBoxService | null = null;
  private exportServiceRef: ExportService | null = null;
  private focusStartupProbeRef: FocusStartupProbeService | null = null;
  private parkingServiceRef: ParkingService | null = null;
  private simpleSyncRef: SimpleSyncService | null = null;

  constructor(
    private readonly options: WorkspaceShellLazyServiceRefsControllerOptions,
  ) {}

  get parkingService(): ParkingService {
    return (this.parkingServiceRef ??=
      this.options.injector.get(ParkingService));
  }

  get blackBoxService(): BlackBoxService {
    return (this.blackBoxServiceRef ??=
      this.options.injector.get(BlackBoxService));
  }

  get exportService(): ExportService {
    return (this.exportServiceRef ??=
      this.options.injector.get(ExportService));
  }

  get focusStartupProbe(): FocusStartupProbeService {
    return (this.focusStartupProbeRef ??=
      this.options.injector.get(FocusStartupProbeService));
  }

  get simpleSync(): SimpleSyncService {
    return (this.simpleSyncRef ??=
      this.options.injector.get(SimpleSyncService));
  }
}
