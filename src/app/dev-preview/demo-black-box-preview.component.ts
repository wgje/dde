import { ChangeDetectionStrategy, Component, Injectable, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import type { BlackBoxEntry, StrataLayer } from '../../models/focus';
import { BlackBoxService } from '../../services/black-box.service';
import { SpeechToTextService } from '../../services/speech-to-text.service';
import { FocusPreferenceService } from '../../services/focus-preference.service';
import { StrataService } from '../../services/strata.service';
import { ProjectStateService } from '../../services/project-state.service';
import { LoggerService } from '../../services/logger.service';
import { ToastService } from '../../services/toast.service';
import { MobileBlackBoxDrawerComponent } from '../features/flow/components/mobile-black-box-drawer.component';
import { TaskOperationAdapterService } from '../../services/task-operation-adapter.service';
import { BlackBoxPanelComponent } from '../features/focus/components/black-box/black-box-panel.component';
import { BlackBoxRecorderComponent } from '../features/focus/components/black-box/black-box-recorder.component';
import { StrataViewComponent } from '../features/focus/components/strata/strata-view.component';

/** One preview owns the entire inbox/recording/history. No microphone or durable store. */
@Injectable()
export class DemoInboxMemory {
  readonly entries = signal<BlackBoxEntry[]>([]);
  readonly message = signal('');
  readonly isRecording = signal(false);
  readonly isTranscribing = signal(false);
  readonly recordingDurationSec = signal(12);
  readonly offlinePendingCount = signal(0);
  readonly preferences = signal({ strataEnabled: true, blackBoxEnabled: true });
  readonly entriesByDate = computed(() => {
    const groups = new Map<string, BlackBoxEntry[]>();
    for (const entry of this.entries()) { const rows = groups.get(entry.date) ?? []; rows.push(entry); groups.set(entry.date, rows); }
    return [...groups].map(([date, entries]) => ({ date, entries }));
  });
  readonly pendingCount = computed(() => this.entries().filter(entry => !entry.isRead && !entry.isCompleted).length);
  readonly layers = signal<StrataLayer[]>([]);
  readonly todayCount = computed(() => this.layers()[0]?.items.length ?? 0);
  readonly totalCount = computed(() => this.layers().reduce((sum, layer) => sum + layer.items.length, 0));
  readonly totalDays = computed(() => this.layers().length);
  readonly tasks = signal([]);
  isBlackBoxEnabled(): boolean { return true; }
  isSupported(): boolean { return true; }
  category(): DemoInboxMemory { return this; }
  debug(): void {}
  refresh(): void {}
  async refreshForView(): Promise<void> {}
  warning(title: string): void { this.message.set(title); }
  isMajorTick(): boolean { return true; }
  getDepthLabel(date: string): string { return date; }
  getWeeklyCount(): number { return this.totalCount(); }
  getLayerLabel(date: string): string { return date; }
  getColorTier(): { bgClass: string; borderClass: string; textClass: string; subTextClass: string } {
    return { bgClass: 'bg-stone-900', borderClass: 'border-amber-600', textClass: 'text-stone-200', subTextClass: 'text-stone-400' };
  }
  reset(state: string): void {
    const create = (content: string, date: string, isRead: boolean, isCompleted: boolean): BlackBoxEntry => ({
      id: crypto.randomUUID(), userId: 'local-user', projectId: null, content, date,
      createdAt: date + 'T12:00:00Z', updatedAt: date + 'T12:00:00Z', isRead, isCompleted, isArchived: isCompleted, deletedAt: null,
    });
    this.entries.set([
      create('整理今天的新想法', '2026-11-27', false, false),
      { ...create('已经看过，稍后行动', '2026-11-27', true, false), userId: 'preview-only-user', syncStatus: 'pending' },
      create('完成的记录', '2026-11-26', true, true),
    ]);
    this.layers.set(['2026-11-27', '2026-11-26'].map((date, index) => ({date, opacity: 1 - index * .15,
      items: Array.from({length: index ? 4 : 10}, (_, row) => ({id: crypto.randomUUID(), type: row % 2 ? 'black_box' as const : 'task' as const, title: `已完成的${row % 2 ? '记录' : '任务'} ${row + 1}`, completedAt: date + 'T12:00:00Z'})) })));
    this.isRecording.set(state === 'recording'); this.message.set('');
  }
  async createDurably(input: {content: string}): Promise<{ok: true}> {
    const date = '2026-11-27'; this.entries.update(rows => [{id: crypto.randomUUID(), userId:'local-user', projectId:null,
      content:input.content, date, createdAt:date+'T12:00:00Z', updatedAt:date+'T12:00:00Z', isRead:false, isCompleted:false, isArchived:false,deletedAt:null}, ...rows]); return {ok:true};
  }
  async updateTaskStatus(id: string): Promise<boolean> { this.restore(id);return true; }
  async updateDurably(id: string, patch: Partial<BlackBoxEntry>): Promise<{ok:true}> { this.entries.update(rows => rows.map(entry => entry.id === id ? {...entry,...patch}: entry));return {ok:true}; }
  async markAsReadDurably(id: string): Promise<{ok: true}> { this.entries.update(rows => rows.map(entry => entry.id === id ? {...entry,isRead:true} : entry));return {ok:true}; }
  async markAsCompletedDurably(id: string): Promise<{ok: true}> { this.entries.update(rows => rows.map(entry => entry.id === id ? {...entry,isRead:true,isCompleted:true} : entry));return {ok:true}; }
  async deleteDurably(id: string): Promise<{ok: true}> { this.entries.update(rows => rows.filter(entry => entry.id !== id));return {ok:true}; }
  async startRecording(): Promise<boolean> { this.isRecording.set(true); return true; }
  cancelRecording(): void { this.isRecording.set(false); }
  async stopAndTranscribe(): Promise<string> { this.isRecording.set(false); return '这是虚拟录音的示例文字，没有调用麦克风。'; }
  restore(id: string): void { this.layers.update(layers => layers.map(layer => ({...layer, items:layer.items.filter(item => item.id !== id)})));this.message.set('虚拟历史条目已恢复'); }
}

@Component({selector:'app-demo-black-box-preview',standalone:true,changeDetection:ChangeDetectionStrategy.OnPush,
  imports:[MobileBlackBoxDrawerComponent,BlackBoxPanelComponent,BlackBoxRecorderComponent,StrataViewComponent],
  providers:[DemoInboxMemory, ...[BlackBoxService,SpeechToTextService,FocusPreferenceService,StrataService,ProjectStateService,LoggerService,ToastService,TaskOperationAdapterService].map(provide=>({provide,useExisting:DemoInboxMemory}))],
  template:`<section class="inbox-preview">
    @if (state() === 'mobile') { <app-mobile-black-box-drawer /> }
    @else if (state() === 'strata') { <app-strata-view [alwaysShow]="true" (restoreItem)="memory.restore($event.id)" /> }
    @else if (state() === 'recorder' || state() === 'recording' || state() === 'transcription') {
      <p>虚拟录音演示：不会请求麦克风或调用转写服务。</p><app-black-box-recorder appearance="obsidian" (transcribed)="memory.createDurably({content:$event})" />
    } @else { <app-black-box-panel /> }
    <p role="status">{{ memory.message() }}</p>
  </section>`, styles:[`:host{display:block}.inbox-preview{padding:24px;background:#171923;color:#e7e5e4;border-radius:12px;min-height:300px}`]})
export class DemoBlackBoxPreviewComponent {
  readonly state=input('panel'); readonly memory=inject(DemoInboxMemory);
  private readonly recorder=viewChild(BlackBoxRecorderComponent);
  constructor(){effect(()=>this.memory.reset(this.state()));effect(()=>{const recorder=this.recorder();if(recorder && this.state()==='transcription'){recorder.transcription.set('这是待保存的虚拟录音文字。');recorder.editableText='这是待保存的虚拟录音文字。';}});}
}