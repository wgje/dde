import { ApplicationRef, Component, DestroyRef, EventEmitter, Input, OnDestroy, Output, inject, type ComponentRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConfigurableFocusTrapFactory, type ConfigurableFocusTrap } from '@angular/cdk/a11y';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamicModalService, MODAL_DATA, MODAL_REF, type ModalRef } from './dynamic-modal.service';

let componentCreationFailure: Error | null = null;
let outputSubscribeFailure: Error | null = null;
let rollbackCleanupAction: (() => void) | null = null;
@Component({ standalone: true, template: `<button type="button">{{ label }}</button>` })
class TestDynamicModalComponent {
  @Input() label = '';
  @Output() close = new EventEmitter<unknown>();
  readonly data = inject(MODAL_DATA) as { title: string };
  readonly modalRef = inject(MODAL_REF);
}
@Component({ standalone: true, template: `<button type="button">close</button>` })
class ReentrantCloseModalComponent implements OnDestroy {
  readonly modalRef = inject(MODAL_REF);
  ngOnDestroy(): void { this.modalRef.close('destroy-close'); }
}
@Component({ standalone: true, template: `<button type="button">throwing cleanup</button>` })
class ThrowingSubscriptionModalComponent {
  constructor() { if (componentCreationFailure) throw componentCreationFailure; }
  emitClose?: (result: string) => void;
  readonly unsubscribe = vi.fn(() => {
    rollbackCleanupAction?.();
    throw new Error('unsubscribe failed');
  });
  readonly close = {
    subscribe: vi.fn((handler: (result: string) => void) => {
      this.emitClose = handler;
      return { unsubscribe: this.unsubscribe };
    }),
  };
  readonly failureUnsubscribe = vi.fn();
  readonly failure = {
    subscribe: vi.fn(() => {
      if (outputSubscribeFailure) throw outputSubscribeFailure;
      return { unsubscribe: this.failureUnsubscribe };
    }),
  };
}
@Component({ standalone: true, template: `<button type="button">open on destroy</button>` })
class OpenModalOnDestroyComponent implements OnDestroy {
  private readonly dynamicModal = inject(DynamicModalService);
  onDestroyAction: () => void = () => void this.dynamicModal.open(TestDynamicModalComponent);
  throwAfterAction = false;
  ngOnDestroy(): void {
    this.onDestroyAction();
    if (this.throwAfterAction) throw new Error('destroy failed after reentrant action');
  }
}
@Component({ standalone: true, template: `<button type="button">cleanup reentry</button>` })
class ServiceCloseDuringCleanupModalComponent implements OnDestroy {
  private readonly dynamicModal = inject(DynamicModalService);
  closeDuringUnsubscribe = false;
  closeDuringDestroy = false;
  readonly unsubscribe = vi.fn(() => {
    if (this.closeDuringUnsubscribe) this.dynamicModal.close('unsubscribe-reentry');
  });
  readonly close = {
    subscribe: vi.fn(() => ({ unsubscribe: this.unsubscribe })),
  };
  ngOnDestroy(): void { if (this.closeDuringDestroy) this.dynamicModal.close('destroy-reentry'); }
}
type TestFocusTrap = ConfigurableFocusTrap & {
  destroy: ReturnType<typeof vi.fn>;
  focusInitialElement: ReturnType<typeof vi.fn>;
};
type OpenInternals = {
  createModalComponent: (...args: never[]) => ComponentRef<unknown>;
  modalStack: { update: (updater: (stack: unknown[]) => unknown[]) => void };
};

