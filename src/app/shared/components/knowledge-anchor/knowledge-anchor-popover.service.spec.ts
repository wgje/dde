import { Overlay } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import { SiyuanPreviewService } from '../../../core/external-sources/siyuan/siyuan-preview.service';
import { KnowledgeAnchorPopoverService } from './knowledge-anchor-popover.service';

describe('KnowledgeAnchorPopoverService', () => {
  const link: ExternalSourceLink = {
    id: 'link-1',
    taskId: 'task-1',
    sourceType: 'siyuan-block',
    targetId: '20260426123456-abc1234',
    uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
    sortOrder: 0,
    deletedAt: null,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  };

  let service: KnowledgeAnchorPopoverService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        KnowledgeAnchorPopoverService,
        { provide: Overlay, useValue: {} },
        {
          provide: SiyuanPreviewService,
          useValue: {
            abortActive: vi.fn(),
          },
        },
      ],
    });
    service = TestBed.inject(KnowledgeAnchorPopoverService);
  });

  afterEach(() => {
    service.dispose();
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('cancels zero-valued hover open and close timer handles', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
    const origin = document.createElement('button');

    service.scheduleOpen(link, origin);
    service.close();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);

    clearTimeoutSpy.mockClear();

    service.scheduleClose();
    service.keepOpen();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });
});
