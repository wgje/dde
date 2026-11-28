import { AfterViewInit, ChangeDetectionStrategy, Component, Input, ViewChild, computed, inject, signal } from '@angular/core';
import { TextUnassignedComponent } from '../features/text/components/text-unassigned.component';
import { TextUnfinishedComponent } from '../features/text/components/text-unfinished.component';
import { TextDeleteDialogComponent } from '../features/text/components/text-delete-dialog.component';
import { MobileTodoDrawerComponent } from '../features/flow/components/mobile-todo-drawer.component';
import { DEMO_TASK_PREVIEW_PROVIDERS, DemoTaskPreviewMemory } from './demo-task-preview.providers';
import { ProjectStateService } from '../../services/project-state.service';
import { TaskOperationAdapterService } from '../../services/task-operation-adapter.service';
import { UiStateService } from '../../services/ui-state.service';
import { ParkingService } from '../../services/parking.service';
import { SimpleReminderService } from '../../services/simple-reminder.service';
import { UserSessionService } from '../../services/user-session.service';
import { SyncCoordinatorService } from '../../services/sync-coordinator.service';

@Component({selector:'app-demo-text-lists-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
 imports:[TextUnassignedComponent,TextUnfinishedComponent,TextDeleteDialogComponent,MobileTodoDrawerComponent],
 providers:[...DEMO_TASK_PREVIEW_PROVIDERS,
  {provide:UiStateService,useFactory:()=>{const unassigned=signal(true),unfinished=signal(true);return{isTextSidebarVisible:()=>true,hasTextUnassignedOpenPreference:()=>true,hasTextUnfinishedOpenPreference:()=>true,isTextUnassignedOpen:unassigned,isTextUnfinishedOpen:unfinished,toggleTextUnassignedOpen:()=>unassigned.update(v=>!v),toggleTextUnfinishedOpen:()=>unfinished.update(v=>!v)};}},
  {provide:ProjectStateService,useFactory:()=>{const m=inject(DemoTaskPreviewMemory);return{activeProjectId:()=>m.projectId,captureActiveProjectOwner:()=>({projectId:m.projectId,generation:1}),isActiveProjectOwnerCurrent:()=>true,
   unassignedTasks:computed(()=>m.additionalTasks().filter(t=>t.stage===null)),unfinishedItems:computed(()=>m.task().content.split('\n').flatMap((text,index)=>text.startsWith('- [ ]')?[{taskId:m.task().id,taskDisplayId:'1',todoIndex:index,text:text.slice(6)}]:[])),getTask:(id:string)=>m.getTask(id),compressDisplayId:(id:string)=>id};}},
  {provide:TaskOperationAdapterService,useFactory:()=>{const m=inject(DemoTaskPreviewMemory);return{updateTaskDraft:(id:string,fields:{title:string;content:string})=>m.patch(id,fields),updateTaskContent:(id:string,content:string)=>m.patch(id,{content}),deleteTask:async(id:string)=>{m.remove(id);return true;},moveTaskToStage:async(id:string,stage:number|null)=>m.patch(id,{stage}),core:{completeUnfinishedItem:(id:string,index:number)=>{const task=m.getTask(id);if(task){const lines=task.content.split('\n');lines[index]=lines[index].replace('- [ ]','- [x]');void m.patch(id,{content:lines.join('\n')});}}}};}},
  {provide:ParkingService,useFactory:()=>{const m=inject(DemoTaskPreviewMemory);return{parkTask:async(id:string)=>{m.park(id);return true;}};}},
  {provide:SimpleReminderService,useValue:{setReminder:async()=>true,cancelReminder:async()=>true}},
  {provide:UserSessionService,useValue:{isHintOnlyStartupPlaceholderVisible:()=>false}},
  {provide:SyncCoordinatorService,useValue:{isLoadingRemote:()=>false}},
 ],
 template:`<section class="text-lists-preview" aria-label="文本列表演示">
 @if(result()){<p role="status">{{result()}}</p>}
 @else if(state.startsWith('delete')){<app-text-delete-dialog [task]="memory.task()" [hasChildren]="state !== 'delete-single'" [keepChildren]="keepChildren()" (keepChildrenChange)="keepChildren.set($event)" (confirm)="result.set($event ? '已删除虚拟任务，保留子任务' : '已删除虚拟任务和子任务')" (cancel)="result.set('已取消删除')" />}
 @else if(state==='mobile-todo'){<app-mobile-todo-drawer (taskClick)="result.set('已定位：'+$event.title)" (centerOnNode)="result.set('已定位虚拟任务')" (createUnassigned)="create()" />}
 @else if(state.startsWith('unfinished')){<app-text-unfinished [isMobile]="state==='unfinished-mobile'" (jumpToTask)="result.set('已定位虚拟任务')" />}
 @else {<app-text-unassigned [isMobile]="state==='unassigned-mobile'" (taskClick)="result.set('已选择：'+$event.title)" (createUnassigned)="create()" />}
 </section>`,styles:[`:host{display:block}.text-lists-preview{position:relative;transform:translateZ(0);min-height:450px;padding:16px;background:var(--theme-bg,#f8fafc);border-radius:12px}`],
})
export class DemoTextListsPreviewComponent implements AfterViewInit{
 @Input() state='unassigned';
 @ViewChild(TextUnassignedComponent) private unassigned?:TextUnassignedComponent;
 readonly memory=inject(DemoTaskPreviewMemory);
 readonly result=signal('');readonly keepChildren=signal(false);
 constructor(){this.memory.addRelative(this.memory.task(),false);const first=this.memory.additionalTasks()[0];void this.memory.patch(first.id,{stage:null,title:'未分配的虚拟想法'});}
 create():void{this.memory.addRelative(this.memory.task(),false);const task=this.memory.additionalTasks().at(-1)!;void this.memory.patch(task.id,{stage:null,title:'刚创建的待分配任务'});}
 ngAfterViewInit():void{queueMicrotask(()=>{if(this.state==='unassigned-edit')void this.unassigned?.setEditingTask(this.memory.additionalTasks()[0].id,true);});}
}
