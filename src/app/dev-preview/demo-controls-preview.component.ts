import { AfterViewInit, Injectable, ChangeDetectionStrategy, Component, Input, ViewChild, inject, signal } from '@angular/core';
import { NewProjectModalComponent } from '../shared/modals/new-project-modal.component';
import { DeleteConfirmModalComponent } from '../shared/modals/delete-confirm-modal.component';
import { ConfigHelpModalComponent } from '../shared/modals/config-help-modal.component';
import { GateActionsComponent } from '../features/focus/components/gate/gate-actions.component';
import { GateService } from '../../services/gate.service';
import { SpeechToTextService } from '../../services/speech-to-text.service';
import { BlackBoxService } from '../../services/black-box.service';
import { ToastService } from '../../services/toast.service';
import { LoggerService } from '../../services/logger.service';

@Injectable()
class DemoControlMemory { readonly action=signal(''); }
import { MODAL_DATA, MODAL_REF } from '../../services/dynamic-modal.service';

@Component({ selector:'app-demo-controls-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
  imports:[NewProjectModalComponent,DeleteConfirmModalComponent,ConfigHelpModalComponent,GateActionsComponent],
  providers:[DemoControlMemory,
    {provide:GateService,useFactory:()=>{const memory=inject(DemoControlMemory);return {cardAnimation:signal('idle'),markAsRead:()=>memory.action.set('已标记已读'),markAsCompleted:()=>memory.action.set('已标记完成')};}},
    {provide:SpeechToTextService,useFactory:()=>({isRecording:signal(false),isTranscribing:signal(false),isSupported:()=>false,cancelRecording:()=>{}})},
    {provide:BlackBoxService,useFactory:()=>{const memory=inject(DemoControlMemory);return {createDurably:async()=>{memory.action.set('已记录虚拟想法');return {ok:true};}};}},
    {provide:ToastService,useValue:{success:()=>{},error:()=>{}}},
    {provide:LoggerService,useValue:{info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}}},
    {provide:MODAL_DATA,useValue:null},{provide:MODAL_REF,useValue:null}],
  template:`<section class="control-preview" aria-label="共享控件演示">
    @if(!result()) {
      @switch(state) {
        @case('project-create') { <app-new-project-modal (confirm)="created($event)" (close)="result.set('已取消创建')" /> }
        @case('delete-confirm') { <app-delete-confirm-modal title="删除虚拟任务" message="确认删除这条演示任务吗？" itemName="准备一次清楚的演示" warning="这只影响当前预览，刷新即可恢复" (confirm)="result.set('虚拟任务已删除')" (close)="result.set('已取消删除')" /> }
        @case('gate-actions') { <app-gate-actions /><p role="status">{{ gateMemory.action() }}</p> }
        @case('config-help') { <app-config-help-modal (close)="result.set('配置说明已关闭')" /> }
      }
    } @else { <p role="status" data-testid="demo-control-result">{{ result() }}</p> }
  </section>`,
  styles:[`:host{display:block}.control-preview{position:relative;transform:translateZ(0);min-height:650px;overflow:hidden;background:var(--theme-bg,#f8fafc);border-radius:16px;padding:16px}`],
})
export class DemoControlsPreviewComponent implements AfterViewInit {
  @Input() state='project-create';
  @ViewChild(NewProjectModalComponent) private newProject?:NewProjectModalComponent;
  readonly gateMemory=inject(DemoControlMemory);
  readonly result=signal('');
  ngAfterViewInit():void { queueMicrotask(()=>{this.newProject?.projectName.set('今天的演示项目');this.newProject?.projectDescription.set('虚拟项目，可以放心试一试。');}); }
  created(project:{name:string;description:string}):void {this.result.set(`已创建虚拟项目：${project.name}`);}
}
