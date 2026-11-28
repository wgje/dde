import { ChangeDetectionStrategy, Component, Injectable, Input, OnChanges, inject, signal } from '@angular/core';
import { FocusSessionTriggerComponent } from '../features/focus/components/focus-session-trigger.component';
import { GateOverlayComponent } from '../features/focus/components/gate/gate-overlay.component';
import { GateService } from '../../services/gate.service';
import { StrataService } from '../../services/strata.service';
import { SpeechToTextService } from '../../services/speech-to-text.service';
import { BlackBoxService } from '../../services/black-box.service';
import { ToastService } from '../../services/toast.service';
import { LoggerService } from '../../services/logger.service';
@Injectable()
class FocusShellMemory {
 readonly active=signal(true);readonly completed=signal(false);readonly message=signal('');
 readonly progress=signal({current:1,total:3});readonly cardAnimation=signal('idle');readonly impactTick=signal(0);
 readonly currentEntry=signal({id:crypto.randomUUID(),content:'把昨天留下的想法整理成今天的一步。',createdAt:'2026-11-27T08:00:00.000Z'});
 readonly isActive=this.active;readonly showCompletionMessage=this.completed;
 markAsRead=()=>this.message.set('虚拟想法已标记已读');markAsCompleted=()=>{this.active.set(false);this.completed.set(true);this.message.set('虚拟想法已完成');};
 notifyAnimationStarted=()=>{};onEnteringComplete=()=>{};onHeaveReadComplete=()=>{};onHeavyDropComplete=()=>{};onSettlingComplete=()=>{};
}
@Component({selector:'app-demo-focus-shell-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
 imports:[FocusSessionTriggerComponent,GateOverlayComponent],providers:[FocusShellMemory,
 {provide:GateService,useExisting:FocusShellMemory},{provide:StrataService,useValue:{layers:()=>[{date:'2026-11-26'},{date:'2026-11-25'}]}},
 {provide:SpeechToTextService,useFactory:()=>({isRecording:signal(false),isTranscribing:signal(false),isSupported:()=>false,cancelRecording:()=>{}})},
 {provide:BlackBoxService,useValue:{createDurably:async()=>({ok:true})}},
 {provide:ToastService,useValue:{success:()=>{},error:()=>{}}},{provide:LoggerService,useValue:{debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}}}],
 template:`<section class="focus-shell-preview" aria-label="Focus 外壳演示">
 @if(state==='trigger'){<app-focus-session-trigger [dispatchGlobalEvent]="false" (toggleRequested)="toggle()" /><p role="status">{{memory.message()}}</p>}
 @else{<app-gate-overlay [lockBodyScroll]="false" /><p class="result" role="status">{{memory.message()}}</p>}
 </section>`,styles:[`:host{display:block}.focus-shell-preview{position:relative;transform:translateZ(0);min-height:900px;overflow:hidden;border-radius:16px;background:#09090b;color:#f8fafc;padding:16px}.result{position:relative;z-index:10000}`],
})
export class DemoFocusShellPreviewComponent implements OnChanges{
 @Input() state='gate-overlay';readonly memory=inject(FocusShellMemory);
 ngOnChanges():void{this.memory.active.set(this.state!=='gate-complete');this.memory.completed.set(this.state==='gate-complete');}
 toggle():void{this.memory.message.set(this.memory.message() ? '已退出虚拟专注模式' : '已进入虚拟专注模式');}
}
