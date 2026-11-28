import { ChangeDetectionStrategy, Component, Input, OnChanges, AfterViewInit, ViewChild, computed, inject, signal } from '@angular/core';
import { TextStageCardComponent } from '../features/text/components/text-stage-card.component';
import { TextTaskConnectionsComponent } from '../features/text/components/text-task-connections.component';
import { DEMO_TASK_PREVIEW_PROVIDERS, DemoTaskPreviewMemory } from './demo-task-preview.providers';
import type { StageData } from '../features/text/components/text-view.types';
@Component({selector:'app-demo-task-tree-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
  imports:[TextStageCardComponent,TextTaskConnectionsComponent],providers:DEMO_TASK_PREVIEW_PROVIDERS,
  template:`<section class="tree-preview" aria-label="任务阶段与关联演示">
    @if(state.startsWith('connections')){
      <app-text-task-connections [connections]="connections()" [isMobile]="false" (openTask)="selectLinked($event.taskId)" />
      <p role="status">{{ selectedTitle() }}</p>
    }@else{
      <app-text-stage-card [stage]="stage()" [isExpanded]="expanded()" [isMobile]="state === 'mobile'"
        [selectedTaskId]="selectedId()" [userId]="memory.userId" [projectId]="memory.projectId"
        (toggleExpand)="expanded.set(!expanded())" (taskSelect)="selectedId.set($event.id)"
        (addSibling)="memory.addRelative($event,false)" (addChild)="memory.addRelative($event,true)"
        (parkTask)="memory.park($event.id)" (deleteTask)="remove($event.id)" />
    }
  </section>`, styles:[`:host{display:block}.tree-preview{padding:16px;max-width:900px}`],
})
export class DemoTaskTreePreviewComponent implements OnChanges, AfterViewInit{
  @Input() state='expanded';
  @ViewChild(TextTaskConnectionsComponent) private connectionPanel?: TextTaskConnectionsComponent;
  readonly memory=inject(DemoTaskPreviewMemory);
  readonly expanded=signal(true);
  readonly selectedId=signal<string|null>(null);
  readonly removed=signal(false);
  readonly stage=computed<StageData>(()=>({stageNumber:1,tasks:[...(this.removed()?[]:[this.memory.task()]),...this.memory.additionalTasks()]}));
  readonly connections=computed(()=>({outgoing:this.state === 'connections-incoming' ? [] : this.memory.additionalTasks().map(task=>({targetId:task.id,targetTask:task,description:'接下来要做的任务'})),incoming:this.state === 'connections-incoming' || this.state === 'connections-both' ? [{sourceId:this.memory.task().id,sourceTask:this.memory.task(),description:'来自上级的关联'}] : []}));
  readonly selectedTitle=signal('点击关联可定位虚拟任务');
  constructor(){this.reset();}
  ngAfterViewInit():void { queueMicrotask(() => { if(this.state === 'connections-collapsed') this.connectionPanel?.isCollapsed.set(true); }); }
  ngOnChanges():void{this.reset();}
  private reset():void{this.memory.reset('sidecar');this.memory.addRelative(this.memory.task(),true);this.expanded.set(this.state!=='collapsed');this.selectedId.set(null);this.removed.set(false);}
  selectLinked(id:string):void{const task=this.memory.getTask(id);if(task)this.selectedTitle.set(`已定位：${task.title}`);}
  remove(id:string):void{if(id===this.memory.task().id)this.removed.set(true);this.memory.remove(id);}
}
