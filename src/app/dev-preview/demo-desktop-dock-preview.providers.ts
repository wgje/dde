import { Injectable, computed, signal, type Provider } from '@angular/core';
import { DockEngineService } from '../../services/dock-engine.service';
import { UiStateService } from '../../services/ui-state.service';
import { ProjectStore } from '../core/state/stores';
import { AuthService } from '../../services/auth.service';
import { LoggerService } from '../../services/logger.service';
import { ExternalSourceLinkService } from '../core/external-sources/external-source-link.service';
import { SiyuanPreviewService } from '../core/external-sources/siyuan/siyuan-preview.service';
import type { DockEntry, DockPendingDecisionEntry } from '../../models/parking-dock';

function entry(title: string, order: number, main = false): DockEntry {
  return { taskId:crypto.randomUUID(), title, sourceProjectId:null, status:main ? 'focusing' : 'pending_start',
    load:main ? 'high' : 'low', expectedMinutes:25, waitMinutes:null, waitStartedAt:null,
    lane:order < 3 ? 'combo-select' : 'backup', zoneSource:'manual', isMain:main, dockedOrder:order,
    sourceKind:'dock-created', detail:'这是虚拟任务，操作只影响当前预览。', systemSelected:false, recommendedScore:null };
}

@Injectable()
export class DemoDesktopDockMemory {
  readonly entries = signal<DockEntry[]>([]);
  readonly focusMode = signal(true);
  readonly focusTransition = signal(null);
  readonly focusScrimOn = signal(false);
  readonly highlightedIds = signal(new Set<string>());
  readonly lastRadarInsertedTaskId = signal<string | null>(null);
  readonly lastRadarEvictedTaskId = signal<string | null>(null);
  readonly pendingRadarEviction = signal<string | null>(null);
  readonly pendingDecisionEntries = signal<DockPendingDecisionEntry[]>([]);
  readonly isFocusTransitionBlocking = signal(false);
  readonly orderedDockEntries = computed(() => this.entries());
  readonly focusingEntry = computed(() => this.entries().find(entry => entry.status === 'focusing') ?? null);
  readonly consoleVisibleEntries = computed(() => this.entries().filter(entry => entry.lane === 'combo-select' && entry.status !== 'suspended_waiting').slice(0,4));
  readonly consoleEntries = this.consoleVisibleEntries;
  readonly comboSelectEntries = computed(() => this.entries().filter(entry => entry.lane === 'combo-select' && !entry.isMain));
  readonly backupEntries = computed(() => this.entries().filter(entry => entry.lane === 'backup'));
  reset(state: string): void {
    const entries = [entry('写下今天的重点',0,true), entry('检查说明文档',1), entry('整理任务关系',2), entry('准备下一次演示',3),entry('等待构建完成',4)];
    if(state === 'waiting') entries[4] = {...entries[4],status:'suspended_waiting',waitMinutes:10,waitStartedAt:new Date().toISOString()};
    if(state === 'planner') entries[0] = {...entries[0],expectedMinutes:null};
    if(state === 'low-load') entries[0] = {...entries[0],load:'low'};
    if(state === 'no-detail') entries[0] = {...entries[0],detail:''};
    if(state === 'radar-overflow') for(let i=5;i<18;i++) entries.push(entry(`额外候选任务 ${i}`,i));
    if(state === 'radar-groups') this.pendingDecisionEntries.set(entries.slice(1,4).map((entry,index)=>({taskId:entry.taskId,title:entry.title,
      group:(['homologous-advancement','cognitive-downgrade','asynchronous-boot'] as const)[index],lane:entry.lane,load:entry.load,expectedMinutes:entry.expectedMinutes,recommendedScore:1})));
    else this.pendingDecisionEntries.set([]);
    this.entries.set(entries); this.lastRadarInsertedTaskId.set(null); this.pendingRadarEviction.set(null);
  }
  patch(id: string, fields: Partial<DockEntry>): Promise<boolean> { this.entries.update(entries => entries.map(entry => entry.taskId === id ? {...entry,...fields} : entry)); return Promise.resolve(true); }
  toggleLoad(id:string,direction:'up'|'down'): void { void this.patch(id,{load:direction === 'up' ? 'high':'low'}); }
  setExpectedTime(id:string,expectedMinutes:number|null): Promise<boolean> { return this.patch(id,{expectedMinutes}); }
  setWaitTime(id:string,waitMinutes:number|null): Promise<boolean> { return this.patch(id,{waitMinutes}); }
  completeTask(id:string): void { this.entries.update(entries => entries.filter(entry => entry.taskId !== id)); const next=this.consoleVisibleEntries()[0]; if(next) this.setMainTask(next.taskId); }
  suspendTask(id:string,minutes:number): void { void this.patch(id,{status:'suspended_waiting',waitMinutes:minutes,waitStartedAt:new Date().toISOString(),isMain:false}); const next=this.consoleVisibleEntries()[0]; if(next)this.setMainTask(next.taskId); }
  setMainTask(id:string): void { this.entries.update(entries => entries.map(entry => ({...entry,isMain:entry.taskId === id,status:entry.taskId === id ? 'focusing':entry.status === 'focusing' ? 'pending_start':entry.status}))); }
  switchToTask(id:string): void { this.setMainTask(id); }
  insertToConsoleFromRadar(id:string): void { void this.patch(id,{lane:'combo-select',status:'pending_start',isMain:false}); }
  flushRadarEviction(): void { this.pendingRadarEviction.set(null); }
}

export const DEMO_DESKTOP_DOCK_PROVIDERS: Provider[] = [
  DemoDesktopDockMemory, {provide:DockEngineService,useExisting:DemoDesktopDockMemory},
  {provide:UiStateService,useValue:{isMobile:()=>false}},
  {provide:ProjectStore,useFactory:()=>({projects:signal([])})},
  {provide:AuthService,useValue:{currentUserId:()=>null}},
  {provide:ExternalSourceLinkService,useFactory:()=>({links:signal([]),activeLinksForTask:()=>[]})},
  {provide:SiyuanPreviewService,useValue:{preview:()=>Promise.resolve({status:'cache-only'})}},
  {provide:LoggerService,useFactory:()=>{const logger={debug:()=>{},warn:()=>{},info:()=>{},error:()=>{},category:()=>logger};return logger;}},
];
