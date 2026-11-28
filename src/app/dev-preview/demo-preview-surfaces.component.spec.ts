import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { DemoPreviewSurfacesComponent } from './demo-preview-surfaces.component';
import { DemoPreviewMemoryService } from './demo-preview-memory.service';
import { DockEngineService } from '../../services/dock-engine.service';
import { ProjectStateService } from '../../services/project-state.service';
import { GateService } from '../../services/gate.service';

describe('DemoPreviewSurfacesComponent memory isolation', () => {
  function render(widget: string, state = 'default') {
    // Angular JIT does not infer input() metadata in this lane; mirror the AOT input mapping.
    const def = (DemoPreviewSurfacesComponent as unknown as { ɵcmp: { inputs: Record<string, unknown> } }).ɵcmp;
    def.inputs = { ...def.inputs };
    for (const name of ['widget', 'state', 'persistentKey']) def.inputs[name] = [name, 1, null];
    TestBed.configureTestingModule({ imports: [DemoPreviewSurfacesComponent] });
    const fixture = TestBed.createComponent(DemoPreviewSurfacesComponent);
    fixture.componentRef.setInput('widget', widget);
    fixture.componentRef.setInput('state', state);
    fixture.detectChanges();
    TestBed.flushEffects();
    fixture.detectChanges();
    return fixture;
  }
  it('renders the real available appearance settings and updates only local state', () => {
    const fixture = render('settings');
    expect(fixture.nativeElement.querySelector('app-settings-modal-appearance')).not.toBeNull();
    const darkButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(button => (button as HTMLElement).textContent?.includes('深色')) as HTMLButtonElement;
    darkButton.click(); fixture.detectChanges();
    expect(fixture.componentInstance.colorMode()).toBe('dark');
    fixture.destroy();
  });
  it('renders the real status HUD with isolated in-memory engine providers', () => {
    const fixture = render('status');
    const memory = fixture.debugElement.injector.get(DemoPreviewMemoryService);
    expect(fixture.debugElement.injector.get(DockEngineService)).toBe(memory);
    expect(fixture.nativeElement.querySelector('app-dock-status-machine')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('正在写方案');
    fixture.destroy();
  });
  it('renders the real Gate card and daily task without root services', () => {
    const gate = render('gate');
    expect(gate.debugElement.injector.get(GateService)).toBe(gate.componentInstance.memory);
    expect(gate.nativeElement.textContent).toContain('记下一个想法');
    gate.destroy(); TestBed.resetTestingModule();
    const daily = render('daily', 'daily');
    expect(daily.nativeElement.querySelector('app-dock-daily-slot')).not.toBeNull();
    daily.destroy();
  });
  it('restores only virtual deleted-task data using memory project state', async () => {
    const fixture = render('recovery');
    const memory = fixture.componentInstance.memory;
    expect(fixture.debugElement.injector.get(ProjectStateService)).toBe(memory);
    const restore = fixture.nativeElement.querySelector('button[title="恢复任务"]') as HTMLButtonElement;
    expect(restore).not.toBeNull(); restore.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(memory.deletedTasks()).toHaveLength(0); fixture.destroy();
  });
  it('does not read or write browser Storage in direct-preview mode', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem'); const write = vi.spyOn(Storage.prototype, 'setItem');
    read.mockClear(); write.mockClear();
    const fixture = render('settings');
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    fixture.destroy(); read.mockRestore(); write.mockRestore();
  });
});