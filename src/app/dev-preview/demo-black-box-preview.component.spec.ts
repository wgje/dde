import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoBlackBoxPreviewComponent, DemoInboxMemory } from './demo-black-box-preview.component';
import { BlackBoxPanelComponent } from '../features/focus/components/black-box/black-box-panel.component';

import { BlackBoxEntryComponent } from '../features/focus/components/black-box/black-box-entry.component';
import { BlackBoxTextInputComponent } from '../features/focus/components/black-box/black-box-text-input.component';
import { BlackBoxRecorderComponent } from '../features/focus/components/black-box/black-box-recorder.component';
import { StrataViewComponent } from '../features/focus/components/strata/strata-view.component';
import { StrataLayerComponent } from '../features/focus/components/strata/strata-layer.component';

describe('complete inbox preview', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
  async function render(state: string) {
    const types: Array<[unknown,string[],string[]]> = [
      [DemoBlackBoxPreviewComponent,['state'],[]], [BlackBoxPanelComponent,['expandToken'],['swipeToSwitch']],
      [BlackBoxTextInputComponent,['showFallbackHint','appearance'],['submitted']],

      [BlackBoxEntryComponent,['entry','appearance'],['markRead','markCompleted','delete']],
      [BlackBoxRecorderComponent,['appearance','onTranscribed'],['transcribed']],
      [StrataViewComponent,['alwaysShow'],['restoreItem']], [StrataLayerComponent,['layer','index'],['restoreItem']],
    ];
    for(const [type,inputs,outputs] of types){const def=(type as {ɵcmp:{inputs:Record<string,unknown>;outputs:Record<string,string>}}).ɵcmp;def.inputs={...def.inputs};def.outputs={...def.outputs};for(const name of inputs)def.inputs[name]=[name,1,null];for(const name of outputs)def.outputs[name]=name;}
    await TestBed.configureTestingModule({imports:[DemoBlackBoxPreviewComponent]}).compileComponents();
    const fixture=TestBed.createComponent(DemoBlackBoxPreviewComponent);fixture.componentRef.setInput('state',state);fixture.detectChanges();await fixture.whenStable();fixture.detectChanges();return fixture;
  }
  it.each(['panel','mobile','recorder','recording','transcription','strata'])('renders real components for %s',async state=>{const view=await render(state);expect(view.nativeElement.textContent.length).toBeGreaterThan(20);view.destroy();});
  it('creates entries in the scoped inbox without network or storage',async()=>{
    const write=vi.spyOn(Storage.prototype,'setItem');const network=vi.spyOn(globalThis,'fetch');
    const view=await render('panel');const memory=view.debugElement.injector.get(DemoInboxMemory);
    await memory.createDurably({content:'安全的新想法'});view.detectChanges();
    expect(view.nativeElement.textContent).toContain('安全的新想法');expect(write).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();view.destroy();
  });
  it.each(['panel', 'mobile'])('mounts labeled SVG actions immediately in %s', async state => {
    const view = await render(state);
    const entry = view.nativeElement.querySelector('app-black-box-entry');
    expect(entry).not.toBeNull();
    for (const label of ['标记已读', '标记完成', '删除']) {
      const button = entry.querySelector(`button[aria-label="${label}"]`);
      expect(button).not.toBeNull();
      expect(button.textContent.trim().length).toBeGreaterThan(0);
      expect(button.querySelector('svg[aria-hidden="true"][focusable="false"]')).not.toBeNull();
    }
    expect(entry.querySelector('[data-testid="black-box-entry-actions"]').classList.contains('opacity-0')).toBe(false);
    expect(view.nativeElement.textContent).not.toMatch(/[📦👁✅🗑⏳]/u);
    const pending = view.nativeElement.querySelector('[data-testid="sync-pending-indicator"]');
    expect(pending.textContent).toContain('待同步');
    expect(pending.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const memory = view.debugElement.injector.get(DemoInboxMemory);
    const id = memory.entries()[0].id;
    entry.querySelector('button[aria-label="标记已读"]').click();
    await view.whenStable(); view.detectChanges();
    expect(memory.entries().find(row => row.id === id)?.isRead).toBe(true);
    expect(entry.querySelector('button[aria-label="标记已读"]')).toBeNull();
    entry.querySelector('button[aria-label="标记完成"]').click();
    await view.whenStable(); view.detectChanges();
    expect(memory.entries().find(row => row.id === id)?.isCompleted).toBe(true);
    expect(entry.textContent).toContain('已完成');
    view.destroy();
  });
  it.each(['panel', 'mobile'])('renders pending and offline SVGs without cloud or durable writes in %s', async state => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const network = vi.spyOn(globalThis, 'fetch');
    const view = await render(state);
    const memory = view.debugElement.injector.get(DemoInboxMemory);
    memory.entries.update(rows => rows.map(row => ({ ...row, userId: 'preview-only-user', syncStatus: 'pending' as const })));
    memory.offlinePendingCount.set(2);
    view.detectChanges();
    const pending = view.nativeElement.querySelector('[data-testid="sync-pending-indicator"]');
    expect(pending.textContent).toContain('待同步');
    expect(pending.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(view.nativeElement.textContent).toContain('2 条录音待联网后转写');
    expect(view.nativeElement.textContent).not.toMatch(/[⏳📡]/u);
    expect(write).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    view.destroy();
  });
  it('keeps the history restore action explicit and functional with an undo SVG', async () => {
    const view = await render('strata');
    const memory = view.debugElement.injector.get(DemoInboxMemory);
    const count = memory.totalCount();
    const restore = view.nativeElement.querySelector('.strata-restore-btn');
    expect(restore.textContent.trim()).toBe('恢复');
    expect(restore.querySelector('svg[aria-hidden="true"][focusable="false"]')).not.toBeNull();
    restore.click(); await view.whenStable(); view.detectChanges();
    expect(memory.totalCount()).toBe(count - 1);
    expect(view.nativeElement.textContent).toContain('虚拟历史条目已恢复');
    view.destroy();
  });
  it('new instance resets inbox and ids',()=>{const first=new DemoInboxMemory();first.reset('panel');const second=new DemoInboxMemory();second.reset('panel');expect(first.entries()[0].id).not.toBe(second.entries()[0].id);});
});