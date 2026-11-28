import { ChangeDetectionStrategy, Component, Injectable, inject, Input, signal } from '@angular/core';
import { KnowledgeAnchorComponent } from '../shared/components/knowledge-anchor/knowledge-anchor.component';
import { KnowledgeAnchorPopoverComponent } from '../shared/components/knowledge-anchor/knowledge-anchor-popover.component';
import { ExternalSourceLinkService } from '../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../core/external-sources/siyuan/siyuan-preview.service';
import type { ExternalSourceLink, SiyuanPreviewResult } from '../core/external-sources/external-source.model';
import { AuthService } from '../../services/auth.service';
import { LoggerService } from '../../services/logger.service';
@Injectable()
export class DemoKnowledgeMemory {
  readonly taskId=crypto.randomUUID();
  readonly links=signal<ExternalSourceLink[]>([]);
  readonly message=signal('');
  readonly showPreview=signal(false);
  readonly owner='demo-knowledge-memory';
  link(): ExternalSourceLink { return {id:crypto.randomUUID(),taskId:this.taskId,sourceType:'siyuan-block',targetId:'20261127080000-demo001',uri:'siyuan://blocks/20261127080000-demo001',label:'虚拟思源文档',hpath:'/演示笔记/产品方案',role:'reference',sortOrder:0,createdAt:'2026-11-27T08:00:00Z',updatedAt:'2026-11-27T08:00:00Z'}; }
  reset(state:string):void {this.links.set(state==='unbound'?[]:[this.link()]);this.showPreview.set(state==='preview');this.message.set('');}
  currentUserId():string {return this.owner;}
  captureAuthIdentityFence():string {return this.owner;}
  activeLinksForTask(id:string):ExternalSourceLink[]{return this.links().filter(l=>l.taskId===id&&!l.deletedAt);}
  async bindSiyuanBlock():Promise<ExternalSourceLink>{const link=this.link();this.links.update(ls=>[...ls,link]);return link;}
  async replaceSiyuanBlock(id:string):Promise<ExternalSourceLink>{const link={...this.link(),id};this.links.update(ls=>ls.map(l=>l.id===id?link:l));return link;}
  async removeLink(id:string):Promise<void>{this.links.update(ls=>ls.filter(l=>l.id!==id));}
  openLink():void {this.showPreview.set(true);this.message.set('正在展示虚拟思源内容，没有打开真实思源。');}
  async updateMetadata(id:string,patch:Partial<ExternalSourceLink>):Promise<void>{this.links.update(ls=>ls.map(l=>l.id===id?{...l,...patch}:l));}
  preview(link:ExternalSourceLink):Promise<SiyuanPreviewResult>{return Promise.resolve({status:'ready',origin:'cache',preview:{blockId:link.targetId,linkId:link.id,title:'虚拟思源文档',hpath:'/演示笔记/产品方案',plainText:'这里是一段虚拟思源块正文。\n修改组件后可以立即查看标题、路径、正文和子块的呈现效果。',excerpt:'这里是一段虚拟思源块正文。\n修改组件后可以立即查看标题、路径、正文和子块的呈现效果。',childBlocks:[{id:crypto.randomUUID(),content:'子块一：说明用户目标',type:'p'},{id:crypto.randomUUID(),content:'子块二：记录验收步骤',type:'p'}],truncated:false,fetchedAt:'2026-11-27T08:00:00Z',fetchStatus:'ready'}});}
  category():{debug:()=>void;warn:()=>void}{return {debug:()=>{},warn:()=>{}};}
}
@Component({selector:'app-demo-knowledge-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
  imports:[KnowledgeAnchorComponent,KnowledgeAnchorPopoverComponent],
  providers:[DemoKnowledgeMemory,...[ExternalSourceLinkService,SiyuanPreviewService,AuthService,LoggerService].map(provide=>({provide,useExisting:DemoKnowledgeMemory}))],
  template:`<section data-testid="demo-knowledge-preview"><app-knowledge-anchor [taskId]="memory.taskId" [manageable]="true" [editable]="state()==='unbound'" previewMode="deep-link-only" />
  @if(memory.showPreview() && memory.links()[0];as link){<app-knowledge-anchor-popover [link]="link" />}
  <p role="status">{{memory.message()}}</p></section>`,styles:[`:host{display:block;min-width:0}section{padding:16px;border:1px solid #d6d3d1;border-radius:12px}p{font-size:12px}`]})
export class DemoKnowledgePreviewComponent {
  readonly memory=inject(DemoKnowledgeMemory); readonly state=signal('bound');
  @Input({alias:'state'}) set stateInput(state:string){this.state.set(state);this.memory.reset(state);}
}