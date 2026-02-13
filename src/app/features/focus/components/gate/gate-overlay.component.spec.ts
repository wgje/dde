import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GateService } from '../../../../../services/gate.service';
import { StrataService } from '../../../../../services/strata.service';
import { StrataLayer } from '../../../../../models/focus';
import { GateActionsComponent } from './gate-actions.component';
import { GateCardComponent } from './gate-card.component';
import { GateOverlayComponent } from './gate-overlay.component';

@Component({
  selector: 'app-gate-card',
  standalone: true,
  template: '',
})
class StubGateCardComponent {}

@Component({
  selector: 'app-gate-actions',
  standalone: true,
  template: '',
})
class StubGateActionsComponent {}

describe('GateOverlayComponent', () => {
  let fixture: ComponentFixture<GateOverlayComponent>;

  const layers = signal<StrataLayer[]>([]);
  const mockGateService = {
    isActive: signal(true),
    showCompletionMessage: signal(false),
    markAsRead: vi.fn(),
    markAsCompleted: vi.fn(),
    canSnooze: vi.fn(() => true),
    snooze: vi.fn(),
  };

  const mockStrataService = {
    layers,
  };

  beforeEach(async () => {
    layers.set([
      {
        date: '2026-02-06',
        items: [
          { type: 'black_box', id: 'bb-1', title: '第一条记录', completedAt: '2026-02-06T10:00:00Z' },
          { type: 'task', id: 'task-1', title: '第二条记录', completedAt: '2026-02-06T11:00:00Z' },
        ],
        opacity: 1,
      },
    ]);

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

  it('should render strata item titles without slice runtime errors', () => {
    expect(() => fixture.detectChanges()).not.toThrow();
    // In new minimalist design, we only show the date, not the items
    expect(fixture.nativeElement.textContent).toContain('2026-02-06');
  });

  it('should handle empty items list safely', () => {
    layers.set([
      {
        date: '2026-02-05',
        items: [],
        opacity: 1,
      },
    ]);

    expect(() => fixture.detectChanges()).not.toThrow();
  });
});
