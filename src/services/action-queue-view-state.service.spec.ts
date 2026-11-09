import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionQueueViewStateService } from './action-queue-view-state.service';
import { LoggerService } from './logger.service';

describe('ActionQueueViewStateService', () => {
  let service: ActionQueueViewStateService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ActionQueueViewStateService,
        {
          provide: LoggerService,
          useValue: {
            category: () => ({ debug: vi.fn() }),
          },
        },
      ],
    });
    service = TestBed.inject(ActionQueueViewStateService);
  });

  it('global discard 后的 settle-owner 不应覆盖旧 process 的 discard', () => {
    const processGeneration = service.currentQueueViewGeneration;

    service.invalidateQueueView('full-wipe', 'discard', null);
    service.invalidateQueueView('owner-transition', 'settle-owner', null);

    expect(service.getStaleProcessPolicy(processGeneration, 'owner-a')).toBe('discard');
  });

  it('owner discard 超过 16 次后续无关 invalidation 后仍应保留 watermark', () => {
    const processGeneration = service.currentQueueViewGeneration;

    service.invalidateQueueView('owner-a-clear', 'discard', 'owner-a');
    for (let index = 0; index < 20; index += 1) {
      service.invalidateQueueView(`owner-b-transition-${index}`, 'settle-owner', 'owner-b');
    }
    service.invalidateQueueView('owner-a-transition', 'settle-owner', 'owner-a');

    expect(service.getStaleProcessPolicy(processGeneration, 'owner-a')).toBe('discard');
  });
});
