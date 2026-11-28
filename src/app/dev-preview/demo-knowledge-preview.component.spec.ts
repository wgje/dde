import {TestBed} from '@angular/core/testing';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {DemoKnowledgePreviewComponent} from './demo-knowledge-preview.component';
import {KnowledgeAnchorComponent} from '../shared/components/knowledge-anchor/knowledge-anchor.component';
import {KnowledgeAnchorPopoverComponent} from '../shared/components/knowledge-anchor/knowledge-anchor-popover.component';
async function render(state:string){
  for(const [type,names] of [[KnowledgeAnchorComponent,['taskId','isMobile','editable','manageable','compact','previewMode']],[KnowledgeAnchorPopoverComponent,['link']]] as Array<[unknown,string[]]>){const d=(type as {ɵcmp:{inputs:Record<string,unknown>}}).ɵcmp;d.inputs={...d.inputs};for(const n of names)d.inputs[n]=[n,1,null];}
  await TestBed.configureTestingModule({imports:[DemoKnowledgePreviewComponent]}).compileComponents();
  const f=TestBed.createComponent(DemoKnowledgePreviewComponent);f.componentRef.setInput('state',state);f.detectChanges();await f.whenStable();f.detectChanges();return f;
}
describe('virtual real knowledge block',()=>{
 afterEach(()=>{vi.restoreAllMocks();TestBed.resetTestingModule();});
 it('shows bound chip and full real popover text without a root overlay',async()=>{const f=await render('preview');expect(f.nativeElement.textContent).toContain('虚拟思源文档');expect(f.nativeElement.textContent).toContain('虚拟思源块正文');expect(f.nativeElement.textContent).toContain('子块一');expect(f.nativeElement.querySelector('app-knowledge-anchor-popover')).toBeTruthy();});
 it('open bound block displays the virtual preview and never fetches',async()=>{const f=await render('bound');const network=vi.spyOn(globalThis,'fetch');const chip=f.nativeElement.querySelector('[data-testid=knowledge-anchor-chip]') as HTMLButtonElement | null;expect(chip).toBeTruthy();chip!.click();f.detectChanges();await f.whenStable();f.detectChanges();expect(f.nativeElement.textContent).toContain('虚拟思源块正文');expect(network).not.toHaveBeenCalled();});
 it('unbound sample can bind and remove using memory only',async()=>{const f=await render('unbound');expect(f.componentInstance.memory.links()).toHaveLength(0);await f.componentInstance.memory.bindSiyuanBlock();f.detectChanges();expect(f.componentInstance.memory.links()).toHaveLength(1);await f.componentInstance.memory.removeLink(f.componentInstance.memory.links()[0].id);expect(f.componentInstance.memory.links()).toHaveLength(0);});
});