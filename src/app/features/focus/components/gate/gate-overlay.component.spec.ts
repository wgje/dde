import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GateService } from '../../../../../services/gate.service';
import { StrataService } from '../../../../../services/strata.service';
import { StrataLayer } from '../../../../../models/focus';
import { GateActionsComponent } from './gate-actions.component';
import { GateCardComponent } from './gate-card.component';
import { GateOverlayComponent } from './gate-overlay.component';

@Component({
  selector: 'app-gate-card',
  standalone: true,
  template: '<div data-testid="gate-card">stub gate card</div>',
})
class StubGateCardComponent {}

@Component({
  selector: 'app-gate-actions',
  standalone: true,
  template: '<div data-testid="gate-actions">stub gate actions</div>',
})
class StubGateActionsComponent {}

describe('GateOverlayComponent', () => {
  let fixture: ComponentFixture<GateOverlayComponent>;

  const layers = signal<StrataLayer[]>([]);
  const progress = signal({ current: 1, total: 3 });
  const showCompletion = signal(false);
  const isActive = signal(true);

  const mockGateService = {
    isActive,
    showCompletionMessage: showCompletion,
    impactTick: signal(0),
    progress,
    markAsRead: vi.fn(),
    markAsCompleted: vi.fn(),
  };

  const mockStrataService = {
    layers,
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    layers.set([
      {
        date: '2026-02-06',
        items: [{ type: 'black_box', id: 'bb-1', title: '第一条记录', completedAt: '2026-02-06T10:00:00Z' }],
        opacity: 1,
      },
    ]);
    progress.set({ current: 1, total: 3 });
    showCompletion.set(false);
    isActive.set(true);

    await TestBed.configureTestingModule({
      imports: [GateOverlayComponent],
      providers: [
        { provide: GateService, useValue: mockGateService },
        { provide: StrataService, useValue: mockStrataService },
      ],
    })
      .overrideComponent(GateOverlayComponent, {
        remove: {
          imports: [GateCardComponent, GateActionsComponent],
        },
        add: {
          imports: [StubGateCardComponent, StubGateActionsComponent],
        },
      })
      .compileComponents();

    fixture = TestBed.createComponent(GateOverlayComponent);
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.resetTestingModule();
  });

  it('should render gate overlay with rubble chips and strata preview', () => {
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('沉积之门');
    expect(text).toContain('2026-02-06');

    const chips = fixture.nativeElement.querySelectorAll('.rubble-chip');
    expect(chips.length).toBe(3);
  });

  it('should render completion message safely', () => {
    showCompletion.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('沉积完成');
  });
});
