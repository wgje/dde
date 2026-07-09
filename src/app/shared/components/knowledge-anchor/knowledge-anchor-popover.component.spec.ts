import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from '../../../../services/logger.service';
import type { ExternalSourceLink } from '../../../core/external-sources/external-source.model';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../../../core/external-sources/siyuan/siyuan-preview.service';
import { KnowledgeAnchorPopoverComponent } from './knowledge-anchor-popover.component';

type PreviewMock = ReturnType<typeof vi.fn<SiyuanPreviewService['preview']>>;

describe('KnowledgeAnchorPopoverComponent', () => {
  const link: ExternalSourceLink = {
    id: 'link-1',
    taskId: 'task-1',
    sourceType: 'siyuan-block',
    targetId: '20260426123456-abc1234',
    uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
    label: '思源 abc1234',
    sortOrder: 0,
    deletedAt: null,
    createdAt: '2026-05-18T12:34:00.000Z',
    updatedAt: '2026-05-18T12:34:00.000Z',
  };

  let fixture: ComponentFixture<KnowledgeAnchorPopoverComponent>;
  let openLink: ReturnType<typeof vi.fn>;
  let updateMetadata: ReturnType<typeof vi.fn>;
  let preview: PreviewMock;

  beforeEach(async () => {
    openLink = vi.fn();
    updateMetadata = vi.fn().mockResolvedValue(undefined);
    preview = vi.fn().mockResolvedValue({
      status: 'ready',
      origin: 'network',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        title: '细菌能量来源',
        hpath: '/生物/微生物/细菌能量来源',
        excerpt: '对于细菌选择光能还是化能……',
        fetchedAt: '2026-05-28T12:34:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });

    await TestBed.configureTestingModule({
      imports: [KnowledgeAnchorPopoverComponent],
      providers: [
        {
          provide: SiyuanPreviewService,
          useValue: {
            preview,
          },
        },
        {
          provide: ExternalSourceLinkService,
          useValue: {
            openLink,
            updateMetadata,
          },
        },
        { provide: LoggerService, useValue: { category: () => ({ warn: vi.fn() }) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(KnowledgeAnchorPopoverComponent);
    Object.assign(fixture.componentInstance as unknown as Record<string, unknown>, {
      link: signal(link),
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders the fetched Siyuan title and linked-at time, then backfills link metadata', () => {
    const title = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-popover-title"]') as HTMLElement;
    const linkedAt = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-linked-at"]') as HTMLElement;
    const absoluteLocation = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-absolute-location"]') as HTMLButtonElement;

    expect(title.textContent).toContain('细菌能量来源');
    expect(fixture.nativeElement.textContent).not.toContain('缓存时间');
    expect(linkedAt.textContent).toContain('关联于：05/18');
    expect(absoluteLocation.textContent).toContain('/生物/微生物/细菌能量来源');
    expect(updateMetadata).toHaveBeenCalledWith(link.id, {
      label: '细菌能量来源',
      hpath: '/生物/微生物/细菌能量来源',
    });
  });

  it('normalizes a folder-relative hpath into an absolute visible location', () => {
    fixture.componentInstance.result.set({
      status: 'ready',
      origin: 'cache',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        title: '细菌能量来源',
        hpath: '生物/微生物/细菌能量来源',
        excerpt: 'placeholder',
        fetchedAt: '2026-05-28T12:35:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });
    fixture.detectChanges();

    const absoluteLocation = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-absolute-location"]') as HTMLButtonElement;

    expect(absoluteLocation.textContent).toContain('/生物/微生物/细菌能量来源');
    expect(absoluteLocation.title).toBe('/生物/微生物/细菌能量来源');
  });

  it('prefers resolved hpath over the placeholder link label when preview title is absent', () => {
    fixture.componentInstance.result.set({
      status: 'ready',
      origin: 'cache',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        hpath: '/生物/无标题块',
        excerpt: 'placeholder',
        fetchedAt: '2026-05-28T12:35:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });
    fixture.detectChanges();

    const title = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-popover-title"]') as HTMLElement;
    expect(title.textContent).toContain('无标题块');
    expect(title.textContent).not.toContain('思源 abc1234');
  });

  it('opens the SiYuan block when the absolute location is clicked', () => {
    const absoluteLocation = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-absolute-location"]') as HTMLButtonElement;

    absoluteLocation.click();

    expect(openLink).toHaveBeenCalledWith(link);
  });

  it('still renders the absolute location when preview data is unavailable', () => {
    Object.assign(fixture.componentInstance as unknown as Record<string, unknown>, {
      link: signal({
        ...link,
        hpath: '/生物/细菌能量来源',
      }),
    });
    fixture.componentInstance.result.set({
      status: 'error',
      errorCode: 'unknown',
    });
    fixture.detectChanges();

    const absoluteLocation = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-absolute-location"]') as HTMLButtonElement;

    expect(absoluteLocation.textContent).toContain('/生物/细菌能量来源');
  });

  it('does not backfill metadata for cache-only stale previews', async () => {
    preview.mockResolvedValueOnce({
      status: 'cache-only',
      origin: 'cache',
      stale: true,
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        title: '旧缓存标题',
        hpath: '/缓存/旧标题',
        excerpt: 'stale',
        fetchedAt: '2026-05-20T12:34:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });
    updateMetadata.mockClear();

    const staleFixture = TestBed.createComponent(KnowledgeAnchorPopoverComponent);
    Object.assign(staleFixture.componentInstance as unknown as Record<string, unknown>, {
      link: signal(link),
    });
    staleFixture.detectChanges();
    await staleFixture.whenStable();

    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('ignores a stale preview result when the link input changes before load resolves', async () => {
    updateMetadata.mockClear();
    const nextLink: ExternalSourceLink = {
      ...link,
      id: 'link-2',
      targetId: '20260426123456-next999',
      uri: 'siyuan://blocks/20260426123456-next999',
      label: '思源 next999',
    };
    let resolveFirst!: (value: Awaited<ReturnType<typeof preview>>) => void;
    preview.mockImplementationOnce(() => new Promise(resolve => {
      resolveFirst = resolve;
    }));

    const raceFixture = TestBed.createComponent(KnowledgeAnchorPopoverComponent);
    const linkInput = signal(link);
    Object.assign(raceFixture.componentInstance as unknown as Record<string, unknown>, {
      link: linkInput,
    });
    raceFixture.detectChanges();

    linkInput.set(nextLink);
    preview.mockResolvedValueOnce({
      status: 'ready',
      origin: 'network',
      preview: {
        linkId: nextLink.id,
        blockId: nextLink.targetId,
        title: '新块标题',
        hpath: '/新知识/新块标题',
        excerpt: 'new preview',
        fetchedAt: '2026-05-28T12:36:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });
    await raceFixture.componentInstance.load(false);

    resolveFirst({
      status: 'ready',
      origin: 'network',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        title: '旧块标题',
        hpath: '/旧知识/旧块标题',
        excerpt: 'stale preview',
        fetchedAt: '2026-05-28T12:34:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });
    await raceFixture.whenStable();

    expect(raceFixture.componentInstance.result().preview?.title).toBe('新块标题');
    expect(updateMetadata).toHaveBeenCalledWith(nextLink.id, {
      label: '新块标题',
      hpath: '/新知识/新块标题',
    });
    expect(updateMetadata).not.toHaveBeenCalledWith(link.id, expect.anything());
  });
});
