import { DemoTaskArchivePreviewComponent } from './demo-task-archive-preview.component';
import { ChangeDetectionStrategy, Component, afterNextRender, computed, input } from '@angular/core';
import { DemoDesktopDockPreviewComponent } from './demo-desktop-dock-preview.component';
import { DemoTaskTreePreviewComponent } from './demo-task-tree-preview.component';
import { DemoFlowControlsPreviewComponent } from './demo-flow-controls-preview.component';
import { DemoTextListsPreviewComponent } from './demo-text-lists-preview.component';
import { DemoFeedbackPreviewComponent } from './demo-feedback-preview.component';
import { DemoFocusShellPreviewComponent } from './demo-focus-shell-preview.component';
import { DemoFlowPanelsPreviewComponent } from './demo-flow-panels-preview.component';
import { DemoControlsPreviewComponent } from './demo-controls-preview.component';
import { DemoKnowledgePreviewComponent } from './demo-knowledge-preview.component';
import { DemoBlackBoxPreviewComponent } from './demo-black-box-preview.component';
import { DemoFocusDecisionPreviewComponent } from './demo-focus-decision-preview.component';
import { DemoDashboardPreviewComponent } from './demo-dashboard-preview.component';
import { DemoFlowPreviewComponent } from './demo-flow-preview.component';
import { DemoDockPreviewComponent } from './demo-dock-preview.component';
import { DemoDockEntryPreviewComponent } from './demo-dock-entry-preview.component';
import { DemoTaskPreviewComponent } from './demo-task-preview.component';
import { DemoPreviewSurfacesComponent } from './demo-preview-surfaces.component';
import { resolveDemoPreviewScenario } from './demo-preview-registry';

/** Deliberately does not inject workspace/auth/sync/persistence services. */
@Component({
  selector: 'app-demo-preview-page', standalone: true,
  imports: [DemoTaskArchivePreviewComponent, DemoDockEntryPreviewComponent, DemoFlowPanelsPreviewComponent, DemoFeedbackPreviewComponent, DemoFocusShellPreviewComponent, DemoFlowControlsPreviewComponent, DemoTextListsPreviewComponent, DemoControlsPreviewComponent, DemoKnowledgePreviewComponent, DemoDesktopDockPreviewComponent, DemoTaskTreePreviewComponent, DemoBlackBoxPreviewComponent, DemoFlowPreviewComponent, DemoFocusDecisionPreviewComponent, DemoDashboardPreviewComponent, DemoDockPreviewComponent, DemoTaskPreviewComponent, DemoPreviewSurfacesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main data-testid="dev-preview-page">
      <header><span>改动预览 · 虚拟数据</span><a href="/&#63;workspace=demo#/projects">回到普通演示</a></header>
      @if (scenario(); as example) {
        <h1>{{ example.title }}</h1><p>{{ example.steps }}</p>
        <p>这里的操作只保存在本页内存中。刷新后恢复样例，不影响你保存的演示数据。</p>
        @for (key of [example.widget + "/" + example.state]; track key) {
        @switch (widget()) {
          @case ('task-archive') { <app-demo-task-archive-preview [previewState]="state()" /> }
          @case ('desktop-dock') { <app-demo-desktop-dock-preview [state]="state()" /> }
          @case ('task-tree') { <app-demo-task-tree-preview [state]="state()" /> }
          @case ('flow-controls') { <app-demo-flow-controls-preview [state]="state()" /> }
          @case ('text-lists') { <app-demo-text-lists-preview [state]="state()" /> }
          @case ('feedback') { <app-demo-feedback-preview [state]="state()" /> }
                  @case ('focus-shell') { <app-demo-focus-shell-preview [state]="state()" /> }
                  @case ('flow-panels') { <app-demo-flow-panels-preview [state]="state()" /> }
                  @case ('controls') { <app-demo-controls-preview [state]="state()" /> }
          @case ('knowledge') { <app-demo-knowledge-preview [state]="state()" /> }
          @case ('inbox') { <app-demo-black-box-preview [state]="state()" /> }
          @case ('focus-decision') { <app-demo-focus-decision-preview [state]="state()" /> }
          @case ('dashboard') { <app-demo-dashboard-preview [state]="state()" /> }
          @case ('settings') { <app-demo-preview-surfaces [widget]="widget()" [state]="state()" /> }
          @case ('focus') { <app-demo-preview-surfaces [widget]="widget()" [state]="state()" /> }
          @case ('status') { <app-demo-preview-surfaces [widget]="widget()" [state]="state()" /> }
          @case ('black-box') { <app-demo-preview-surfaces [widget]="widget()" [state]="state()" /> }
          @case ('recovery') { <app-demo-preview-surfaces [widget]="widget()" [state]="state()" /> }
          @case ('task') { <app-demo-task-preview [state]="state()" /> }
          @case ('dock') { @if (state() === 'mobile-entry' || state() === 'mobile-open') { <app-demo-dock-entry-preview [state]="state()" /> } @else { <app-demo-dock-preview [widget]="widget()" [state]="state()" /> } }
          @case ('flow') { @if (state() === 'legend') { <app-demo-dock-preview widget="flow" state="legend" /> } @else { @defer (when widget() === 'flow') { <app-demo-flow-preview [state]="state()" /> } } }

        }
        }
      } @else { <h1 data-testid="dev-preview-not-found">找不到这个示例</h1><p>请检查小部件和状态链接，没有进入真实工作区。</p> }
    </main>
  `,
  styles: [`:host{display:block;height:100%;overflow:auto;background:var(--theme-bg,#fafaf9);color:var(--theme-text,#292524)}main{max-width:1100px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;gap:20px}h1{font-size:24px;margin:24px 0 12px}p{margin:12px 0;font-size:14px}a{color:#4f46e5}`],
})
export class DemoPreviewPageComponent {
  readonly widget = input('');
  readonly state = input('');
  readonly scenario = computed(() => resolveDemoPreviewScenario(this.widget(), this.state()));
  constructor() {
    afterNextRender(() => { document.getElementById('initial-loader')?.remove(); });
  }
}