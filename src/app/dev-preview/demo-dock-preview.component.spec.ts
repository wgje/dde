import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it } from 'vitest';
import { DemoDockPreviewComponent } from './demo-dock-preview.component';
import { DockMobileDrawerComponent } from '../features/parking/components/dock-mobile-drawer.component';

function render(widget: string, state: string) {
  // Vitest JIT does not extract signal-input metadata (the app AOT compiler does).
  const definition = (DemoDockPreviewComponent as unknown as {
    ɵcmp: { inputs: Record<string, unknown> };
  }).ɵcmp;
  definition.inputs = { ...definition.inputs, widget: ['widget', 1, null], state: ['state', 1, null] };
  const drawerDefinition = (DockMobileDrawerComponent as unknown as {
    ɵcmp: { inputs: Record<string, unknown> };
  }).ɵcmp;
  drawerDefinition.inputs = { ...drawerDefinition.inputs };
  for (const name of ['entries', 'projects', 'showTrigger']) drawerDefinition.inputs[name] = [name, 1, null];
  TestBed.configureTestingModule({ imports: [DemoDockPreviewComponent] });
  const fixture = TestBed.createComponent(DemoDockPreviewComponent);
  fixture.componentRef.setInput('widget', widget);
  fixture.componentRef.setInput('state', state);
  fixture.detectChanges();
  TestBed.flushEffects();
  fixture.detectChanges();
  return fixture;
}

describe('DemoDockPreviewComponent ready initial states', () => {
  it('mounts the real task form without requiring a trigger', () => {
    const fixture = render('dock', 'create');
    expect(fixture.nativeElement.querySelector('app-dock-inline-task-form')).not.toBeNull();
    expect(fixture.componentInstance.title()).toBe('检查今天的任务');
  });

  it('mounts and opens the real result drawer on the first render', () => {
    const fixture = render('dock', 'created');
    const drawer = fixture.debugElement.query(By.directive(DockMobileDrawerComponent));
    expect(drawer).not.toBeNull();
    expect((drawer.componentInstance as DockMobileDrawerComponent).opened()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="demo-dock-created"]')?.textContent).toContain('检查今天的任务');
  });

  it('mounts the real minimap legend on the first render', () => {
    const fixture = render('flow', 'legend');
    expect(fixture.nativeElement.querySelector('app-flow-minimap-legend')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-dock-mobile-drawer')).toBeNull();
  });

  it('starts the mobile-entry fixture collapsed and opens through the real trigger', () => {
    const fixture = render('dock', 'mobile-entry');
    const drawer = fixture.debugElement.query(By.directive(DockMobileDrawerComponent)).componentInstance as DockMobileDrawerComponent;
    expect(drawer.opened()).toBe(false);
    const trigger = fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-drawer-trigger"]') as HTMLButtonElement;
    expect(trigger.textContent).toContain('停泊坞');
    expect(trigger.querySelector('small')?.textContent).toBe(String(drawer.activeEntries().length));
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-focus-entry"]')).not.toBeNull();
    trigger.click();
    fixture.detectChanges();
    expect(drawer.opened()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-task-drawer"]')).not.toBeNull();
    fixture.destroy();
    TestBed.resetTestingModule();
    const fresh = render('dock', 'mobile-entry');
    expect((fresh.debugElement.query(By.directive(DockMobileDrawerComponent)).componentInstance as DockMobileDrawerComponent).opened()).toBe(false);
  });

  it('mounts the mobile-open result directly without performing a task action', () => {
    const fixture = render('dock', 'mobile-open');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-task-drawer"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-drawer-trigger"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="当前主任务"]')?.textContent).toContain('检查今天的任务');
  });
});
