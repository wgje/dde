import { ApplicationRef, Component, EventEmitter, Input, OnDestroy, Output, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamicModalService, MODAL_DATA, MODAL_REF } from './dynamic-modal.service';

@Component({
  standalone: true,
  template: `<button type="button">{{ label }}</button>`,
})
class TestDynamicModalComponent {
  @Input() label = '';
  @Output() close = new EventEmitter<unknown>();

  readonly data = inject(MODAL_DATA) as { title: string };
  readonly modalRef = inject(MODAL_REF);
}

@Component({
  standalone: true,
  template: `<button type="button">close</button>`,
})
class ReentrantCloseModalComponent implements OnDestroy {
  readonly modalRef = inject(MODAL_REF);

  ngOnDestroy(): void {
    this.modalRef.close('destroy-close');
  }
}

@Component({
  standalone: true,
  template: `<button type="button">throwing cleanup</button>`,
})
class ThrowingSubscriptionModalComponent {
  emitClose?: (result: string) => void;
  readonly unsubscribe = vi.fn(() => {
    throw new Error('unsubscribe failed');
  });
  readonly close = {
    subscribe: vi.fn((handler: (result: string) => void) => {
      this.emitClose = handler;
      return { unsubscribe: this.unsubscribe };
    }),
  };
}

describe('DynamicModalService', () => {
  let service: DynamicModalService;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    TestBed.configureTestingModule({
      providers: [DynamicModalService],
    });
    service = TestBed.inject(DynamicModalService);
  });

  afterEach(() => {
    service.closeAll();
    vi.unstubAllGlobals();
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

  it('ignores reentrant close calls from component destroy hooks', async () => {
    const ref = service.open<ReentrantCloseModalComponent, unknown, string>(
      ReentrantCloseModalComponent,
    );
    const componentRef = ref.componentRef;
    const destroySpy = vi.spyOn(componentRef, 'destroy');

    ref.close('primary-close');

    await expect(ref.result).resolves.toBe('primary-close');
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(service.stackDepth()).toBe(0);
    expect(document.body.querySelector('.dynamic-modal-container')).toBeNull();
  });

  it('continues modal cleanup when an output subscription unsubscribe throws', async () => {
    const ref = service.open<ThrowingSubscriptionModalComponent, unknown, string>(
      ThrowingSubscriptionModalComponent,
    );
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
});
