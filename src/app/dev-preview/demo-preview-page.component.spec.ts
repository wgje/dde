import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DockMobileDrawerComponent } from '../features/parking/components/dock-mobile-drawer.component';
import { DemoPreviewPageComponent } from './demo-preview-page.component';
import { DemoDockEntryPreviewComponent } from './demo-dock-entry-preview.component';

describe('development Dock preview routes', () => {
  afterEach(() => TestBed.resetTestingModule());
  it.each(['mobile-entry', 'mobile-open'] as const)('mounts real drawer: %s', async state => {
    for (const [component, names] of [
      [DemoPreviewPageComponent, ['widget', 'state']],
      [DemoDockEntryPreviewComponent, ['state']],
      [DockMobileDrawerComponent, ['entries', 'projects', 'showTrigger', 'activeView', 'focusActive', 'interactive', 'readOnly']],
    ] as const) {
      const definition = (component as unknown as { ɵcmp: { inputs: Record<string, unknown> } }).ɵcmp;
      definition.inputs = { ...definition.inputs };
      for (const name of names) definition.inputs[name] = [name, 1, null];
    }
    await TestBed.configureTestingModule({ imports: [DemoPreviewPageComponent] }).compileComponents();
    const fixture = TestBed.createComponent(DemoPreviewPageComponent);
    fixture.componentRef.setInput('widget', 'dock');
    fixture.componentRef.setInput('state', state);
    fixture.detectChanges(); TestBed.flushEffects(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-dock-mobile-drawer')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('虚拟数据');
    expect(!!fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-task-drawer"]')).toBe(state === 'mobile-open');
    fixture.destroy();
  });
});
