import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DemoFlowPreviewComponent } from './demo-flow-preview.component';
@Component({
  selector: 'app-demo-preview-panel', standalone: true, imports: [DemoFlowPreviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@switch (widget()) { @case ('flow') { <app-demo-flow-preview [state]="state()" /> } }`,
})
export class DemoPreviewPanelComponent {
  readonly widget = input('flow');
  readonly state = input('overview-dense');
}
