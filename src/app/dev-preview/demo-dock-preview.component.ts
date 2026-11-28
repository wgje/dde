import { ChangeDetectionStrategy, Component, computed, input, signal, ViewChild } from '@angular/core';
import { DockMobileDrawerComponent } from '../features/parking/components/dock-mobile-drawer.component';
import { DockInlineTaskFormComponent } from '../features/parking/components/dock-inline-task-form.component';
import { FlowMinimapLegendComponent } from '../features/flow/components/flow-minimap-legend.component';
import type { MinimapLegendCategory } from '../features/flow/components/flow-minimap-geometry';
import type { CognitiveLoad, DockEntry, DockLane } from '../../models/parking-dock';

@Component({
  selector: 'app-demo-dock-preview', standalone: true,
  imports: [DockInlineTaskFormComponent, FlowMinimapLegendComponent, DockMobileDrawerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (widget() === 'flow') {
      <div class="legend-wrap"><app-flow-minimap-legend [visible]="true" [mobile]="true"
        [hiddenCategories]="hiddenCategories()" (categoryToggle)="toggleLegend($event)" /></div>
      <p>隐藏的标记：{{ hiddenCategories().size }}</p>
    } @else if (entryPreview()) {
      <div class="entry-preview">
        <p class="workspace-hint">当前工作区</p>
        <h3>把注意力留给正在做的事</h3>
        <p>停泊坞收在下方，需要时再展开。</p>
        <app-dock-mobile-drawer [entries]="entries()" [projects]="[]"
          (taskConfirmed)="selectTask($event)" />
      </div>
    } @else {
      <app-dock-inline-task-form [taskTitle]="title()" (taskTitleChange)="title.set($event)"
        [taskLane]="lane()" (taskLaneChange)="lane.set($event)"
        [taskLoad]="load()" (taskLoadChange)="load.set($event)"
        [expectedMinutes]="minutes()" (expectedMinutesChange)="minutes.set($event)"
        [waitMinutes]="wait()" (waitMinutesChange)="wait.set($event)"
        [taskDetail]="detail()" (taskDetailChange)="detail.set($event)" (createTask)="create()" />
      @if (created()) { <p role="status" data-testid="demo-dock-created">已添加：{{ resultTitle() }}</p><div class="result-drawer"><app-dock-mobile-drawer [entries]="entries()" [projects]="[]" [showTrigger]="false" (taskConfirmed)="selectTask($event)" /></div> }
    }
  `,
  styles: [`:host{display:block;background:#172033;padding:20px;border-radius:12px;color:#e2e8f0}.legend-wrap{position:relative;min-height:76px}.result-drawer{position:relative;transform:translateZ(0);min-height:500px}.entry-preview{position:relative;transform:translateZ(0);min-height:440px;background:var(--theme-bg,#fafaf9);color:var(--theme-text-dark,#292524);margin:-20px;padding:24px;border-radius:12px}.entry-preview p{font-size:13px;line-height:1.8;color:var(--theme-text,#57534e)}.workspace-hint{font-size:11px!important}.entry-preview h3{font-size:18px;font-weight:500;margin:30px 0 8px}`],
})
export class DemoDockPreviewComponent {
  readonly widget = input('dock');
  readonly state = input('create');
  readonly entryPreview = computed(() => this.state() === 'mobile-entry' || this.state() === 'mobile-open');
  readonly title = signal('检查今天的任务');
  readonly lane = signal<DockLane>('backup');
  readonly load = signal<CognitiveLoad>('low');
  readonly minutes = signal<string | number>(15);
  readonly wait = signal<string | number>('');
  readonly detail = signal('此任务是虚拟样例，可放心修改。');
  private readonly savedTitle = signal<string | null>(null);
  readonly created = computed(() => this.savedTitle() !== null || this.state() === 'created');
  readonly resultTitle = computed(() => this.savedTitle() ?? '检查今天的任务');
  readonly hiddenCategories = signal<ReadonlySet<MinimapLegendCategory>>(new Set());
  private readonly taskId = crypto.randomUUID();
  readonly entries = computed<DockEntry[]>(() => this.created() || this.entryPreview() ? [{
    taskId: this.taskId, title: this.resultTitle(), sourceProjectId: null, status: 'pending_start',
    load: this.load(), expectedMinutes: Number(this.minutes()) || null, waitMinutes: Number(this.wait()) || null,
    waitStartedAt: null, lane: this.lane(), zoneSource: 'manual', isMain: true, dockedOrder: 0,
    detail: this.detail(), sourceKind: 'dock-created', systemSelected: false, recommendedScore: null,
  }] : []);
  // The ready-result URL must open the drawer as soon as its view is mounted.
  @ViewChild(DockMobileDrawerComponent)
  set drawer(drawer: DockMobileDrawerComponent | undefined) {
    if (drawer) drawer.opened.set(this.state() !== 'mobile-entry');
  }
  selectTask(taskId: string): void { this.savedTitle.set(this.entries().find(entry => entry.taskId === taskId)?.title ?? this.resultTitle()); }
  create(): void { if (this.title().trim()) this.savedTitle.set(this.title().trim()); }
  toggleLegend(category: MinimapLegendCategory): void {
    this.hiddenCategories.update(current => { const next = new Set(current); if (next.has(category)) next.delete(category); else next.add(category); return next; });
  }
}
