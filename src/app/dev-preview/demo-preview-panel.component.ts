import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DemoFlowPreviewComponent } from './demo-flow-preview.component';
import { DemoBlackBoxPreviewComponent } from './demo-black-box-preview.component';
@Component({
  selector: 'app-demo-preview-panel', standalone: true, imports: [DemoFlowPreviewComponent, DemoBlackBoxPreviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@switch (widget()) { @case ('flow') { <app-demo-flow-preview [state]="state()" /> } @case ('inbox') { <app-demo-black-box-preview [state]="state()" /> } }`,
})
export class DemoPreviewPanelComponent {
  readonly widget = input('flow');
  readonly state = input('overview-dense');
}
