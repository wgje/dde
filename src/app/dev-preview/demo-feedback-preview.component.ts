import { ChangeDetectionStrategy, Component, Injectable, inject, Input, signal, computed } from '@angular/core';
import type { ParkingNotice } from '../../models';

import { SyncStatusComponent } from '../shared/components/sync-status.component';
import { ToastContainerComponent } from '../shared/components/toast-container.component';
import { PwaInstallPromptBannerComponent } from '../shared/components/pwa-install-prompt-banner.component';
import { ParkingNoticeComponent } from '../features/parking/parking-notice.component';
import { ActionQueueService } from '../../services/action-queue.service';
import { SyncStateService } from '../core/services/sync/sync-state.service';
import { SyncCoordinatorService } from '../../services/sync-coordinator.service';
import { ProjectStateService } from '../../services/project-state.service';
import { AuthService } from '../../services/auth.service';
import { ConflictStorageService } from '../../services/conflict-storage.service';
import { RetryQueueService } from '../core/services/sync/retry-queue.service';
import { ToastService, type ToastMessage } from '../../services/toast.service';
import { LoggerService } from '../../services/logger.service';
import { UiStateService } from '../../services/ui-state.service';
import { PwaInstallPromptService } from '../../services/pwa-install-prompt.service';
import { ParkingService } from '../../services/parking.service';
import { SimpleReminderService } from '../../services/simple-reminder.service';
import { GateService } from '../../services/gate.service';
@Injectable()
export class DemoFeedbackMemory {
 readonly messages=signal<ToastMessage[]>([]); readonly hasMessages=computed(()=>this.messages().length>0);
 readonly isMobile=signal(false); readonly result=signal(''); readonly promptVisible=signal(true);
 readonly activeNotice=signal<ParkingNotice|null>(null); readonly pendingNotices=signal<ParkingNotice[]>([]); readonly isActive=signal(false);
 readonly syncState=signal({isOnline:true,isSyncing:false,syncError:null,backgroundSyncNotice:null,cloudSyncPausedReason:null,offlineMode:false,pendingCount:0,lastSyncTime:null});
 readonly pendingActions=signal<never[]>([]);readonly queueSize=signal(0);readonly deadLetterSize=signal(0);readonly deadLetterQueue=signal<never[]>([]);readonly queueFrozen=signal(false);readonly queueFreezeReason=signal(null);readonly legacyReviewCount=signal(0);readonly conflictCount=signal(0);readonly hasUnresolvedConflicts=signal(false);readonly isProcessing=signal(false);readonly isLoadingRemote=signal(false);
 subscribeToOwnerStorageLoadStateChanges(listener: () => void): () => void { void listener; return () => {}; }
 getCurrentOwnerStorageLoadState(): "loaded" { return "loaded"; }
 reset(state:string):void {this.result.set('');this.promptVisible.set(true);this.messages.set([]);this.pendingNotices.set([]);this.activeNotice.set(null);
  if(state.startsWith('toast'))this.messages.set([{id:crypto.randomUUID(),type:state==='toast-info'?'info':'success',title:'虚拟任务已保存',message:'这是一个可以关闭的真实提示。',duration:0,createdAt:Date.now(),action:{label:'查看结果',onClick:()=>{this.result.set('已查看虚拟结果');}}}]);
  if(state==='parking-reminder')this.activeNotice.set({id:crypto.randomUUID(),type:'reminder',projectId:crypto.randomUUID(),taskId:crypto.randomUUID(),taskTitle:'该继续演示任务了',minVisibleMs:0,fallbackTimeoutMs:3600000,actions:[{key:'start-work',label:'切换到此任务'},{key:'snooze-5m',label:'5 分钟后'},{key:'ignore',label:'忽略'}]});
  if(state==='parking-eviction')this.pendingNotices.set([{id:crypto.randomUUID(),type:'eviction',taskId:crypto.randomUUID(),taskTitle:'虚拟停泊任务',evictionTokenId:crypto.randomUUID(),minVisibleMs:0,fallbackTimeoutMs:3600000,actions:[{key:'undo-eviction',label:'撤回'},{key:'keep-parked',label:'关闭'}]}]);
 }
 currentUserId():null{return null;}activeProjectId():null{return null;}category():DemoFeedbackMemory{return this;}error():void{}debug():void{}warn():void{}info(title:string,body=''):void{this.result.set(`${title} ${body}`);}success(title:string,body=''):void{this.result.set(`${title} ${body}`);}warning(title:string,body=''):void{this.result.set(`${title} ${body}`);}
 dismiss(id:string):void{this.messages.update(ms=>ms.filter(m=>m.id!==id));}
 canShowInstallPrompt():boolean{return this.promptVisible();}canInstall():boolean{return true;}installHint():string{return '安装虚拟演示应用（不会请求系统权限）';}initialize():void{}async promptInstall():Promise<boolean>{this.result.set('已模拟安装，没有请求浏览器安装权限');this.promptVisible.set(false);return true;}dismissPrompt():void{this.promptVisible.set(false);}
 async processQueue():Promise<void>{}async resyncActiveProject():Promise<{success:boolean;message:string}>{return{success:true,message:'虚拟同步完成'};}downloadEscapeExport():void{this.result.set('不下载真实数据');}retryDeadLetter():void{}dismissDeadLetter():void{}clearDeadLetterQueue():void{}
 async startWork():Promise<boolean>{this.result.set('已切换虚拟任务');return true;}async snooze5m():Promise<boolean>{this.result.set('虚拟提醒已延后');return true;}async snooze30m():Promise<boolean>{return true;}async snooze2h():Promise<boolean>{return true;}async cancelReminder():Promise<boolean>{this.result.set('虚拟提醒已关闭');return true;}handleNoticeFadeout():void{}clearActiveNotice():void{this.activeNotice.set(null);}consumeNotice():void{this.pendingNotices.set([]);}async undoEviction():Promise<boolean>{this.result.set('虚拟任务已撤回');return true;}async keepParked():Promise<boolean>{return true;}getEvictionToken():object{return {};}
}
@Component({selector:'app-demo-feedback-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
 imports:[SyncStatusComponent,ToastContainerComponent,PwaInstallPromptBannerComponent,ParkingNoticeComponent],
 providers:[DemoFeedbackMemory,...[ActionQueueService,SyncStateService,SyncCoordinatorService,ProjectStateService,AuthService,ConflictStorageService,RetryQueueService,ToastService,LoggerService,UiStateService,PwaInstallPromptService,ParkingService,SimpleReminderService,GateService].map(provide=>({provide,useExisting:DemoFeedbackMemory}))],
 template:`<section class="feedback" data-testid="demo-feedback-preview">
 @switch(state()){@case('sync'){<app-sync-status />}@case('sync-compact'){<app-sync-status [compact]="true" />}
 @case('pwa'){<app-pwa-install-prompt-banner top="24px" />}@case('parking-reminder'){<app-parking-notice />}@case('parking-eviction'){<app-parking-notice />}
 @default{<app-toast-container />}}
 </section><p role="status">{{memory.result()}}</p>`,styles:[`:host{display:block;min-width:0}.feedback{position:relative;transform:translateZ(0);min-height:300px;padding:16px;border:1px solid #d6d3d1;border-radius:12px}p{font-size:12px;margin-top:10px}`]})
export class DemoFeedbackPreviewComponent{readonly state=signal('sync');readonly memory=inject(DemoFeedbackMemory);@Input({alias:'state'})set stateInput(state:string){this.state.set(state);this.memory.reset(state);}}