describe('DynamicModalService', () => {
  let service: DynamicModalService;
  let traps: TestFocusTrap[];
  let createTrap: ReturnType<typeof vi.fn>;
  let destroyCallbacks: Array<() => void>;
  function makeTrap(): TestFocusTrap {
    return { destroy: vi.fn(), enabled: true, focusInitialElement: vi.fn(() => true) } as unknown as TestFocusTrap;
  }
  function flushRender(): void { TestBed.inject(ApplicationRef).tick(); }
  function appendFocusedOpener(): HTMLButtonElement {
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();
    return opener;
  }
  function openOuter(): { ref: ModalRef; opener: HTMLButtonElement; settled: ReturnType<typeof vi.fn> } {
    const ref = service.open(TestDynamicModalComponent);
    ref.componentRef.changeDetectorRef.detectChanges();
    const opener = ref.componentRef.location.nativeElement.querySelector('button') as HTMLButtonElement;
    opener.focus();
    const settled = vi.fn();
    void ref.result.then(settled);
    return { ref, opener, settled };
  }
  function expectOuterModalActive(): void {
    expect(service.stackDepth()).toBe(1);
    expect(traps[0].enabled).toBe(true);
    expect(traps[0].destroy).not.toHaveBeenCalled();
    expect(traps[0].focusInitialElement).toHaveBeenCalledOnce();
  }
  async function expectCleanupServiceClose(surface: 'unsubscribe' | 'trap' | 'destroy'): Promise<void> {
    const { settled: outerSettled } = openOuter();
    const serviceClose = vi.spyOn(service, 'close');
    const innerRef = service.open<ServiceCloseDuringCleanupModalComponent, unknown, string>(ServiceCloseDuringCleanupModalComponent);
    const inner = innerRef.componentRef.instance as ServiceCloseDuringCleanupModalComponent;
    if (surface === 'unsubscribe') inner.closeDuringUnsubscribe = true;
    if (surface === 'destroy') inner.closeDuringDestroy = true;
    if (surface === 'trap') {
      traps[1].destroy.mockImplementation(() => service.close('trap-reentry'));
    }
    const innerDestroy = vi.spyOn(innerRef.componentRef, 'destroy');
    innerRef.close('primary');
    await expect(innerRef.result).resolves.toBe('primary');
    await Promise.resolve();
    expect(serviceClose).toHaveBeenCalledOnce();
    expect(serviceClose).toHaveBeenCalledWith(`${surface}-reentry`);
    expect(outerSettled).not.toHaveBeenCalled();
    expectOuterModalActive();
    expect(traps[1].destroy).toHaveBeenCalledOnce();
    expect(innerDestroy).toHaveBeenCalledOnce();
  }

  beforeEach(() => {
    destroyCallbacks = [];
    traps = [];
    createTrap = vi.fn(() => {
      const trap = makeTrap();
      traps.push(trap);
      return trap;
    });
    TestBed.configureTestingModule({
      providers: [
        DynamicModalService,
        { provide: ConfigurableFocusTrapFactory, useValue: { create: createTrap } },
      ],
    });
    vi.spyOn(TestBed.inject(DestroyRef), 'onDestroy').mockImplementation(callback => {
      destroyCallbacks.push(callback);
      return () => undefined;
    });
    service = TestBed.inject(DynamicModalService);
  });
  afterEach(() => {
    service.closeAll();
    vi.restoreAllMocks();
  });
  it('opens a component, wires modal data and close output, then cleans up DOM', async () => {
    const closeHandler = vi.fn();
    const ref = service.open<TestDynamicModalComponent, { title: string }, { confirmed: boolean }>(
      TestDynamicModalComponent,
      {
        data: { title: '删除项目' },
        inputs: { label: '确认删除' },
        outputs: { close: closeHandler },
      },
    );
    const instance = ref.componentRef.instance as TestDynamicModalComponent;
    ref.componentRef.changeDetectorRef.detectChanges();
    expect(service.stackDepth()).toBe(1);
    expect(service.hasOpenModal()).toBe(true);
    expect(instance.data).toEqual({ title: '删除项目' });
    expect(instance.label).toBe('确认删除');
    expect(instance.modalRef.close).toBe(ref.close);
    expect(document.body.querySelector('.dynamic-modal-container')).not.toBeNull();
    instance.close.emit({ confirmed: true });
    await expect(ref.result).resolves.toEqual({ confirmed: true });
    expect(closeHandler).toHaveBeenCalledWith({ confirmed: true });
    expect(service.stackDepth()).toBe(0);
    expect(service.hasOpenModal()).toBe(false);
    expect(document.body.querySelector('.dynamic-modal-container')).toBeNull();
  });
  it.each(['append', 'component', 'output', 'attach', 'escape', 'trap', 'commit', 'rollback'] as const)(
    'rolls back every acquired resource when %s acquisition fails',
    phase => {
      const error = new Error(`${phase} failed`);
      const opener = appendFocusedOpener();
      const openerFocus = vi.spyOn(opener, 'focus');
      const outerRef = service.open(TestDynamicModalComponent);
      const outerDestroy = vi.spyOn(outerRef.componentRef, 'destroy');
      flushRender();
      const appRef = TestBed.inject(ApplicationRef);
      const detachView = vi.spyOn(appRef, 'detachView');
      const removeListener = vi.spyOn(document, 'removeEventListener');
      let candidateContainer!: HTMLElement;
      const bodyAppend = document.body.appendChild.bind(document.body);
      vi.spyOn(document.body, 'appendChild').mockImplementationOnce(node => {
        candidateContainer = node as HTMLElement;
        vi.spyOn(candidateContainer, 'remove');
        const appended = bodyAppend(node);
        if (phase === 'append') throw error;
        return appended;
      });
      const internals = service as unknown as OpenInternals;
      const createComponent = internals.createModalComponent.bind(service);
      const failedRef = { current: null as ComponentRef<unknown> | null };
      vi.spyOn(internals, 'createModalComponent').mockImplementationOnce((...args) => {
        const ref = createComponent(...args);
        failedRef.current = ref;
        vi.spyOn(ref, 'destroy');
        return ref;
      });
      const attachView = appRef.attachView.bind(appRef);
      if (phase === 'attach') {
        vi.spyOn(appRef, 'attachView').mockImplementationOnce(view => {
          attachView(view);
          throw error;
        });
      }
      const addListener = document.addEventListener.bind(document);
      vi.spyOn(document, 'addEventListener').mockImplementationOnce((...args) => {
        addListener(...args);
        if (phase === 'escape') throw error;
      });
      if (phase === 'component') componentCreationFailure = error;
      if (phase === 'output') outputSubscribeFailure = error;
      const rollbackClose = vi.fn(() => service.close('rollback-reentry'));
      rollbackCleanupAction = phase === 'rollback' ? rollbackClose : null;
      if (phase === 'trap' || phase === 'rollback') createTrap.mockImplementationOnce(() => { throw error; });
      const stackUpdate = internals.modalStack.update.bind(internals.modalStack);
      if (phase === 'commit') {
        vi.spyOn(internals.modalStack, 'update').mockImplementationOnce(updater => {
          stackUpdate(updater);
          throw error;
        });
      }
      let caught: unknown;
      try {
        service.open(ThrowingSubscriptionModalComponent, {
          outputs: { close: vi.fn(), failure: vi.fn() },
        });
      } catch (openError) {
        caught = openError;
      }
      componentCreationFailure = outputSubscribeFailure = null;
      rollbackCleanupAction = null;
      expect(caught).toBe(error);
      expect(document.querySelectorAll('.dynamic-modal-container')).toHaveLength(1);
      expectOuterModalActive();
      expect(outerDestroy).not.toHaveBeenCalled();
      expect(openerFocus).not.toHaveBeenCalled();
      expect(candidateContainer.remove).toHaveBeenCalledOnce();
      expect(rollbackClose).toHaveBeenCalledTimes(Number(phase === 'rollback'));
      if (failedRef.current) {
        const instance = failedRef.current.instance as ThrowingSubscriptionModalComponent;
        expect(failedRef.current.destroy).toHaveBeenCalledOnce();
        expect(instance.unsubscribe).toHaveBeenCalledTimes(phase === 'output' ? 1 : Number(!['append', 'component'].includes(phase)));
        expect(instance.failureUnsubscribe).toHaveBeenCalledTimes(Number(['attach', 'escape', 'trap', 'commit', 'rollback'].includes(phase)));
      }
      expect(detachView).toHaveBeenCalledTimes(Number(['attach', 'escape', 'trap', 'commit', 'rollback'].includes(phase)));
      expect(removeListener).toHaveBeenCalledTimes(Number(['escape', 'trap', 'commit', 'rollback'].includes(phase)));
      expect(traps.length).toBe(phase === 'commit' ? 2 : 1);
      if (phase === 'commit') expect(traps[1].destroy).toHaveBeenCalledOnce();
      flushRender();
      expect(traps.slice(1).every(trap => trap.focusInitialElement.mock.calls.length === 0)).toBe(true);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(service.stackDepth()).toBe(0);
      const later = service.open(TestDynamicModalComponent);
      later.close();
      expect(service.stackDepth()).toBe(0);
    },
  );
  it('ignores reentrant close calls from component destroy hooks', async () => {
    const ref = service.open<ReentrantCloseModalComponent, unknown, string>(ReentrantCloseModalComponent);
    const componentRef = ref.componentRef;
    const destroySpy = vi.spyOn(componentRef, 'destroy');
    ref.close('primary-close');
    await expect(ref.result).resolves.toBe('primary-close');
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(service.stackDepth()).toBe(0);
    expect(document.body.querySelector('.dynamic-modal-container')).toBeNull();
  });
  it('continues modal cleanup when an output subscription unsubscribe throws', async () => {
    const ref = service.open<ThrowingSubscriptionModalComponent, unknown, string>(ThrowingSubscriptionModalComponent);
    const instance = ref.componentRef.instance as ThrowingSubscriptionModalComponent;
    const destroySpy = vi.spyOn(ref.componentRef, 'destroy');
    const detachViewSpy = vi.spyOn(TestBed.inject(ApplicationRef), 'detachView');
    expect(() => instance.emitClose?.('closed')).not.toThrow();
    await expect(ref.result).resolves.toBe('closed');
    expect(instance.unsubscribe).toHaveBeenCalledTimes(1);
    expect(detachViewSpy).toHaveBeenCalledWith(ref.componentRef.hostView);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(service.stackDepth()).toBe(0);
    expect(document.body.querySelector('.dynamic-modal-container')).toBeNull();
  });
  it('captures the exact connected opener before modal DOM effects and restores it', () => {
    const opener = appendFocusedOpener();
    const laterFocus = document.createElement('button');
    document.body.append(laterFocus);
    const openerFocus = vi.spyOn(opener, 'focus');
    const originalAppend = document.body.appendChild.bind(document.body);
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation(node => {
      laterFocus.focus();
      return originalAppend(node);
    });
    const ref = service.open(TestDynamicModalComponent);
    appendSpy.mockRestore();
    ref.close();
    expect(openerFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });
  it('focuses the current top and reacquires the survivor after callbacks have run', () => {
    const closed = service.open(TestDynamicModalComponent);
    closed.close();
    const outer = service.open(TestDynamicModalComponent);
    const inner = service.open(TestDynamicModalComponent);
    expect(createTrap).toHaveBeenCalledTimes(3);
    expect(traps[1].enabled).toBe(false);
    expect(traps[2].enabled).toBe(true);
    flushRender();
    expect(traps[0].focusInitialElement).not.toHaveBeenCalled();
    expect(traps[1].focusInitialElement).not.toHaveBeenCalled();
    expect(traps[2].focusInitialElement).toHaveBeenCalledTimes(1);
    inner.close();
    expect(traps[1].focusInitialElement).toHaveBeenCalledTimes(1);
    outer.close();
  });
  it('reacquires surviving outer focus when inner closes before initial render', () => {
    const outerOpener = appendFocusedOpener();
    const outerFocus = vi.spyOn(outerOpener, 'focus');
    const outerRef = service.open(TestDynamicModalComponent);
    const innerRef = service.open(TestDynamicModalComponent);
    innerRef.close();
    expect(traps[1].destroy).toHaveBeenCalledTimes(1);
    expect(traps[0].enabled).toBe(true);
    expect(traps[0].focusInitialElement).toHaveBeenCalledTimes(1);
    expect(outerFocus).not.toHaveBeenCalled();
    flushRender();
    expect(traps[0].focusInitialElement).toHaveBeenCalledTimes(1);
    outerRef.close();
    expect(outerFocus).toHaveBeenCalledTimes(1);
  });
  it('binds configured close-handler closes to the original modal item', async () => {
    const { settled: outerSettled } = openOuter();
    let innerRef!: ModalRef<string>;
    const closeHandler = vi.fn(() => {
      service.close('service-replay');
      innerRef.close('ref-replay');
    });
    innerRef = service.open<TestDynamicModalComponent, unknown, string>(TestDynamicModalComponent, {
      outputs: { close: closeHandler },
    });
    const inner = innerRef.componentRef.instance as TestDynamicModalComponent;
    inner.close.emit('inner-result');
    await expect(innerRef.result).resolves.toBe('inner-result');
    await Promise.resolve();
    expect(closeHandler).toHaveBeenCalledTimes(1);
    expect(outerSettled).not.toHaveBeenCalled();
    expectOuterModalActive();
    expect(traps[1].destroy).toHaveBeenCalledTimes(1);
  });
  it.each(['unsubscribe', 'trap', 'destroy'] as const)(
    'binds service.close reentry from %s cleanup to the original item',
    expectCleanupServiceClose,
  );
  it('does not restore a stale opener when destroy cleanup opens a new top modal', async () => {
    const opener = appendFocusedOpener();
    const openerFocus = vi.spyOn(opener, 'focus');
    const ref = service.open<OpenModalOnDestroyComponent, unknown, string>(OpenModalOnDestroyComponent);
    (ref.componentRef.instance as OpenModalOnDestroyComponent).throwAfterAction = true;
    expect(() => ref.close('closed')).not.toThrow();
    await expect(ref.result).resolves.toBe('closed');
    expect(service.stackDepth()).toBe(1);
    expect(openerFocus).not.toHaveBeenCalled();
    expect(traps[0].destroy).toHaveBeenCalledTimes(1);
    expect(traps[1].enabled).toBe(true);
  });
  it('reactivates the surviving top trap after cleanup closes a lower modal', () => {
    const lowerRef = service.open(TestDynamicModalComponent);
    service.open(TestDynamicModalComponent);
    const topRef = service.open(OpenModalOnDestroyComponent);
    const top = topRef.componentRef.instance as OpenModalOnDestroyComponent;
    top.onDestroyAction = () => lowerRef.close();
    top.throwAfterAction = true;
    flushRender();
    expect(() => topRef.close()).not.toThrow();
    expect(service.stackDepth()).toBe(1);
    expect(traps[0].destroy).toHaveBeenCalledTimes(1);
    expect(traps[1].enabled).toBe(true);
    expect(traps[1].focusInitialElement).toHaveBeenCalledTimes(1);
    expect(traps[2].destroy).toHaveBeenCalledTimes(1);
  });
  it('closes a non-top modal without moving focus or disturbing the top trap', () => {
    const opener = appendFocusedOpener();
    const openerFocus = vi.spyOn(opener, 'focus');
    const lower = service.open(TestDynamicModalComponent);
    service.open(TestDynamicModalComponent);
    lower.close();
    expect(openerFocus).not.toHaveBeenCalled();
    expect(traps[0].destroy).toHaveBeenCalledTimes(1);
    expect(traps[1].enabled).toBe(true);
    expect(service.stackDepth()).toBe(1);
  });
  it('accepts backdrop and Escape settlement only for the exact top item', () => {
    service.open(TestDynamicModalComponent);
    service.open(TestDynamicModalComponent);
    const backdrops = Array.from(document.querySelectorAll<HTMLElement>('.dynamic-modal-backdrop'));
    backdrops[0].click();
    expect(service.stackDepth()).toBe(2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(service.stackDepth()).toBe(1);
    backdrops[0].click();
    expect(service.stackDepth()).toBe(0);
  });
  it('settles and cleans up once even when a configured close handler throws', async () => {
    const handler = vi.fn(() => {
      throw new Error('handler failed');
    });
    const ref = service.open<TestDynamicModalComponent, unknown, string>(TestDynamicModalComponent, {
      outputs: { close: handler },
    });
    const instance = ref.componentRef.instance as TestDynamicModalComponent;
    expect(() => instance.close.emit('closed')).not.toThrow();
    expect(() => ref.close('replay')).not.toThrow();
    await expect(ref.result).resolves.toBe('closed');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(service.stackDepth()).toBe(0);
    expect(traps[0].destroy).toHaveBeenCalledTimes(1);
  });
  it('continues settlement when trap cleanup and focus restoration throw', async () => {
    const opener = appendFocusedOpener();
    vi.spyOn(opener, 'focus').mockImplementation(() => {
      throw new Error('focus failed');
    });
    const trap = makeTrap();
    trap.destroy.mockImplementation(() => {
      throw new Error('trap failed');
    });
    createTrap.mockReturnValueOnce(trap);
    const ref = service.open(TestDynamicModalComponent);
    expect(() => ref.close()).not.toThrow();
    await expect(ref.result).resolves.toBeUndefined();
    expect(trap.destroy).toHaveBeenCalledTimes(1);
    const laterRef = service.open<TestDynamicModalComponent, unknown, string>(TestDynamicModalComponent);
    service.close('later-close');
    await expect(laterRef.result).resolves.toBe('later-close');
    expect(service.stackDepth()).toBe(0);
    expect(document.body.querySelector('.dynamic-modal-container')).toBeNull();
  });
  it('closeAll owns focus restoration when inner cleanup closes the outer item', async () => {
    const outerOpener = appendFocusedOpener();
    const outerFocus = vi.spyOn(outerOpener, 'focus');
    const { ref: outerRef, opener: innerOpener } = openOuter();
    const innerFocus = vi.spyOn(innerOpener, 'focus');
    const innerRef = service.open<OpenModalOnDestroyComponent, unknown, string>(OpenModalOnDestroyComponent);
    (innerRef.componentRef.instance as OpenModalOnDestroyComponent).onDestroyAction = () =>
      outerRef.close('nested-close');
    service.closeAll();
    await expect(outerRef.result).resolves.toBe('nested-close');
    await expect(innerRef.result).resolves.toBeUndefined();
    expect(outerFocus).toHaveBeenCalledTimes(1);
    expect(innerFocus).not.toHaveBeenCalled();
    expect(traps.every(trap => trap.destroy.mock.calls.length === 1)).toBe(true);
    expect(service.stackDepth()).toBe(0);
  });
  it('keeps a modal opened by closeAll cleanup and suppresses stale focus restoration', () => {
    const opener = appendFocusedOpener();
    const openerFocus = vi.spyOn(opener, 'focus');
    const outerRef = service.open(TestDynamicModalComponent);
    const innerRef = service.open(OpenModalOnDestroyComponent);
    (innerRef.componentRef.instance as OpenModalOnDestroyComponent).onDestroyAction = () => {
      outerRef.close();
      service.open(TestDynamicModalComponent);
    };
    service.closeAll();
    expect(service.stackDepth()).toBe(1);
    expect(openerFocus).not.toHaveBeenCalled();
    expect(traps.slice(0, 2).every(trap => trap.destroy.mock.calls.length === 1)).toBe(true);
    expect(traps[2].enabled).toBe(true);
    service.close();
    expect(openerFocus).toHaveBeenCalledTimes(1);
    expect(service.stackDepth()).toBe(0);
  });
  it('service destruction is terminal against cleanup reentry and later public calls', () => {
    const opener = appendFocusedOpener();
    const openerFocus = vi.spyOn(opener, 'focus');
    const attachView = vi.spyOn(TestBed.inject(ApplicationRef), 'attachView');
    const ref = service.open(OpenModalOnDestroyComponent);
    const destroy = destroyCallbacks[0];
    destroy();
    destroy();
    expect(attachView).toHaveBeenCalledOnce();
    expect(createTrap).toHaveBeenCalledOnce();
    expect(traps[0].destroy).toHaveBeenCalledOnce();
    expect(traps[0].focusInitialElement).not.toHaveBeenCalled();
    expect(service.stackDepth()).toBe(0);
    expect(openerFocus).not.toHaveBeenCalled();
    expect(document.body.querySelector('.dynamic-modal-container')).toBeNull();
    expect(() => service.open(TestDynamicModalComponent)).toThrow(/destroyed/i);
    expect(() => service.closeAll()).not.toThrow();
    expect(() => service.close()).not.toThrow();
    expect(() => ref.close()).not.toThrow();
    flushRender();
    expect(createTrap).toHaveBeenCalledOnce();
  });
});
