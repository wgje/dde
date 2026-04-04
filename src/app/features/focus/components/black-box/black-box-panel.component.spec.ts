import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { BlackBoxPanelComponent } from './black-box-panel.component';
import { BlackBoxService } from '../../../../../services/black-box.service';
import { SpeechToTextService } from '../../../../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../../../../services/focus-preference.service';
import { ToastService } from '../../../../../services/toast.service';

describe('BlackBoxPanelComponent', () => {
  it('ngOnInit 应只补本地快照，不触发远端拉取', async () => {
    const blackBoxService = {
      entriesByDate: signal([]),
      pendingCount: signal(0),
      refreshForView: vi.fn().mockResolvedValue(undefined),
      loadFromServer: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: BlackBoxService, useValue: blackBoxService },
        { provide: SpeechToTextService, useValue: {} },
        { provide: FocusPreferenceService, useValue: {} },
        { provide: ToastService, useValue: {} },
      ],
    });

    const component = runInInjectionContext(injector, () => new BlackBoxPanelComponent());

    component.ngOnInit();
    await Promise.resolve();

    expect(blackBoxService.refreshForView).toHaveBeenCalledTimes(1);
    expect(blackBoxService.loadFromServer).not.toHaveBeenCalled();
  });
});