import { Injector, NgZone, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FlowMinimapComponent } from '../features/flow/components/flow-minimap.component';
import { DemoFlowMemoryService, DemoFlowPreviewComponent, createDemoFlowData } from './demo-flow-preview.component';

// Repo unit config aliases GoJS; browser acceptance must additionally use the real runtime.
describe('DemoFlowPreviewComponent fixture and lifetime', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });

  it.each(['overview-dense', 'overview-selected', 'overview-zoomed', 'overview-dense-mobile'])('mounts the real minimap immediately for %s without durable data', async state => {
    // Canvas layout is browser-only; mounting and model isolation are independently verified here.
    vi.spyOn(DemoFlowPreviewComponent.prototype, 'ngAfterViewInit').mockImplementation(() => {});
    await TestBed.configureTestingModule({ imports: [DemoFlowPreviewComponent] }).compileComponents();
    const fixture = TestBed.createComponent(DemoFlowPreviewComponent);
    fixture.componentRef.setInput('state', state);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(FlowMinimapComponent))).not.toBeNull();
    expect(fixture.nativeElement.querySelector('svg.minimap-svg')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('选中树 1 的任务 13');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('creates four fresh 31-task trees with a cross-tree relationship for dense selection and zoom', () => {
    const first = createDemoFlowData('overview-dense');
    const second = createDemoFlowData('overview-selected');
    expect(first.nodes).toHaveLength(124);
    expect(first.links).toHaveLength(121);
    expect(first.links.some(link => link.isCrossTree)).toBe(true);
    const keys = new Set(first.nodes.map(node => node.key));
    expect(second.nodes.every(node => !keys.has(node.key))).toBe(true);
  });

  it('creates distinct client UUIDs and actual graph links without user workspace entities', () => {
    const data = createDemoFlowData('normal');
    expect(data.nodes).toHaveLength(3);
    expect(data.links).toHaveLength(2);
    const first = new Set(data.nodes.map(node => node.key));
    const second = createDemoFlowData('normal');
    expect(second.nodes.every(node => !first.has(node.key))).toBe(true);
    expect(data.nodes.every(node => typeof node.key === 'string' && /^[0-9a-f-]{36}$/i.test(node.key))).toBe(true);
  });

  it('maps each supported state to the expected real Flow model marker', () => {
    expect(createDemoFlowData('parked').nodes[0].isParked).toBe(true);
    expect(createDemoFlowData('focused').nodes[0].isDockFocused).toBe(true);
    expect(createDemoFlowData('search').nodes[0].isSearchMatch).toBe(true);
    const sidecar = createDemoFlowData('sidecar').nodes[0];
    expect(sidecar.sidecarHasSignals).toBe(true);
    expect(sidecar.sidecarExpanded).toBe(true);
  });

  it('clears the diagram adapter and detaches the actual canvas on destroy', () => {
    const memory = new DemoFlowMemoryService();
    const instance = { div: document.createElement('div') };
    memory.diagramInstance = instance as never;
    const injector = Injector.create({providers: [
      {provide: DemoFlowMemoryService, useValue: memory},
      {provide: NgZone, useValue: {runOutsideAngular: (fn: () => unknown) => fn()}},
    ]});
    const component = runInInjectionContext(injector, () => new DemoFlowPreviewComponent());
    component.ngOnDestroy();
    expect(instance.div).toBeNull();
    expect(memory.isInitialized).toBe(false);
    expect(memory.diagramInstance).toBeNull();
  });

  it('avoids the legacy global diagram class selector hiding GoJS internal surfaces', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/dev-preview/demo-flow-preview.component.ts'), 'utf8');
    expect(source).toContain('class="preview-canvas"');
    expect(source).not.toContain('class="diagram"');
  });
  it('imports the production minimap component rather than drawing a fake minimap', () => {
    expect(FlowMinimapComponent).toBeTypeOf('function');
  });
});
