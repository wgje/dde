import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import type { ExternalSourceLink, SiyuanPreviewResult } from '../../../core/external-sources/external-source.model';
import { ExternalSourceLinkService } from '../../../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../../../core/external-sources/siyuan/siyuan-preview.service';
import { KnowledgeAnchorComponent } from './knowledge-anchor.component';

describe('KnowledgeAnchorComponent', () => {
  const link: ExternalSourceLink = {
    id: 'link-1',
    taskId: 'task-1',
    sourceType: 'siyuan-block',
    targetId: '20260426123456-abc1234',
    uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
    label: '思源 abc1234',
    sortOrder: 0,
    deletedAt: null,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  };

  let fixture: ComponentFixture<KnowledgeAnchorComponent>;
  let bindSiyuanBlock: ReturnType<typeof vi.fn>;
  let openLink: ReturnType<typeof vi.fn>;
  let preview: ReturnType<typeof vi.fn>;
  let removeLink: ReturnType<typeof vi.fn>;
  let replaceSiyuanBlock: ReturnType<typeof vi.fn>;
  let activeLinks: ExternalSourceLink[];
  let currentUserId: WritableSignal<string | null>;
  let authFenceGeneration: number;
  let abortActive: ReturnType<typeof vi.fn>;
  let debugLog: ReturnType<typeof vi.fn>;
  let isMobileInput: WritableSignal<boolean>;
  let editableInput: WritableSignal<boolean>;
  let manageableInput: WritableSignal<boolean>;
  let linksVersion: WritableSignal<number>;
  let previewModeInput: WritableSignal<'full' | 'deep-link-only'>;

  beforeEach(async () => {
    activeLinks = [link];
    currentUserId = signal('owner-a');
    authFenceGeneration = 0;
    abortActive = vi.fn();
    debugLog = vi.fn();
    isMobileInput = signal(true);
    bindSiyuanBlock = vi.fn().mockResolvedValue(link);
    openLink = vi.fn();
    removeLink = vi.fn().mockResolvedValue(undefined);
    replaceSiyuanBlock = vi.fn().mockResolvedValue({
      ...link,
      targetId: '20260426123456-def5678',
      uri: 'siyuan://blocks/20260426123456-def5678?focus=1',
    });
    linksVersion = signal(0);
    preview = vi.fn().mockResolvedValue({
      status: 'ready',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        excerpt: 'preview text',
        fetchedAt: '2026-05-18T00:00:00.000Z',
        fetchStatus: 'ready',
      },
    });

    await TestBed.configureTestingModule({
      imports: [KnowledgeAnchorComponent],
      providers: [
        {
          provide: ExternalSourceLinkService,
          useValue: {
            links: linksVersion,
            activeLinksForTask: vi.fn().mockImplementation(() => activeLinks),
            bindSiyuanBlock,
            openLink,
            removeLink,
            replaceSiyuanBlock,
          },
        },
        {
          provide: AuthService,
          useValue: {
            currentUserId,
            captureAuthIdentityFence: () => `${authFenceGeneration}:${currentUserId() ?? ''}`,
          },
        },
        { provide: SiyuanPreviewService, useValue: { preview, abortActive } },
        { provide: LoggerService, useValue: { category: () => ({ debug: debugLog, warn: vi.fn() }) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(KnowledgeAnchorComponent);
    editableInput = signal(false);
    manageableInput = signal(false);
    previewModeInput = signal<'full' | 'deep-link-only'>('full');
    Object.assign(fixture.componentInstance as unknown as Record<string, unknown>, {
      taskId: signal('task-1'),
      isMobile: isMobileInput,
      editable: editableInput,
      manageable: manageableInput,
      compact: signal(false),
      previewMode: previewModeInput,
    });
    fixture.detectChanges();
  });

  it('uses deep-link-only mode without opening the mobile preview sheet', () => {
    previewModeInput.set('deep-link-only');
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLButtonElement;
    chip.click();
    fixture.detectChanges();

    expect(openLink).toHaveBeenCalledWith(link);
    expect(preview).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-sheet"]')).toBeNull();
  });

  it('clears owner-scoped surfaces and ignores a late preview after account change', async () => {
    const createDeferred = <T,>() => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(promiseResolve => { resolve = promiseResolve; });
      return { promise, resolve };
    };
    const ownerAPreview = createDeferred<SiyuanPreviewResult>();
    const ownerBPreview = createDeferred<SiyuanPreviewResult>();
    const cancelOwnerA = vi.fn();
    const cancelOwnerB = vi.fn();
    preview
      .mockReturnValueOnce(Object.assign(ownerAPreview.promise, { cancel: cancelOwnerA }))
      .mockReturnValueOnce(Object.assign(ownerBPreview.promise, { cancel: cancelOwnerB }));

    const component = fixture.componentInstance;
    const openSheet = () => component.onChipClick({ stopPropagation: vi.fn() } as unknown as Event, link);
    openSheet();
    fixture.detectChanges();
    expect(component.activeLink()?.id).toBe(link.id);

    currentUserId.set('owner-b');
    authFenceGeneration += 1;
    fixture.detectChanges();
    expect(component.sheetOpen()).toBe(false);
    expect(component.activeLink()).toBeNull();
    expect(component.sheetResult().preview).toBeUndefined();
    expect(cancelOwnerA).toHaveBeenCalledOnce();
    expect(abortActive).not.toHaveBeenCalled();

    openSheet();
    fixture.detectChanges();
    ownerBPreview.resolve({
      status: 'ready',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        excerpt: 'owner-b content',
        fetchedAt: '2026-05-19T00:00:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.sheetResult().preview?.excerpt).toBe('owner-b content');
    expect(cancelOwnerB).not.toHaveBeenCalled();

    ownerAPreview.resolve({
      status: 'ready',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        excerpt: 'owner-a content',
        fetchedAt: '2026-05-18T00:00:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(component.sheetResult().preview?.excerpt).toBe('owner-b content');

    const chip = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLButtonElement;
    component.onContextMenu({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: chip,
    } as unknown as MouseEvent, link);
    fixture.detectChanges();
    expect(component.actionMenuOpen()).toBe(true);

    currentUserId.set('owner-c');
    authFenceGeneration += 1;
    fixture.detectChanges();
    expect(component.actionMenuOpen()).toBe(false);
    expect(component.menuLink()).toBeNull();
  });

  it('same-host supersession cancels only its previous preview request', async () => {
    const nextLink: ExternalSourceLink = {
      ...link,
      id: 'link-2',
      targetId: '20260426123456-def5678',
      uri: 'siyuan://blocks/20260426123456-def5678?focus=1',
    };
    const first = new Promise<SiyuanPreviewResult>(() => undefined);
    const second = new Promise<SiyuanPreviewResult>(() => undefined);
    const cancelFirst = vi.fn();
    const cancelSecond = vi.fn();
    preview
      .mockReturnValueOnce(Object.assign(first, { cancel: cancelFirst }))
      .mockReturnValueOnce(Object.assign(second, { cancel: cancelSecond }));
    const component = fixture.componentInstance;

    component.onChipClick({ stopPropagation: vi.fn() } as unknown as Event, link);
    component.onChipClick({ stopPropagation: vi.fn() } as unknown as Event, nextLink);

    expect(cancelFirst).toHaveBeenCalledOnce();
    expect(cancelSecond).not.toHaveBeenCalled();
    expect(abortActive).not.toHaveBeenCalled();
  });

  it('popover load catches from mouseenter and focus do not globally abort another preview', async () => {
    isMobileInput.set(false);
    const component = fixture.componentInstance;
    const host = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLElement;
    const componentWithPopover = component as unknown as {
      withOwnerScopedPopover: (action: (popover: unknown) => void) => Promise<void>;
    };
    vi.spyOn(componentWithPopover, 'withOwnerScopedPopover')
      .mockRejectedValueOnce(new Error('lazy import failed'))
      .mockRejectedValueOnce(new Error('lazy import failed'));

    component.onMouseEnter({ currentTarget: host } as unknown as MouseEvent, link);
    await vi.waitFor(() => expect(debugLog).toHaveBeenCalledTimes(1));
    component.onFocus({ currentTarget: host } as unknown as FocusEvent, link);
    await vi.waitFor(() => expect(debugLog).toHaveBeenCalledTimes(2));

    expect(abortActive).not.toHaveBeenCalled();
  });

  it('ignores a late preview completion after destroy', async () => {
    let resolvePreview!: (value: SiyuanPreviewResult) => void;
    const pendingPreview = new Promise<SiyuanPreviewResult>(resolve => { resolvePreview = resolve; });
    const cancelPreview = vi.fn();
    preview.mockReturnValueOnce(Object.assign(pendingPreview, { cancel: cancelPreview }));
    const component = fixture.componentInstance;

    component.onChipClick({ stopPropagation: vi.fn() } as unknown as Event, link);
    expect(component.sheetResult()).toEqual({ status: 'loading' });

    fixture.destroy();
    expect(cancelPreview).toHaveBeenCalledOnce();
    expect(abortActive).not.toHaveBeenCalled();
    resolvePreview({
      status: 'ready',
      preview: {
        linkId: link.id,
        blockId: link.targetId,
        excerpt: 'late after destroy',
        fetchedAt: '2026-05-20T00:00:00.000Z',
        fetchStatus: 'ready',
        truncated: false,
      },
    });
    await Promise.resolve();

    expect(component.sheetResult()).toEqual({ status: 'loading' });
  });

  it('ignores a late preview rejection after destroy without global abort', async () => {
    let rejectPreview!: (error: unknown) => void;
    const pendingPreview = new Promise<SiyuanPreviewResult>((_resolve, reject) => { rejectPreview = reject; });
    const cancelPreview = vi.fn();
    preview
      .mockResolvedValueOnce({ status: 'loading' })
      .mockReturnValueOnce(Object.assign(pendingPreview, { cancel: cancelPreview }));
    const component = fixture.componentInstance;
    component.onChipClick({ stopPropagation: vi.fn() } as unknown as Event, link);
    const refresh = component.refreshSheet(link);

    fixture.destroy();
    expect(cancelPreview).toHaveBeenCalledOnce();
    rejectPreview(new Error('late preview rejection'));
    await refresh;

    expect(component.sheetResult()).toEqual({ status: 'loading' });
    expect(abortActive).not.toHaveBeenCalled();
  });

  it('does not resolve or open a lazy popover when import completes after destroy', async () => {
    const component = fixture.componentInstance;
    const withOwnerScopedPopover = Reflect.get(component, 'withOwnerScopedPopover') as (
      action: (popover: unknown) => void,
    ) => Promise<void>;
    const envInjector = Reflect.get(component, 'envInjector') as {
      get: (...args: unknown[]) => unknown;
    };
    const getPopover = vi.spyOn(envInjector, 'get');
    const scheduleOpen = vi.fn();
    const pendingOpen = Reflect.apply(withOwnerScopedPopover, component, [scheduleOpen]) as Promise<void>;

    fixture.destroy();
    await pendingOpen;

    expect(getPopover).not.toHaveBeenCalled();
    expect(scheduleOpen).not.toHaveBeenCalled();
  });

  it('opens a mobile action menu after long press and suppresses the follow-up chip click', () => {
    vi.useFakeTimers();
    try {
      const chip = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLButtonElement;
      fixture.componentInstance.onPointerDown({
        pointerType: 'touch',
        clientX: 10,
        clientY: 10,
        currentTarget: chip,
      } as unknown as PointerEvent, link);

      vi.advanceTimersByTime(450);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-action-menu"]')).not.toBeNull();

      const preventDefault = vi.fn();
      fixture.componentInstance.onChipClick({
        stopPropagation: vi.fn(),
        preventDefault,
      } as unknown as Event, link);

      expect(preventDefault).toHaveBeenCalled();
      expect(openLink).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels mobile long press when the pointer moves beyond tolerance', () => {
    vi.useFakeTimers();
    try {
      const chip = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLButtonElement;
      fixture.componentInstance.onPointerDown({
        pointerType: 'touch',
        clientX: 10,
        clientY: 10,
        currentTarget: chip,
      } as unknown as PointerEvent, link);
      fixture.componentInstance.onPointerMove({ clientX: 30, clientY: 10 } as PointerEvent);

      vi.advanceTimersByTime(450);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-action-menu"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears mobile long press timer when the timer handle is 0', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const chip = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-chip"]') as HTMLButtonElement;

    try {
      fixture.componentInstance.onPointerDown({
        pointerType: 'touch',
        clientX: 10,
        clientY: 10,
        currentTarget: chip,
      } as unknown as PointerEvent, link);
      fixture.componentInstance.onPointerEnd();

      expect(setTimeoutSpy).toHaveBeenCalledOnce();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('shows task-block edit and delete actions when the anchor is editable', async () => {
    editableInput.set(true);
    fixture.detectChanges();

    const editButton = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-edit"]') as HTMLButtonElement;
    const removeButton = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-remove"]') as HTMLButtonElement;

    expect(editButton).not.toBeNull();
    expect(removeButton).not.toBeNull();

    removeButton.click();
    await fixture.whenStable();

    expect(removeLink).toHaveBeenCalledWith(link.id);
  });

  it('shows every active anchor with management actions only when editable', () => {
    activeLinks = [
      link,
      {
        ...link,
        id: 'link-2',
        targetId: '20260426123456-def5678',
        uri: 'siyuan://blocks/20260426123456-def5678?focus=1',
        label: '思源 def5678',
        sortOrder: 1,
      },
    ];
    linksVersion.set(1);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('[data-testid="knowledge-anchor-chip"]')).toHaveLength(1);

    editableInput.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('[data-testid="knowledge-anchor-chip"]')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('[data-testid="knowledge-anchor-edit"]')).toHaveLength(2);
    expect(fixture.nativeElement.querySelectorAll('[data-testid="knowledge-anchor-remove"]')).toHaveLength(2);
  });

  it('allows preview management without exposing the add-link form', async () => {
    manageableInput.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-edit"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-remove"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-input"]')).toBeNull();

    const editButton = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-edit"]') as HTMLButtonElement;
    editButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-input"]')).not.toBeNull();
  });

  it('keeps the editable form as an add-link path until edit mode is selected', async () => {
    editableInput.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-input"]') as HTMLInputElement;
    input.value = '20260426123456-ghi9012';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const submitButton = input.form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    submitButton?.click();
    await fixture.whenStable();

    expect(bindSiyuanBlock).toHaveBeenCalledWith('task-1', '20260426123456-ghi9012');
    expect(replaceSiyuanBlock).not.toHaveBeenCalled();
  });

  it('replaces the current visible SiYuan link instead of adding a hidden second link', async () => {
    editableInput.set(true);
    fixture.detectChanges();

    const editButton = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-edit"]') as HTMLButtonElement;
    editButton.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('[data-testid="knowledge-anchor-input"]') as HTMLInputElement;
    expect(input.value).toBe(link.uri);
    input.value = '20260426123456-def5678';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const submitButton = input.form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    submitButton?.click();
    await fixture.whenStable();

    expect(replaceSiyuanBlock).toHaveBeenCalledWith(link.id, '20260426123456-def5678');
    expect(bindSiyuanBlock).not.toHaveBeenCalled();
  });
});
