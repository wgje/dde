import { AfterViewInit, ChangeDetectionStrategy, Component, inject, Input, signal, ViewChild } from '@angular/core';
import { DashboardModalComponent } from '../shared/modals/dashboard-modal.component';
import { DEMO_DASHBOARD_PROVIDERS, DemoDashboardMemoryService } from './demo-dashboard-preview.providers';

@Component({
  selector: 'app-demo-dashboard-preview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DashboardModalComponent],
  providers: DEMO_DASHBOARD_PROVIDERS,
  template: `
    <section class="dashboard-preview" data-testid="demo-dashboard-preview" [attr.data-preview-state]="state()">
      <app-dashboard-modal (close)="memory.info('演示面板保持打开，可继续试用。')" />
    </section>
    <p role="status">{{ memory.message() }}</p>
  `,
  styles: [`
    :host { display:block; min-width:0; }
    .dashboard-preview { position:relative; transform:translateZ(0); min-height:560px; overflow:auto; border-radius:16px; }
    p { margin-top:8px; font-size:12px; color:var(--theme-text,#292524); }
  `],
})
export class DemoDashboardPreviewComponent implements AfterViewInit {
  readonly state = signal('status');
  readonly memory = inject(DemoDashboardMemoryService);
  @ViewChild(DashboardModalComponent) private dashboard?: DashboardModalComponent;
  @Input({ alias: 'state' }) set stateInput(value: string) {
    this.state.set(value);
    this.memory.reset(value);
    this.dashboard?.setActiveTab(value === 'queue' ? 'queue' : 'status');
  }
  ngAfterViewInit(): void {
    queueMicrotask(() => this.dashboard?.setActiveTab(this.state() === 'queue' ? 'queue' : 'status'));
  }
}