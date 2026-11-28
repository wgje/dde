import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
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
import { DemoTaskPreviewComponent } from './demo-task-preview.component';
import { DemoDockPreviewComponent } from './demo-dock-preview.component';
import { DemoFlowPreviewComponent } from './demo-flow-preview.component';
import { DemoFocusDecisionPreviewComponent } from './demo-focus-decision-preview.component';
import { DemoDashboardPreviewComponent } from './demo-dashboard-preview.component';
import { DemoPreviewSurfacesComponent } from './demo-preview-surfaces.component';
import { DEMO_PREVIEW_SCENARIOS, demoPreviewHref } from './demo-preview-registry';

@Component({
  selector: 'app-demo-preview-panel', standalone: true,
  imports: [DemoFlowPanelsPreviewComponent, DemoFeedbackPreviewComponent, DemoFocusShellPreviewComponent, DemoFlowControlsPreviewComponent, DemoTextListsPreviewComponent, DemoControlsPreviewComponent, DemoKnowledgePreviewComponent, DemoDesktopDockPreviewComponent, DemoTaskTreePreviewComponent, DemoPreviewSurfacesComponent, DemoDashboardPreviewComponent, DemoBlackBoxPreviewComponent, DemoTaskPreviewComponent, DemoDockPreviewComponent, DemoFlowPreviewComponent, DemoFocusDecisionPreviewComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel" data-testid="demo-preview-panel">
      <button type="button" (click)="expanded.update(toggle)" [attr.aria-expanded]="expanded()">开发预览区 · {{ expanded() ? '收起' : '展开' }}</button>
      @if (expanded()) {
        <p>真实组件、虚拟数据。这里的试用不改变主工作区。改动链接刷新即恢复。</p>
        <details><summary>所有直达链接</summary><nav aria-label="改动预览链接">@for (example of examples; track example.widget + '/' + example.state) {
          <a [href]="href(example.widget, example.state)" target="_blank" rel="noopener">{{ example.title }}</a>
        }</nav></details>
        <div class="examples">
          @for (example of examples; track example.widget + '/' + example.state) {
            <article><h3>{{ example.title }}</h3><a [href]="href(example.widget, example.state)" target="_blank" rel="noopener">单独打开此例</a>
              @defer (on viewport) {
                @switch (example.widget) {
                  @case ('desktop-dock') { <app-demo-desktop-dock-preview [state]="example.state" /> }
                  @case ('task-tree') { <app-demo-task-tree-preview [state]="example.state" /> }
                  @case ('task') { <app-demo-task-preview [state]="example.state" /> }
                  @case ('dock') { <app-demo-dock-preview widget="dock" [state]="example.state" /> }
                  @case ('flow-controls') { <app-demo-flow-controls-preview [state]="example.state" /> }
                  @case ('text-lists') { <app-demo-text-lists-preview [state]="example.state" /> }
                  @case ('feedback') { <app-demo-feedback-preview [state]="example.state" /> }
                  @case ('focus-shell') { <app-demo-focus-shell-preview [state]="example.state" /> }
                  @case ('flow-panels') { <app-demo-flow-panels-preview [state]="example.state" /> }
                  @case ('controls') { <app-demo-controls-preview [state]="example.state" /> }
                  @case ('knowledge') { <app-demo-knowledge-preview [state]="example.state" /> }
                  @case ('inbox') { <app-demo-black-box-preview [state]="example.state" /> }
                  @case ('dashboard') { <app-demo-dashboard-preview [state]="example.state" /> }
                  @case ('settings') { <app-demo-preview-surfaces [widget]="example.widget" [state]="example.state" [persistentKey]="example.widget + '-' + example.state" /> }
                  @case ('focus') { <app-demo-preview-surfaces [widget]="example.widget" [state]="example.state" [persistentKey]="example.widget + '-' + example.state" /> }
                  @case ('status') { <app-demo-preview-surfaces [widget]="example.widget" [state]="example.state" [persistentKey]="example.widget + '-' + example.state" /> }
                  @case ('black-box') { <app-demo-preview-surfaces [widget]="example.widget" [state]="example.state" [persistentKey]="example.widget + '-' + example.state" /> }
                  @case ('recovery') { <app-demo-preview-surfaces [widget]="example.widget" [state]="example.state" [persistentKey]="example.widget + '-' + example.state" /> }
                  @case ('focus-decision') { <app-demo-focus-decision-preview [state]="example.state" /> }
                  @case ('flow') { @if (example.state === 'legend') { <app-demo-dock-preview widget="flow" state="legend" /> } @else { <app-demo-flow-preview [state]="example.state" /> } }

                }
              } @placeholder { <div class="sample-placeholder">{{ example.title }} · 滚动到这里自动显示</div> }
            </article>
          }
        </div>
      }
    </section>
  `,
  styles: [`:host{display:block;width:100%;height:45vh;min-height:240px;flex:0 0 45vh;overflow:auto;background:var(--theme-bg,#fafaf9)}.panel{padding:24px;border-top:1px solid #a8a29e}button{padding:8px 16px;border:1px solid #a8a29e;border-radius:8px}p{margin:12px 0}details{margin:12px 0}summary{cursor:pointer}nav{margin-top:12px;display:flex;gap:12px;flex-wrap:wrap}a{color:#4f46e5;font-size:12px}.examples{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,540px),1fr));gap:20px;margin-top:20px}article{position:relative;min-width:0;padding:12px;border:1px solid #a8a29e;border-radius:12px}h3{margin-bottom:12px}.sample-placeholder{min-height:120px}`],
})
export class DemoPreviewPanelComponent {
  readonly expanded = signal(true);
  readonly toggle = (value: boolean) => !value;
  readonly examples = DEMO_PREVIEW_SCENARIOS;
  readonly href = demoPreviewHref;
}