import { ChangeDetectionStrategy, Component, afterNextRender, computed, input } from '@angular/core';
import { DemoFlowPreviewComponent } from './demo-flow-preview.component';
import { DemoBlackBoxPreviewComponent } from './demo-black-box-preview.component';
import { DemoDockEntryPreviewComponent } from './demo-dock-entry-preview.component';
import { resolveDemoPreviewScenario } from './demo-preview-registry';
@Component({
  selector: 'app-demo-preview-page', standalone: true, imports: [DemoFlowPreviewComponent, DemoBlackBoxPreviewComponent, DemoDockEntryPreviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main data-testid="dev-preview-page">
    @if (scenario(); as example) {
      <h1>{{ example.title }}</h1><p>{{ example.steps }}</p>
      <p>虚拟数据，仅本页内存；刷新恢复，不访问真实工作区或云端。</p>
      @switch (widget()) { @case ('flow') { <app-demo-flow-preview [state]="state()" /> } @case ('inbox') { <app-demo-black-box-preview [state]="state()" /> } @case ('dock') { <app-demo-dock-entry-preview [state]="state()" /> } }
    } @else { <h1>找不到这个示例</h1> }
  </main>`,
  styles: [`:host{display:block;height:100%;overflow:auto;background:#fafaf9}main{max-width:1100px;margin:auto;padding:24px}h1{font-size:24px}p{margin:12px 0}`],
})
export class DemoPreviewPageComponent {
  readonly widget = input('');
  readonly state = input('');
  readonly scenario = computed(() => resolveDemoPreviewScenario(this.widget(), this.state()));
  constructor() { afterNextRender(() => document.getElementById('initial-loader')?.remove()); }
}
