import { ChangeDetectionStrategy, Component, ViewChild, computed, input, signal } from '@angular/core';
import type { DockEntry } from '../../models/parking-dock';
import { DockMobileDrawerComponent } from '../features/parking/components/dock-mobile-drawer.component';

@Component({
  selector: 'app-demo-dock-entry-preview',
  standalone: true,
  imports: [DockMobileDrawerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dock-preview">
      <div class="workspace" aria-hidden="true">
        <span class="workspace-label">正在处理</span>
        <strong>整理今天最重要的一步</strong>
        <span class="workspace-note">其余任务安静地停在背景里。</span>
      </div>
      <app-dock-mobile-drawer [entries]="entries()" [projects]="[]" [showTrigger]="true"
        [activeView]="'text'" [focusActive]="false" [interactive]="true" [readOnly]="false"
        (taskConfirmed)="selectTask($event)" />
    </section>
  `,
  styles: [`
    :host { display: block; }
    .dock-preview { position: relative; min-height: 480px; overflow: hidden; border-radius: 12px; background: #f1f0eb; color: #302f2a; transform: translateZ(0); }
    .workspace { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 30px; }
    .workspace-label { color: #758071; font-size: 11px; }
    .workspace strong { max-width: 18em; font-size: 20px; font-weight: 500; }
    .workspace-note { color: #797970; font-size: 12px; }
  `],
})
export class DemoDockEntryPreviewComponent {
  readonly state = input('mobile-entry');
  readonly taskIds = { current: crypto.randomUUID(), candidate: crypto.randomUUID(), waiting: crypto.randomUUID() };
  readonly currentTaskId = signal(this.taskIds.current);
  readonly openState = computed(() => this.state() === 'mobile-open');
  readonly entries = computed<DockEntry[]>(() => [
    this.entry(this.taskIds.current, '今天最重要的一步', 'focusing', 'combo-select'),
    this.entry(this.taskIds.candidate, '核对待回复的内容', 'pending_start', 'combo-select'),
    this.entry(this.taskIds.waiting, '等对方确认时间', 'suspended_waiting', 'backup', 20),
  ].map(entry => ({ ...entry, status: entry.taskId === this.currentTaskId() ? 'focusing' : entry.status, isMain: entry.taskId === this.currentTaskId() })));

  @ViewChild(DockMobileDrawerComponent)
  set drawer(drawer: DockMobileDrawerComponent | undefined) {
    if (drawer) drawer.opened.set(this.openState());
  }

  selectTask(taskId: string): void {
    if (this.entries().some(entry => entry.taskId === taskId)) this.currentTaskId.set(taskId);
  }

  private entry(taskId: string, title: string, status: DockEntry['status'], lane: DockEntry['lane'], waitMinutes: number | null = null): DockEntry {
    return { taskId, title, sourceProjectId: null, status, load: 'low', expectedMinutes: 15, waitMinutes,
      waitStartedAt: null, lane, zoneSource: 'manual', isMain: false, dockedOrder: 0,
      detail: '这是完全隔离的虚拟任务，只用于展示手机停泊坞。', sourceKind: 'dock-created', systemSelected: false, recommendedScore: null };
  }
}
