import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import type { ColorMode, ThemeType } from '../../models';
import { DockEngineService } from '../../services/dock-engine.service';
import { FocusDockLeaderService } from '../../services/focus-dock-leader.service';
import { PerformanceTierService } from '../../services/performance-tier.service';
import { GateService } from '../../services/gate.service';
import { ProjectStateService } from '../../services/project-state.service';
import { TaskOperationAdapterService } from '../../services/task-operation-adapter.service';
import { ToastService } from '../../services/toast.service';
import { SettingsModalAppearanceComponent } from '../shared/modals/settings-modal-appearance.component';
import { TrashModalComponent } from '../shared/modals/trash-modal.component';
import { GateCardComponent } from '../features/focus/components/gate/gate-card.component';
import { BlackBoxEntryComponent } from '../features/focus/components/black-box/black-box-entry.component';
import { DockStatusMachineComponent } from '../features/parking/components/dock-status-machine.component';
import { DockDailySlotComponent } from '../features/parking/components/dock-daily-slot.component';
import { DockFocusSceneComponent } from '../features/parking/components/dock-focus-scene.component';
import { DemoPreviewMemoryService } from './demo-preview-memory.service';

@Component({
  selector: 'app-demo-preview-surfaces',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsModalAppearanceComponent, TrashModalComponent, GateCardComponent, BlackBoxEntryComponent, DockStatusMachineComponent, DockDailySlotComponent, DockFocusSceneComponent],
  providers: [
    DemoPreviewMemoryService,
    { provide: DockEngineService, useExisting: DemoPreviewMemoryService },
    { provide: FocusDockLeaderService, useExisting: DemoPreviewMemoryService },
    { provide: PerformanceTierService, useExisting: DemoPreviewMemoryService },
    { provide: GateService, useExisting: DemoPreviewMemoryService },
    { provide: ProjectStateService, useExisting: DemoPreviewMemoryService },
    { provide: TaskOperationAdapterService, useExisting: DemoPreviewMemoryService },
    { provide: ToastService, useExisting: DemoPreviewMemoryService },
  ],
  template: `
    <section class="preview-surface" [attr.data-color-mode]="colorMode()" [attr.data-preview-widget]="widget()" [attr.data-preview-state]="state()">
      @switch (widget()) {
        @case ('settings') {
          <app-settings-modal-appearance [theme]="theme()" [colorMode]="colorMode()"
            (themeChange)="theme.set($event)" (colorModeChange)="colorMode.set($event)" />
          <p role="status">当前选择：{{ theme() }} · {{ colorMode() }}</p>
        }
        @case ('focus') {
          @if (state() === 'daily' || state() === 'daily-completed' || state() === 'fragment') {
            <app-dock-daily-slot />
          } @else if (state() === 'gate') {
            <app-gate-card />
          } @else {
            <app-dock-status-machine [forcedMode]="state() === 'minimal' ? 'minimal' : 'full'" />
          }
          @if (state() === 'fragment' || state() === 'scene' || state() === 'zen' || state() === 'burnout') {
            <div class="contained-scene"><app-dock-focus-scene [active]="true" [scrimOn]="true" [sceneMode]="sceneMode()" [reducedMotion]="true" /></div>
          }
        }
        @case ('daily') { <app-dock-daily-slot /> }
        @case ('gate') { <app-gate-card /> }
        @case ('status') { <app-dock-status-machine [forcedMode]="state() === 'minimal' ? 'minimal' : 'full'" /> }
        @case ('recovery') {
          <div class="contained-overlay"><app-trash-modal [show]="true" [projectOwner]="memory.owner" [canPublishUi]="memory.canPublishUi" /></div>
          <p role="status">{{ memory.toastMessage() }}</p>
        }
        @case ('black-box') {
          @for (entry of memory.blackBoxEntries(); track entry.id) {
            <app-black-box-entry [entry]="entry" (markRead)="memory.markBlackBoxRead($event)" (markCompleted)="memory.markBlackBoxCompleted($event)" (delete)="memory.deleteBlackBox($event)" />
          }
        }
        @default { <p role="status">此预览没有对应的小部件。</p> }
      }
    </section>
  `,
  styles: [`:host{display:block;min-width:0}.preview-surface{position:relative;transform:translateZ(0);padding:16px;color:var(--theme-text,#292524);background:var(--theme-bg,#fafaf9);border-radius:16px}.contained-scene{position:relative;transform:translateZ(0);height:240px;overflow:hidden;margin-top:16px}.contained-overlay{position:relative;min-height:480px;transform:translateZ(0);overflow:auto;border-radius:16px}p{margin-top:12px;font-size:12px}`],
})
export class DemoPreviewSurfacesComponent {
  readonly widget = input('settings');
  readonly state = input('default');
  readonly persistentKey = input('');
  readonly memory = inject(DemoPreviewMemoryService);
  readonly theme = signal<ThemeType>('default');
  readonly colorMode = signal<ColorMode>('light');
  constructor() {
    effect(() => {
      const widget = this.widget();
      const state = this.state();
      untracked(() => {
        if (widget === 'settings') this.colorMode.set(state === 'dark' ? 'dark' : state === 'system' ? 'system' : 'light');
        if (widget === 'recovery') this.memory.resetRecoveryState(state);
        if (widget === 'black-box') this.memory.resetBlackBoxState(state);
        if (widget === 'focus' || widget === 'daily') this.memory.resetDailyState(state);
        if (widget === 'focus' || widget === 'status') this.memory.resetStatusState(state);
      });
    });
  }
  sceneMode(): 'steady' | 'fragment' | 'zen' | 'burnout' {
    const state = this.state();
    return state === 'fragment' || state === 'zen' || state === 'burnout' ? state : 'steady';
  }
}