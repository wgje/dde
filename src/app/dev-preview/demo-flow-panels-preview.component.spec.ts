import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { DemoFlowPanelsPreviewComponent } from './demo-flow-panels-preview.component';
import { FlowPaletteComponent } from '../features/flow/components/flow-palette.component';
import { FlowRightPanelComponent } from '../features/flow/components/flow-right-panel.component';
import { BlackBoxPanelComponent } from '../features/focus/components/black-box/black-box-panel.component';
import { BlackBoxEntryComponent } from '../features/focus/components/black-box/black-box-entry.component';
import { BlackBoxTextInputComponent } from '../features/focus/components/black-box/black-box-text-input.component';
import { BlackBoxRecorderComponent } from '../features/focus/components/black-box/black-box-recorder.component';
import { StrataViewComponent } from '../features/focus/components/strata/strata-view.component';
import { StrataLayerComponent } from '../features/focus/components/strata/strata-layer.component';
import { readFileSync } from 'node:fs';

describe('DemoFlowPanelsPreviewComponent isolated real panels', () => {
 afterEach(()=>{TestBed.resetTestingModule();vi.restoreAllMocks();});
 async function render(state:string){
  const bindings:Array<[unknown,string[],string[]]>=[
   [FlowPaletteComponent,['height','isDropTargetActive','blackBoxEntriesOverride'],['heightChange','centerOnNode','createUnassigned','taskClick','taskDragStart','taskDrop','taskTouchStart','taskTouchMove','taskTouchEnd','swipeToText','swipeToSidebar','isOpenChange']],
   [FlowRightPanelComponent,['isOpen'],['close','projectClick']],
   [BlackBoxPanelComponent,['expandToken'],['swipeToSwitch']],
   [BlackBoxTextInputComponent,['showFallbackHint','appearance'],['submitted']],
   [BlackBoxEntryComponent,['entry','appearance'],['markRead','markCompleted','delete']],
   [BlackBoxRecorderComponent,['appearance','onTranscribed'],['transcribed']],
   [StrataViewComponent,['alwaysShow'],['restoreItem']],
   [StrataLayerComponent,['layer','index'],['restoreItem']],
  ];
  for(const[type,inputs,outputs]of bindings){const def=(type as {ɵcmp:{inputs:Record<string,unknown>;outputs:Record<string,string>}}).ɵcmp;def.inputs={...def.inputs};def.outputs={...def.outputs};for(const name of inputs)def.inputs[name]=[name,1,null];for(const name of outputs)def.outputs[name]=name;}
  await TestBed.configureTestingModule({imports:[DemoFlowPanelsPreviewComponent]}).compileComponents();
  const fixture=TestBed.createComponent(DemoFlowPanelsPreviewComponent);fixture.componentRef.setInput('state',state);fixture.detectChanges();await fixture.whenStable();fixture.detectChanges();return fixture;
 }
 it.each(['palette','palette-unassigned','palette-blackbox','palette-history','right-panel'])('renders %s from real leaves with no Storage or network access',async state=>{
  const read=vi.spyOn(Storage.prototype,'getItem');const write=vi.spyOn(Storage.prototype,'setItem');const fetch=vi.spyOn(globalThis,'fetch');
  const view=await render(state);expect(view.nativeElement.textContent.length).toBeGreaterThan(20);expect(read).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();view.destroy();
 });
 it('uses explicit local inbox projection rather than global black-box map',async()=>{const view=await render('palette');const palette=view.debugElement.query(By.directive(FlowPaletteComponent)).componentInstance as FlowPaletteComponent;expect(palette.allBlackBoxEntries()).toEqual(view.componentInstance.inbox.entries().filter(entry=>!entry.deletedAt && !entry.isArchived));view.destroy();});
 it('switches project through the real panel without route navigation',async()=>{const view=await render('right-panel');const panel=view.debugElement.query(By.directive(FlowRightPanelComponent)).componentInstance as FlowRightPanelComponent;const id=view.componentInstance.memory.projects()[1].id;panel.onProjectClick(id);view.detectChanges();expect(view.componentInstance.memory.activeProjectId()).toBe(id);expect(view.nativeElement.textContent).toContain('没有离开此页');view.destroy();});
 it('embeds actual overview on the existing real diagram adapter rather than an empty host',()=>{const source=readFileSync('src/app/dev-preview/demo-flow-preview.component.ts','utf8');expect(source).toContain('FlowOverviewPanelComponent');expect(source).toContain("state().startsWith('overview')");expect(source).toContain('{ provide: FlowDiagramService, useExisting: DemoFlowMemoryService }');expect(source).toContain('this.memory.diagramInstance = diagram');});
});