import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { MobileDrawerContainerComponent } from './mobile-drawer-container.component';
import { DRAWER_CONFIG } from '../../../../config/drawer.config';

let topContentInstanceCount = 0;

@Component({
  selector: 'app-mobile-drawer-test-top-content',
  standalone: true,
  template: '<div data-testid="top-content">Top content</div>',
})
class MobileDrawerTestTopContentComponent {
  constructor() {
    topContentInstanceCount += 1;
  }
}

@Component({
  standalone: true,
  imports: [MobileDrawerContainerComponent, MobileDrawerTestTopContentComponent],
  template: `
    <app-mobile-drawer-container (drawerStateChange)="events.push($event)">
      <ng-template #topDrawer>
        <app-mobile-drawer-test-top-content />
      </ng-template>
      <div slot="middle">Middle</div>
      <ng-template #bottomDrawer>
        <div data-testid="bottom-content">Bottom content</div>
      </ng-template>
    </app-mobile-drawer-container>
  `,
})
class MobileDrawerTestHostComponent {
  events: unknown[] = [];
}

describe('MobileDrawerContainerComponent', () => {
  let fixture: ComponentFixture<MobileDrawerTestHostComponent>;

  beforeEach(async () => {
    topContentInstanceCount = 0;
    await TestBed.configureTestingModule({
      imports: [MobileDrawerTestHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(MobileDrawerTestHostComponent);
    fixture.detectChanges();
  });

  it('does not instantiate templated top drawer content until the drawer opens', () => {
    expect(topContentInstanceCount).toBe(0);
    expect(fixture.nativeElement.querySelector('[data-testid="top-content"]')).toBeNull();

    const drawer = fixture.debugElement.query(By.directive(MobileDrawerContainerComponent))
      .componentInstance as MobileDrawerContainerComponent;
    drawer.openTopDrawer();
    fixture.detectChanges();

    expect(topContentInstanceCount).toBe(1);
    expect(fixture.nativeElement.querySelector('[data-testid="top-content"]')).not.toBeNull();
  });

  it('does not emit delayed drawerStateChange after destroy', () => {
    vi.useFakeTimers();
    const drawerDebugElement = fixture.debugElement.query(By.directive(MobileDrawerContainerComponent));
    const drawer = drawerDebugElement.componentInstance as MobileDrawerContainerComponent;
    const host = fixture.componentInstance;

    try {
      drawer.toggleTopPanel();
      drawer.ngOnDestroy();
      vi.advanceTimersByTime(DRAWER_CONFIG.ANIMATION_DURATION);

      expect(host.events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears captured touch state on touchcancel so later touchmove is ignored', () => {
    const drawer = fixture.debugElement.query(By.directive(MobileDrawerContainerComponent))
      .componentInstance as MobileDrawerContainerComponent;
    const gestureService = drawer.gestureService;
    const startSpy = vi.spyOn(gestureService, 'onTouchStart').mockReturnValue(true);
    const moveSpy = vi.spyOn(gestureService, 'onTouchMove').mockReturnValue(true);
    const cancelSpy = vi.spyOn(gestureService, 'onTouchCancel');

    drawer.onTouchStart(createTouchEvent('touchstart', 120));
    drawer.onTouchCancel(createTouchEvent('touchcancel', 120));
    drawer.onTouchMove(createTouchEvent('touchmove', 160));

    expect(startSpy).toHaveBeenCalledOnce();
    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('ignores late touch entry points after destroy', () => {
    const drawer = fixture.debugElement.query(By.directive(MobileDrawerContainerComponent))
      .componentInstance as MobileDrawerContainerComponent;
    const gestureService = drawer.gestureService;
    const startSpy = vi.spyOn(gestureService, 'onTouchStart').mockReturnValue(true);
    const moveSpy = vi.spyOn(gestureService, 'onTouchMove');
    const endSpy = vi.spyOn(gestureService, 'onTouchEnd');
    const emitSpy = vi.spyOn(drawer.drawerStateChange, 'emit');

    drawer.ngOnDestroy();
    drawer.onTouchStart(createTouchEvent('touchstart', 120));
    drawer.onTouchMove(createTouchEvent('touchmove', 160));
    drawer.onTouchEnd(createTouchEvent('touchend', 160));

    expect(startSpy).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();
    expect(endSpy).not.toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('does not emit programmatic state changes when the active layer stays unchanged', () => {
    const drawer = fixture.debugElement.query(By.directive(MobileDrawerContainerComponent))
      .componentInstance as MobileDrawerContainerComponent;
    const emitSpy = vi.spyOn(drawer.drawerStateChange, 'emit');

    drawer.openTopDrawer();
    setActiveLayerForTest(drawer, 'top');
    drawer.openTopDrawer();
    drawer.openBottomDrawer();
    setActiveLayerForTest(drawer, 'bottom');
    drawer.openBottomDrawer();
    drawer.closeDrawer();
    setActiveLayerForTest(drawer, 'middle');
    drawer.closeDrawer();

    expect(emitSpy).toHaveBeenCalledTimes(3);
    expect(emitSpy).toHaveBeenNthCalledWith(1, {
      previousLayer: 'middle',
      currentLayer: 'top',
      triggeredBy: 'programmatic',
    });
    expect(emitSpy).toHaveBeenNthCalledWith(2, {
      previousLayer: 'top',
      currentLayer: 'bottom',
      triggeredBy: 'programmatic',
    });
    expect(emitSpy).toHaveBeenNthCalledWith(3, {
      previousLayer: 'bottom',
      currentLayer: 'middle',
      triggeredBy: 'programmatic',
    });
  });

  it('ignores late programmatic drawer entry points after destroy', () => {
    vi.useFakeTimers();
    const drawer = fixture.debugElement.query(By.directive(MobileDrawerContainerComponent))
      .componentInstance as MobileDrawerContainerComponent;
    const gestureService = drawer.gestureService;
    const openTopSpy = vi.spyOn(gestureService, 'openTopDrawer');
    const openBottomSpy = vi.spyOn(gestureService, 'openBottomDrawer');
    const collapseTopSpy = vi.spyOn(gestureService, 'collapseTopDrawer');
    const collapseBottomSpy = vi.spyOn(gestureService, 'collapseBottomDrawer');
    const closeSpy = vi.spyOn(gestureService, 'closeDrawer');
    const emitSpy = vi.spyOn(drawer.drawerStateChange, 'emit');

    try {
      drawer.ngOnDestroy();
      drawer.toggleTopPanel();
      drawer.toggleBottomPanel();
      drawer.openTopDrawer();
      drawer.openBottomDrawer();
      drawer.closeDrawer();
      vi.advanceTimersByTime(DRAWER_CONFIG.ANIMATION_DURATION);

      expect(openTopSpy).not.toHaveBeenCalled();
      expect(openBottomSpy).not.toHaveBeenCalled();
      expect(collapseTopSpy).not.toHaveBeenCalled();
      expect(collapseBottomSpy).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

function createTouchEvent(type: string, clientY: number): TouchEvent {
  return {
    type,
    touches: [{ clientY }],
    changedTouches: [{ clientY }],
    preventDefault: vi.fn(),
  } as unknown as TouchEvent;
}

function setActiveLayerForTest(
  drawer: MobileDrawerContainerComponent,
  layer: 'top' | 'middle' | 'bottom',
): void {
  const service = drawer.gestureService;
  if (layer === 'top') {
    service.topPanelHeight.set(DRAWER_CONFIG.TOP_SNAP_POINTS.HALF);
    service.bottomPanelHeight.set(DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED);
    return;
  }
  if (layer === 'bottom') {
    service.topPanelHeight.set(DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED);
    service.bottomPanelHeight.set(DRAWER_CONFIG.BOTTOM_SNAP_POINTS.HALF);
    return;
  }
  service.topPanelHeight.set(DRAWER_CONFIG.TOP_SNAP_POINTS.COLLAPSED);
  service.bottomPanelHeight.set(DRAWER_CONFIG.BOTTOM_SNAP_POINTS.COLLAPSED);
}
