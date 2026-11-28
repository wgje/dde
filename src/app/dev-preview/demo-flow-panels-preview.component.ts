import { ChangeDetectionStrategy, Component, Injectable, Input, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { Project, Task, UnfinishedItem } from '../../models';
import { FlowPaletteComponent } from '../features/flow/components/flow-palette.component';
import { FlowRightPanelComponent } from '../features/flow/components/flow-right-panel.component';
import { FlowSwipeGestureService } from '../features/flow/services/flow-swipe-gesture.service';
import { UiStateService } from '../../services/ui-state.service';
import { ProjectStateService } from '../../services/project-state.service';
import { BlackBoxService } from '../../services/black-box.service';
import { FocusPreferenceService } from '../../services/focus-preference.service';
import { StrataService } from '../../services/strata.service';
import { SpeechToTextService } from '../../services/speech-to-text.service';
import { LoggerService } from '../../services/logger.service';
import { ToastService } from '../../services/toast.service';
import { TaskOperationAdapterService } from '../../services/task-operation-adapter.service';
import { DemoInboxMemory } from './demo-black-box-preview.component';

@Injectable()
export class DemoFlowPanelMemory {
  readonly tasks = signal<Task[]>([this.task('规划下一步', 1), this.task('待安排的想法', null)]);
  readonly projects = signal<Project[]>([{ id:crypto.randomUUID(), name:'开发演示项目', description:'预览内存项目', createdDate:'2026-01-01T12:00:00Z', tasks: this.tasks(), connections:[] }, {id:crypto.randomUUID(),name:'另一个虚拟项目',description:'可安全切换',createdDate:'2026-01-01T12:00:00Z',tasks:[],connections:[]}]);
  readonly activeProjectId = signal(this.projects()[0].id);
  readonly activeProject = computed(() => this.projects().find(project => project.id === this.activeProjectId()) ?? null);
  readonly unfinishedItems = computed<UnfinishedItem[]>(() => this.tasks().filter(task => task.stage !== null).map(task => ({taskId:task.id, taskDisplayId:task.displayId, todoIndex:0,text:'完成示例中的第一步'})));
  readonly unassignedTasks = computed(() => this.tasks().filter(task => task.stage === null));
  readonly taskTodoStats = () => ({total:3,completed:1,pending:2});
  readonly isFlowUnfinishedOpen = signal(true);
  readonly isFlowUnassignedOpen = signal(false);
  readonly activeView = signal('flow');
  readonly isMobile = signal(false);
  readonly message = signal('');
  readonly rightOpen = signal(true);
  compressDisplayId(value: string): string { return value; }
  setActiveProjectId(id: string): void { this.activeProjectId.set(id); }
  async navigate(): Promise<boolean> { this.message.set('仅切换预览内项目，没有离开此页'); return true; }
  handleRightPanelTouchStart(): void {}
  handleRightPanelTouchMove(): void {}
  handleRightPanelTouchEnd(): string { return 'none'; }
  handleBackdropTouchEnd(): string { return 'none'; }
  private task(title:string,stage:number|null):Task {return {id:crypto.randomUUID(),title,content:'- [ ] 完成示例中的第一步',stage,parentId:null,order:1,rank:100,status:'active',x:0,y:0,createdDate:'2026-01-01T12:00:00Z',displayId:stage===null?'待分配':'1'};}
}

@Component({selector:'app-demo-flow-panels-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
 imports:[FlowPaletteComponent,FlowRightPanelComponent],
 providers:[DemoFlowPanelMemory,DemoInboxMemory,
  ...[UiStateService,ProjectStateService,Router,FlowSwipeGestureService].map(provide=>({provide,useExisting:DemoFlowPanelMemory})),
  ...[BlackBoxService,FocusPreferenceService,StrataService,SpeechToTextService,LoggerService,ToastService,TaskOperationAdapterService].map(provide=>({provide,useExisting:DemoInboxMemory}))],
 template:`<section class="panel-preview">
   @if(state()==='right-panel') {<app-flow-right-panel [isOpen]="memory.rightOpen()" (close)="memory.rightOpen.set(false)" />}
   @else {<app-flow-palette [blackBoxEntriesOverride]="inbox.entries()" (centerOnNode)="memory.message.set('定位虚拟任务')" (taskClick)="memory.message.set($event.title)" (createUnassigned)="memory.message.set('请求创建虚拟待分配任务')" />}
 </section><p role="status">{{memory.message()}}</p>`,
 styles:[`:host{display:block}.panel-preview{position:relative;transform:translateZ(0);isolation:isolate;height:620px;overflow:hidden;border-radius:16px;background:var(--theme-bg,#fafaf9)}p{padding:8px;font-size:12px}`]})
export class DemoFlowPanelsPreviewComponent {
 readonly state=signal('palette');
 @Input({alias:'state'}) set stateInput(value:string){this.state.set(value);this.configurePalette();}
 readonly memory=inject(DemoFlowPanelMemory);
 readonly inbox=inject(DemoInboxMemory);
 private palette:FlowPaletteComponent|undefined;
 @ViewChild(FlowPaletteComponent) set paletteInput(value:FlowPaletteComponent|undefined){this.palette=value;queueMicrotask(()=>this.configurePalette());}
 constructor(){this.inbox.reset('panel');effect(()=>{this.state();this.memory.rightOpen.set(true);});}
 private configurePalette():void {if(!this.palette)return;this.palette.setWorkbenchTab(this.state()==='palette-unassigned'?'unassigned':this.state()==='palette-blackbox'?'blackbox':'unfinished');this.palette.isHistoryExpanded.set(this.state()==='palette-history');}
}