import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GateService } from '../../../../../services/gate.service';
import { GateCardComponent } from './gate-card.component';

describe('GateCardComponent', () => {
  let fixture: ComponentFixture<GateCardComponent>;
  let component: GateCardComponent;

  const mockGateService = {
    progress: signal({ current: 1, total: 2 }),
    currentEntry: signal({
      id: 'entry-1',
      content: '门体测试内容',
      createdAt: new Date().toISOString(),
    }),
    impactTick: signal(0),
    cardAnimation: signal<'idle' | 'entering' | 'heave_read' | 'heavy_drop' | 'settling'>('idle'),
    markAsRead: vi.fn(),
    markAsCompleted: vi.fn(),
    onEnteringComplete: vi.fn(),
    onHeaveReadComplete: vi.fn(),
    onHeavyDropComplete: vi.fn(),
    onSettlingComplete: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGateService.cardAnimation.set('idle');

    await TestBed.configureTestingModule({
      imports: [GateCardComponent],
      providers: [{ provide: GateService, useValue: mockGateService }],
    }).compileComponents();

    fixture = TestBed.createComponent(GateCardComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  it('should render gate content and progress', () => {
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('门体测试内容');
    expect(text).toContain('1/2');
  });

  it('should call onEnteringComplete when entering animation ends', () => {
    mockGateService.cardAnimation.set('entering');
    const node = {} as EventTarget;

    component.onAnimationEnd({
      target: node,
      currentTarget: node,
    } as AnimationEvent);

    expect(mockGateService.onEnteringComplete).toHaveBeenCalledOnce();
  });

  it('drag down should trigger markAsCompleted', () => {
    component.onPointerDown({
      button: 0,
      pointerId: 1,
      clientY: 100,
      currentTarget: { setPointerCapture: vi.fn() },
    } as unknown as PointerEvent);

    component.onPointerMove({ pointerId: 1, clientY: 220 } as PointerEvent);
    component.onPointerUp({ pointerId: 1 } as PointerEvent);

    expect(mockGateService.markAsCompleted).toHaveBeenCalledOnce();
  });

  it('impact tick should only pulse the gate card scene', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    fixture.detectChanges();

    const scene = fixture.nativeElement.querySelector('.gate-card-scene') as HTMLElement;
    expect(scene.classList.contains('impact-pulse')).toBe(false);

    mockGateService.impactTick.update(value => value + 1);
    fixture.detectChanges();

    expect(scene.classList.contains('impact-pulse')).toBe(true);
  });

  it('drag up should trigger markAsRead', () => {
    component.onPointerDown({
      button: 0,
      pointerId: 1,
      clientY: 220,
      currentTarget: { setPointerCapture: vi.fn() },
    } as unknown as PointerEvent);

    component.onPointerMove({ pointerId: 1, clientY: 100 } as PointerEvent);
    component.onPointerUp({ pointerId: 1 } as PointerEvent);

    expect(mockGateService.markAsRead).toHaveBeenCalledOnce();
  });
});
