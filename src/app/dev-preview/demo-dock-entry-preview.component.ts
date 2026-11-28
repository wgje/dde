import { ChangeDetectionStrategy, Component, ViewChild, computed, input, signal } from '@angular/core';
import type { DockEntry } from '../models/parking-dock';
import { DockMobileDrawerComponent } from '../features/parking/components/dock-mobile-drawer.component';

@Component({
  selector: 'app-demo-dock-entry-preview',
  standalone: true,
  imports: [DockMobileDrawerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dock-preview" [class.open-preview]="openState()">
      <div class="workspace" aria-hidden="true">
        <span class="workspace-label">正在处理</span>
        <strong>整理今天最重要的一步</strong>
        <span class="workspace-note">其余任务安静地停在背景里。</span>
      </div>
      <app-dock-mobile-drawer
        [entries]="entries()"
        [projects]="[]"
        [showTrigger]="true"
        [activeView]="'text'"
        [focusActive]="false"
        [interactive]="true"
        [readOnly]="false"
        (taskConfirmed)="selectTask($event)" />
      @if (selectedTitle(); as title) {
        <p class="selection" role="status">当前示例任务：{{ title }}</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .dock-preview { position: relative; min-height: 480px; overflow: hidden; border-radius: 12px; background: #f1f0eb; color: #302f2a; }
    .workspace { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 30px; }
    .workspace-label { color: #758071; font-size: 11px; }
    .workspace strong { max-width: 18em; font-size: 20px; font-weight: 500; }
    .workspace-note { color: #797970; font-size: 12px; }
    .selection { position: absolute; top: 12px; left: 14px; margin: 0; padding: 8px 12px; border-radius: 8px; background: #fff; font-size: 12px; }
  `],
})
export class DemoDockEntryPreviewComponent {
  readonly state = input('mobile-entry');
  readonly currentId = signal('dock-preview-current');
  readonly selectedTitle = signal('');
  readonly openState = computed(() => this.state() === 'mobile-open');
  readonly entries = computed<DockEntry[]>(() => [
    this.entry({taskId: this.currentId(), title: '今天最重要的一步', status: 'focusing', isMain: true, lane: 'combo-select'}),
    this.entry({taskId: 'dock-preview-candidate', title: '核对待回复的内容', status: 'pending_start', isMain: false, lane: 'combo-select'}),
    this.entry({taskId: 'dock-preview-waiting', title: '等对方确认时间', status: 'suspended_waiting', isMain: false, lane: 'backup', waitMinutes: 20}),
  ]);

  @ViewChild(DockMobileDrawerComponent)
  set drawer(drawer: DockMobileDrawerComponent | undefined) {
    if (drawer) drawer.opened.set(this.openState());
  }

  selectTask(taskId: string): void {
    const selected = this.entries().find(entry => entry.taskId === taskId);
    if (!selected) return;
    this.selectedTitle.set(selected.title);
    this.currentId.set(taskId);
  }

  private entry(values: Pick<DockEntry, 'taskId'|'title'|'status'|'isMain'|'lane'> & Partial<DockEntry>): DockEntry {
    return { ...values, sourceProjectId: null, load: 'low', expectedMinutes: 15, waitMinutes: null,
      waitStartedAt: null, zoneSource: 'manual', dockedOrder: 0, detail: '这是完全隔离的虚拟任务，只用于展示手机停泊坞。',
      sourceKind: 'dock-created', systemSelected: false, recommendedScore: null };
  }
}
